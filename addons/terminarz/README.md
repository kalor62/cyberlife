# Terminarz

Rejestr zobowiązań cyklicznych i terminowych — ubezpieczenia, leasing,
podatki, domeny, abonamenty — każde z przypisanym właścicielem. Zobowiązanie
generuje terminy, terminy mają statusy, a statusy pilnują, żeby nic nie
przepadło.

## Co robi

- **📋 Zobowiązania** — lista z cyklem słownie, kwotą, właścicielem, najbliższym
  terminem i historią wystąpień; potwierdzanie płatności z datą i kwotą
  rzeczywistą, cofanie omyłkowych potwierdzeń.
- **📆 Kalendarz** — widoki Dzień / Miesiąc / Rok z filtrami właściciela
  i kategorii oraz sumami kwot.
- **Przypomnienia** — powiadomienia systemowe 7 dni przed terminem, dzień przed
  i po przekroczeniu terminu; każde najwyżej raz.
- **Widgety** — „Nadchodzące płatności" (pięć najbliższych pozycji, przegapione
  czerwone na górze), „Dzisiaj" (data i pozycje na dziś) oraz „Miesiąc" (mini
  siatka bieżącego miesiąca z kropkami przy dniach z terminami). Każdy klikalny:
  prowadzi do modułu, a z mini siatki wprost na wybrany dzień w kalendarzu.

## Widoki kalendarza

Dzień (`d`), Tydzień (`w`), Miesiąc (`m`), Rok (`r`); `[` i `]` przesuwają
okres, `t` wraca na dzisiaj. Tydzień to siedem kolumn pon–niedz z pełną listą
pozycji dnia — klik w kolumnę otwiera widok dnia.

## Statusy terminu

| Status | Kiedy |
|---|---|
| nadchodząca | przed terminem |
| do potwierdzenia | od dnia terminu do +3 dni (karencja) |
| potwierdzona | po potwierdzeniu, z datą i kwotą rzeczywistą |
| przegapiona | po karencji, bez potwierdzenia |

## Narzędzia dla agentów (MCP)

Addon udostępnia cztery narzędzia z prefiksem `terminarz_`:

| Narzędzie | Do czego |
|---|---|
| `terminarz_list` | zobowiązania z konfiguracją i najbliższym terminem; filtry `owner`, `category` |
| `terminarz_pending` | wystąpienia „do potwierdzenia" i „przegapione" w oknie `from`–`to` (domyślnie 60 dni wstecz → 7 dni w przód) |
| `terminarz_confirm` | potwierdza jedno wystąpienie: `obligationId`, `dueDate`, `paidDate`, opcjonalnie `amount` i `note` |
| `terminarz_suggest` | zapisuje wykryte płatności cykliczne; użytkownik widzi je jako pasek do przejrzenia nad listą |

`terminarz_pending` zwraca komplet danych potrzebnych do dopasowania przelewu:

```json
{
  "obligationId": "o1809168741",
  "name": "PIT-4R",
  "dueDate": "2026-08-20",
  "expectedAmount": 1954,
  "tolerancePct": 10,
  "status": "missed",
  "matchPattern": "PIT-4R",
  "owner": "Spółka"
}
```

`terminarz_confirm` odrzuca nieistniejące i już rozliczone wystąpienia:

```
zobowiązanie nie znalezione
wystąpienie 2026-08-21 nie istnieje dla tego zobowiązania (cykl: co miesiąc, 20-go)
wystąpienie już potwierdzone
```

## Automatyzacja z wyciągami

Terminarz wie, co miało być zapłacone; addon KSeF wie, co faktycznie zeszło
z konta. Automatyzacja cykliczna łączy jedno z drugim, więc płatności firmowe
potwierdzają się same, a ręcznie zostaje tylko to, czego nie widać na wyciągu.

Załóż regułę w **⚡ Auto** (wyzwalacz: harmonogram, np. co poniedziałek rano),
akcja: uruchom agenta z tym promptem:

