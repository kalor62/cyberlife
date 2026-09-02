// Mail skill of Cyber Bot: per-mailbox rules, a scripted "check unread mail"
// turn run in a dedicated thread, and an audit log of what happened to each
// message (with a stored body excerpt so it stays readable after the mail is
// gone). Rules are plain substring matches; anything the bot must judge is an
// `agent` rule whose instructions the bot follows per message.

const K_RULES = "mailRules";
const K_LOG_INDEX = "mailLog.n";
const logKey = (i) => "mailLog." + i;
const K_DRY_RUN = "mailDryRun";
const K_AUTO_MIN = "mailAutoMinutes";
const K_MAIL_THREAD = "mailThread";
const LOG_CHUNK_BYTES = 48 * 1024;
const LOG_ARCHIVE_AFTER_MS = 90 * 24 * 3600 * 1000;
const LOG_DROP_ARCHIVED_AFTER_MS = 2 * LOG_ARCHIVE_AFTER_MS;
const MAX_LOG_ENTRIES = 3000;
const BODY_CAP = 4000;
const MAIL_THREAD_RESET_AFTER = 40;

export const MAIL_ACTIONS = {
  trash: "Do kosza",
  archive: "Archiwizuj (przeczytane)",
  markRead: "Oznacz jako przeczytane",
  notify: "Powiadom mnie",
  agent: "Instrukcja dla bota",
};

export const MAIL_TOOLS = [
  "cyber-bot_mail_rules",
  "cyber-bot_mail_rule_save",
  "cyber-bot_mail_log",
  "system_notify",
];
export const GMAIL_READ_TOOLS = ["gmail_status", "gmail_search", "gmail_read", "gmail_inbox"];
export const GMAIL_WRITE_TOOLS = ["gmail_modify", "gmail_trash"];

