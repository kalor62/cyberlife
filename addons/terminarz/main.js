// Terminarz — recurring/scheduled obligations register (tasks 1/6 + 2/6 of #2).
//
// A local register of cyclic commitments (insurance, leasing, taxes, domains,
// subscriptions) each with an OWNER. Task 2/6 adds the period engine: every
// obligation generates occurrences (due dates), each occurrence has a status
// (upcoming → due → confirmed / missed) and can be confirmed with the real
// payment date and amount.
//
// Single-file on purpose: hot reload (`addons_reload`) only re-imports the
// ENTRY, so keeping everything here means every edit reloads cleanly.

export default async function activate(cl) {
  const STYLE_ID = "terminarz-style";

  // ------------------------------------------------------------- constants
  const CATEGORIES = [
    { id: "car", label: "Ubezpieczenie auta" },
    { id: "home", label: "Ubezpieczenie domu" },
    { id: "firm", label: "Ubezpieczenie firmy" },
    { id: "leasing", label: "Leasing" },
    { id: "tax", label: "Podatek" },
    { id: "domain", label: "Domena / hosting" },
    { id: "subscription", label: "Abonament" },
    { id: "other", label: "Inne" },
  ];
  const CATEGORY_LABEL = Object.fromEntries(
    CATEGORIES.map((c) => [c.id, c.label]),
  );

  const MONTHS = [
    "styczeń",
    "luty",
    "marzec",
    "kwiecień",
    "maj",
    "czerwiec",
    "lipiec",
    "sierpień",
    "wrzesień",
    "październik",
    "listopad",
    "grudzień",
  ];
  const MONTHS_GEN = [
    "stycznia",
    "lutego",
    "marca",
    "kwietnia",
    "maja",
    "czerwca",
    "lipca",
    "sierpnia",
    "września",
    "października",
    "listopada",
    "grudnia",
  ];

  const DEFAULT_OWNERS = [
    { id: "ja", name: "Ja", color: "#89b4fa" },
    { id: "zona", name: "Żona", color: "#f5c2e7" },
    { id: "jdg", name: "JDG", color: "#a6e3a1" },
    { id: "spolka", name: "Spółka", color: "#fab387" },
  ];

  // ------------------------------------------------------------- helpers
  const esc = (s) =>
    String(s ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  const escAttr = (s) => esc(s).replace(/'/g, "&#39;");
  const utf8 = new TextEncoder();
  const byteLen = (v) => utf8.encode(JSON.stringify(v)).length;

  function formatAmount(n) {
    if (n == null || n === "") return "—";
    const num = Number(n);
    if (!isFinite(num)) return "—";
    return (
      num.toLocaleString("pl-PL", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      }) + " zł"
    );
  }

  // Cycle → human-readable Polish (e.g. "co miesiąc, 15-go", "raty: luty, maj").
  function cycleWords(cycle) {
    if (!cycle || !cycle.type) return "—";
    switch (cycle.type) {
      case "monthly":
        return `co miesiąc, ${cycle.day}-go`;
      case "quarterly":
        return `co kwartał, ${cycle.day}-go`;
      case "yearly":
        return `rocznie: ${cycle.day} ${MONTHS_GEN[cycle.month] || ""}`.trim();
      case "installments": {
        const names = (cycle.months || [])
          .slice()
          .sort((a, b) => a - b)
          .map((m) => MONTHS[m])
          .filter(Boolean);
        return `raty: ${names.join(", ")}`;
      }
      case "onetime":
        return `jednorazowo: ${cycle.date || "—"}`;
      default:
        return "—";
    }
  }

  // ------------------------------------------------------------- period engine
  // Every obligation generates occurrences (due dates). Statuses:
  //   upcoming  — before the due date
  //   due       — due date … due date + GRACE_DAYS (needs confirmation)
  //   confirmed — user confirmed (with real date and optional real amount)
  //   missed    — past due date + GRACE_DAYS without confirmation
  const GRACE_DAYS = 3; // karencja — do zmiany, jeśli właściciel uzna inaczej
  const HISTORY_MONTHS = 12;
  const HISTORY_SHOWN = 12;
  const CONTRACT_SOON_DAYS = 60;
  const QUARTER_MONTHS = [0, 3, 6, 9]; // styczeń, kwiecień, lipiec, październik

  const pad2 = (n) => String(n).padStart(2, "0");
  // „dziś 15:04" dla świeżych danych, pełna data dla starszych
  function fmtSyncTime(iso) {
    const d = new Date(iso);
    if (isNaN(d)) return "—";
    const stamp = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
    const day = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
    return day === todayStr() ? `dziś ${stamp}` : `${fmtDate(day)} ${stamp}`;
  }
  const dateStr = (d) =>
    `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  const todayStr = () => dateStr(new Date());
  const parseDate = (s) => {
    const [y, m, d] = String(s).split("-").map(Number);
    return new Date(y, (m || 1) - 1, d || 1);
  };
  const addDays = (s, n) => {
    const d = parseDate(s);
    d.setDate(d.getDate() + n);
    return dateStr(d);
  };
  const addMonths = (s, n) => {
    // clamp the day so e.g. 29.02 − 12 mies. nie przeskakuje na 1.03
    const d = parseDate(s);
    return mkDue(d.getFullYear(), d.getMonth() + n, d.getDate());
  };
  // whole days from a to b (positive when b is later)
  const daysBetween = (a, b) =>
    Math.round((parseDate(b) - parseDate(a)) / 86400000);
  const daysInMonth = (y, m) => new Date(y, m + 1, 0).getDate();
  const mkDue = (y, m, day) =>
    dateStr(new Date(y, m, Math.min(day, daysInMonth(y, m))));
  const fmtDate = (s) => {
    if (!s) return "—";
    const [y, m, d] = String(s).split("-");
    return d ? `${d}.${m}.${y}` : s;
  };

  // All due dates of a cycle within [startStr, endStr] inclusive, sorted.
  function occurrencesBetween(cycle, startStr, endStr) {
    if (!cycle || !cycle.type) return [];
    const out = [];
    const start = parseDate(startStr);
    const end = parseDate(endStr);
    if (cycle.type === "onetime") {
      if (cycle.date && cycle.date >= startStr && cycle.date <= endStr)
        out.push(cycle.date);
      return out;
    }
    const day = Number(cycle.day) || 1;
    for (let y = start.getFullYear(); y <= end.getFullYear(); y++) {
      let months;
      if (cycle.type === "monthly") months = [...Array(12).keys()];
      else if (cycle.type === "quarterly") months = QUARTER_MONTHS;
      else if (cycle.type === "yearly") months = [Number(cycle.month) || 0];
      else if (cycle.type === "installments")
        months = (cycle.months || []).slice().sort((a, b) => a - b);
      else return [];
      for (const m of months) {
        const due = mkDue(y, m, day);
        if (due >= startStr && due <= endStr) out.push(due);
      }
    }
    return out.sort();
  }

  // History window start: month of creation, capped at HISTORY_MONTHS back.
  // Month granularity so an occurrence earlier in the creation month counts
  // (freshly added obligation with a day already past ⇒ visible as missed).
  function windowStart(o) {
    const cap = addMonths(todayStr(), -HISTORY_MONTHS);
    const start = obligationStart(o);
    return start > cap ? start : cap;
  }

  // Uncapped lower bound: the month the obligation was created in. The history
  // view clamps this to HISTORY_MONTHS, but "does this occurrence exist?" must
  // not — an occurrence from two years ago is still a real occurrence.
  function obligationStart(o) {
    return (o.createdAt || todayStr()).slice(0, 7) + "-01";
  }

  const occKey = (oblId, due) => `${oblId}|${due}`;

  function occStatus(oblId, due, confMap, effective) {
    if (confMap[occKey(oblId, due)]) return "confirmed";
    const late = daysBetween(effective || due, todayStr());
    if (late < 0) return "upcoming";
    if (late <= GRACE_DAYS) return "due";
    return "missed";
  }

  // Past occurrences (≤ today, newest first) and the next upcoming one.
  function obligationOccurrences(o) {
    const today = todayStr();
    const past = occurrencesBetween(o.cycle, windowStart(o), today).reverse();
    const next =
      occurrencesBetween(o.cycle, addDays(today, 1), addMonths(today, 13))[0] ||
      null;
    return { past, next };
  }

  // The occurrence shown in the "Najbliższy termin" column: the oldest
  // unresolved past occurrence wins over the next upcoming one.
  function nearestOccurrence(o, confMap) {
    const { past, next } = obligationOccurrences(o);
    const unresolved = past
      .slice()
      .reverse()
      .find((due) => occStatus(o.id, due, confMap) !== "confirmed");
    const pick = unresolved || next;
    if (!pick) return null;
    return {
      due: effectiveDue(o.id, pick),
      sourceDue: pick,
      status: unresolved
        ? occStatus(o.id, pick, confMap, effectiveDue(o.id, pick))
        : "upcoming",
      gone: isGone(o.id, pick),
    };
  }

  // "YYYY-MM" contract end → days until the last day of that month (null when unset).
  function contractDaysLeft(o) {
    if (!o.contractEnd) return null;
    const [y, m] = o.contractEnd.split("-").map(Number);
    if (!y || !m) return null;
    return daysBetween(todayStr(), mkDue(y, m - 1, 31));
  }

  // ------------------------------------------------------------- store
  // Owners live in one small key; obligations are chunked under a byte cap so a
  // growing list never blows the host's 64KB/value limit (pattern from ksef).
  const MAX_CHUNK_BYTES = 52 * 1024;
  const K_OWNERS = "owners";
  const K_OBL = "obl"; // chunk prefix: obl, obl#2, obl#3, …
  const K_CONF = "conf"; // confirmations, same chunking: conf, conf#2, …
  // Starts as an empty object, never null: the host may render the widget
  // the moment it is registered, before initStore() has filled it in.
  let cache = {};

  async function initStore() {
    cache = await cl.storage.all();
    if (!Array.isArray(cache[K_OWNERS])) {
      await put(K_OWNERS, DEFAULT_OWNERS.slice());
    }
    // 1/6 records predate createdAt — backfill so the period engine has a
    // history window start for them.
    const list = obligations();
    if (list.some((o) => !o.createdAt)) {
      const today = todayStr();
      for (const o of list) if (!o.createdAt) o.createdAt = today;
      await saveObligations(list);
    }
  }
  async function put(key, value) {
    await cl.storage.set(key, value);
    cache[key] = value;
  }
  async function drop(key) {
    await cl.storage.remove(key);
    delete cache[key];
  }
  function partKeys(prefix) {
    // numeric suffix sort — plain .sort() would put "#10" before "#2"
    const idx = (k) => (k.includes("#") ? Number(k.split("#")[1]) : 1);
    return Object.keys(cache)
      .filter((k) => k === prefix || k.startsWith(`${prefix}#`))
      .sort((a, b) => idx(a) - idx(b));
  }
  function owners() {
    return Array.isArray(cache[K_OWNERS]) ? cache[K_OWNERS] : [];
  }
  function obligations() {
    return partKeys(K_OBL).flatMap((k) => cache[k] || []);
  }
  async function saveChunked(prefix, list) {
    const parts = [];
    let current = [];
    let bytes = 2;
    for (const rec of list) {
      const rb = byteLen(rec);
      if (current.length && bytes + rb + 1 > MAX_CHUNK_BYTES) {
        parts.push(current);
        current = [];
        bytes = 2;
      }
      bytes += rb + (current.length ? 1 : 0);
      current.push(rec);
    }
    parts.push(current);
    for (let i = 0; i < parts.length; i++) {
      await put(i === 0 ? prefix : `${prefix}#${i + 1}`, parts[i]);
    }
    for (const stale of partKeys(prefix)) {
      const idx = stale === prefix ? 0 : Number(stale.split("#")[1]) - 1;
      if (idx >= parts.length) await drop(stale);
    }
    // any obligation/confirmation write is visible in the widget
    refreshWidgets();
  }
  async function saveObligations(list) {
    await saveChunked(K_OBL, list);
  }

  // Confirmations: flat records {k: "oblId|dueDate", date, amount, at}.
  function confirmations() {
    return partKeys(K_CONF).flatMap((k) => cache[k] || []);
  }
  function confirmationMap() {
    return Object.fromEntries(confirmations().map((c) => [c.k, c]));
  }
  async function addConfirmation(oblId, due, date, amount, note = "") {
    const k = occKey(oblId, due);
    const list = confirmations().filter((c) => c.k !== k);
    const rec = { k, date, amount, at: todayStr() };
    if (note) rec.note = note;
    list.push(rec);
    await saveChunked(K_CONF, list);
    await syncOccurrenceTitle(oblId, due);
  }
  async function removeConfirmation(oblId, due) {
    const k = occKey(oblId, due);
    await saveChunked(
      K_CONF,
      confirmations().filter((c) => c.k !== k),
    );
    await syncOccurrenceTitle(oblId, due);
  }
  async function dropConfirmationsFor(oblId) {
    await saveChunked(
      K_CONF,
      confirmations().filter((c) => !c.k.startsWith(`${oblId}|`)),
    );
  }
  // After a cycle edit the generated due dates shift, which would orphan
  // existing confirmations (paid periods would show up as "missed"). Re-key
  // each orphan to the nearest newly generated occurrence; drop it when no
  // occurrence lands within REMAP_MAX_DAYS (its period no longer exists).
  const REMAP_MAX_DAYS = 45;
  async function reconcileConfirmations(o) {
    const valid = occurrencesBetween(
      o.cycle,
      windowStart(o),
      addMonths(todayStr(), 13),
    );
    const validSet = new Set(valid);
    const keyed = new Map(confirmations().map((c) => [c.k, c]));
    let changed = false;
    for (const [k, c] of [...keyed]) {
      if (!k.startsWith(`${o.id}|`)) continue;
      const due = k.slice(o.id.length + 1);
      if (validSet.has(due)) continue;
      changed = true;
      keyed.delete(k);
      let best = null;
      let bestDist = Infinity;
      for (const d of valid) {
        const dist = Math.abs(daysBetween(due, d));
        if (dist < bestDist) {
          bestDist = dist;
          best = d;
        }
      }
      if (best != null && bestDist <= REMAP_MAX_DAYS) {
        const nk = occKey(o.id, best);
        if (!keyed.has(nk)) keyed.set(nk, { ...c, k: nk });
      }
    }
    if (changed) await saveChunked(K_CONF, [...keyed.values()]);
  }
  async function upsertObligation(rec) {
    const list = obligations();
    const i = list.findIndex((o) => o.id === rec.id);
    const prev = i >= 0 ? list[i] : null;
    if (i >= 0) list[i] = rec;
    else list.push(rec);
    await saveObligations(list);
    if (prev && JSON.stringify(prev.cycle) !== JSON.stringify(rec.cycle))
      await reconcileConfirmations(rec);
    // Google idzie w tle — zapis lokalny jest już zrobiony, a synchronizacja
    // 12 wystąpień to kilkanaście żądań sieciowych. Czekanie na nią trzymało
    // otwarty formularz i kusiło do ponownego kliknięcia „Zapisz", co
    // uruchamiało drugi przebieg i tworzyło duplikaty.
    syncObligation(rec)
      .then(() => oblEl && renderObligations(oblEl))
      .catch((err) => cl.log("sync w tle:", err));
  }
  async function removeObligation(id) {
    await dropGoogleEvents(id);
    await saveObligations(obligations().filter((o) => o.id !== id));
    await dropConfirmationsFor(id);
  }
  async function saveOwners(list) {
    await put(K_OWNERS, list);
  }
  function ownerById(id) {
    return owners().find((o) => o.id === id) || null;
  }
  function newId() {
    return (
      "o" + Math.abs(hashStr(JSON.stringify(obligations()) + Math.random()))
    );
  }
  // deterministic-ish id without Date.now/Math.random reliance issues
  function hashStr(s) {
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
    return h;
  }

  // ------------------------------------------------------------- reminders (task 4/6)
  // Three moments per occurrence: 7 days out, 1 day out, and once it turns
  // "missed". Each fires at most once — the sent marks live in their own
  // storage key so a reinstall of the addon does not replay months of alerts.
  const K_SUGG = "sugg"; // sugestie z agenta: [{id, name, amount, cycle, lastSeen, at}]
  const K_SENT = "sent"; // { "oblId|due|stage": "YYYY-MM-DD" }
  const K_GCAL = "gcal"; // mapowanie wystąpień na eventy Google: [{k, event, calendar}]
  const K_GERR = "gerr"; // { oblId: "komunikat" } — pozycje, których nie udało się zsynchronizować
  const K_SHIFT = "shift"; // { "oblId|termin": "nowa data" } — przesunięcia zrobione w Google
  const K_GONE = "gone"; // { "oblId|termin": "YYYY-MM-DD" } — event skasowany w Google
  const K_EXT = "gext"; // obce wydarzenia z udostępnionych kalendarzy + czas pobrania
  const K_PREFS = "prefs"; // { hiddenCals: [calendarId] }
  const REMIND_AHEAD = 7; // pierwsze ostrzeżenie: tyle dni przed terminem
  const MISSED_LOOKBACK = 30; // jak stare przegapione jeszcze zgłaszamy
  const MAX_PER_RUN = 5; // żeby zaległości nie wysypały serii powiadomień
  const MARK_KEEP_DAYS = 90; // po tylu dniach znacznik nie jest już potrzebny
  const REMIND_INTERVAL_MS = 60 * 60 * 1000; // co godzinę
  let remindTimer = null;

  function sentMarks() {
    return cache[K_SENT] && typeof cache[K_SENT] === "object"
      ? cache[K_SENT]
      : {};
  }

  function reminderText(o, due, stage, left) {
    const ow = ownerById(o.ownerId);
    const who = ow ? ` (${ow.name})` : "";
    const amount = formatAmount(o.amount);
    if (stage === "missed")
      return `Przegapione: ${o.name} — ${amount}${who}, termin ${fmtDate(due)}`;
    if (stage === "d1")
      return `${left === 0 ? "Dziś" : "Jutro"}: ${o.name} — ${amount}${who}`;
    return `Za ${left} dni: ${o.name} — ${amount}${who}, termin ${fmtDate(due)}`;
  }

  // Which reminders are due right now, given today's date and what was sent.
  function pendingReminders() {
    const today = todayStr();
    const marks = sentMarks();
    const confMap = confirmationMap();
    const out = [];
    // Window reaches back far enough that a payment missed while the app was
    // closed still gets reported, and forward to the first warning.
    const lookback = addDays(today, -MISSED_LOOKBACK);
    const to = addDays(today, REMIND_AHEAD);
    for (const o of obligations()) {
      // never reach before the obligation existed — the same boundary the
      // history uses, so a freshly added record cannot claim a missed payment
      // from before it was created
      const start = windowStart(o);
      const from = start > lookback ? start : lookback;
      for (const due of occurrencesBetween(o.cycle, from, to)) {
        const status = occStatus(o.id, due, confMap);
        if (status === "confirmed") continue;
        const left = daysBetween(today, due);
        // Stages are ranges, not exact days — opening the app 5 days before
        // the term must still warn instead of silently skipping day 7.
        // left < 0 = po terminie, ale wciąż w karencji: nie wolno mu wpaść
        // w "d1", bo dostałby komunikat „Jutro" dla zaległej płatności
        let stage = null;
        if (status === "missed") stage = "missed";
        else if (left >= 0 && left <= 1) stage = "d1";
        else if (left > 1 && left <= REMIND_AHEAD) stage = "d7";
        if (!stage) continue;
        const key = `${o.id}|${due}|${stage}`;
        if (marks[key]) continue;
        out.push({
          key,
          due,
          title: "Terminarz",
          message: reminderText(o, due, stage, left),
        });
      }
    }
    // najpilniejsze najpierw, gdy zaległości jest więcej niż limit na przebieg
    return out.sort((a, b) => a.due.localeCompare(b.due)).slice(0, MAX_PER_RUN);
  }

  // Marks only need to outlive the window that can still produce a reminder.
  function pruneMarks(marks) {
    const cutoff = addDays(todayStr(), -MARK_KEEP_DAYS);
    const out = {};
    for (const [k, v] of Object.entries(marks)) {
      const due = k.split("|")[1];
      if (!due || due >= cutoff) out[k] = v;
    }
    return out;
  }

  async function runReminders() {
    const pending = pendingReminders();
    if (!pending.length) return 0;
    const marks = { ...sentMarks() };
    let sent = 0;
    for (const r of pending) {
      try {
        await cl.notify(r.title, r.message);
        marks[r.key] = todayStr();
        sent++;
      } catch (err) {
        // brak uprawnienia "notify" albo notyfikacje niedostępne — addon ma
        // działać dalej, więc tylko log i żadnego znacznika (spróbuje ponownie).
        // Brak uprawnienia dotyczy wszystkich naraz, więc wtedy przerywamy;
        // pojedynczy błąd notyfikatora nie blokuje pozostałych pozycji.
        const msg = err && err.message ? err.message : String(err);
        cl.log("powiadomienie odrzucone:", msg);
        if (msg.includes('"notify" permission')) break;
      }
    }
    if (sent) await put(K_SENT, pruneMarks(marks));
    return sent;
  }

  // ------------------------------------------------------------- widget (task 4/6)
  // Five nearest items: everything already missed first (red), then upcoming.
  function upcomingItems(limit = 5) {
    const confMap = confirmationMap();
    const out = [];
    for (const o of obligations()) {
      const { past, next } = obligationOccurrences(o);
      for (const due of past) {
        const status = occStatus(o.id, due, confMap);
        if (status === "missed" || status === "due")
          out.push({ o, due, status, sort: 0 });
      }
      if (next) out.push({ o, due: next, status: "upcoming", sort: 1 });
    }
    return out
      .sort((a, b) => a.sort - b.sort || a.due.localeCompare(b.due))
      .slice(0, limit);
  }

  function renderUpcomingWidget(el) {
    injectStyle();
    const items = upcomingItems();
    el.innerHTML = items.length
      ? `<div class="tz-widget">${items
          .map((it) => {
            const ow = ownerById(it.o.ownerId);
            return `<div class="tz-widget-row ${it.status}">
              <span class="tz-w-date">${esc(fmtDate(it.due).slice(0, 5))}</span>
              <span class="tz-w-name" title="${escAttr(it.o.name)}">${esc(it.o.name)}</span>
              ${ow ? `<span class="tz-chip" style="background:${escAttr(ow.color)}">${esc(ow.name)}</span>` : ""}
              <span class="tz-amt">${formatAmount(it.o.amount)}</span>
            </div>`;
          })
          .join("")}</div>`
      : `<div class="widget-empty">Brak nadchodzących płatności</div>`;
    el.onclick = () => cl.openModule("main", "obligations");
  }

  // The host rebuilds widget frames on unrelated events (project switch,
  // kanban, automations), so holding element references would pile up
  // detached nodes. Query the live DOM instead, like refreshLiveWidgets does.
  // Host nadaje widgetom przedrostek z id addonu — wyprowadzamy go tak samo,
  // żeby zmiana id nie rozjechała się z selektorami w refreshWidgets.
  const wid = (short) => `${cl.id}.${short}`;
  const WIDGETS = [
    { id: wid("upcoming"), render: (el) => renderUpcomingWidget(el) },
    { id: wid("today"), render: (el) => renderTodayWidget(el) },
    { id: wid("month"), render: (el) => renderMonthWidget(el) },
  ];
  function refreshWidgets() {
    for (const w of WIDGETS) {
      document
        .querySelectorAll(`[data-widget-id="${w.id}"] .widget-frame-body`)
        .forEach((body) => w.render(body));
    }
  }

  // ----------------------------------------------------------- widgets (6/6)
  const WEEKDAYS = [
    "niedziela",
    "poniedziałek",
    "wtorek",
    "środa",
    "czwartek",
    "piątek",
    "sobota",
  ];
  const TODAY_WIDGET_MAX = 5;

  // Both widgets jump into the calendar, so the module opens where the click
  // suggested: a day cell lands on that day, the frame itself on the month.
  function openCalendar(view, anchor) {
    cal.view = view;
    if (anchor) setAnchor(anchor);
    // openModule woła onShow strony, która renderuje kalendarz z nową kotwicą —
    // dodatkowy render tylko przebudowywałby DOM po raz drugi
    cl.openModule("main", "calendar");
  }

  function renderTodayWidget(el) {
    injectStyle();
    const today = todayStr();
    const d = parseDate(today);
    const heading = `${WEEKDAYS[d.getDay()]}, ${d.getDate()} ${MONTHS_GEN[d.getMonth()]}`;
    const items = itemsForRange(today, today, confirmationMap(), obligations());
    const shown = items.slice(0, TODAY_WIDGET_MAX);
    const more = items.length - shown.length;
    el.innerHTML = `<div class="tz-today">
      <div class="tz-today-date">${esc(heading)}</div>
      ${
        items.length
          ? shown
              .map((it) => {
                if (it.kind === "google")
                  return `<div class="tz-widget-row tz-ext" title="${escAttr(it.account || "")}">
                    <span class="tz-w-name"><span class="tz-cdot" style="background:${escAttr(safeColor(it.color))}"></span> ${esc(it.title)}</span>
                    <span class="tz-hint">${esc(it.time || "cały dzień")}</span>
                  </div>`;
                const ow = ownerById(it.ownerId);
                return `<div class="tz-widget-row ${it.status}">
                  <span class="tz-w-name" title="${escAttr(it.title)}">${esc(it.title)}</span>
                  ${ow ? `<span class="tz-chip" style="background:${escAttr(ow.color)}">${esc(ow.name)}</span>` : ""}
                  <span class="tz-amt">${formatAmount(it.amount)}</span>
                </div>`;
              })
              .join("") +
            (more > 0 ? `<div class="tz-more">+${more} więcej</div>` : "")
          : `<div class="widget-empty">Nic na dziś ✨</div>`
      }
    </div>`;
    el.onclick = () => openCalendar("day", today);
  }

  function renderMonthWidget(el) {
    injectStyle();
    const today = todayStr();
    const d = parseDate(today);
    const y = d.getFullYear();
    const m = d.getMonth();
    const byDay = itemsByDay(
      mkDue(y, m, 1),
      mkDue(y, m, 31),
      confirmationMap(),
      obligations(),
    );
    const cells = miniMonthCells(y, m, byDay, {
      dayAttr: (due, dayItems) =>
        `data-day="${escAttr(due)}" title="${escAttr(
          dayItems.length
            ? `${fmtDate(due)} — ${dayItems.length} ${dayItems.length === 1 ? "pozycja" : "pozycji"}`
            : fmtDate(due),
        )}"`,
    });
    el.innerHTML = `<div class="tz-monthw">
      <div class="tz-monthw-head">${esc(capitalize(MONTHS[m]))} ${y}</div>
      <div class="tz-ygrid7">${cells}</div>
    </div>`;
    el.onclick = (e) => {
      // closest() idzie aż do korzenia dokumentu — ograniczamy do widgetu
      const cell = e.target.closest(".tz-ycell[data-day]");
      if (cell && el.contains(cell))
        openCalendar("day", cell.getAttribute("data-day"));
      else openCalendar("month", mkDue(y, m, 1));
    };
  }

  // ------------------------------------------------------------- suggestions (task 5/6)
  // Recurring payments an agent spotted elsewhere (bank statements). They are
  // proposals only — nothing lands in the register until the user accepts one.
  // Chunked like obl/conf: an agent parsing statements can append repeatedly,
  // and a single key is capped at 64KB by the host.
  function suggestions() {
    return partKeys(K_SUGG).flatMap((k) => cache[k] || []);
  }
  async function saveSuggestions(list) {
    await saveChunked(K_SUGG, list);
  }
  // Same charge parsed from two statement lines differs in case, spacing and
  // rounding — treat those as one finding instead of two rows.
  const suggKey = (name, amount) =>
    `${String(name).trim().toLowerCase().replace(/\s+/g, " ")}|${Number(amount || 0).toFixed(2)}`;

  // Free-text cycle from the agent ("monthly", "co miesiąc", "rocznie") plus
  // the last seen date is enough to prefill the form; the user corrects the rest.
  function cycleFromSuggestion(s) {
    const raw = String(s.cycle || "").toLowerCase();
    const seen = /^\d{4}-\d{2}-\d{2}$/.test(s.lastSeen || "")
      ? parseDate(s.lastSeen)
      : parseDate(todayStr());
    const day = seen.getDate();
    if (/\b(kwartal|kwartaln|quarter|quarterly)/.test(raw))
      return { type: "quarterly", day };
    if (/\b(rocz|roczn|year|yearly|annual)/.test(raw))
      return { type: "yearly", month: seen.getMonth(), day };
    // jeden miesiąc rat to wszystko, co da się wywnioskować z lastSeen —
    // resztę użytkownik zaznacza w formularzu
    if (/\b(raty|ratach|install|installments)/.test(raw))
      return { type: "installments", months: [seen.getMonth()], day };
    if (/\b(jednoraz|once|onetime|one-time)/.test(raw))
      return { type: "onetime", date: dateStr(seen) };
    return { type: "monthly", day };
  }

  // ------------------------------------------------------------- Google Calendar (2/3)
  // Każde wystąpienie z horyzontu 12 miesięcy ma odpowiadający mu event
  // całodniowy w wybranym kalendarzu. Mapowanie trzymamy u siebie, bo Google
  // nie wie nic o zobowiązaniach — zna tylko pojedyncze wydarzenia.
  const GCAL_HORIZON_MONTHS = 12;
  const GCAL_LOCAL = ""; // wartość pola „Kalendarz" dla pozycji tylko lokalnych
  const GCAL_NOTE = "Cyber Life · Terminarz";
  // Znacznik w opisie wydarzenia wiąże je z konkretnym zobowiązaniem. Dzięki
  // niemu stan uzgadniamy z Google, a nie z lokalną notatką, która może się
  // rozjechać (dwie instancje addonu, przerwany zapis, ręczne kasowanie).
  const gcalTag = (oblId) => `#terminarz:${oblId}`;
  const gcalNoteFor = (oblId) => `${GCAL_NOTE}\n${gcalTag(oblId)}`;
  let sharedCalendars = []; // [{id, label}] — puste, gdy Google niepodłączone

  function gcalMap() {
    return partKeys(K_GCAL).flatMap((k) => cache[k] || []);
  }
  async function saveGcalMap(list) {
    await saveChunked(K_GCAL, list);
  }
  function gcalErrors() {
    return cache[K_GERR] && typeof cache[K_GERR] === "object" ? cache[K_GERR] : {};
  }
  // Surowy błąd potrafi mieć pełny URL Google i pół strony tekstu — w dymku
  // przy pozycji liczy się przyczyna, nie ślad techniczny.
  function friendlyGcalError(message) {
    const msg = String(message || "");
    if (/connection lost|no such host|dial tcp|Failed to fetch|NetworkError|ECONNREFUSED|timeout/i.test(msg))
      return "Brak połączenia z Google — spróbuję ponownie przy następnym uruchomieniu";
    if (/401|invalid_grant|unauthorized/i.test(msg))
      return "Google odrzuciło autoryzację — podłącz konto ponownie w Ustawieniach";
    if (/403|insufficient|forbidden/i.test(msg))
      return "Brak uprawnień do tego kalendarza";
    if (/404|not found/i.test(msg))
      return "Kalendarz jest niedostępny — sprawdź udostępnienie w Ustawieniach";
    return msg.length > 160 ? msg.slice(0, 157) + "…" : msg;
  }

  async function setGcalError(oblId, message) {
    const errs = { ...gcalErrors() };
    if (message) errs[oblId] = friendlyGcalError(message);
    else delete errs[oblId];
    await put(K_GERR, errs);
  }

  // Lista udostępnionych kalendarzy; pusta także wtedy, gdy addon nie ma
  // uprawnienia albo Google nie jest podłączone — pole w formularzu wtedy nie
  // istnieje i wszystko działa jak przed 2/3.
  async function loadSharedCalendars() {
    try {
      const accounts = await cl.api("/api/calendar/accounts");
      sharedCalendars = (accounts || []).flatMap((acc) =>
        (acc.calendars || []).map((c) => ({
          id: c.id,
          label: `${acc.email} / ${c.name}`,
          name: c.name,
          color: c.color || "",
          readOnly: !!c.readOnly,
        })),
      );
    } catch (err) {
      sharedCalendars = [];
      cl.log("kalendarze Google niedostępne:", err && err.message ? err.message : err);
    }
    return sharedCalendars;
  }

  function calendarLabel(id) {
    const found = sharedCalendars.find((c) => c.id === id);
    return found ? found.label : id;
  }

  // Tytuł eventu; „✓ " dokleja się po potwierdzeniu wystąpienia
  function eventTitle(o, confirmed) {
    const ow = ownerById(o.ownerId);
    const who = ow ? ` (${ow.name})` : "";
    return `${confirmed ? "✓ " : ""}${o.name} — ${formatAmount(o.amount)}${who}`;
  }

  // Okno synchronizacji: horyzont w przód plus okres karencji wstecz. Bez
  // tego wystąpienie „do potwierdzenia" sprzed dwóch dni nie miałoby
  // odpowiednika w Google, a to właśnie te pozycje się potwierdza.
  function gcalWindow() {
    const today = todayStr();
    return [addDays(today, -GRACE_DAYS), addMonths(today, GCAL_HORIZON_MONTHS)];
  }

  function horizonOccurrences(o) {
    const [from, to] = gcalWindow();
    return occurrencesBetween(o.cycle, from, to);
  }

  // Doprowadza Google do stanu zgodnego z zobowiązaniem: tworzy brakujące
  // eventy, poprawia tytuły, kasuje nadmiarowe i przenosi je po zmianie
  // kalendarza. Błąd nie przerywa zapisu lokalnego — zostaje ślad w K_GERR.
  // Wydarzenia tego zobowiązania faktycznie obecne w kalendarzu, po dacie.
  // Duplikaty na ten sam dzień trafiają do listy „extra" do skasowania.
  async function existingEvents(calendarId, oblId, from, to) {
    const events = await cl.api(
      `/api/calendar/events?calendar=${encodeURIComponent(calendarId)}&from=${from}&to=${to}`,
    );
    const tag = gcalTag(oblId);
    const byDate = new Map();
    const extra = [];
    for (const ev of events || []) {
      if (!ev || !(ev.note || "").includes(tag)) continue;
      if (byDate.has(ev.start)) extra.push(ev);
      else byDate.set(ev.start, ev);
    }
    return { byDate, extra };
  }

  async function syncObligation(o) {
    if (!o) return;
    const target = o.calendarId || GCAL_LOCAL;
    const confMap = confirmationMap();
    const wanted = target ? horizonOccurrences(o) : [];
    const wantedSet = new Set(wanted);
    // Uzgadniamy z każdym kalendarzem, w którym mamy ślad tego zobowiązania,
    // żeby po zmianie kalendarza posprzątać także ten poprzedni.
    const touched = new Set(
      gcalMap()
        .filter((m) => m.k.startsWith(`${o.id}|`))
        .map((m) => m.calendar),
    );
    if (target) touched.add(target);
    if (!touched.size) {
      await setGcalError(o.id, "");
      return;
    }

    const [from, to] = gcalWindow();
    const fresh = [];
    try {
      for (const calId of touched) {
        const { byDate, extra } = await existingEvents(calId, o.id, from, to);
        // 1. skasuj duplikaty i wszystko, czego tu być nie powinno
        const doomed = [...extra];
        for (const [date, ev] of byDate) {
          if (calId !== target || !wantedSet.has(date)) doomed.push(ev);
        }
        for (const ev of doomed) {
          await cl.api("/api/calendar/events", {
            op: "delete",
            calendar: calId,
            event: ev.id,
          });
          byDate.delete(ev.start);
        }
        if (calId !== target) continue;

        // 2. popraw tytuły istniejących i utwórz brakujące
        for (const due of wanted) {
          const key = occKey(o.id, due);
          const title = eventTitle(o, !!confMap[key]);
          const ev = byDate.get(due);
          if (ev) {
            if (ev.title !== title) {
              await cl.api("/api/calendar/events", {
                op: "update",
                calendar: target,
                event: ev.id,
                title,
              });
            }
            fresh.push({ k: key, event: ev.id, calendar: target });
          } else {
            const created = await cl.api("/api/calendar/events", {
              calendar: target,
              title,
              date: due,
              note: gcalNoteFor(o.id),
            });
            if (created && created.id)
              fresh.push({ k: key, event: created.id, calendar: target });
          }
        }
      }
      // mapowanie odtwarzane ze stanu Google, nie doklejane do starego
      await replaceObligationMapping(o.id, fresh);
      await setGcalError(o.id, "");
    } catch (err) {
      const msg = err && err.message ? err.message : String(err);
      await replaceObligationMapping(o.id, fresh);
      await setGcalError(o.id, msg);
      cl.log(`sync z Google nieudany dla „${o.name}":`, msg);
    }
  }

  // Podmienia wpisy jednego zobowiązania, czytając mapę tuż przed zapisem,
  // żeby równoległy zapis innej pozycji nie został nadpisany.
  async function replaceObligationMapping(oblId, entries) {
    const rest = gcalMap().filter((m) => !m.k.startsWith(`${oblId}|`));
    await saveGcalMap([...rest, ...entries]);
  }

  // Usuwa wszystkie eventy zobowiązania (przy kasowaniu pozycji)
  async function dropGoogleEvents(oblId) {
    const calendars = new Set(
      gcalMap()
        .filter((m) => m.k.startsWith(`${oblId}|`))
        .map((m) => m.calendar),
    );
    if (!calendars.size) {
      await setGcalError(oblId, "");
      return;
    }
    const [from, to] = gcalWindow();
    try {
      for (const calId of calendars) {
        const { byDate, extra } = await existingEvents(calId, oblId, from, to);
        for (const ev of [...byDate.values(), ...extra]) {
          await cl.api("/api/calendar/events", {
            op: "delete",
            calendar: calId,
            event: ev.id,
          });
        }
      }
      await replaceObligationMapping(oblId, []);
      await setGcalError(oblId, "");
    } catch (err) {
      cl.log("usuwanie eventów Google nieudane:", err && err.message ? err.message : err);
    }
  }

  // Potwierdzenie i jego cofnięcie zmieniają tylko tytuł jednego eventu
  async function syncOccurrenceTitle(oblId, due) {
    const o = obligations().find((x) => x.id === oblId);
    if (!o || !o.calendarId) return;
    const entry = gcalMap().find((m) => m.k === occKey(oblId, due));
    if (!entry) return;
    try {
      await cl.api("/api/calendar/events", {
        op: "update",
        calendar: entry.calendar,
        event: entry.event,
        title: eventTitle(o, !!confirmationMap()[occKey(oblId, due)]),
      });
      await setGcalError(oblId, "");
    } catch (err) {
      await setGcalError(oblId, err && err.message ? err.message : String(err));
    }
  }

  // Ponowna próba dla pozycji, które nie zsynchronizowały się wcześniej —
  // wołana przy starcie addonu, żeby chwilowy brak sieci sam się naprawił.
  async function retryFailedSyncs() {
    const failed = Object.keys(gcalErrors());
    if (!failed.length || !sharedCalendars.length) return;
    for (const id of failed) {
      const o = obligations().find((x) => x.id === id);
      if (o) await syncObligation(o);
    }
  }

  // ------------------------------------------------------------- sync zwrotny (3/3)
  // Google jest właścicielem dat: przesunięcie wydarzenia w telefonie ma
  // przesunąć termin w Terminarzu, a nie odwrotnie. Cykl zostaje nietknięty —
  // przesunięcie zapamiętujemy jako wyjątek dla konkretnego wystąpienia.
  const POLL_INTERVAL_MS = 5 * 60 * 1000;
  let pollTimer = null;

  function shifts() {
    return cache[K_SHIFT] && typeof cache[K_SHIFT] === "object" ? cache[K_SHIFT] : {};
  }
  function goneEvents() {
    return cache[K_GONE] && typeof cache[K_GONE] === "object" ? cache[K_GONE] : {};
  }
  // Widocznością steruje lista ukrytych kalendarzy. Stary, globalny
  // przełącznik `showGoogle: false` czytamy jako „wszystkie ukryte", żeby
  // aktualizacja addonu nie odsłoniła nagle wydarzeń komuś, kto je wyłączył.
  function prefs() {
    const p = cache[K_PREFS] && typeof cache[K_PREFS] === "object" ? cache[K_PREFS] : {};
    return {
      hiddenCals: Array.isArray(p.hiddenCals)
        ? p.hiddenCals
        : p.showGoogle === false
          ? sharedCalendars.map((c) => c.id)
          : [],
    };
  }

  function calVisible(calendarId) {
    return !prefs().hiddenCals.includes(calendarId);
  }

  async function setCalVisible(calendarId, visible) {
    const hidden = prefs().hiddenCals.filter((id) => id !== calendarId);
    if (!visible) hidden.push(calendarId);
    await put(K_PREFS, { hiddenCals: hidden });
  }
  // Data, pod którą wystąpienie faktycznie żyje — po uwzględnieniu
  // przesunięcia zrobionego w Google.
  function effectiveDue(oblId, due) {
    return shifts()[occKey(oblId, due)] || due;
  }
  function isGone(oblId, due) {
    return !!goneEvents()[occKey(oblId, due)];
  }

  function externalCache() {
    const c = cache[K_EXT];
    return c && typeof c === "object" ? c : { at: "", items: [] };
  }

  // Obce wydarzenia: wszystko z udostępnionych kalendarzy poza tym, co samo
  // pochodzi z Terminarza. Trzymamy je w storage, żeby widoki działały też
  // bez sieci — wtedy pokazujemy ostatnio pobrane dane i czas pobrania.
  // Zwraca też rozbicie per kalendarz — okno „Synchronizuj" pokazuje, ile
  // czego zaciągnięto, żeby było widać, że coś się faktycznie wydarzyło.
  async function fetchExternalEvents() {
    if (!sharedCalendars.length) return { ...externalCache(), stats: [] };
    const [from, to] = gcalWindow();
    const items = [];
    const stats = [];
    for (const calRef of sharedCalendars) {
      try {
        const events = await cl.api(
          `/api/calendar/events?calendar=${encodeURIComponent(calRef.id)}&from=${from}&to=${to}`,
        );
        let ours = 0;
        let external = 0;
        for (const ev of events || []) {
          if ((ev.note || "").includes("#terminarz:")) {
            ours++;
            continue;
          }
          external++;
          items.push({
            id: ev.id,
            calendar: calRef.id,
            account: calRef.label,
            title: ev.title || "(bez tytułu)",
            start: ev.start,
            allDay: !!ev.allDay,
            // kolor własny wydarzenia, a w jego braku kolor kalendarza
            color: ev.color || calRef.color || "",
          });
        }
        stats.push({ label: calRef.label, ours, external, error: "" });
      } catch (err) {
        const msg = err && err.message ? err.message : String(err);
        cl.log("pobieranie obcych wydarzeń nieudane:", msg);
        stats.push({ label: calRef.label, ours: 0, external: 0, error: friendlyGcalError(msg) });
        return { ...externalCache(), stats, failed: true }; // zostaw ostatnie dobre dane
      }
    }
    const fresh = { at: new Date().toISOString(), items };
    await put(K_EXT, fresh);
    return { ...fresh, stats };
  }

  // Porównuje mapowanie z tym, co jest w Google: wykrywa przesunięcia dat
  // i skasowane wydarzenia.
  async function pullFromGoogle() {
    const map = gcalMap();
    if (!map.length) return false;
    const [from, to] = gcalWindow();
    const byCalendar = new Map();
    for (const m of map) {
      if (!byCalendar.has(m.calendar)) byCalendar.set(m.calendar, []);
      byCalendar.get(m.calendar).push(m);
    }
    const nextShifts = { ...shifts() };
    const nextGone = { ...goneEvents() };
    let changed = false;

    for (const [calId, entries] of byCalendar) {
      let events;
      try {
        events = await cl.api(
          `/api/calendar/events?calendar=${encodeURIComponent(calId)}&from=${from}&to=${to}`,
        );
      } catch (err) {
        cl.log("odczyt z Google nieudany:", err && err.message ? err.message : err);
        continue; // brak sieci nie może kasować wiedzy o wystąpieniach
      }
      const byId = new Map((events || []).map((e) => [e.id, e]));
      for (const entry of entries) {
        const [oblId, due] = [entry.k.split("|")[0], entry.k.split("|")[1]];
        const ev = byId.get(entry.event);
        if (!ev) {
          if (!nextGone[entry.k]) {
            nextGone[entry.k] = todayStr();
            changed = true;
          }
          continue;
        }
        if (nextGone[entry.k]) {
          delete nextGone[entry.k];
          changed = true;
        }
        // Google wygrywa dla dat
        const start = (ev.start || "").slice(0, 10);
        if (start && start !== effectiveDue(oblId, due)) {
          if (start === due) delete nextShifts[entry.k];
          else nextShifts[entry.k] = start;
          changed = true;
        }
      }
    }
    if (changed) {
      await put(K_SHIFT, nextShifts);
      await put(K_GONE, nextGone);
    }
    return changed;
  }

  // Jeden przebieg: zmiany z Google plus odświeżenie obcych wydarzeń
  async function pollGoogle() {
    if (!sharedCalendars.length) return;
    const changed = await pullFromGoogle();
    await fetchExternalEvents();
    if (oblEl) renderObligations(oblEl);
    if (calEl) renderCalendar(calEl);
    refreshWidgets();
    return changed;
  }

  // ------------------------------------------------------------- style
  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const s = document.createElement("style");
    s.id = STYLE_ID;
    s.textContent = `
      .tz-wrap{display:flex;flex-direction:column;height:100%;min-height:0;}
      .tz-bar{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 14px;border-bottom:1px solid var(--border,#45475a);}
      .tz-bar h2{margin:0;font-size:var(--fs-lg,16px);}
      .tz-body{flex:1;min-height:0;overflow-y:auto;padding:12px 14px;}
      .tz-btn{background:var(--accent,#89b4fa);color:var(--bg-primary,#1e1e2e);border:none;border-radius:8px;padding:8px 14px;font-weight:600;cursor:pointer;font:inherit;}
      .tz-btn.ghost{background:var(--bg-tertiary,#313244);color:var(--text-primary,#cdd6f4);border:1px solid var(--border,#45475a);}
      .tz-btn.danger{background:var(--error,#f38ba8);color:var(--bg-primary,#1e1e2e);}
      .tz-btn:disabled{opacity:.5;cursor:not-allowed;}
      .tz-empty{margin:48px auto;text-align:center;color:var(--text-muted,#9399b2);max-width:32em;display:flex;flex-direction:column;gap:12px;align-items:center;}
      table.tz-tbl{width:100%;border-collapse:collapse;font-size:var(--fs-base,14px);}
      .tz-tbl th{text-align:left;color:var(--text-muted,#9399b2);font-weight:600;padding:8px 10px;border-bottom:1px solid var(--border,#45475a);white-space:nowrap;}
      .tz-tbl td{padding:9px 10px;border-bottom:1px solid var(--border,#45475a);vertical-align:top;}
      .tz-tbl tr:hover td{background:var(--bg-secondary,#181825);}
      .tz-chip{display:inline-block;padding:2px 9px;border-radius:999px;font-size:12px;font-weight:600;color:#11111b;white-space:nowrap;}
      .tz-cat{color:var(--text-secondary,#bac2de);font-size:12px;}
      .tz-amt{white-space:nowrap;font-variant-numeric:tabular-nums;}
      .tz-actions{display:flex;gap:6px;justify-content:flex-end;}
      .tz-iconbtn{background:none;border:1px solid var(--border,#45475a);border-radius:6px;color:var(--text-secondary,#bac2de);cursor:pointer;padding:4px 8px;font:inherit;font-size:12px;}
      .tz-iconbtn:hover{color:var(--text-primary,#cdd6f4);}
      .tz-iconbtn.danger:hover{color:var(--error,#f38ba8);border-color:var(--error,#f38ba8);}
      .tz-modal-bg{position:fixed;inset:0;background:rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center;z-index:1000;padding:16px;}
      .tz-modal{background:var(--bg-primary,#1e1e2e);border:1px solid var(--border,#45475a);border-radius:14px;max-width:560px;width:100%;max-height:88vh;overflow-y:auto;padding:18px 20px;}
      .tz-modal h3{margin:0 0 12px;}
      .tz-field{display:flex;flex-direction:column;gap:4px;margin-bottom:10px;}
      .tz-field>span{font-size:12px;color:var(--text-secondary,#bac2de);}
      .tz-row2{display:grid;grid-template-columns:1fr 1fr;gap:10px;}
      .tz-input,.tz-select,.tz-ta{background:var(--bg-secondary,#181825);color:var(--text-primary,#cdd6f4);border:1px solid var(--border,#45475a);border-radius:8px;padding:8px 10px;font:inherit;font-size:var(--fs-base,14px);width:100%;box-sizing:border-box;}
      .tz-ta{resize:vertical;min-height:52px;}
      .tz-months{display:grid;grid-template-columns:repeat(3,1fr);gap:4px 10px;margin-top:4px;}
      .tz-months label{display:flex;align-items:center;gap:6px;font-size:13px;cursor:pointer;}
      .tz-err{color:var(--error,#f38ba8);font-size:12px;margin-top:2px;}
      .tz-note{color:var(--success,#a6e3a1);font-size:12px;margin-top:2px;}
      .tz-sync-status{color:var(--text-secondary,#bac2de);font-size:13px;margin-bottom:10px;}
      .tz-sync-err{color:var(--error,#f38ba8);}
      .tz-sync-tbl td{font-size:13px;}
      .tz-modal-actions{display:flex;gap:8px;justify-content:flex-end;margin-top:16px;}
      .tz-hint{color:var(--text-muted,#9399b2);font-size:12px;}
      .tz-owner-row{display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid var(--border,#45475a);}
      .tz-swatch{width:16px;height:16px;border-radius:4px;flex-shrink:0;}
      .tz-soon{margin:60px auto;text-align:center;color:var(--text-muted,#9399b2);}
      /* period statuses — row tints follow ksefad-row-* from the KSeF addon */
      .tz-row-due td{background:rgba(249,226,175,.08);}
      .tz-row-missed td{background:rgba(243,139,168,.10);}
      .tz-status{font-size:12px;font-weight:600;white-space:nowrap;}
      .tz-status.upcoming{color:var(--text-secondary,#bac2de);}
      .tz-status.due{color:#f9e2af;}
      .tz-status.missed{color:var(--error,#f38ba8);}
      .tz-status.confirmed{color:var(--success,#a6e3a1);}
      .tz-due-cell{white-space:nowrap;}
      .tz-confirm-btn{margin-top:4px;}
      .tz-badge{display:inline-block;margin-left:8px;padding:1px 8px;border:1px solid var(--error,#f38ba8);color:var(--error,#f38ba8);border-radius:999px;font-size:11px;white-space:nowrap;vertical-align:1px;}
      .tz-hist td{background:var(--bg-secondary,#181825);padding:6px 10px 12px;}
      .tz-hist-tbl{width:100%;border-collapse:collapse;font-size:13px;}
      .tz-hist-tbl th{text-align:left;color:var(--text-muted,#9399b2);font-weight:600;padding:4px 8px;border-bottom:1px solid var(--border,#45475a);}
      .tz-hist-tbl td{padding:4px 8px;border-bottom:none;background:none;}
      .tz-hist-title{font-size:12px;color:var(--text-muted,#9399b2);margin:4px 0 6px;}
      .tz-expand-hint{cursor:pointer;}
      /* calendar (3/6) */
      .tz-cal-bar{display:flex;align-items:center;gap:10px;flex-wrap:wrap;}
      .tz-cal-title{font-size:var(--fs-lg,16px);font-weight:700;min-width:12em;}
      .tz-cal-nav{display:flex;gap:4px;}
      .tz-cal-actions{display:flex;gap:6px;margin-left:auto;}
      .tz-cal-actions .tz-btn{padding:5px 12px;font-size:13px;font-weight:500;}
      .tz-cal-views{display:flex;gap:2px;background:var(--bg-tertiary,#313244);border:1px solid var(--border,#45475a);border-radius:8px;padding:2px;}
      .tz-cal-views button{background:none;border:none;border-radius:6px;padding:5px 12px;color:var(--text-secondary,#bac2de);cursor:pointer;font:inherit;font-size:13px;}
      .tz-cal-views button.active{background:var(--accent,#89b4fa);color:var(--bg-primary,#1e1e2e);font-weight:600;}
      .tz-cal-filters{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:8px 14px;border-bottom:1px solid var(--border,#45475a);}
      .tz-fchip{border:1px solid var(--border,#45475a);background:none;border-radius:999px;padding:3px 11px;font:inherit;font-size:12px;font-weight:600;color:var(--text-secondary,#bac2de);cursor:pointer;}
      .tz-fchip.active{color:#11111b;border-color:transparent;}
      .tz-cal-sums{padding:8px 14px;border-bottom:1px solid var(--border,#45475a);color:var(--text-secondary,#bac2de);font-size:13px;}
      .tz-cal-sums b{color:var(--text-primary,#cdd6f4);}
      .tz-mgrid{display:grid;grid-template-columns:repeat(7,1fr);gap:4px;}
      .tz-mgrid-head{color:var(--text-muted,#9399b2);font-size:11px;font-weight:600;text-align:center;padding:2px 0;text-transform:uppercase;}
      .tz-mcell{border:1px solid var(--border,#45475a);border-radius:8px;min-height:84px;padding:4px;display:flex;flex-direction:column;gap:2px;cursor:pointer;min-width:0;}
      .tz-mcell:hover{background:var(--bg-secondary,#181825);}
      .tz-mcell.blank{border-color:transparent;cursor:default;}
      .tz-mcell.blank:hover{background:none;}
      .tz-dnum{font-size:12px;color:var(--text-muted,#9399b2);align-self:flex-start;padding:1px 6px;border-radius:999px;}
      .tz-dnum.today{background:var(--accent,#89b4fa);color:var(--bg-primary,#1e1e2e);font-weight:700;}
      .tz-pill{font-size:11px;border-radius:5px;padding:1px 5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--text-primary,#cdd6f4);background:var(--bg-tertiary,#313244);}
      .tz-pill.due{background:rgba(249,226,175,.18);}
      .tz-pill.missed{background:rgba(243,139,168,.22);}
      .tz-pill.confirmed{background:rgba(166,227,161,.16);}
      .tz-more{font-size:11px;color:var(--text-muted,#9399b2);}
      .tz-day-row{display:flex;align-items:center;gap:12px;padding:10px 4px;border-bottom:1px solid var(--border,#45475a);}
      .tz-ygrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:12px;}
      .tz-ymonth{border:1px solid var(--border,#45475a);border-radius:10px;padding:8px;cursor:pointer;}
      .tz-ymonth:hover{background:var(--bg-secondary,#181825);}
      .tz-ymonth h4{margin:0 0 6px;font-size:13px;text-transform:capitalize;}
      .tz-ygrid7{display:grid;grid-template-columns:repeat(7,1fr);gap:2px;}
      .tz-ycell{height:14px;display:flex;align-items:center;justify-content:center;font-size:9px;color:var(--text-muted,#9399b2);}
      .tz-ycell .dot{width:6px;height:6px;border-radius:50%;background:var(--accent,#89b4fa);}
      .tz-ycell .dot.missed{background:var(--error,#f38ba8);}
      .tz-ycell.today{outline:1px solid var(--accent,#89b4fa);border-radius:3px;}
      .tz-ysum{margin-top:6px;font-size:12px;color:var(--text-secondary,#bac2de);}
      /* widget (4/6) */
      .tz-widget{display:flex;flex-direction:column;gap:3px;}
      .tz-widget-row{display:flex;align-items:center;gap:6px;font-size:12px;min-width:0;}
      .tz-widget-row.missed .tz-w-date,.tz-widget-row.missed .tz-w-name{color:var(--error,#f38ba8);}
      .tz-widget-row.due .tz-w-date{color:#f9e2af;}
      .tz-w-date{font-variant-numeric:tabular-nums;color:var(--text-muted,#9399b2);white-space:nowrap;}
      .tz-w-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
      .tz-widget-row .tz-chip{font-size:10px;padding:1px 6px;}
      /* suggestions bar (5/6) */
      .tz-sugg{border-bottom:1px solid var(--border,#45475a);background:var(--bg-secondary,#181825);padding:8px 14px;}
      .tz-sugg-head{font-size:13px;font-weight:600;margin-bottom:6px;color:var(--text-primary,#cdd6f4);}
      .tz-sugg-row{display:flex;align-items:center;gap:10px;padding:4px 0;font-size:13px;}
      .tz-sugg-name{font-weight:600;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
      .tz-sugg-actions{margin-left:auto;display:flex;gap:6px;}
      .tz-gmark{font-size:12px;opacity:.75;cursor:help;}
      /* obce wydarzenia z Google (3/3) — przygaszone i tylko do odczytu */
      .tz-ext{opacity:.62;}
      .tz-pill.ext{background:var(--bg-secondary,#181825);color:var(--text-secondary,#bac2de);opacity:.85;font-style:italic;border-left:3px solid var(--accent,#89b4fa);}
      .tz-cdot{display:inline-block;width:9px;height:9px;border-radius:50%;flex:none;}
      .tz-swatch{display:inline-block;width:10px;height:10px;border-radius:3px;flex:none;}
      .tz-calchk{display:inline-flex;align-items:center;gap:6px;font-size:12px;white-space:nowrap;}
      .tz-wgrid{display:grid;grid-template-columns:repeat(7,1fr);gap:6px;}
      .tz-wcell{border:1px solid var(--border,#45475a);border-radius:8px;min-height:180px;padding:6px;display:flex;flex-direction:column;gap:3px;cursor:pointer;min-width:0;}
      .tz-wcell:hover{background:var(--bg-secondary,#181825);}
      .tz-whead{display:flex;align-items:center;justify-content:space-between;gap:4px;color:var(--text-muted,#9399b2);font-size:11px;font-weight:600;text-transform:uppercase;}
      .tz-cal-foot{padding:6px 14px;border-top:1px solid var(--border,#45475a);color:var(--text-muted,#9399b2);font-size:11px;}
      .tz-gmark.warn{color:var(--error,#f38ba8);opacity:1;}
      /* widgets Dzisiaj / Miesiąc (6/6) */
      .tz-ycell .dot.due{background:#f9e2af;}
      .tz-today{display:flex;flex-direction:column;gap:4px;}
      .tz-today-date{font-size:14px;font-weight:700;text-transform:capitalize;margin-bottom:2px;}
      .tz-today .tz-widget-row{gap:6px;}
      .tz-monthw{display:flex;flex-direction:column;gap:6px;cursor:pointer;}
      .tz-monthw-head{font-size:12px;font-weight:600;color:var(--text-secondary,#bac2de);text-transform:capitalize;}
      .tz-monthw .tz-ycell{height:18px;font-size:10px;border-radius:3px;}
      .tz-monthw .tz-ycell[data-day]:hover{background:var(--bg-tertiary,#313244);}
    `;
    document.head.appendChild(s);
  }

  // ------------------------------------------------------------- form modal
  function openForm(existing, afterSave) {
    injectStyle();
    // A prefill (from an agent suggestion) comes in without an id — that is a
    // new obligation with fields filled in, not an edit.
    const editing = !!(existing && existing.id);
    // working copy
    const f = existing
      ? JSON.parse(JSON.stringify(existing))
      : {
          id: "",
          name: "",
          category: "other",
          ownerId: owners()[0] ? owners()[0].id : "",
          calendarId: GCAL_LOCAL,
          amount: "",
          tolerancePct: 10,
          cycle: { type: "monthly", day: 1 },
          statementPattern: "",
          contractEnd: "",
          note: "",
        };

    const bg = document.createElement("div");
    bg.className = "tz-modal-bg";
    const modal = document.createElement("div");
    modal.className = "tz-modal";
    bg.appendChild(modal);

    function close() {
      bg.remove();
      document.removeEventListener("keydown", onEsc);
    }
    function onEsc(e) {
      if (e.key === "Escape") {
        e.stopPropagation();
        close();
      }
    }
    bg.addEventListener("click", (e) => {
      if (e.target === bg) close();
    });
    modal.addEventListener("click", (e) => e.stopPropagation());
    document.addEventListener("keydown", onEsc);

    function cycleFields() {
      const c = f.cycle;
      const dayInput = (val) =>
        `<label class="tz-field"><span>Dzień miesiąca (1–31)</span><input class="tz-input" id="f-day" type="number" min="1" max="31" value="${escAttr(val ?? 1)}"><div class="tz-err" id="err-day" style="display:none"></div></label>`;
      if (c.type === "monthly") return dayInput(c.day);
      if (c.type === "quarterly") return dayInput(c.day);
      if (c.type === "yearly")
        return `<div class="tz-row2">
            <label class="tz-field"><span>Miesiąc</span><select class="tz-select" id="f-month">${MONTHS.map((m, i) => `<option value="${i}" ${i === (c.month ?? 0) ? "selected" : ""}>${esc(m)}</option>`).join("")}</select></label>
            ${dayInput(c.day)}
          </div>`;
      if (c.type === "installments")
        return `<div class="tz-field"><span>Miesiące rat</span>
            <div class="tz-months">${MONTHS.map((m, i) => `<label><input type="checkbox" class="f-instm" value="${i}" ${(c.months || []).includes(i) ? "checked" : ""}> ${esc(m)}</label>`).join("")}</div>
            <div class="tz-err" id="err-months" style="display:none"></div>
          </div>
          ${dayInput(c.day)}`;
      if (c.type === "onetime")
        // type="text" (nie "date"): WebKit2GTK na Linuksie nie ma pickera dla
        // input[type=date]/[month] — klik nic nie robi. Tekst RRRR-MM-DD działa
        // na obu platformach.
        return `<label class="tz-field"><span>Data *</span><input class="tz-input" id="f-date" type="text" inputmode="numeric" placeholder="RRRR-MM-DD" value="${escAttr(c.date || "")}"><div class="tz-err" id="err-date" style="display:none"></div></label>`;
      return "";
    }

    function render() {
      modal.innerHTML = `
        <h3>${editing ? "Edytuj zobowiązanie" : "Nowe zobowiązanie"}</h3>
        <label class="tz-field"><span>Nazwa *</span>
          <input class="tz-input" id="f-name" type="text" maxlength="120" value="${escAttr(f.name)}" placeholder="np. Leasing Stellantis">
          <div class="tz-err" id="err-name" style="display:none"></div>
        </label>
        <div class="tz-row2">
          <label class="tz-field"><span>Kategoria</span>
            <select class="tz-select" id="f-cat">${CATEGORIES.map((c) => `<option value="${c.id}" ${c.id === f.category ? "selected" : ""}>${esc(c.label)}</option>`).join("")}</select>
          </label>
          <label class="tz-field"><span>Właściciel</span>
            <select class="tz-select" id="f-owner">${owners()
              .map(
                (o) =>
                  `<option value="${escAttr(o.id)}" ${o.id === f.ownerId ? "selected" : ""}>${esc(o.name)}</option>`,
              )
              .join("")}</select>
          </label>
        </div>
        ${
          sharedCalendars.length
            ? `<label class="tz-field"><span>Kalendarz</span>
                <select class="tz-select" id="f-calendar">
                  <option value="">Lokalny (Cyber Life)</option>
                  ${sharedCalendars
                    .filter((c) => !c.readOnly || c.id === f.calendarId)
                    .map(
                      (c) =>
                        `<option value="${escAttr(c.id)}" ${c.id === f.calendarId ? "selected" : ""}>${esc(c.label)}</option>`,
                    )
                    .join("")}
                </select>
                <div class="tz-hint">Wystąpienia z najbliższych 12 miesięcy trafią do wybranego kalendarza Google.</div>
              </label>`
            : ""
        }
        <div class="tz-row2">
          <label class="tz-field"><span>Kwota (zł) *</span>
            <input class="tz-input" id="f-amount" type="number" step="0.01" min="0" value="${escAttr(f.amount)}" placeholder="0.00">
            <div class="tz-err" id="err-amount" style="display:none"></div>
          </label>
          <label class="tz-field"><span>Tolerancja (%)</span>
            <input class="tz-input" id="f-tol" type="number" min="0" max="100" value="${escAttr(f.tolerancePct ?? 10)}">
          </label>
        </div>
        <label class="tz-field"><span>Cykl</span>
          <select class="tz-select" id="f-cycle">
            <option value="monthly" ${f.cycle.type === "monthly" ? "selected" : ""}>Miesięczny</option>
            <option value="quarterly" ${f.cycle.type === "quarterly" ? "selected" : ""}>Kwartalny</option>
            <option value="yearly" ${f.cycle.type === "yearly" ? "selected" : ""}>Roczny</option>
            <option value="installments" ${f.cycle.type === "installments" ? "selected" : ""}>Raty w wybranych miesiącach</option>
            <option value="onetime" ${f.cycle.type === "onetime" ? "selected" : ""}>Jednorazowy</option>
          </select>
        </label>
        <div id="cycle-fields">${cycleFields()}</div>
        <label class="tz-field"><span>Wzorzec z wyciągu (opcjonalnie)</span>
          <input class="tz-input" id="f-pattern" type="text" maxlength="200" value="${escAttr(f.statementPattern || "")}" placeholder="fragment tytułu przelewu">
        </label>
        <div class="tz-row2">
          <label class="tz-field"><span>Koniec umowy (opcjonalnie)</span>
            <input class="tz-input" id="f-end" type="text" inputmode="numeric" placeholder="RRRR-MM (np. 2027-01)" value="${escAttr(f.contractEnd || "")}">
            <div class="tz-err" id="err-end" style="display:none"></div>
          </label>
        </div>
        <label class="tz-field"><span>Notatka (opcjonalnie)</span>
          <textarea class="tz-ta" id="f-note" maxlength="2000">${esc(f.note || "")}</textarea>
        </label>
        <div class="tz-modal-actions">
          <button class="tz-btn ghost" id="f-cancel">Anuluj</button>
          <button class="tz-btn" id="f-save">${editing ? "Zapisz zmiany" : "Dodaj"}</button>
        </div>`;

      // sync working copy on input so cycle switch keeps entered values
      const bind = (id, fn) => {
        const el = modal.querySelector(id);
        if (el) el.addEventListener("input", fn);
      };
      bind("#f-name", (e) => (f.name = e.target.value));
      bind("#f-cat", (e) => (f.category = e.target.value));
      bind("#f-owner", (e) => (f.ownerId = e.target.value));
      bind("#f-calendar", (e) => (f.calendarId = e.target.value));
      bind("#f-amount", (e) => (f.amount = e.target.value));
      bind("#f-tol", (e) => (f.tolerancePct = e.target.value));
      bind("#f-pattern", (e) => (f.statementPattern = e.target.value));
      bind("#f-end", (e) => (f.contractEnd = e.target.value));
      bind("#f-note", (e) => (f.note = e.target.value));

      modal.querySelector("#f-cycle").addEventListener("change", (e) => {
        captureCycle();
        const t = e.target.value;
        if (t === "monthly" || t === "quarterly")
          f.cycle = { type: t, day: f.cycle.day || 1 };
        else if (t === "yearly")
          f.cycle = {
            type: t,
            month: f.cycle.month || 0,
            day: f.cycle.day || 1,
          };
        else if (t === "installments")
          f.cycle = {
            type: t,
            months: f.cycle.months || [],
            day: f.cycle.day || 1,
          };
        else f.cycle = { type: "onetime", date: f.cycle.date || "" };
        modal.querySelector("#cycle-fields").innerHTML = cycleFields();
        wireCycleFields();
      });
      wireCycleFields();

      modal.querySelector("#f-cancel").addEventListener("click", close);
      modal.querySelector("#f-save").addEventListener("click", onSave);
      modal.querySelector("#f-name").focus();
    }

    function wireCycleFields() {
      const day = modal.querySelector("#f-day");
      if (day)
        day.addEventListener(
          "input",
          (e) => (f.cycle.day = Number(e.target.value)),
        );
      const month = modal.querySelector("#f-month");
      if (month)
        month.addEventListener(
          "change",
          (e) => (f.cycle.month = Number(e.target.value)),
        );
      const date = modal.querySelector("#f-date");
      if (date)
        date.addEventListener("input", (e) => (f.cycle.date = e.target.value));
      modal
        .querySelectorAll(".f-instm")
        .forEach((cb) => cb.addEventListener("change", captureCycle));
    }
    function captureCycle() {
      const day = modal.querySelector("#f-day");
      if (day) f.cycle.day = Number(day.value);
      const month = modal.querySelector("#f-month");
      if (month) f.cycle.month = Number(month.value);
      const date = modal.querySelector("#f-date");
      if (date) f.cycle.date = date.value;
      const boxes = modal.querySelectorAll(".f-instm");
      if (boxes.length)
        f.cycle.months = Array.from(boxes)
          .filter((b) => b.checked)
          .map((b) => Number(b.value));
    }

    function showErr(id, msg) {
      const el = modal.querySelector(id);
      if (el) {
        el.textContent = msg;
        el.style.display = "";
      }
    }
    function clearErrs() {
      modal
        .querySelectorAll(".tz-err")
        .forEach((e) => (e.style.display = "none"));
    }

    let saving = false;
    async function onSave() {
      if (saving) return; // klik w trakcie zapisu nie może zapisać drugi raz
      captureCycle();
      clearErrs();
      let ok = true;
      if (!f.name || !f.name.trim()) {
        showErr("#err-name", "Podaj nazwę zobowiązania");
        ok = false;
      }
      const amt = Number(f.amount);
      if (!(amt > 0)) {
        showErr("#err-amount", "Kwota musi być większa od zera");
        ok = false;
      }
      if (
        f.cycle.type === "installments" &&
        (!f.cycle.months || f.cycle.months.length === 0)
      ) {
        showErr("#err-months", "Zaznacz co najmniej jeden miesiąc rat");
        ok = false;
      }
      if (f.cycle.type !== "onetime") {
        // pusty input → Number("") === 0 → new Date(y, m, 0) cofa termin
        // o miesiąc; bez tej walidacji zapis przesunąłby wszystkie terminy
        const d = Number(f.cycle.day);
        if (!Number.isInteger(d) || d < 1 || d > 31) {
          showErr("#err-day", "Dzień miesiąca musi być liczbą od 1 do 31");
          ok = false;
        }
      }
      const endVal = (f.contractEnd || "").trim();
      if (endVal && !/^\d{4}-(0[1-9]|1[0-2])$/.test(endVal)) {
        showErr("#err-end", "Format: RRRR-MM (np. 2027-01)");
        ok = false;
      }
      if (f.cycle.type === "onetime") {
        const dv = (f.cycle.date || "").trim();
        if (!/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(dv)) {
          showErr("#err-date", "Podaj datę w formacie RRRR-MM-DD");
          ok = false;
        }
      }
      if (!ok) return;

      const rec = {
        id: f.id || newId(),
        createdAt: f.createdAt || todayStr(),
        name: f.name.trim(),
        category: f.category,
        ownerId: f.ownerId,
        calendarId: f.calendarId || GCAL_LOCAL,
        amount: amt,
        tolerancePct: Number(f.tolerancePct) || 0,
        cycle: f.cycle,
        statementPattern: (f.statementPattern || "").trim(),
        contractEnd: (f.contractEnd || "").trim(),
        note: (f.note || "").trim(),
      };
      saving = true;
      const saveBtn = modal.querySelector("#f-save");
      if (saveBtn) {
        saveBtn.disabled = true;
        saveBtn.textContent = "Zapisywanie…";
      }
      try {
        await upsertObligation(rec);
      } finally {
        saving = false;
      }
      close();
      if (afterSave) afterSave();
    }

    render();
    document.body.appendChild(bg);

    // Kalendarz mógł zostać udostępniony w Ustawieniach już po starcie
    // addonu — odświeżamy listę i przerysowujemy pole, jeśli się zmieniła.
    const before = sharedCalendars.map((c) => c.id).join("|");
    loadSharedCalendars()
      .then((list) => {
        if (list.map((c) => c.id).join("|") !== before && bg.isConnected) render();
      })
      .catch(() => {});
  }

  // ------------------------------------------------------------- confirm
  function confirmDialog(
    message,
    onYes,
    { danger = true, yesLabel = "Usuń" } = {},
  ) {
    injectStyle();
    const bg = document.createElement("div");
    bg.className = "tz-modal-bg";
    bg.innerHTML = `
      <div class="tz-modal" style="max-width:420px">
        <p style="margin:0 0 16px">${esc(message)}</p>
        <div class="tz-modal-actions">
          <button class="tz-btn ghost" id="c-no">Anuluj</button>
          <button class="tz-btn ${danger ? "danger" : ""}" id="c-yes">${esc(yesLabel)}</button>
        </div>
      </div>`;
    const modal = bg.querySelector(".tz-modal");
    modal.addEventListener("click", (e) => e.stopPropagation());
    const close = () => {
      bg.remove();
      document.removeEventListener("keydown", onEsc);
    };
    const onEsc = (e) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        close();
      }
    };
    bg.addEventListener("click", (e) => {
      if (e.target === bg) close();
    });
    document.addEventListener("keydown", onEsc);
    bg.querySelector("#c-no").addEventListener("click", close);
    bg.querySelector("#c-yes").addEventListener("click", () => {
      close();
      onYes();
    });
    document.body.appendChild(bg);
  }

  // Wspólna skorupa okna modalnego: Esc, klik w tło, brak propagacji kliknięć.
  function modalShell(innerHTML, width = "460px") {
    injectStyle();
    const bg = document.createElement("div");
    bg.className = "tz-modal-bg";
    bg.innerHTML = `<div class="tz-modal" style="max-width:${width}">${innerHTML}</div>`;
    const modal = bg.querySelector(".tz-modal");
    modal.addEventListener("click", (e) => e.stopPropagation());
    const onEsc = (e) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        close();
      }
    };
    const close = () => {
      bg.remove();
      document.removeEventListener("keydown", onEsc);
    };
    bg.addEventListener("click", (e) => {
      if (e.target === bg) close();
    });
    document.addEventListener("keydown", onEsc);
    document.body.appendChild(bg);
    return { bg, modal, close };
  }

  // ------------------------------------------------------------- ręczna synchronizacja
  // To samo, co robi automatyczny poll, tylko na żądanie i ze statystykami
  // per kalendarz — bez tego nie widać, czy klik cokolwiek zrobił.
  async function runManualSync() {
    const changed = await pullFromGoogle();
    const res = await fetchExternalEvents();
    if (oblEl) renderObligations(oblEl);
    if (calEl) renderCalendar(calEl);
    refreshWidgets();
    return { changed, stats: res.stats || [], failed: !!res.failed, at: res.at || "" };
  }

  function syncRowsHtml(stats) {
    return stats
      .map(
        (st) => `<tr>
          <td>${esc(st.label)}</td>
          ${
            st.error
              ? `<td colspan="2" class="tz-sync-err">${esc(st.error)}</td>`
              : `<td class="tz-amt">${st.external}</td><td class="tz-amt">${st.ours}</td>`
          }
        </tr>`,
      )
      .join("");
  }

  function openSyncDialog() {
    const { bg, close } = modalShell(
      `<h3>Synchronizacja z Google</h3>
       <div class="tz-sync-status" id="s-status">Pobieram zmiany…</div>
       <table class="tz-tbl tz-sync-tbl">
         <thead><tr><th>Kalendarz</th><th>Wydarzenia</th><th>Z Terminarza</th></tr></thead>
         <tbody id="s-rows">${sharedCalendars
           .map((c) => `<tr><td>${esc(c.label)}</td><td colspan="2" class="tz-cat">…</td></tr>`)
           .join("")}</tbody>
       </table>
       <div class="tz-cal-foot" id="s-foot" style="border:none;padding:8px 0 0"></div>
       <div class="tz-modal-actions">
         <button class="tz-btn ghost" id="s-again" disabled>Synchronizuj ponownie</button>
         <button class="tz-btn" id="s-close">Zamknij</button>
       </div>`,
      "520px",
    );
    const statusEl = bg.querySelector("#s-status");
    const rowsEl = bg.querySelector("#s-rows");
    const footEl = bg.querySelector("#s-foot");
    const againBtn = bg.querySelector("#s-again");
    bg.querySelector("#s-close").addEventListener("click", close);

    const run = async () => {
      againBtn.disabled = true;
      statusEl.textContent = "Pobieram zmiany…";
      let res;
      try {
        res = await runManualSync();
      } catch (err) {
        statusEl.textContent = friendlyGcalError(err && err.message ? err.message : String(err));
        statusEl.className = "tz-sync-status tz-sync-err";
        againBtn.disabled = false;
        return;
      }
      // Modal żyje poza kontenerem strony, ale renderCalendar mógł go już
      // przerysować — sprawdzamy, czy okno wciąż jest w DOM.
      if (!bg.isConnected) return;
      rowsEl.innerHTML = syncRowsHtml(res.stats);
      statusEl.className = "tz-sync-status" + (res.failed ? " tz-sync-err" : "");
      statusEl.textContent = res.failed
        ? "Synchronizacja nieudana — pokazuję ostatnie pobrane dane."
        : res.changed
          ? "Gotowe. Zmiany z Google zostały wczytane."
          : "Gotowe. Brak zmian po stronie Google.";
      footEl.textContent = res.at ? `Pobrano: ${fmtSyncTime(res.at)}` : "";
      againBtn.disabled = false;
    };
    run();
    againBtn.addEventListener("click", run);
  }

  // ------------------------------------------------------------- zwykłe wydarzenie Google
  // Google chce pełnego RFC3339 ze strefą — budujemy je z lokalnej daty
  // i godziny, żeby wydarzenie wpadło o tej porze, którą widzi użytkownik.
  function rfc3339Local(dateStr, timeStr) {
    const [y, m, d] = dateStr.split("-").map(Number);
    const [hh, mm] = timeStr.split(":").map(Number);
    const off = -new Date(y, m - 1, d, hh, mm).getTimezoneOffset();
    const pad = (n) => String(Math.abs(Math.trunc(n))).padStart(2, "0");
    return `${dateStr}T${pad(hh)}:${pad(mm)}:00${off >= 0 ? "+" : "-"}${pad(off / 60)}:${pad(off % 60)}`;
  }

  const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

  function openExternalEvent(defaultDate, afterSave) {
    const { bg, close } = modalShell(
      `<h3>Nowe wydarzenie</h3>
       <label class="tz-field"><span>Kalendarz *</span>
         <select class="tz-select" id="e-cal">
           ${sharedCalendars.map((c) => `<option value="${escAttr(c.id)}">${esc(c.label)}</option>`).join("")}
         </select>
       </label>
       <label class="tz-field"><span>Tytuł *</span>
         <input class="tz-input" id="e-title" type="text" maxlength="200" placeholder="np. Spotkanie z księgową">
       </label>
       <label class="tz-field"><span>Data *</span>
         <input class="tz-input" id="e-date" type="text" inputmode="numeric" placeholder="RRRR-MM-DD" value="${escAttr(defaultDate || todayStr())}">
       </label>
       <div class="tz-row2">
         <label class="tz-field"><span>Godzina od</span>
           <input class="tz-input" id="e-from" type="text" placeholder="HH:MM (puste = cały dzień)">
         </label>
         <label class="tz-field"><span>Godzina do</span>
           <input class="tz-input" id="e-to" type="text" placeholder="HH:MM">
         </label>
       </div>
       <label class="tz-field"><span>Notatka</span>
         <textarea class="tz-input" id="e-note" rows="2" maxlength="500"></textarea>
       </label>
       <div class="tz-err" id="e-err" style="display:none"></div>
       <div class="tz-modal-actions">
         <button class="tz-btn ghost" id="e-cancel">Anuluj</button>
         <button class="tz-btn" id="e-save">Zapisz w Google</button>
       </div>`,
    );
    const errEl = bg.querySelector("#e-err");
    const saveBtn = bg.querySelector("#e-save");
    bg.querySelector("#e-cancel").addEventListener("click", close);
    const fail = (msg) => {
      errEl.textContent = msg;
      errEl.style.display = "";
      saveBtn.disabled = false;
      saveBtn.textContent = "Zapisz w Google";
    };

    saveBtn.addEventListener("click", async () => {
      if (saveBtn.disabled) return;
      errEl.style.display = "none";
      const calId = bg.querySelector("#e-cal").value;
      const title = bg.querySelector("#e-title").value.trim();
      const date = bg.querySelector("#e-date").value.trim();
      const from = bg.querySelector("#e-from").value.trim();
      const to = bg.querySelector("#e-to").value.trim();
      const note = bg.querySelector("#e-note").value.trim();
      if (!title) return fail("Podaj tytuł wydarzenia");
      if (!/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(date))
        return fail("Podaj datę w formacie RRRR-MM-DD");
      if (from && !TIME_RE.test(from)) return fail("Godzina od: format HH:MM");
      if (to && !TIME_RE.test(to)) return fail("Godzina do: format HH:MM");
      if (to && !from) return fail("Podaj godzinę początku albo zostaw obie puste");
      if (from && to && to <= from) return fail("Godzina do musi być późniejsza niż od");

      const body = { op: "create", calendar: calId, title, note };
      if (from) {
        body.start = rfc3339Local(date, from);
        if (to) body.end = rfc3339Local(date, to);
      } else {
        body.date = date;
      }
      saveBtn.disabled = true;
      saveBtn.textContent = "Zapisywanie…";
      try {
        await cl.api("/api/calendar/events", body);
      } catch (err) {
        return fail(friendlyGcalError(err && err.message ? err.message : String(err)));
      }
      // Bez tego świeżo dodane wydarzenie nie pojawiłoby się w widokach,
      // gdy jego kalendarz jest odznaczony — wygląda jak zgubiony zapis.
      if (!calVisible(calId)) await setCalVisible(calId, true);
      await fetchExternalEvents();
      if (afterSave) afterSave();
      const [winFrom, winTo] = gcalWindow();
      if (date >= winFrom && date <= winTo) {
        close();
        return;
      }
      // Poza oknem synchronizacji wydarzenie istnieje w Google, ale nie
      // pojawi się w widokach — inaczej zapis wyglądałby na nieudany.
      errEl.className = "tz-note";
      errEl.textContent =
        "Zapisano w Google. Data wykracza poza zakres synchronizacji, więc wydarzenie nie pojawi się w kalendarzu Terminarza.";
      errEl.style.display = "";
      const actions = bg.querySelector(".tz-modal-actions");
      actions.innerHTML = `<button class="tz-btn" id="e-ok">Zamknij</button>`;
      actions.querySelector("#e-ok").addEventListener("click", close);
    });
    bg.querySelector("#e-title").focus();
  }

  // ------------------------------------------------------------- payment confirmation
  const STATUS_LABEL = {
    upcoming: "nadchodząca",
    due: "do potwierdzenia",
    missed: "przegapiona",
    confirmed: "potwierdzona",
  };

  function openConfirmPayment(o, due, afterSave) {
    injectStyle();
    const bg = document.createElement("div");
    bg.className = "tz-modal-bg";
    bg.innerHTML = `
      <div class="tz-modal" style="max-width:420px">
        <h3>Potwierdź płatność</h3>
        <p style="margin:0 0 12px">${esc(o.name)} — termin ${esc(fmtDate(due))}</p>
        <label class="tz-field"><span>Data płatności *</span>
          <input class="tz-input" id="p-date" type="text" inputmode="numeric" placeholder="RRRR-MM-DD" value="${escAttr(todayStr())}">
          <div class="tz-err" id="p-err-date" style="display:none"></div>
        </label>
        <label class="tz-field"><span>Kwota rzeczywista (zł)</span>
          <input class="tz-input" id="p-amount" type="number" step="0.01" min="0" value="${escAttr(o.amount)}">
          <div class="tz-err" id="p-err-amount" style="display:none"></div>
        </label>
        <div class="tz-modal-actions">
          <button class="tz-btn ghost" id="p-cancel">Anuluj</button>
          <button class="tz-btn" id="p-save">Potwierdź</button>
        </div>
      </div>`;
    const modal = bg.querySelector(".tz-modal");
    modal.addEventListener("click", (e) => e.stopPropagation());
    const close = () => {
      bg.remove();
      document.removeEventListener("keydown", onEsc);
    };
    const onEsc = (e) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        close();
      }
    };
    bg.addEventListener("click", (e) => {
      if (e.target === bg) close();
    });
    document.addEventListener("keydown", onEsc);
    bg.querySelector("#p-cancel").addEventListener("click", close);
    bg.querySelector("#p-save").addEventListener("click", async () => {
      const dv = bg.querySelector("#p-date").value.trim();
      const errEl = bg.querySelector("#p-err-date");
      errEl.style.display = "none";
      if (!/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(dv)) {
        errEl.textContent = "Podaj datę w formacie RRRR-MM-DD";
        errEl.style.display = "";
        return;
      }
      const rawAmt = bg.querySelector("#p-amount").value.trim();
      const amt = rawAmt === "" ? Number(o.amount) : Number(rawAmt);
      if (!(amt > 0)) {
        const aErr = bg.querySelector("#p-err-amount");
        aErr.textContent = "Kwota musi być większa od zera";
        aErr.style.display = "";
        return;
      }
      await addConfirmation(o.id, due, dv, amt);
      close();
      if (afterSave) afterSave();
    });
    document.body.appendChild(bg);
  }

  // ------------------------------------------------------------- obligations page
  let oblEl = null;
  const expandedIds = new Set(); // rows with the occurrence history open

  function historyHtml(o, confMap) {
    const { past, next } = obligationOccurrences(o);
    const shown = past.slice(0, HISTORY_SHOWN);
    if (!shown.length) {
      return `<div class="tz-hist-title">Brak historii — najbliższy termin: ${esc(next ? fmtDate(next) : "—")}.</div>`;
    }
    const rows = shown
      .map((due) => {
        const st = occStatus(o.id, due, confMap, effectiveDue(o.id, due));
        const c = confMap[occKey(o.id, due)];
        const moved = effectiveDue(o.id, due) !== due;
        return `<tr>
          <td>${esc(fmtDate(effectiveDue(o.id, due)))}${
            moved
              ? ` <span class="tz-gmark" title="${escAttr(`Przesunięte w Google z ${fmtDate(due)}`)}">↔</span>`
              : ""
          }${
            isGone(o.id, due)
              ? ` <span class="tz-gmark warn" title="Event usunięty w Google">⚠</span>`
              : ""
          }</td>
          <td><span class="tz-status ${st}">${STATUS_LABEL[st]}</span></td>
          <td>${c ? esc(fmtDate(c.date)) : "—"}</td>
          <td class="tz-amt">${c ? formatAmount(c.amount) : "—"}</td>
          <td>${c ? `<button class="tz-iconbtn tz-undo" data-due="${escAttr(due)}">cofnij</button>` : ""}</td>
        </tr>`;
      })
      .join("");
    return `<div class="tz-hist-title">Historia wystąpień (ostatnie ${shown.length})</div>
      <table class="tz-hist-tbl">
        <thead><tr><th>Termin</th><th>Status</th><th>Zapłacono</th><th>Kwota</th><th></th></tr></thead>
        <tbody>${rows}</tbody>
      </table>`;
  }

  // Znacznik synchronizacji przy nazwie: kalendarz dla pozycji trzymanych
  // w Google, ostrzeżenie gdy ostatnia próba się nie powiodła.
  function gcalMark(o) {
    const err = gcalErrors()[o.id];
    if (err)
      return ` <span class="tz-gmark warn" title="${escAttr(`Nie zsynchronizowano z Google: ${err}`)}">⚠</span>`;
    if (!o.calendarId) return "";
    // wystąpienia skasowane w Google widać przy nazwie, żeby nie trzeba było
    // szukać ich po kalendarzu
    const gone = Object.keys(goneEvents())
      .filter((k) => k.startsWith(`${o.id}|`))
      .map((k) => fmtDate(k.split("|")[1]));
    const moved = Object.keys(shifts()).filter((k) =>
      k.startsWith(`${o.id}|`),
    ).length;
    return (
      ` <span class="tz-gmark" title="${escAttr(calendarLabel(o.calendarId))}">📆</span>` +
      (moved
        ? ` <span class="tz-gmark" title="${escAttr(`Terminy przesunięte w Google: ${moved}`)}">↔</span>`
        : "") +
      (gone.length
        ? ` <span class="tz-gmark warn" title="${escAttr(`Event usunięty w Google: ${gone.join(", ")}`)}">⚠</span>`
        : "")
    );
  }

  function suggestionsBarHtml() {
    const sugg = suggestions();
    if (!sugg.length) return "";
    const rows = sugg
      .map(
        (s) => `<div class="tz-sugg-row" data-sugg="${escAttr(s.id)}">
          <span class="tz-sugg-name">${esc(s.name)}</span>
          <span class="tz-amt">${formatAmount(s.amount)}</span>
          <span class="tz-hint">${esc(s.cycle || "—")}${s.lastSeen ? ` · ostatnio ${esc(fmtDate(s.lastSeen))}` : ""}</span>
          <span class="tz-sugg-actions">
            <button class="tz-btn tz-sugg-add" style="padding:3px 10px;font-size:12px">Dodaj</button>
            <button class="tz-iconbtn tz-sugg-drop">Odrzuć</button>
          </span>
        </div>`,
      )
      .join("");
    return `<div class="tz-sugg">
      <div class="tz-sugg-head">🔎 Wykryto ${sugg.length} ${sugg.length === 1 ? "cykliczną płatność" : "cyklicznych płatności"} — przejrzyj</div>
      ${rows}
    </div>`;
  }

  function renderObligations(el) {
    oblEl = el;
    injectStyle();
    const confMap = confirmationMap();
    const list = obligations()
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name, "pl"));

    const rows = list
      .map((o) => {
        const owner = ownerById(o.ownerId);
        const chip = owner
          ? `<span class="tz-chip" style="background:${escAttr(owner.color)}">${esc(owner.name)}</span>`
          : `<span class="tz-hint">—</span>`;
        const near = nearestOccurrence(o, confMap);
        const rowCls =
          near && near.status === "missed"
            ? "tz-row-missed"
            : near && near.status === "due"
              ? "tz-row-due"
              : "";
        const nearCell = near
          ? `<div>${esc(fmtDate(near.due))}</div>
             <span class="tz-status ${near.status}">${STATUS_LABEL[near.status]}</span>
             ${near.gone ? ` <span class="tz-gmark warn" title="Event usunięty w Google">⚠</span>` : ""}
             ${
               near.status === "due" || near.status === "missed"
                 ? `<div><button class="tz-btn tz-confirm-btn tz-confirm" style="padding:4px 10px;font-size:12px">Potwierdź</button></div>`
                 : ""
             }`
          : `<span class="tz-hint">—</span>`;
        const daysLeft = contractDaysLeft(o);
        const badge =
          daysLeft != null && daysLeft >= 0 && daysLeft <= CONTRACT_SOON_DAYS
            ? (() => {
                const [y, m] = o.contractEnd.split("-").map(Number);
                const endDate = mkDue(y, m - 1, 31);
                return `<span class="tz-badge">Umowa kończy się ${esc(fmtDate(endDate).slice(0, 5))}</span>`;
              })()
            : "";
        const expanded = expandedIds.has(o.id);
        return `<tr data-id="${escAttr(o.id)}" class="${rowCls} tz-expand-hint" title="Kliknij, aby ${expanded ? "zwinąć" : "rozwinąć"} historię">
          <td>${esc(o.name)}${badge}${gcalMark(o)}<div class="tz-cat">${esc(CATEGORY_LABEL[o.category] || o.category)}</div></td>
          <td>${chip}</td>
          <td>${esc(cycleWords(o.cycle))}</td>
          <td class="tz-due-cell">${nearCell}</td>
          <td class="tz-amt">${formatAmount(o.amount)}</td>
          <td>${o.contractEnd ? esc(o.contractEnd) : "<span class='tz-hint'>—</span>"}</td>
          <td><div class="tz-actions">
            <button class="tz-iconbtn tz-edit">Edytuj</button>
            <button class="tz-iconbtn danger tz-del">Usuń</button>
          </div></td>
        </tr>${
          expanded
            ? `<tr class="tz-hist" data-hist="${escAttr(o.id)}"><td colspan="7">${historyHtml(o, confMap)}</td></tr>`
            : ""
        }`;
      })
      .join("");

    el.innerHTML = `
      <div class="tz-wrap">
        <div class="tz-bar">
          <h2>📋 Zobowiązania</h2>
          <button class="tz-btn" id="tz-add">+ Dodaj</button>
        </div>
        ${suggestionsBarHtml()}
        <div class="tz-body">
          ${
            list.length === 0
              ? `<div class="tz-empty">
                   <div style="font-size:32px">📋</div>
                   <div>Brak zobowiązań — dodaj pierwsze.</div>
                   <button class="tz-btn" id="tz-add-empty">+ Dodaj zobowiązanie</button>
                 </div>`
              : `<table class="tz-tbl">
                   <thead><tr>
                     <th>Nazwa / kategoria</th><th>Właściciel</th><th>Cykl</th>
                     <th>Najbliższy termin</th><th>Kwota</th><th>Koniec umowy</th><th></th>
                   </tr></thead>
                   <tbody>${rows}</tbody>
                 </table>`
          }
        </div>
      </div>`;

    const add = () => openForm(null, () => renderObligations(el));
    el.querySelector("#tz-add").addEventListener("click", add);

    el.querySelectorAll(".tz-sugg-row[data-sugg]").forEach((row) => {
      const id = row.getAttribute("data-sugg");
      const drop = async () => {
        await saveSuggestions(suggestions().filter((s) => s.id !== id));
        renderObligations(el);
      };
      row.querySelector(".tz-sugg-add").addEventListener("click", () => {
        const s = suggestions().find((x) => x.id === id);
        if (!s) return;
        // accepted suggestion prefills the form; it leaves the bar only once
        // the obligation is actually saved
        openForm(
          {
            id: "",
            name: s.name,
            category: "other",
            ownerId: owners()[0] ? owners()[0].id : "",
            amount: s.amount || "",
            tolerancePct: 10,
            cycle: cycleFromSuggestion(s),
            statementPattern: s.name,
            contractEnd: "",
            note: "",
          },
          async () => {
            await drop();
          },
        );
      });
      row.querySelector(".tz-sugg-drop").addEventListener("click", drop);
    });
    const addEmpty = el.querySelector("#tz-add-empty");
    if (addEmpty) addEmpty.addEventListener("click", add);

    el.querySelectorAll("tr[data-id]").forEach((tr) => {
      const id = tr.getAttribute("data-id");
      const rec = () => obligations().find((o) => o.id === id);
      tr.querySelector(".tz-edit").addEventListener("click", (e) => {
        e.stopPropagation();
        const o = rec();
        if (o) openForm(o, () => renderObligations(el));
      });
      tr.querySelector(".tz-del").addEventListener("click", (e) => {
        e.stopPropagation();
        const o = rec();
        confirmDialog(`Usunąć zobowiązanie „${o ? o.name : ""}"?`, async () => {
          await removeObligation(id);
          expandedIds.delete(id);
          renderObligations(el);
        });
      });
      const confirmBtn = tr.querySelector(".tz-confirm");
      if (confirmBtn)
        confirmBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          const o = rec();
          const near = o && nearestOccurrence(o, confirmationMap());
          if (near)
            openConfirmPayment(o, near.due, () => renderObligations(el));
        });
      tr.addEventListener("click", () => {
        if (expandedIds.has(id)) expandedIds.delete(id);
        else expandedIds.add(id);
        renderObligations(el);
      });
    });

    el.querySelectorAll("tr[data-hist]").forEach((tr) => {
      const id = tr.getAttribute("data-hist");
      tr.querySelectorAll(".tz-undo").forEach((btn) =>
        btn.addEventListener("click", (e) => {
          e.stopPropagation();
          const due = btn.getAttribute("data-due");
          confirmDialog(
            `Cofnąć potwierdzenie z ${fmtDate(due)}?`,
            async () => {
              await removeConfirmation(id, due);
              renderObligations(el);
            },
            { danger: false, yesLabel: "Cofnij" },
          );
        }),
      );
    });
  }

  // ------------------------------------------------------------- calendar (task 3/6)
  // View state survives re-renders; anchor is the focused date.
  const cal = {
    view: "month", // "day" | "week" | "month" | "year"
    anchor: todayStr(),
    // Day the user actually picked. Month/year navigation clamps the anchor to
    // the target month's length, so without remembering the intent 31.01 → 28.02
    // would stay 28.03 instead of coming back to 31.
    dayIntent: parseDate(todayStr()).getDate(),
    owners: new Set(), // empty = all owners
    category: "", // "" = all categories
  };
  let calEl = null;

  function setAnchor(s) {
    cal.anchor = s;
    cal.dayIntent = parseDate(s).getDate();
  }

  const DOW = ["pon", "wt", "śr", "czw", "pt", "sob", "niedz"];
  const capitalize = (s) => s.charAt(0).toUpperCase() + s.slice(1);
  const shortName = (s) => (s.length > 18 ? s.slice(0, 17) + "…" : s);
  // Kolory przychodzą z Google, więc do atrybutu style trafia wyłącznie
  // sprawdzony hex — nie chcemy wstrzykiwać cudzego tekstu do CSS.
  const HEX_RE = /^#[0-9a-fA-F]{3,8}$/;
  const safeColor = (c, fallback = "var(--accent,#89b4fa)") =>
    HEX_RE.test(c || "") ? c : fallback;

  function filteredObligations() {
    return obligations().filter(
      (o) =>
        (!cal.owners.size || cal.owners.has(o.ownerId)) &&
        (!cal.category || o.category === cal.category),
    );
  }

  // Generic day items so a second kind (e.g. Google events) can join later:
  // {kind, due, status, title, amount, ownerId, o}
  // `list` domyślnie respektuje filtry strony Kalendarz; widgety podają pełną
  // listę, bo filtr z innej strony nie może po cichu chować pozycji na pulpicie.
  function itemsForRange(
    startStr,
    endStr,
    confMap,
    list = filteredObligations(),
  ) {
    const out = [];
    for (const o of list) {
      // szeroki zakres, bo przesunięcie z Google może wypchnąć wystąpienie
      // poza okno liczone z samego cyklu
      for (const due of occurrencesBetween(
        o.cycle,
        addDays(startStr, -31),
        addDays(endStr, 31),
      )) {
        const shown = effectiveDue(o.id, due);
        if (shown < startStr || shown > endStr) continue;
        const conf = confMap[occKey(o.id, due)];
        out.push({
          kind: "obligation",
          due: shown,
          sourceDue: due,
          gone: isGone(o.id, due),
          status: occStatus(o.id, due, confMap, shown),
          title: o.name,
          // potwierdzona pozycja liczy się kwotą rzeczywistą, nie oczekiwaną
          amount: conf ? conf.amount : o.amount,
          ownerId: o.ownerId,
          o,
        });
      }
    }
    out.push(...externalItems(startStr, endStr));
    return out.sort(
      (a, b) =>
        a.due.localeCompare(b.due) ||
        // płatności przed obcymi wydarzeniami tego samego dnia
        (a.kind === b.kind ? 0 : a.kind === "google" ? 1 : -1),
    );
  }

  function monthRange(anchor) {
    const d = parseDate(anchor);
    const y = d.getFullYear();
    const m = d.getMonth();
    return [mkDue(y, m, 1), mkDue(y, m, 31)];
  }

  function calShift(dir) {
    if (cal.view === "day") {
      setAnchor(addDays(cal.anchor, dir));
      return;
    }
    if (cal.view === "week") {
      setAnchor(addDays(cal.anchor, dir * 7));
      return;
    }
    const d = parseDate(cal.anchor);
    const step = cal.view === "month" ? dir : dir * 12;
    cal.anchor = mkDue(d.getFullYear(), d.getMonth() + step, cal.dayIntent);
  }

  function calTitle() {
    const d = parseDate(cal.anchor);
    if (cal.view === "day")
      return `${d.getDate()} ${MONTHS_GEN[d.getMonth()]} ${d.getFullYear()}`;
    if (cal.view === "week") {
      const [s, e] = weekRange(cal.anchor);
      const ds = parseDate(s);
      const de = parseDate(e);
      if (ds.getFullYear() !== de.getFullYear())
        return `${ds.getDate()} ${MONTHS_GEN[ds.getMonth()]} ${ds.getFullYear()} – ${de.getDate()} ${MONTHS_GEN[de.getMonth()]} ${de.getFullYear()}`;
      if (ds.getMonth() !== de.getMonth())
        return `${ds.getDate()} ${MONTHS_GEN[ds.getMonth()]} – ${de.getDate()} ${MONTHS_GEN[de.getMonth()]} ${de.getFullYear()}`;
      return `${ds.getDate()}–${de.getDate()} ${MONTHS_GEN[ds.getMonth()]} ${de.getFullYear()}`;
    }
    if (cal.view === "month")
      return `${capitalize(MONTHS[d.getMonth()])} ${d.getFullYear()}`;
    return String(d.getFullYear());
  }

  function ownerChipsHtml() {
    return owners()
      .map((ow) => {
        const active = cal.owners.has(ow.id);
        return `<button class="tz-fchip ${active ? "active" : ""}" data-owner="${escAttr(ow.id)}"
          ${active ? `style="background:${escAttr(ow.color)}"` : ""}>${esc(ow.name)}</button>`;
      })
      .join("");
  }

  function sumsBarHtml(items) {
    if (!items.length) return "";
    const total = items.reduce((s, it) => s + Number(it.amount || 0), 0);
    const byOwner = new Map();
    for (const it of items)
      byOwner.set(
        it.ownerId,
        (byOwner.get(it.ownerId) || 0) + Number(it.amount || 0),
      );
    const parts = [...byOwner]
      .sort((a, b) => b[1] - a[1])
      .map(([id, sum]) => {
        const ow = ownerById(id);
        return `${esc(ow ? ow.name : "—")}: ${formatAmount(sum)}`;
      });
    return `<div class="tz-cal-sums"><b>Razem: ${formatAmount(total)}</b> · ${parts.join(" · ")}</div>`;
  }

  // Jedna pigułka pozycji dnia — używa jej siatka miesiąca i tygodnia.
  function itemPillHtml(it) {
    if (it.kind === "google")
      return `<span class="tz-pill ext" style="border-left-color:${escAttr(safeColor(it.color))}" title="${escAttr(it.account || "")}">📅 ${esc(shortName(it.title))}</span>`;
    return `<span class="tz-pill ${it.status}" ${it.gone ? 'title="Event usunięty w Google"' : ""}>${it.gone ? "⚠ " : ""}${esc(shortName(it.title))} · ${formatAmount(it.amount)}</span>`;
  }

  function weekRange(anchor) {
    const back = (parseDate(anchor).getDay() + 6) % 7; // pon = 0
    const start = addDays(anchor, -back);
    return [start, addDays(start, 6)];
  }

  function weekViewHtml(confMap) {
    const [start, end] = weekRange(cal.anchor);
    const items = itemsForRange(start, end, confMap);
    const byDay = new Map();
    for (const it of items) {
      if (!byDay.has(it.due)) byDay.set(it.due, []);
      byDay.get(it.due).push(it);
    }
    const today = todayStr();
    let cells = "";
    for (let i = 0; i < 7; i++) {
      const due = addDays(start, i);
      const dayItems = byDay.get(due) || [];
      cells += `<div class="tz-wcell" data-day="${escAttr(due)}" title="Pokaż dzień">
        <div class="tz-whead">
          <span>${DOW[i]}</span>
          <span class="tz-dnum ${due === today ? "today" : ""}">${parseDate(due).getDate()}</span>
        </div>
        ${dayItems.map(itemPillHtml).join("") || `<span class="tz-more">—</span>`}
      </div>`;
    }
    return `${sumsBarHtml(items)}<div class="tz-body"><div class="tz-wgrid">${cells}</div></div>`;
  }

  function monthGridHtml(confMap) {
    const d = parseDate(cal.anchor);
    const y = d.getFullYear();
    const m = d.getMonth();
    const [start, end] = monthRange(cal.anchor);
    const items = itemsForRange(start, end, confMap);
    const byDay = new Map();
    for (const it of items) {
      if (!byDay.has(it.due)) byDay.set(it.due, []);
      byDay.get(it.due).push(it);
    }
    const today = todayStr();
    const firstDow = (parseDate(start).getDay() + 6) % 7; // Mon=0
    const dim = daysInMonth(y, m);
    let cells = DOW.map((w) => `<div class="tz-mgrid-head">${w}</div>`).join(
      "",
    );
    for (let i = 0; i < firstDow; i++)
      cells += `<div class="tz-mcell blank"></div>`;
    for (let day = 1; day <= dim; day++) {
      const due = mkDue(y, m, day);
      const dayItems = byDay.get(due) || [];
      const shown = dayItems.slice(0, dayItems.length > 3 ? 2 : 3);
      const more = dayItems.length - shown.length;
      cells += `<div class="tz-mcell" data-day="${escAttr(due)}" title="Pokaż dzień">
        <span class="tz-dnum ${due === today ? "today" : ""}">${day}</span>
        ${shown.map(itemPillHtml).join("")}
        ${more > 0 ? `<span class="tz-more">+${more} więcej</span>` : ""}
      </div>`;
    }
    return `${sumsBarHtml(items)}<div class="tz-body"><div class="tz-mgrid">${cells}</div></div>`;
  }

  function dayViewHtml(confMap) {
    const items = itemsForRange(cal.anchor, cal.anchor, confMap);
    if (!items.length)
      return `<div class="tz-body"><div class="tz-empty"><div style="font-size:32px">📆</div><div>Brak płatności tego dnia.</div></div></div>`;
    const rows = items
      .map((it) => {
        if (it.kind === "google") {
          return `<div class="tz-day-row tz-ext" title="${escAttr(it.account || "")}">
            <span class="tz-cdot" style="background:${escAttr(safeColor(it.color))}"></span>
            <div style="flex:1;min-width:0">${esc(it.title)}<div class="tz-cat">${esc(it.account || "")}</div></div>
            ${it.time ? `<span class="tz-hint">${esc(it.time)}</span>` : `<span class="tz-hint">cały dzień</span>`}
          </div>`;
        }
        const ow = ownerById(it.ownerId);
        const chip = ow
          ? `<span class="tz-chip" style="background:${escAttr(ow.color)}">${esc(ow.name)}</span>`
          : "";
        const confirmable = it.status === "due" || it.status === "missed";
        return `<div class="tz-day-row">
          <div style="flex:1;min-width:0">${esc(it.title)}<div class="tz-cat">${esc(CATEGORY_LABEL[it.o.category] || "")}</div></div>
          ${chip}
          <span class="tz-amt">${formatAmount(it.amount)}</span>
          <span class="tz-status ${it.status}">${STATUS_LABEL[it.status]}</span>
          ${it.gone ? `<span class="tz-gmark warn" title="Event usunięty w Google">⚠</span>` : ""}
          ${confirmable ? `<button class="tz-btn tz-day-confirm" data-key="${escAttr(occKey(it.o.id, it.due))}" style="padding:4px 10px;font-size:12px">Potwierdź</button>` : ""}
        </div>`;
      })
      .join("");
    return `<div class="tz-body">${rows}</div>`;
  }

  // Items of a range grouped by due date — the shape both the year view and
  // the month widget need.
  // Obce wydarzenia jako drugi rodzaj pozycji — tylko do odczytu, bez kwoty
  // i bez potwierdzania. Widoki traktują je jak każdą inną pozycję dnia, bo od
  // 3/6 renderują ogólne itemy.
  // Google zwraca godziny w strefie kalendarza (często UTC), więc dzień
  // i godzinę liczymy lokalnie — inaczej wieczorne wydarzenie wylądowałoby
  // w złym dniu, a godzina byłaby przesunięta o offset strefy.
  function extDayAndTime(e) {
    if (e.allDay) return { day: (e.start || "").slice(0, 10), time: "" };
    const d = new Date(e.start);
    if (isNaN(d.getTime()))
      return { day: (e.start || "").slice(0, 10), time: "" };
    return {
      day: dateStr(d),
      time: `${pad2(d.getHours())}:${pad2(d.getMinutes())}`,
    };
  }

  function externalItems(startStr, endStr) {
    const hidden = prefs().hiddenCals;
    return externalCache()
      .items.filter((e) => !hidden.includes(e.calendar))
      .map((e) => ({ e, ...extDayAndTime(e) }))
      .filter(({ day }) => day >= startStr && day <= endStr)
      .map(({ e, day, time }) => ({
        kind: "google",
        due: day,
        time,
        status: "external",
        title: e.title,
        account: e.account,
        calendar: e.calendar,
        color: e.color || "",
        amount: null,
      }));
  }

  function itemsByDay(startStr, endStr, confMap, list) {
    const byDay = new Map();
    for (const it of itemsForRange(
      startStr,
      endStr,
      confMap,
      list ?? filteredObligations(),
    )) {
      if (!byDay.has(it.due)) byDay.set(it.due, []);
      byDay.get(it.due).push(it);
    }
    return byDay;
  }

  // The busiest status of a day decides its dot colour: przegapiona wins over
  // do potwierdzenia, which wins over anything upcoming.
  function dayDotStatus(dayItems) {
    if (dayItems.some((it) => it.status === "missed")) return "missed";
    if (dayItems.some((it) => it.status === "due")) return "due";
    return dayItems.length ? "upcoming" : "";
  }

  // One mini month grid, shared by the Rok view and the „Miesiąc" widget.
  // `dayAttr` lets the caller make cells clickable without duplicating layout.
  function miniMonthCells(y, m, byDay, { dayAttr } = {}) {
    const today = todayStr();
    const firstDow = (new Date(y, m, 1).getDay() + 6) % 7;
    let cells = "";
    for (let i = 0; i < firstDow; i++) cells += `<div class="tz-ycell"></div>`;
    for (let day = 1; day <= daysInMonth(y, m); day++) {
      const due = mkDue(y, m, day);
      const dayItems = byDay.get(due) || [];
      const dot = dayDotStatus(dayItems);
      const attr = dayAttr ? dayAttr(due, dayItems) : "";
      cells += `<div class="tz-ycell ${due === today ? "today" : ""}" ${attr}>${
        dot ? `<span class="dot ${dot}"></span>` : day
      }</div>`;
    }
    return cells;
  }

  function yearViewHtml(confMap) {
    const y = parseDate(cal.anchor).getFullYear();
    const byDay = itemsByDay(mkDue(y, 0, 1), mkDue(y, 11, 31), confMap);
    const minis = MONTHS.map((name, m) => {
      let sum = 0;
      for (let day = 1; day <= daysInMonth(y, m); day++) {
        for (const it of byDay.get(mkDue(y, m, day)) || [])
          sum += Number(it.amount || 0);
      }
      const cells = miniMonthCells(y, m, byDay);
      return `<div class="tz-ymonth" data-month="${m}" title="Pokaż miesiąc">
        <h4>${esc(name)}</h4>
        <div class="tz-ygrid7">${cells}</div>
        <div class="tz-ysum">${sum ? formatAmount(sum) : "—"}</div>
      </div>`;
    }).join("");
    return `<div class="tz-body"><div class="tz-ygrid">${minis}</div></div>`;
  }

  function renderCalendar(el) {
    calEl = el;
    injectStyle();
    const confMap = confirmationMap();
    const body =
      cal.view === "day"
        ? dayViewHtml(confMap)
        : cal.view === "week"
          ? weekViewHtml(confMap)
          : cal.view === "year"
            ? yearViewHtml(confMap)
            : monthGridHtml(confMap);

    el.innerHTML = `
      <div class="tz-wrap">
        <div class="tz-bar tz-cal-bar">
          <h2>📆 Kalendarz</h2>
          <div class="tz-cal-nav">
            <button class="tz-iconbtn" id="cal-prev" title="Poprzedni okres [">‹</button>
            <button class="tz-iconbtn" id="cal-today" title="Dziś (t)">dziś</button>
            <button class="tz-iconbtn" id="cal-next" title="Następny okres ]">›</button>
          </div>
          <span class="tz-cal-title">${esc(calTitle())}</span>
          ${
            sharedCalendars.length
              ? `<div class="tz-cal-actions">
                  <button class="tz-btn ghost" id="cal-add-event" title="Dodaj wydarzenie do kalendarza Google">+ Wydarzenie</button>
                  <button class="tz-btn ghost" id="cal-sync" title="Pobierz zmiany z Google teraz">🔄 Synchronizuj</button>
                </div>`
              : ""
          }
          <div class="tz-cal-views">
            <button data-view="day" class="${cal.view === "day" ? "active" : ""}" title="d">Dzień</button>
            <button data-view="week" class="${cal.view === "week" ? "active" : ""}" title="w">Tydzień</button>
            <button data-view="month" class="${cal.view === "month" ? "active" : ""}" title="m">Miesiąc</button>
            <button data-view="year" class="${cal.view === "year" ? "active" : ""}" title="r">Rok</button>
          </div>
        </div>
        <div class="tz-cal-filters">
          ${ownerChipsHtml()}
          ${
            sharedCalendars.length
              ? sharedCalendars
                  .map(
                    (c) => `<label class="settings-checkbox tz-calchk" title="${escAttr(c.label)}">
                      <input type="checkbox" data-cal="${escAttr(c.id)}" ${calVisible(c.id) ? "checked" : ""}>
                      <span class="tz-swatch" style="background:${escAttr(safeColor(c.color))}"></span>
                      <span>${esc(shortName(c.name || c.label))}</span>
                    </label>`,
                  )
                  .join("")
              : ""
          }
          <select class="tz-select" id="cal-cat" style="width:auto">
            <option value="">Wszystkie kategorie</option>
            ${CATEGORIES.map((c) => `<option value="${c.id}" ${c.id === cal.category ? "selected" : ""}>${esc(c.label)}</option>`).join("")}
          </select>
        </div>
        ${body}
        ${
          sharedCalendars.length
            ? `<div class="tz-cal-foot">${
                externalCache().at
                  ? `Ostatnia synchronizacja z Google: ${esc(fmtSyncTime(externalCache().at))}`
                  : "Brak danych z Google — czekam na pierwszą synchronizację"
              }</div>`
            : ""
        }
      </div>`;

    const rerender = () => renderCalendar(el);
    el.querySelector("#cal-prev").addEventListener("click", () => {
      calShift(-1);
      rerender();
    });
    el.querySelector("#cal-next").addEventListener("click", () => {
      calShift(1);
      rerender();
    });
    el.querySelector("#cal-today").addEventListener("click", () => {
      setAnchor(todayStr());
      rerender();
    });
    const syncBtn = el.querySelector("#cal-sync");
    if (syncBtn) syncBtn.addEventListener("click", () => openSyncDialog());
    const addEvBtn = el.querySelector("#cal-add-event");
    if (addEvBtn)
      addEvBtn.addEventListener("click", () =>
        // W widoku dnia sensownym domyślnym terminem jest oglądany dzień
        openExternalEvent(
          cal.view === "day" || cal.view === "week" ? cal.anchor : todayStr(),
          rerender,
        ),
      );
    el.querySelectorAll(".tz-cal-views button").forEach((b) =>
      b.addEventListener("click", () => {
        cal.view = b.getAttribute("data-view");
        rerender();
      }),
    );
    el.querySelectorAll(".tz-fchip").forEach((b) =>
      b.addEventListener("click", () => {
        const id = b.getAttribute("data-owner");
        if (cal.owners.has(id)) cal.owners.delete(id);
        else cal.owners.add(id);
        rerender();
      }),
    );
    el.querySelectorAll(".tz-calchk input[data-cal]").forEach((chk) =>
      chk.addEventListener("change", async () => {
        await setCalVisible(chk.getAttribute("data-cal"), chk.checked);
        rerender();
        refreshWidgets();
      }),
    );
    el.querySelector("#cal-cat").addEventListener("change", (e) => {
      cal.category = e.target.value;
      rerender();
    });
    el.querySelectorAll(".tz-mcell[data-day], .tz-wcell[data-day]").forEach((c) =>
      c.addEventListener("click", () => {
        setAnchor(c.getAttribute("data-day"));
        cal.view = "day";
        rerender();
      }),
    );
    el.querySelectorAll(".tz-ymonth[data-month]").forEach((c) =>
      c.addEventListener("click", () => {
        const d = parseDate(cal.anchor);
        cal.anchor = mkDue(
          d.getFullYear(),
          Number(c.getAttribute("data-month")),
          1,
        );
        cal.view = "month";
        rerender();
      }),
    );
    // Bind by "oblId|due", not by position — the list is rebuilt on every
    // render and an index could drift out from under the button.
    el.querySelectorAll(".tz-day-confirm").forEach((b) =>
      b.addEventListener("click", () => {
        const [oblId, due] = b.getAttribute("data-key").split("|");
        const o = obligations().find((x) => x.id === oblId);
        if (o) openConfirmPayment(o, due, rerender);
      }),
    );
  }

  // Keyboard shortcuts, wzorem bankOnKey z KSeF.
  function calOnKey(e) {
    if (e.metaKey || e.ctrlKey || e.altKey) return false;
    if (document.querySelector(".tz-modal-bg")) return false;
    const tag = document.activeElement?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return false;
    if (!calEl) return false;
    if (e.key === "[" || e.key === "]") {
      calShift(e.key === "[" ? -1 : 1);
      renderCalendar(calEl);
      return true;
    }
    if (e.key === "t") {
      setAnchor(todayStr());
      renderCalendar(calEl);
      return true;
    }
    const views = { d: "day", w: "week", m: "month", r: "year" };
    if (views[e.key]) {
      cal.view = views[e.key];
      renderCalendar(calEl);
      return true;
    }
    return false;
  }

  // ------------------------------------------------------------- module
  cl.registerModule({
    id: "main",
    label: "Terminarz",
    icon: "📅",
    pages: [
      {
        id: "obligations",
        label: "Zobowiązania",
        icon: "📋",
        render: renderObligations,
        onShow: () => oblEl && renderObligations(oblEl),
      },
      {
        id: "calendar",
        label: "Kalendarz",
        icon: "📆",
        render: renderCalendar,
        onShow: () => calEl && renderCalendar(calEl),
        onKey: (e) => calOnKey(e),
      },
    ],
  });

  // ------------------------------------------------------------- settings (owners)
  cl.registerSettingsSection({
    id: "settings",
    label: "Terminarz",
    icon: "📅",
    render(el) {
      injectStyle();
      function draw() {
        const list = owners();
        el.innerHTML = `
          <h2 class="settings-section-title">📅 Terminarz — właściciele</h2>
          <p class="settings-section-desc">Właściciele przypisywani do zobowiązań. Właściciela, który ma przypisane zobowiązania, nie można usunąć.</p>
          <div id="tz-owners">
            ${list
              .map(
                (o) => `<div class="tz-owner-row" data-id="${escAttr(o.id)}">
                  <span class="tz-swatch" style="background:${escAttr(o.color)}"></span>
                  <span style="flex:1">${esc(o.name)}</span>
                  <button class="tz-iconbtn danger tz-owner-del">Usuń</button>
                </div>`,
              )
              .join("")}
          </div>
          <div class="tz-owner-row" style="border:none">
            <input class="tz-input" id="tz-new-name" type="text" placeholder="Nazwa właściciela" style="flex:1">
            <input id="tz-new-color" type="color" value="#89b4fa" style="width:40px;height:34px;border:none;background:none;cursor:pointer">
            <button class="tz-btn" id="tz-owner-add">Dodaj</button>
          </div>
          <div class="tz-err" id="tz-owner-err" style="display:none"></div>`;

        el.querySelector("#tz-owner-add").addEventListener(
          "click",
          async () => {
            const name = el.querySelector("#tz-new-name").value.trim();
            const color = el.querySelector("#tz-new-color").value || "#89b4fa";
            const errEl = el.querySelector("#tz-owner-err");
            errEl.style.display = "none";
            if (!name) {
              errEl.textContent = "Podaj nazwę właściciela";
              errEl.style.display = "";
              return;
            }
            const id =
              name
                .toLowerCase()
                .replace(/[^a-z0-9]+/gi, "-")
                .replace(/^-|-$/g, "") || "w" + hashStr(name + color);
            const list2 = owners().slice();
            if (list2.some((o) => o.id === id)) {
              errEl.textContent = "Właściciel o tej nazwie już istnieje";
              errEl.style.display = "";
              return;
            }
            list2.push({ id, name, color });
            await saveOwners(list2);
            draw();
          },
        );

        el.querySelectorAll(".tz-owner-row[data-id]").forEach((row) => {
          const id = row.getAttribute("data-id");
          const del = row.querySelector(".tz-owner-del");
          if (del)
            del.addEventListener("click", async () => {
              const errEl = el.querySelector("#tz-owner-err");
              errEl.style.display = "none";
              if (obligations().some((o) => o.ownerId === id)) {
                errEl.textContent = "Właściciel ma przypisane zobowiązania";
                errEl.style.display = "";
                return;
              }
              await saveOwners(owners().filter((o) => o.id !== id));
              draw();
            });
        });
      }
      draw();
    },
  });

  // Register after the store is loaded so the first render already has data.
  await initStore();

  cl.registerWidget({
    id: "upcoming",
    title: "Nadchodzące płatności",
    icon: "📅",
    dashboard: true,
    render: renderUpcomingWidget,
  });
  cl.registerWidget({
    id: "today",
    title: "Dzisiaj",
    icon: "📌",
    dashboard: true,
    render: renderTodayWidget,
  });
  cl.registerWidget({
    id: "month",
    title: "Miesiąc",
    icon: "🗓️",
    dashboard: true,
    render: renderMonthWidget,
  });

  // ----------------------------------------------------------- agent tools (5/6)
  // Exposed over MCP as terminarz_list / _pending / _confirm / _suggest.
  const PENDING_BACK_DAYS = 60;
  const PENDING_AHEAD_DAYS = 7;
  const PENDING_MAX_AHEAD_MONTHS = 24; // sanity cap na okno z argumentów modelu
  const CONFIRM_AHEAD_DAYS = 7; // ile dni „do przodu" wolno jeszcze potwierdzić
  const MAX_SUGGESTIONS = 100;
  const MAX_SUGG_FIELD = 200;
  const MAX_NOTE_LEN = 2000;

  function resolveOwnerId(needle) {
    if (!needle) return null;
    const n = String(needle).toLowerCase();
    const ow = owners().find(
      (o) => o.id.toLowerCase() === n || o.name.toLowerCase() === n,
    );
    return ow ? ow.id : null;
  }

  function ownerName(id) {
    const ow = ownerById(id);
    return ow ? ow.name : null;
  }

  function publicObligation(o, confMap) {
    const near = nearestOccurrence(o, confMap);
    return {
      id: o.id,
      name: o.name,
      category: o.category,
      categoryLabel: CATEGORY_LABEL[o.category] || o.category,
      owner: ownerName(o.ownerId),
      ownerId: o.ownerId,
      expectedAmount: o.amount,
      tolerancePct: o.tolerancePct ?? 0,
      cycle: o.cycle,
      cycleLabel: cycleWords(o.cycle),
      matchPattern: o.statementPattern || "",
      contractEnd: o.contractEnd || null,
      note: o.note || "",
      nextDueDate: near ? near.due : null,
      nextStatus: near ? near.status : null,
    };
  }

  cl.registerAgentTool("list", async (args = {}) => {
    const confMap = confirmationMap();
    const ownerId = args.owner ? resolveOwnerId(args.owner) : null;
    if (args.owner && !ownerId)
      throw new Error(`nieznany właściciel: ${args.owner}`);
    const category = args.category ? String(args.category) : null;
    if (category && !CATEGORY_LABEL[category])
      throw new Error(
        `nieznana kategoria: ${category} (dozwolone: ${CATEGORIES.map((c) => c.id).join(", ")})`,
      );
    const list = obligations().filter(
      (o) =>
        (!ownerId || o.ownerId === ownerId) &&
        (!category || o.category === category),
    );
    return {
      count: list.length,
      obligations: list
        .sort((a, b) => a.name.localeCompare(b.name, "pl"))
        .map((o) => publicObligation(o, confMap)),
    };
  });

  cl.registerAgentTool("pending", async (args = {}) => {
    const today = todayStr();
    const from = args.from || addDays(today, -PENDING_BACK_DAYS);
    const to = args.to || addDays(today, PENDING_AHEAD_DAYS);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to))
      throw new Error("from/to muszą być w formacie YYYY-MM-DD");
    if (from > to)
      throw new Error(`from (${from}) jest późniejsze niż to (${to})`);
    // bez tego "to": "9999-12-31" każe przeliczać wystąpienia przez tysiące lat
    const maxTo = addMonths(today, PENDING_MAX_AHEAD_MONTHS);
    if (to > maxTo)
      throw new Error(
        `to (${to}) wykracza poza dozwolony horyzont — maksimum ${maxTo}`,
      );
    const confMap = confirmationMap();
    const out = [];
    for (const o of obligations()) {
      // never reach before the obligation existed
      const start = windowStart(o);
      const lower = from > start ? from : start;
      for (const due of occurrencesBetween(o.cycle, lower, to)) {
        const status = occStatus(o.id, due, confMap);
        if (status !== "due" && status !== "missed") continue;
        out.push({
          obligationId: o.id,
          name: o.name,
          dueDate: due,
          expectedAmount: o.amount,
          tolerancePct: o.tolerancePct ?? 0,
          status,
          matchPattern: o.statementPattern || "",
          owner: ownerName(o.ownerId),
          category: o.category,
        });
      }
    }
    out.sort((a, b) => a.dueDate.localeCompare(b.dueDate));
    return { count: out.length, from, to, pending: out };
  });

  cl.registerAgentTool("confirm", async (args = {}) => {
    const { obligationId, dueDate, paidDate } = args;
    const o = obligations().find((x) => x.id === obligationId);
    if (!o)
      throw new Error(
        `zobowiązanie nie znalezione: ${obligationId ?? "(brak id)"}`,
      );
    for (const [label, v] of [
      ["dueDate", dueDate],
      ["paidDate", paidDate],
    ]) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(v || "")))
        throw new Error(`${label} musi być w formacie YYYY-MM-DD`);
    }
    // dueDate must be an occurrence this obligation actually generates —
    // checked against its whole lifetime, not the 12-month history window,
    // so rozliczanie zaległości sprzed roku nie dostaje „nie istnieje"
    const valid = occurrencesBetween(
      o.cycle,
      obligationStart(o),
      addMonths(todayStr(), 13),
    );
    if (!valid.includes(dueDate))
      throw new Error(
        `wystąpienie ${dueDate} nie istnieje dla tego zobowiązania (cykl: ${cycleWords(o.cycle)})`,
      );
    if (confirmationMap()[occKey(o.id, dueDate)])
      throw new Error("wystąpienie już potwierdzone");
    // Early payment is legitimate (the automation matches ±5 dni), a term
    // months away is not — that would silently settle a future period.
    const ahead = daysBetween(todayStr(), dueDate);
    if (ahead > CONFIRM_AHEAD_DAYS)
      throw new Error(
        `wystąpienie ${dueDate} jeszcze nie nadeszło (termin za ${ahead} dni)`,
      );
    const amount = Number(args.amount);
    await addConfirmation(
      o.id,
      dueDate,
      paidDate,
      amount > 0 ? amount : o.amount,
      args.note ? String(args.note).slice(0, MAX_NOTE_LEN) : "",
    );
    if (oblEl) renderObligations(oblEl);
    return {
      ok: true,
      obligationId: o.id,
      dueDate,
      paidDate,
      amount: amount > 0 ? amount : o.amount,
    };
  });

  cl.registerAgentTool("suggest", async (args = {}) => {
    const items = Array.isArray(args.items) ? args.items : [];
    if (!items.length)
      throw new Error("items: podaj co najmniej jedną pozycję");
    const list = suggestions().slice();
    const clip = (v) =>
      String(v || "")
        .trim()
        .slice(0, MAX_SUGG_FIELD);
    let added = 0;
    let skipped = 0;
    for (const it of items) {
      const name = clip(it?.name);
      if (!name) continue;
      if (list.length >= MAX_SUGGESTIONS) {
        skipped++;
        continue;
      }
      const amount = Number(it.amount) || 0;
      if (list.some((s) => suggKey(s.name, s.amount) === suggKey(name, amount)))
        continue;
      let id = "s" + Math.abs(hashStr(name + amount + list.length));
      while (list.some((s) => s.id === id)) id += "x";
      list.push({
        id,
        name,
        amount,
        cycle: clip(it.cycle),
        lastSeen: clip(it.lastSeen),
        at: todayStr(),
      });
      added++;
    }
    if (added) await saveSuggestions(list);
    if (oblEl) renderObligations(oblEl);
    const out = { added, pending: list.length };
    if (skipped) {
      out.skipped = skipped;
      out.note = `lista sugestii jest pełna (limit ${MAX_SUGGESTIONS}) — przejrzyj istniejące`;
    }
    return out;
  });

  // Google: lista udostępnionych kalendarzy decyduje, czy pole „Kalendarz"
  // w ogóle istnieje; zaległe synchronizacje dochodzą przy starcie.
  loadSharedCalendars()
    .then(() => retryFailedSyncs())
    .then(() => pollGoogle())
    .then(() => oblEl && renderObligations(oblEl))
    .catch((err) => cl.log("Google Calendar:", err));

  // Zmiany zrobione w Google (przesunięcia, kasowanie) i obce wydarzenia
  // dociągamy cyklicznie; timer ginie razem z instancją addonu.
  pollTimer = setInterval(() => {
    pollGoogle().catch((err) => cl.log("polling Google:", err));
  }, POLL_INTERVAL_MS);

  // Reminders: once at startup, then hourly. The timer is cleared on dispose
  // so a hot reload does not leave a second one running.
  runReminders().catch((err) => cl.log("przypomnienia:", err));
  remindTimer = setInterval(() => {
    runReminders().catch((err) => cl.log("przypomnienia:", err));
  }, REMIND_INTERVAL_MS);

  cl.log("Terminarz ready");

  return () => {
    if (remindTimer) clearInterval(remindTimer);
    remindTimer = null;
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
    oblEl = null;
    calEl = null;
  };
}