```
Rozlicz Terminarz z wyciągami bankowymi.

1. Pobierz oczekiwane płatności: terminarz_pending {}
   (bez argumentów — domyślnie 60 dni wstecz do 7 dni w przód).
   Jeśli lista jest pusta, zakończ i napisz, że nie ma czego rozliczać.

2. Pobierz przelewy z tego samego okresu: ksef_list_bank_transactions
   z zakresem dat obejmującym najstarszy i najnowszy dueDate z punktu 1.

3. Dopasuj przelew do pozycji, gdy spełnione są WSZYSTKIE warunki:
   - tytuł przelewu zawiera matchPattern (bez rozróżniania wielkości liter);
     gdy matchPattern jest pusty, użyj nazwy zobowiązania,
   - kwota mieści się w expectedAmount ± tolerancePct procent,
   - data przelewu wypada w oknie dueDate ± 5 dni.

4. Dla każdego pewnego dopasowania wywołaj:
   terminarz_confirm {obligationId, dueDate, paidDate: <data przelewu>,
                      amount: <kwota przelewu>, note: "auto: wyciąg"}
   Nie potwierdzaj pozycji, dla której pasuje więcej niż jeden przelew
   albo żaden — zostaw ją człowiekowi.

5. Jeśli w wyciągu widzisz powtarzalne obciążenia, których nie ma
   w Terminarzu (ten sam tytuł i zbliżona kwota w kolejnych miesiącach),
   zgłoś je: terminarz_suggest {items: [{name, amount, cycle, lastSeen}]}.

6. Na koniec napisz krótkie podsumowanie: ile pozycji potwierdzono,
   ile zostało do ręcznego sprawdzenia i dlaczego.
```

Potwierdzenia z automatyzacji trafiają do historii zobowiązania tak samo jak
te klikane ręcznie, więc zawsze widać realną datę i kwotę. Zgłoszone sugestie
czekają w pasku nad listą — zaakceptowana otwiera formularz z wypełnionymi
polami, odrzucona znika.

## Kalendarz Google

Gdy w **Ustawienia → Google Calendar** podłączone jest konto i udostępniony
przynajmniej jeden kalendarz, na stronie Kalendarz pojawiają się dwa przyciski:

- **🔄 Synchronizuj** — uruchamia ten sam przebieg, co automatyczny poll
  (co 5 minut), tylko od razu. Okno pokazuje per kalendarz, ile zaciągnięto
  zwykłych wydarzeń i ile pozycji pochodzi z Terminarza; błąd jednego
  kalendarza nie kasuje wcześniej pobranych danych.
- **+ Wydarzenie** — dodaje zwykłe wydarzenie do wybranego kalendarza Google
  (cały dzień albo z godzinami). Nie jest to zobowiązanie: nie ma cyklu,
  kwoty ani potwierdzania płatności. Po zapisie widok odświeża się sam,
  a kalendarz docelowy zostaje odznaczony jako widoczny, jeśli był ukryty.

Pod paskiem jest po jednym checkboksie na udostępniony kalendarz — odznaczenie
chowa jego wydarzenia we wszystkich widokach i na widgetach. Kolor kwadracika
to kolor kalendarza z Google; wydarzenie z własnym kolorem dostaje swój.

Wydarzenia spoza Terminarza pozostają w widokach tylko do odczytu — edytuje
się je w Google.

## Dane

Wszystko leży lokalnie w magazynie addonu (`cl.storage`). Listy, które rosną —
zobowiązania (`obl`), potwierdzenia (`conf`) i sugestie (`sugg`) — są dzielone
na części pod limit 64 KB na klucz; `owners` i `sent` są z natury małe.
Uprawnienia w manifeście: `notify` (powiadomienia systemowe) i `calendar`
(dostęp do `/api/calendar` — wyłącznie do kalendarzy oznaczonych jako
udostępnione dla addonów).

## Instalacja w trybie deweloperskim

```bash
cp -r addons/terminarz ~/.cyberlife/addons/
```

Potem włącz addon w **Ustawienia → Manage Addons** i zrestartuj aplikację
(albo przeładuj addony, jeśli masz to podpięte pod automatyzację).