export function createMail(cl, deps) {
  const { esc, truncate, newId } = deps;
  let rules = null;
  let log = null; // full list, newest first
  let pageEl = null;
  let autoTimer = null;

  // ---------------------------------------------------------------- storage
  async function loadRules() {
    if (rules) return rules;
    const r = await cl.storage.get(K_RULES);
    rules = Array.isArray(r) ? r : [];
    return rules;
  }
  async function saveRules() {
    await cl.storage.set(K_RULES, rules);
  }

  async function loadLog() {
    if (log) return log;
    const n = Number(await cl.storage.get(K_LOG_INDEX)) || 0;
    const parts = [];
    for (let i = 0; i < n; i++) {
      const chunk = await cl.storage.get(logKey(i));
      if (Array.isArray(chunk)) parts.push(...chunk);
    }
    log = parts;
    if (archiveOldEntries()) await saveLog();
    return log;
  }

  // Newest first; chunks split by byte size so no single key hits the cap.
  async function saveLog() {
    log = log.slice(0, MAX_LOG_ENTRIES);
    const chunks = [];
    let cur = [];
    let size = 2;
    for (const e of log) {
      const s = JSON.stringify(e).length + 1;
      if (cur.length && size + s > LOG_CHUNK_BYTES) {
        chunks.push(cur);
        cur = [];
        size = 2;
      }
      cur.push(e);
      size += s;
    }
    if (cur.length) chunks.push(cur);
    const prevN = Number(await cl.storage.get(K_LOG_INDEX)) || 0;
    for (let i = 0; i < chunks.length; i++) await cl.storage.set(logKey(i), chunks[i]);
    for (let i = chunks.length; i < prevN; i++) {
      try {
        await cl.storage.remove(logKey(i));
      } catch (e) {
        cl.log("mail log chunk remove failed:", e.message);
      }
    }
    await cl.storage.set(K_LOG_INDEX, chunks.length);
  }

  function archiveOldEntries() {
    const now = Date.now();
    let changed = false;
    const kept = [];
    for (const e of log) {
      if (e.archived && now - e.ts > LOG_DROP_ARCHIVED_AFTER_MS) {
        changed = true;
        continue;
      }
      if (!e.archived && now - e.ts > LOG_ARCHIVE_AFTER_MS) {
        e.archived = true;
        changed = true;
      }
      kept.push(e);
    }
    log = kept;
    return changed;
  }

  // ---------------------------------------------------------------- rules
  function normalizeRule(input) {
    const account = String(input.account || "").trim().toLowerCase();
    if (!account) throw new Error("account is required (mailbox address or *)");
    const from = String(input.from || "").trim();
    const subject = String(input.subject || "").trim();
    if (!from && !subject) throw new Error("rule needs from and/or subject");
    const action = String(input.action || "").trim();
    if (!MAIL_ACTIONS[action]) throw new Error(`action must be one of ${Object.keys(MAIL_ACTIONS).join(", ")}`);
    const instructions = String(input.instructions || "").trim();
    if (action === "agent" && !instructions) throw new Error("agent rules need instructions");
    return { account, from, subject, action, instructions, note: String(input.note || "").trim() };
  }

  async function saveRule(input) {
    await loadRules();
    const data = normalizeRule(input);
    const existing = input.id ? rules.find((r) => r.id === input.id) : null;
    if (existing) {
      Object.assign(existing, data);
      await saveRules();
      return existing;
    }
    const rule = { id: newId(), ...data, enabled: true, createdAt: Date.now(), hits: 0 };
    rules.unshift(rule);
    await saveRules();
    renderIfMounted();
    return rule;
  }

  async function deleteRule(id) {
    await loadRules();
    rules = rules.filter((r) => r.id !== id);
    await saveRules();
    renderIfMounted();
  }

  async function toggleRule(id, enabled) {
    await loadRules();
    const r = rules.find((x) => x.id === id);
    if (!r) return;
    r.enabled = enabled;
    await saveRules();
    renderIfMounted();
  }

  function rulesFor(account) {
    return rules.filter((r) => r.enabled !== false && (!account || r.account === "*" || r.account === account));
  }

  // ---------------------------------------------------------------- log
  async function appendLog(input) {
    await loadLog();
    const entry = {
      id: newId(),
      ts: Date.now(),
      account: String(input.account || "").trim().toLowerCase(),
      msgId: String(input.msgId || "").trim(),
      from: String(input.from || "").trim().slice(0, 200),
      subject: String(input.subject || "").trim().slice(0, 300),
      action: String(input.action || "").trim().slice(0, 40),
      ruleId: input.ruleId ? String(input.ruleId) : "",
      result: String(input.result || "").trim().slice(0, 500),
      body: String(input.body || "").trim().slice(0, BODY_CAP),
      dryRun: !!input.dryRun,
    };
    if (!entry.account || !entry.subject && !entry.from) throw new Error("account and from/subject are required");
    log.unshift(entry);
    if (entry.ruleId) {
      await loadRules();
      const r = rules.find((x) => x.id === entry.ruleId);
      if (r) {
        r.hits = (r.hits || 0) + 1;
        r.lastHitAt = entry.ts;
        await saveRules();
      }
    }
    await saveLog();
    renderIfMounted();
    return entry;
  }

  async function dropArchivedLog() {
    await loadLog();
    log = log.filter((e) => !e.archived);
    await saveLog();
    renderIfMounted();
  }

  // ---------------------------------------------------------------- settings
  async function isDryRun() {
    const v = await cl.storage.get(K_DRY_RUN);
    return v === undefined || v === null ? true : !!v;
  }
  async function autoMinutes() {
    return Number(await cl.storage.get(K_AUTO_MIN)) || 0;
  }

  // ---------------------------------------------------------------- the run
  // Everything the bot needs travels in the turn: rules as data, the exact
  // procedure, and the dry-run flag. Matching is spelled out so two runs
  // never disagree about what a rule covers.
  async function buildRunMessage(accounts) {
    await loadRules();
    const dry = await isDryRun();
    const active = accounts.flatMap((a) => rulesFor(a).map((r) => ({ ...r, appliesTo: a })));
    const rulesJson = JSON.stringify(
      active.map((r) => ({ id: r.id, account: r.appliesTo, from: r.from, subject: r.subject, action: r.action, instructions: r.instructions })),
    );
    return [
      "## Zadanie: przegląd nieprzeczytanych maili",
      `Skrzynki: ${accounts.join(", ")}.`,
      dry
        ? "TRYB PRÓBNY: nie wykonuj żadnych zmian w skrzynce (żadnego gmail_trash / gmail_modify). Zamiast tego loguj akcję z prefiksem `dry:` i opisz co byś zrobił."
        : "Tryb rzeczywisty: wykonuj akcje z zasad.",
      "",
      "### Procedura (dla każdej skrzynki osobno, parametr account = adres skrzynki)",
      "1. gmail_search query `is:unread in:inbox newer_than:14d`, max 40 wyników.",
      "2. Dla każdego maila dopasuj PIERWSZĄ pasującą zasadę z listy poniżej (kolejność listy). Zasada pasuje, gdy: `from` (jeśli podane) występuje w nagłówku From bez rozróżniania wielkości liter ORAZ `subject` (jeśli podany) występuje w temacie bez rozróżniania wielkości liter.",
      "3. Wykonaj akcję zasady:",
      "   - trash → gmail_trash",
      "   - archive → gmail_modify {archive:true, markRead:true}",
      "   - markRead → gmail_modify {markRead:true}",
      "   - notify → system_notify {source:'cyber-bot', title: temat, message: nadawca + 1-2 zdania streszczenia} i gmail_modify {markRead:true}",
      "   - agent → gmail_read (pełna treść), wykonaj `instructions` zasady i zdecyduj; efekt zrealizuj tymi samymi narzędziami (trash/modify/system_notify). W wątpliwościach: NIE usuwaj — powiadom.",
      "4. KAŻDY przetworzony mail zaloguj przez cyber-bot_mail_log {account, msgId, from, subject, action, ruleId, result, body}. `action` = co faktycznie zrobiłeś (trash / archive / markRead / notify / agent:<decyzja>; w trybie próbnym z prefiksem `dry:`). `body` = treść maila (tekst, max 4000 znaków) dla akcji agent i notify, dla pozostałych wystarczy snippet.",
      "5. Maile BEZ pasującej zasady: nie ruszaj ich. Zebrane pogrupuj po nadawcy.",
      "",
      "### Na koniec",
      "- Jeśli cokolwiek zrobiłeś lub są maile bez zasady: system_notify {source:'cyber-bot', title:'Maile: N przetworzonych, M do decyzji', message: krótkie podsumowanie}.",
      "- W odpowiedzi: krótka tabela co zrobiłeś, a potem lista maili bez zasady (nadawca, temat, 1 zdanie o treści) z pytaniem co z nimi zrobić i propozycją zasady (podaj gotowe `from`/`subject`). Gdy użytkownik odpowie, załóż zasady przez cyber-bot_mail_rule_save (pole account = skrzynka!) i wykonaj wskazane akcje na tych mailach.",
      "- Nigdy nie używaj innych narzędzi gmail niż search/read/modify/trash. Nigdy nie usuwaj maila, którego nie obejmuje zasada, chyba że użytkownik wprost o to prosi w tym wątku.",
      "",
      "### Zasady (DANE)",
      rulesJson === "[]" ? "(brak zasad — wszystkie maile trafią na listę do decyzji)" : rulesJson,
    ].join("\n");
  }

  // ---------------------------------------------------------------- page
  const state = { account: "", tab: "active", expanded: null, accounts: [] };

  function renderIfMounted() {
    if (pageEl?.isConnected) renderPage(pageEl);
  }

  async function renderPage(el) {
    pageEl = el;
    await Promise.all([loadRules(), loadLog()]);
    if (!state.accounts.length) {
      try {
        state.accounts = await cl.listEmailAccounts();
      } catch (e) {
        cl.log("email accounts unavailable:", e.message);
      }
    }
    const dry = await isDryRun();
    const auto = await autoMinutes();
    const acc = state.account;
    const shownRules = rules.filter((r) => !acc || r.account === acc || r.account === "*");
    const shownLog = log.filter((e) => (state.tab === "archive" ? e.archived : !e.archived) && (!acc || e.account === acc));
    const accOpts = (withAll, allLabel) =>
      (withAll ? [`<option value="">${allLabel}</option>`] : [])
        .concat(state.accounts.map((a) => `<option value="${esc(a)}" ${a === acc ? "selected" : ""}>${esc(a)}</option>`))
        .join("");

    el.innerHTML = `
      <div class="cb-mail">
        <div class="cb-mail-bar">
          <select id="cbmAcc">${accOpts(true, "wszystkie skrzynki")}</select>
          <button class="cb-send cb-mail-run" id="cbmRun" ${deps.isBusy() ? "disabled" : ""}>📧 Sprawdź maile teraz</button>
          <label class="cb-mail-check"><input type="checkbox" id="cbmDry" ${dry ? "checked" : ""}> tryb próbny (bez zmian w skrzynce)</label>
          <label class="cb-mail-check">co <input type="number" id="cbmAuto" min="0" step="5" value="${auto}" style="width:56px"> min automatycznie (0 = wył.)</label>
        </div>
        <details class="cb-mail-sec" open>
          <summary>Zasady (${shownRules.length})</summary>
          <div class="cb-mail-rules">
            ${shownRules.length ? shownRules.map(ruleRow).join("") : '<div class="cb-hint">Brak zasad. Uruchom przegląd — bot zaproponuje zasady dla maili, które znajdzie. Możesz też dodać ręcznie poniżej.</div>'}
          </div>
          <form class="cb-mail-form" id="cbmForm">
            <select name="account" required>${state.accounts.map((a) => `<option value="${esc(a)}">${esc(a)}</option>`).join("")}<option value="*">* (wszystkie)</option></select>
            <input name="from" placeholder="nadawca zawiera… (np. familylink-noreply@google.com)">
            <input name="subject" placeholder="temat zawiera… (opcjonalnie)">
            <select name="action">${Object.entries(MAIL_ACTIONS).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join("")}</select>
            <input name="instructions" placeholder="instrukcja dla bota (dla akcji „Instrukcja dla bota”)">
            <button class="cb-send" type="submit" style="height:32px">Dodaj zasadę</button>
          </form>
        </details>
        <details class="cb-mail-sec" open>
          <summary>Log (${shownLog.length}) <span class="cb-mail-tabs"><button data-tab="active" class="${state.tab === "active" ? "on" : ""}">aktywne</button><button data-tab="archive" class="${state.tab === "archive" ? "on" : ""}">archiwum (&gt;90 dni)</button>${state.tab === "archive" && shownLog.length ? '<button data-act="drop-archive">usuń archiwum</button>' : ""}</span></summary>
          <div class="cb-mail-log">
            ${shownLog.length ? shownLog.slice(0, 300).map(logRow).join("") : '<div class="cb-hint">Pusto.</div>'}
          </div>
        </details>
      </div>`;

    el.querySelector("#cbmAcc").addEventListener("change", (e) => {
      state.account = e.target.value;
      renderPage(el);
    });
    el.querySelector("#cbmRun").addEventListener("click", () => deps.startRun(acc ? [acc] : state.accounts));
    el.querySelector("#cbmDry").addEventListener("change", (e) => cl.storage.set(K_DRY_RUN, e.target.checked));
    el.querySelector("#cbmAuto").addEventListener("change", async (e) => {
      await cl.storage.set(K_AUTO_MIN, Math.max(0, Number(e.target.value) || 0));
      await scheduleAuto();
    });
    el.querySelector("#cbmForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      try {
        await saveRule(Object.fromEntries(fd.entries()));
      } catch (err) {
        alert(err.message);
      }
    });
    el.querySelectorAll("[data-rule-del]").forEach((b) => b.addEventListener("click", () => deleteRule(b.dataset.ruleDel)));
    el.querySelectorAll("[data-rule-toggle]").forEach((b) =>
      b.addEventListener("change", () => toggleRule(b.dataset.ruleToggle, b.checked)),
    );
    el.querySelectorAll("[data-tab]").forEach((b) =>
      b.addEventListener("click", (e) => {
        e.preventDefault();
        state.tab = b.dataset.tab;
        renderPage(el);
      }),
    );
    el.querySelector('[data-act="drop-archive"]')?.addEventListener("click", async (e) => {
      e.preventDefault();
      if (confirm("Usunąć zarchiwizowane wpisy logu?")) await dropArchivedLog();
    });
    el.querySelectorAll(".cb-mail-entry").forEach((row) =>
      row.addEventListener("click", (e) => {
        if (e.target.closest("a")) return;
        state.expanded = state.expanded === row.dataset.id ? null : row.dataset.id;
        renderPage(el);
      }),
    );
  }

  function ruleRow(r) {
    return `
      <div class="cb-mail-rule ${r.enabled === false ? "off" : ""}">
        <input type="checkbox" data-rule-toggle="${esc(r.id)}" ${r.enabled === false ? "" : "checked"} title="włączona">
        <span class="cb-mail-acc">${esc(r.account)}</span>
        <span class="cb-mail-match">${r.from ? `od: <b>${esc(r.from)}</b>` : ""}${r.from && r.subject ? " · " : ""}${r.subject ? `temat: <b>${esc(r.subject)}</b>` : ""}</span>
        <span class="cb-mail-action">${esc(MAIL_ACTIONS[r.action] || r.action)}</span>
        ${r.instructions ? `<span class="cb-mail-instr" title="${esc(r.instructions)}">${esc(truncate(r.instructions, 90))}</span>` : ""}
        <span class="cb-meta">${r.hits || 0}×</span>
        <button class="cb-thread-del" style="display:inline;position:static" data-rule-del="${esc(r.id)}" title="Usuń zasadę">✕</button>
      </div>`;
  }

  function logRow(e) {
    const open = state.expanded === e.id;
    const rule = e.ruleId ? rules.find((r) => r.id === e.ruleId) : null;
    return `
      <div class="cb-mail-entry ${open ? "open" : ""}" data-id="${esc(e.id)}">
        <div class="cb-mail-entry-head">
          <span class="cb-meta">${new Date(e.ts).toLocaleString("pl-PL")}</span>
          <span class="cb-mail-acc">${esc(e.account)}</span>
          <span class="cb-mail-action ${e.dryRun || e.action.startsWith("dry:") ? "dry" : ""}">${esc(e.action)}</span>
          <span class="cb-mail-from">${esc(truncate(e.from, 40))}</span>
          <span class="cb-mail-subj">${esc(truncate(e.subject, 80))}</span>
        </div>
        ${open ? `
          <div class="cb-mail-entry-body">
            <div><b>Wynik:</b> ${esc(e.result || "—")}${rule ? ` · <b>zasada:</b> ${esc(rule.from || "")} ${esc(rule.subject || "")} → ${esc(MAIL_ACTIONS[rule.action] || rule.action)}` : ""}${e.msgId ? ` · <span class="cb-meta">id ${esc(e.msgId)}</span>` : ""}</div>
            <pre>${esc(e.body || "(brak zapisanej treści)")}</pre>
          </div>` : ""}
      </div>`;
  }

  // ---------------------------------------------------------------- auto run
  async function scheduleAuto() {
    if (autoTimer) clearInterval(autoTimer);
    autoTimer = null;
    const min = await autoMinutes();
    if (min <= 0) return;
    autoTimer = setInterval(async () => {
      if (deps.isBusy()) return;
      let accounts = state.accounts;
      if (!accounts.length) {
        try {
          accounts = await cl.listEmailAccounts();
        } catch (e) {
          cl.log("auto mail run: accounts unavailable:", e.message);
          return;
        }
      }
      if (accounts.length) deps.startRun(accounts, { silent: true });
    }, min * 60 * 1000);
  }

  return {
    K_MAIL_THREAD,
    MAIL_THREAD_RESET_AFTER,
    loadRules,
    rulesFor,
    isDryRun,
    saveRule,
    appendLog,
    buildRunMessage,
    renderPage,
    scheduleAuto,
    dispose() {
      if (autoTimer) clearInterval(autoTimer);
      pageEl = null;
    },
  };
}
