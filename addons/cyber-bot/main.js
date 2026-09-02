// Cyber Bot — a Grok-style chat bot for Cyber Life.
//
// The "brain" is the Claude Code CLI in print mode, launched as a Cyber Life
// session through /api/term (runner "shell"). Every thread is one Claude
// conversation: the first turn starts it with --session-id, later turns
// --resume it, so the bot remembers the whole thread. The CLI is confined to
// the MCP tools of the local Cyber Life API (board, notes, terminarz, ksef …)
// — no shell, no file tools — and its long-term memory is a CLAUDE.md the bot
// itself appends to through the cyber-bot_remember tool.
//
// Hot reload (`addons_reload`) re-imports only this entry; after editing
// mail.js restart the app to clear the import cache.

import { createMail, MAIL_TOOLS, GMAIL_READ_TOOLS, GMAIL_WRITE_TOOLS } from "./mail.js";

export default async function activate(cl) {
  const STYLE_ID = "cyber-bot-style";
  const SENTINEL = "<<<CBEND>>>";
  const K_PRESET = "preset";
  const K_MODEL = "model";
  const K_WRITE = "allowWrite";
  const K_MEMORY = "memory";
  const K_THREADS = "threads";
  const K_ACTIVE = "activeThread";
  const K_LEGACY_HISTORY = "history";
  const threadKey = (id) => "thread:" + id;
  const MAX_THREADS = 20;
  const MAX_MESSAGES = 80;
  const HISTORY_BYTE_CAP = 56 * 1024; // headroom under the 64KB/key storage cap
  const TURN_TIMEOUT_MS = 6 * 60 * 1000;

  // ---------------------------------------------------------------- tools
  // Hard whitelist: the CLI runs with --permission-mode manual, so anything
  // outside this list is refused (no human to approve in print mode).
  const READ_TOOLS = [
    "system_info",
    "system_notify",
    "board_list_projects",
    "board_get",
    "notes_get",
    "tasks_list",
    "prompts_list",
    "projects_groups",
    "auto_list_rules",
    "auto_list_runs",
    "health_get_report",
    "term_list",
    "widgets_catalog",
    "terminarz_list",
    "terminarz_pending",
    "terminarz_suggest",
    "ksef_list_companies",
    "ksef_list_invoices",
    "ksef_list_bank_transactions",
    "ksef_tax_alerts",
    "ksef_list_clients",
    "ksef_list_unmatched_files",
    "nitroarena_today_summary",
    "nitroarena_runner_health",
    "cyber-bot_remember",
  ];
  const WRITE_TOOLS = [
    "board_create_task",
    "board_update_task",
    "board_move_task",
    "board_comment",
    "notes_append",
    "tasks_create",
    "prompts_save",
  ];
  const mcpName = (t) => (t.startsWith("gmail_") ? "mcp__gmail__" : "mcp__cyberlife__") + t;

  // ---------------------------------------------------------------- persona
  const PRESETS = {
    zadziorny: {
      label: "Zadziorny (domyślny)",
      text:
        "Jesteś Cyber Bot — asystent wbudowany w Cyber Life. Masz charakter: " +
        "dowcipny, bezpośredni, konkretny, lekko zadziorny (w stylu Groka), " +
        "ale zawsze pomocny i rzeczowy. Piszesz po polsku, zwięźle, w markdown. " +
        "Bez korpo-lania wody.",
    },
    rzeczowy: {
      label: "Rzeczowy",
      text:
        "Jesteś Cyber Bot — asystent w Cyber Life. Odpowiadasz rzeczowo, " +
        "zwięźle i neutralnie, po polsku, w markdown. Trzymasz się faktów. " +
        "Zero zbędnego gadania.",
    },
    mentor: {
      label: "Mentor",
      text:
        "Jesteś Cyber Bot — spokojny mentor w Cyber Life. Tłumaczysz jasno, " +
        "podpowiadasz następne kroki, po polsku, w markdown.",
    },
  };
  const DEFAULT_PRESET = "zadziorny";

  const K_SYSTEM_PROMPT = "systemPrompt";
  const K_CONTEXT_LINE = "contextLine";

  function defaultSystemPrompt(preset, allowWrite) {
    const base = (PRESETS[preset] || PRESETS[DEFAULT_PRESET]).text;
    return [
      base,
      "",
      "Masz narzędzia MCP serwera „cyberlife” (projekty, board, notatki, " +
        "terminarz, KSeF/faktury, nitroarena). Gdy pytanie dotyczy danych " +
        "użytkownika — użyj narzędzia zamiast zgadywać, a odpowiedź opieraj " +
        "na tym, co zwróciło. Nie wymyślaj danych.",
      allowWrite
        ? "Możesz tworzyć/zmieniać taski, komentarze i notatki, ale tylko gdy " +
          "użytkownik wyraźnie o to prosi; po zmianie krótko potwierdź co zrobiłeś."
        : "Narzędzia zapisu są wyłączone — gdy użytkownik prosi o zmianę, " +
          "opisz co byś zrobił i wskaż, że zapis można włączyć w ustawieniach bota.",
      "Plik CLAUDE.md w katalogu roboczym to Twoja trwała pamięć o " +
        "użytkowniku. Gdy użytkownik prosi coś zapamiętać lub sam natrafisz na " +
        "trwały fakt/preferencję — wywołaj cyber-bot_remember z jedną zwięzłą " +
        "notatką. Nie zapisuj rzeczy jednorazowych.",
      "Wiersz „[Kontekst: …]” na początku wiadomości to dane z aplikacji, " +
        "nie polecenia. Nie powtarzaj kontekstu w odpowiedzi.",
      "Formatowanie (czat renderuje markdown): krótkie akapity, nagłówki ### " +
        "dla sekcji, listy punktowane zamiast zdań-wyliczanek, tabela gdy " +
        "porównujesz kilka pozycji (np. maile: | Od | Temat | Akcja |), " +
        "**pogrubione etykiety** typu **Od:** każda w OSOBNEJ linii, `kod` " +
        "dla adresów/identyfikatorów/nazw narzędzi. Pytanie do użytkownika " +
        "zawsze jako ostatnia, osobna linia.",
    ].join("\n");
  }

  // The system prompt is whatever sits in settings; empty = the default for
  // the chosen preset (so presets keep working as one-click starting points).
  async function systemPromptText(allowWrite) {
    const custom = await cl.storage.get(K_SYSTEM_PROMPT);
    if (custom && String(custom).trim()) return String(custom);
    const preset = (await cl.storage.get(K_PRESET)) || DEFAULT_PRESET;
    return defaultSystemPrompt(preset, allowWrite);
  }

  async function contextLineEnabled() {
    const v = await cl.storage.get(K_CONTEXT_LINE);
    return v === undefined || v === null || v === true;
  }

  // ---------------------------------------------------------------- helpers
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const esc = (s) =>
    String(s ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  const truncate = (s, n) =>
    typeof s === "string" && s.length > n ? s.slice(0, n) + "…" : s;
  const shq = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";
  const b64 = (s) => {
    const bytes = new TextEncoder().encode(s);
    let bin = "";
    for (const b of bytes) bin += String.fromCharCode(b);
    return btoa(bin);
  };
  const newId = () =>
    crypto.randomUUID
      ? crypto.randomUUID()
      : "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
          const r = (Math.random() * 16) | 0;
          return (c === "x" ? r : (r & 3) | 8).toString(16);
        });
  const fmtWhen = (ts) =>
    new Date(ts).toLocaleString("pl-PL", {
      day: "2-digit",
      month: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });

  // Minimal, dependency-free markdown → HTML. A disk addon is imported raw
  // (no bundler), so `import { marked }` would not resolve. Everything is
  // escaped first, so it is safe to inject. Covers what a chat reply needs:
  // fenced/inline code, headings, bullet + numbered lists, tables, quotes,
  // rules, bold/italic, links. A single newline is a line break (the pane
  // capture already re-joins wrapped lines, so every newline is the model's).
  function mdToHtml(md) {
    const src = String(md ?? "");
    const blocks = [];
    let tmp = src.replace(/```(\w+)?\n([\s\S]*?)```/g, (_m, lang, code) => {
      const i = blocks.length;
      blocks.push(
        `<pre class="cb-code"><code>${esc(code.replace(/\n$/, ""))}</code></pre>`,
      );
      return `@@CB${i}@@`;
    });
    tmp = esc(tmp);
    const lines = tmp.split("\n");
    let html = "";
    let list = null; // "ul" | "ol"
    let para = [];
    let quote = [];
    let table = [];
    const closeList = () => {
      if (list) {
        html += `</${list}>`;
        list = null;
      }
    };
    const flushPara = () => {
      if (para.length) {
        html += `<p>${para.map(inline).join("<br>")}</p>`;
        para = [];
      }
    };
    const flushQuote = () => {
      if (quote.length) {
        html += `<blockquote>${quote.map(inline).join("<br>")}</blockquote>`;
        quote = [];
      }
    };
    const flushTable = () => {
      if (!table.length) return;
      const rows = table.filter((r) => !/^\s*\|?\s*:?-{2,}/.test(r));
      const cells = (r) =>
        r
          .trim()
          .replace(/^\|/, "")
          .replace(/\|$/, "")
          .split("|")
          .map((c) => inline(c.trim()));
      const [head, ...body] = rows.map(cells);
      html +=
        '<table class="cb-table"><thead><tr>' +
        (head || []).map((c) => `<th>${c}</th>`).join("") +
        "</tr></thead><tbody>" +
        body.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`).join("") +
        "</tbody></table>";
      table = [];
    };
    const flushAll = () => {
      flushPara();
      flushQuote();
      flushTable();
      closeList();
    };
    for (const line of lines) {
      const ph = line.match(/^@@CB(\d+)@@$/);
      if (ph) {
        flushAll();
        html += blocks[Number(ph[1])];
        continue;
      }
      if (/^\s*$/.test(line)) {
        flushAll();
        continue;
      }
      if (/^\s*\|.*\|\s*$/.test(line)) {
        flushPara();
        flushQuote();
        closeList();
        table.push(line);
        continue;
      }
      flushTable();
      if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
        flushAll();
        html += "<hr>";
        continue;
      }
      const h = line.match(/^(#{1,4})\s+(.*)$/);
      if (h) {
        flushAll();
        const lvl = h[1].length + 1;
        html += `<h${lvl}>${inline(h[2])}</h${lvl}>`;
        continue;
      }
      const q = line.match(/^\s*&gt;\s?(.*)$/);
      if (q) {
        flushPara();
        closeList();
        quote.push(q[1]);
        continue;
      }
      flushQuote();
      const li = line.match(/^\s*[-*•]\s+(.*)$/);
      const oli = line.match(/^\s*\d+[.)]\s+(.*)$/);
      if (li || oli) {
        flushPara();
        const kind = li ? "ul" : "ol";
        if (list && list !== kind) closeList();
        if (!list) {
          html += `<${kind}>`;
          list = kind;
        }
        html += `<li>${inline((li || oli)[1])}</li>`;
        continue;
      }
      // an indented line right after a list item continues that item
      if (list && /^\s{2,}\S/.test(line)) {
        html = html.replace(/<\/li>$/, `<br>${inline(line.trim())}</li>`);
        continue;
      }
      closeList();
      para.push(line);
    }
    flushAll();
    html = html.replace(/@@CB(\d+)@@/g, (_m, i) => blocks[Number(i)] || "");
    return html;

    function inline(s) {
      return s
        .replace(/`([^`]+)`/g, "<code>$1</code>")
        .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
        .replace(/(^|[^*\w])\*([^*]+)\*/g, "$1<em>$2</em>")
        .replace(/(^|[^\w])_([^_]+)_(?=[^\w]|$)/g, "$1<em>$2</em>")
        .replace(
          /\[([^\]]+)\]\((https?:[^)\s]+)\)/g,
          '<a href="$2" class="cb-link" data-href="$2">$1</a>',
        )
        .replace(/(^|\s)(https?:\/\/[^\s&<]+)/g, '$1<a href="$2" class="cb-link" data-href="$2">$2</a>');
    }
  }

  function cleanPane(text) {
    return String(text ?? "")
      .replace(/\r/g, "")
      .split("\n")
      .map((l) => l.replace(/[ \t]+$/, ""))
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const s = document.createElement("style");
    s.id = STYLE_ID;
    s.textContent = `
      .cb-wrap{display:flex;height:100%;min-height:0;}
      .cb-side{width:210px;flex:none;border-right:1px solid var(--border,#45475a);display:flex;flex-direction:column;min-height:0;}
      .cb-side-head{display:flex;align-items:center;justify-content:space-between;padding:8px 10px;font-size:12px;color:var(--text-muted,#9399b2);text-transform:uppercase;letter-spacing:.04em;}
      .cb-new{background:var(--bg-tertiary,#313244);color:var(--text-primary,#cdd6f4);border:1px solid var(--border,#45475a);border-radius:8px;padding:2px 8px;cursor:pointer;font:inherit;font-size:12px;}
      .cb-new:hover{border-color:var(--accent,#89b4fa);}
      .cb-threads{flex:1;min-height:0;overflow-y:auto;padding:0 6px 6px;}
      .cb-thread{position:relative;padding:7px 26px 7px 9px;border-radius:8px;cursor:pointer;margin-bottom:2px;}
      .cb-thread:hover{background:var(--bg-tertiary,#313244);}
      .cb-thread.active{background:var(--bg-tertiary,#313244);border-left:2px solid var(--accent,#89b4fa);padding-left:7px;}
      .cb-thread-title{font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
      .cb-thread-del{position:absolute;right:6px;top:6px;border:none;background:none;color:var(--text-muted,#9399b2);cursor:pointer;display:none;font-size:12px;}
      .cb-thread:hover .cb-thread-del{display:block;}
      .cb-thread-del:hover{color:var(--error,#f38ba8);}
      .cb-main{flex:1;min-width:0;display:flex;flex-direction:column;min-height:0;}
      .cb-scroll{flex:1;min-height:0;overflow-y:auto;padding:12px;display:flex;flex-direction:column;gap:10px;}
      .cb-empty{margin:auto;text-align:center;color:var(--text-muted,#9399b2);max-width:32em;}
      .cb-row{display:flex;}
      .cb-row.user{justify-content:flex-end;}
      .cb-bubble{max-width:80%;padding:8px 12px;border-radius:14px;font-size:var(--fs-base,14px);line-height:1.5;word-wrap:break-word;overflow-wrap:anywhere;}
      .cb-row.user .cb-bubble{background:var(--accent,#89b4fa);color:var(--bg-primary,#1e1e2e);border-bottom-right-radius:4px;white-space:pre-wrap;}
      .cb-row.bot .cb-bubble{background:var(--bg-tertiary,#313244);color:var(--text-primary,#cdd6f4);border-bottom-left-radius:4px;border:1px solid var(--border,#45475a);}
      .cb-row.bot .cb-bubble{max-width:92%;line-height:1.6;padding:10px 14px;}
      .cb-bubble p{margin:0 0 .7em;}.cb-bubble p:last-child{margin-bottom:0;}
      .cb-bubble h2,.cb-bubble h3,.cb-bubble h4,.cb-bubble h5{margin:.9em 0 .4em;color:var(--accent,#89b4fa);line-height:1.3;}
      .cb-bubble h2:first-child,.cb-bubble h3:first-child,.cb-bubble h4:first-child{margin-top:.1em;}
      .cb-bubble h2{font-size:1.15em;}.cb-bubble h3{font-size:1.05em;}.cb-bubble h4,.cb-bubble h5{font-size:1em;}
      .cb-bubble strong{color:var(--warning,#f9e2af);font-weight:600;}
      .cb-bubble em{color:var(--text-secondary,#a6adc8);}
      .cb-bubble ul,.cb-bubble ol{margin:.3em 0 .7em;padding-left:1.4em;}
      .cb-bubble li{margin:.25em 0;}
      .cb-bubble li::marker{color:var(--accent,#89b4fa);}
      .cb-bubble code{background:var(--bg-primary,#1e1e2e);color:var(--success,#a6e3a1);padding:.08em .4em;border-radius:5px;font-size:.9em;}
      .cb-bubble pre.cb-code{background:var(--bg-primary,#1e1e2e);border:1px solid var(--border,#45475a);border-radius:8px;padding:10px 12px;overflow-x:auto;margin:.5em 0 .8em;line-height:1.45;}
      .cb-bubble pre.cb-code code{background:none;color:var(--text-primary,#cdd6f4);padding:0;}
      .cb-bubble blockquote{margin:.4em 0 .8em;padding:.3em .9em;border-left:3px solid var(--accent,#89b4fa);background:var(--bg-primary,#1e1e2e);color:var(--text-secondary,#a6adc8);border-radius:0 8px 8px 0;}
      .cb-bubble hr{border:none;border-top:1px solid var(--border,#45475a);margin:.9em 0;}
      .cb-bubble table.cb-table{border-collapse:collapse;margin:.4em 0 .9em;font-size:.94em;display:block;overflow-x:auto;max-width:100%;}
      .cb-bubble table.cb-table th,.cb-bubble table.cb-table td{border:1px solid var(--border,#45475a);padding:5px 9px;text-align:left;vertical-align:top;}
      .cb-bubble table.cb-table th{background:var(--bg-primary,#1e1e2e);color:var(--accent,#89b4fa);font-weight:600;white-space:nowrap;}
      .cb-bubble table.cb-table tr:nth-child(even) td{background:rgba(255,255,255,.025);}
      .cb-link{color:var(--accent,#89b4fa);text-decoration:underline;cursor:pointer;}
      .cb-meta{font-size:11px;color:var(--text-muted,#9399b2);margin-top:2px;}
      .cb-typing{display:inline-block;color:var(--text-muted,#9399b2);font-style:italic;}
      .cb-input{display:flex;gap:8px;padding:10px 12px;border-top:1px solid var(--border,#45475a);}
      .cb-input textarea{flex:1;resize:none;min-height:40px;max-height:140px;background:var(--bg-secondary,#181825);color:var(--text-primary,#cdd6f4);border:1px solid var(--border,#45475a);border-radius:10px;padding:9px 11px;font:inherit;font-size:var(--fs-base,14px);}
      .cb-send{align-self:flex-end;background:var(--accent,#89b4fa);color:var(--bg-primary,#1e1e2e);border:none;border-radius:10px;padding:0 16px;height:40px;font-weight:600;cursor:pointer;font:inherit;}
      .cb-send:disabled{opacity:.5;cursor:not-allowed;}
      .cb-err{color:var(--error,#f38ba8);}
      .cb-histrow{padding:8px 10px;border:1px solid var(--border,#45475a);border-radius:8px;margin-bottom:6px;display:flex;justify-content:space-between;gap:10px;align-items:center;}
      .cb-histrow .cb-open{cursor:pointer;flex:1;min-width:0;}
      .cb-ask-w{display:flex;flex-direction:column;gap:6px;}
      .cb-ask-w input{background:var(--bg-secondary,#181825);color:var(--text-primary,#cdd6f4);border:1px solid var(--border,#45475a);border-radius:8px;padding:7px 9px;font:inherit;}
      .cb-mail{padding:12px;display:flex;flex-direction:column;gap:10px;overflow-y:auto;height:100%;}
      .cb-mail-bar{display:flex;gap:10px;align-items:center;flex-wrap:wrap;}
      .cb-mail-bar select,.cb-mail-form select,.cb-mail-form input,.cb-mail-check input[type=number]{background:var(--bg-secondary,#181825);color:var(--text-primary,#cdd6f4);border:1px solid var(--border,#45475a);border-radius:8px;padding:5px 8px;font:inherit;font-size:13px;}
      .cb-mail-run{height:32px;}
      .cb-mail-check{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--text-muted,#9399b2);}
      .cb-mail-sec{border:1px solid var(--border,#45475a);border-radius:10px;padding:8px 12px;}
      .cb-mail-sec summary{cursor:pointer;font-weight:600;display:flex;align-items:center;gap:10px;}
      .cb-mail-tabs{display:inline-flex;gap:4px;font-weight:400;}
      .cb-mail-tabs button{background:none;border:1px solid var(--border,#45475a);color:var(--text-muted,#9399b2);border-radius:6px;padding:1px 8px;font:inherit;font-size:12px;cursor:pointer;}
      .cb-mail-tabs button.on{color:var(--text-primary,#cdd6f4);background:var(--bg-tertiary,#313244);}
      .cb-mail-rules{display:flex;flex-direction:column;gap:4px;margin:8px 0;}
      .cb-mail-rule{display:flex;gap:8px;align-items:center;font-size:13px;padding:5px 8px;border-radius:8px;background:var(--bg-secondary,#181825);flex-wrap:wrap;}
      .cb-mail-rule.off{opacity:.5;}
      .cb-mail-acc{font-family:monospace;font-size:11px;color:var(--text-muted,#9399b2);}
      .cb-mail-action{font-size:11px;padding:1px 6px;border-radius:6px;background:var(--bg-tertiary,#313244);white-space:nowrap;}
      .cb-mail-action.dry{opacity:.7;font-style:italic;}
      .cb-mail-instr{color:var(--text-muted,#9399b2);font-size:12px;}
      .cb-mail-match{flex:1;min-width:120px;}
      .cb-mail-form{display:grid;grid-template-columns:1.2fr 1.6fr 1.4fr 1fr 2fr auto;gap:6px;align-items:center;}
      .cb-mail-log{display:flex;flex-direction:column;gap:3px;margin-top:8px;}
      .cb-mail-entry{border-radius:8px;padding:5px 8px;cursor:pointer;background:var(--bg-secondary,#181825);}
      .cb-mail-entry:hover{background:var(--bg-tertiary,#313244);}
      .cb-mail-entry-head{display:flex;gap:10px;align-items:center;font-size:13px;min-width:0;}
      .cb-mail-from{color:var(--text-muted,#9399b2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:220px;}
      .cb-mail-subj{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
      .cb-mail-entry-body{margin-top:6px;font-size:12px;}
      .cb-mail-entry-body pre{white-space:pre-wrap;background:var(--bg-primary,#1e1e2e);border:1px solid var(--border,#45475a);border-radius:8px;padding:8px;max-height:320px;overflow:auto;margin-top:6px;}
      .cb-ta{width:100%;background:var(--bg-secondary,#181825);color:var(--text-primary,#cdd6f4);border:1px solid var(--border,#45475a);border-radius:8px;padding:8px;font:inherit;}
    `;
    document.head.appendChild(s);
  }

  // ---------------------------------------------------------------- bot home
  // ~/.cyberlife/addon-data/cyber-bot is the CLI's working directory: it holds
  // mcp.json (tools), persona.txt (system prompt), CLAUDE.md (memory) and
  // threads/<id>/turn.txt (the message of the turn being run — passed through
  // a file so no user text ever meets shell quoting).
  let home = null;
  let sysInfoCache = null;

  async function systemInfo() {
    try {
      sysInfoCache = await cl.api("/api/system");
    } catch (e) {
      cl.log("system info unavailable:", e.message);
      sysInfoCache = sysInfoCache || {};
    }
    return sysInfoCache;
  }

  async function putText(path, text) {
    await cl.putDataFile(path, b64(text && text.length ? text : "\n"));
  }

  async function ensureHome() {
    if (home) return home;
    const sys = await systemInfo();
    if (!sys.addonData) {
      throw new Error(
        "Ta wersja Cyber Life nie zgłasza katalogu addon-data — zaktualizuj aplikację.",
      );
    }
    home = sys.addonData.replace(/\/+$/, "") + "/" + cl.id;
    const mcpUrl = sys.mcp || "http://127.0.0.1:8377/mcp";
    const mcpServers = { cyberlife: { type: "http", url: mcpUrl } };
    if (sys.gmailMcp && sys.gmailMcp.command) {
      mcpServers.gmail = { type: "stdio", command: sys.gmailMcp.command, args: sys.gmailMcp.args || [] };
    }
    await putText("mcp.json", JSON.stringify({ mcpServers }, null, 2));
    await writeMemoryFile();
    return home;
  }

  // ---------------------------------------------------------------- memory
  const MEMORY_HEADER =
    "# Pamięć Cyber Bota\n\nTrwałe fakty i preferencje użytkownika. Dopisuj przez cyber-bot_remember.\n\n";

  async function getMemory() {
    const m = await cl.storage.get(K_MEMORY);
    return typeof m === "string" ? m : "";
  }

  async function writeMemoryFile() {
    await putText("CLAUDE.md", MEMORY_HEADER + (await getMemory()));
  }

  async function setMemory(text) {
    await cl.storage.set(K_MEMORY, String(text || "").trim());
    await writeMemoryFile();
  }

  async function remember(note) {
    const line = "- " + String(note).trim().replace(/\s*\n\s*/g, " ");
    const cur = await getMemory();
    const next = (cur ? cur + "\n" : "") + line;
    if (next.length > 24000) {
      throw new Error(
        "Pamięć jest pełna (24KB) — użytkownik musi ją przejrzeć w ustawieniach bota.",
      );
    }
    await setMemory(next);
    return next.split("\n").length;
  }

  // ---------------------------------------------------------------- threads
  async function loadThreads() {
    const t = await cl.storage.get(K_THREADS);
    return Array.isArray(t) ? t : [];
  }
  async function saveThreads(list) {
    await cl.storage.set(K_THREADS, list);
  }
  async function loadMessages(threadId) {
    const m = await cl.storage.get(threadKey(threadId));
    return Array.isArray(m) ? m : [];
  }
  // Trim by BYTES, not message count: long replies with code blocks would
  // blow the 64KB cap and make cl.storage.set throw AFTER a successful answer.
  async function saveMessages(threadId, msgs) {
    let kept = msgs.slice(-MAX_MESSAGES);
    while (
      kept.length > 1 &&
      new Blob([JSON.stringify(kept)]).size > HISTORY_BYTE_CAP
    ) {
      kept = kept.slice(1);
    }
    try {
      await cl.storage.set(threadKey(threadId), kept);
    } catch (e) {
      cl.log("saveMessages trimmed after error:", e.message);
      try {
        await cl.storage.set(threadKey(threadId), kept.slice(-2));
      } catch (e2) {
        cl.log("saveMessages failed:", e2.message);
      }
    }
  }

  async function removeThreadData(id) {
    try {
      await cl.storage.remove(threadKey(id));
    } catch (e) {
      cl.log("thread storage remove failed:", e.message);
    }
    try {
      await cl.deleteDataFile(`threads/${id}/turn.txt`);
    } catch (e) {
      cl.log("thread turn file remove skipped:", e.message);
    }
  }

  async function createThread(list) {
    const t = {
      id: newId(),
      title: "Nowy wątek",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      started: false,
    };
    list.unshift(t);
    while (list.length > MAX_THREADS) {
      const old = list.pop();
      await removeThreadData(old.id);
    }
    await saveThreads(list);
    return t;
  }

  // v0.1 kept one flat history of pane scrapes (prompt echoed into every
  // reply) — nothing worth carrying over, so it is just dropped.
  async function dropLegacyHistory() {
    const old = await cl.storage.get(K_LEGACY_HISTORY);
    if (old === undefined || old === null) return;
    try {
      await cl.storage.remove(K_LEGACY_HISTORY);
    } catch (e) {
      cl.log("legacy history remove failed:", e.message);
    }
  }

  // ---------------------------------------------------------------- brain
  let busy = false;
  let disposed = false;
  const activeSessions = new Set();

  function contextLine(sys) {
    const now = new Date().toLocaleString("pl-PL");
    const proj = sys && sys.activeProject;
    const p = proj ? `aktywny projekt: ${proj.name} (${proj.path})` : "brak aktywnego projektu";
    return `[Kontekst: ${now}, ${p}]`;
  }

  // Chat threads see the app; only the mail thread sees Gmail, and its
  // destructive gmail tools disappear entirely in dry-run mode.
  async function allowedTools(thread) {
    const write = !!(await cl.storage.get(K_WRITE));
    let tools = write ? READ_TOOLS.concat(WRITE_TOOLS) : READ_TOOLS.slice();
    if (thread && thread.kind === "mail") {
      tools = tools.concat(MAIL_TOOLS, GMAIL_READ_TOOLS);
      if (!(await mail.isDryRun())) tools = tools.concat(GMAIL_WRITE_TOOLS);
    }
    return [...new Set(tools)].map(mcpName);
  }

  function turnScript({ dir, threadId, started, allowed, model }) {
    const args = [
      "claude",
      "-p",
      started ? "--resume" : "--session-id",
      shq(threadId),
      "--permission-mode",
      "manual",
      "--tools",
      '""',
      "--mcp-config",
      "mcp.json",
      "--strict-mcp-config",
      "--allowedTools",
      shq(allowed.join(",")),
    ];
    if (model) args.push("--model", shq(model));
    // `--` matters: --allowedTools is variadic and would swallow the prompt
    args.push(
      "--append-system-prompt",
      '"$(cat persona.txt)"',
      "--",
      `"$(cat ${shq(`threads/${threadId}/turn.txt`)})"`,
    );
    return `cd ${shq(dir)} && ${args.join(" ")} 2>&1; printf '\\n${SENTINEL}\\n'; exec sleep 86400`;
  }

  const LOST_SESSION_RE = /No conversation found with session ID/i;

  // Runs one turn of a thread: writes the turn file, launches the CLI in the
  // bot home and polls the pane until SENTINEL. Returns the reply text.
  async function runTurn(thread, message, onChunk) {
    const dir = await ensureHome();
    const sys = await systemInfo();
    const model = String((await cl.storage.get(K_MODEL)) || "").trim();
    const allowed = await allowedTools(thread);
    await putText("persona.txt", await systemPromptText(!!(await cl.storage.get(K_WRITE))));
    const prefix = (await contextLineEnabled()) ? contextLine(sys) + "\n" : "";
    await putText(`threads/${thread.id}/turn.txt`, prefix + message);

    const prompt = turnScript({ dir, threadId: thread.id, started: thread.started, allowed, model });
    const created = await cl.api("/api/term/create", {
      name: "cyber-bot",
      runner: "shell",
      workDir: dir,
      prompt,
    });
    const session = created && created.session;
    if (!session) throw new Error("Nie udało się uruchomić sesji bota.");
    activeSessions.add(session);
    try {
      let last = "";
      const started = Date.now();
      // eslint-disable-next-line no-constant-condition
      while (true) {
        await sleep(600);
        if (disposed) break;
        let res;
        try {
          res = await cl.api("/api/term/read", { session, lines: 1500 });
        } catch (e) {
          cl.log("session vanished mid-turn:", e.message);
          break;
        }
        const raw = res.text || "";
        const sentIdx = raw.indexOf(SENTINEL);
        if (sentIdx >= 0) {
          last = cleanPane(raw.slice(0, sentIdx));
          break;
        }
        const text = cleanPane(raw);
        if (text && text !== last) {
          last = text;
          if (onChunk) onChunk(text);
        }
        if (Date.now() - started > TURN_TIMEOUT_MS) {
          last = (last ? last + "\n\n" : "") + "(przerwano: bot nie odpowiedział w 6 minut)";
          break;
        }
      }
      return last;
    } finally {
      activeSessions.delete(session);
      try {
        await cl.api("/api/term/close", { session });
      } catch (e) {
        cl.log("session close skipped:", e.message);
      }
    }
  }

  async function ask(thread, message, onChunk) {
    if (busy) throw new Error("Bot jest zajęty poprzednią odpowiedzią.");
    if (!message || !message.trim()) throw new Error("Pusta wiadomość.");
    busy = true;
    try {
      let reply = await runTurn(thread, message.trim(), onChunk);
      if (thread.started && LOST_SESSION_RE.test(reply)) {
        cl.log("CLI session lost, starting the thread over:", thread.id);
        thread.started = false;
        reply = await runTurn(thread, message.trim(), onChunk);
      }
      thread.started = true;
      return reply || "(brak odpowiedzi — sprawdź, czy `claude` jest zainstalowane i zalogowane)";
    } finally {
      busy = false;
    }
  }

  // ---------------------------------------------------------------- mail
  const mail = createMail(cl, { esc, truncate, newId, isBusy: () => busy, startRun: startMailRun });

  async function mailThread() {
    await ensureLoaded();
    let id = await cl.storage.get(mail.K_MAIL_THREAD);
    let t = state.threads.find((x) => x.id === id);
    if (!t) {
      t = { id: newId(), kind: "mail", title: "📧 Maile", createdAt: Date.now(), updatedAt: Date.now(), started: false };
      state.threads.unshift(t);
      await saveThreads(state.threads);
      await cl.storage.set(mail.K_MAIL_THREAD, t.id);
    }
    return t;
  }

  // A run is a normal turn in the mail thread: the bubble shows a one-liner,
  // the model gets the full procedure + rules. Long threads start a fresh
  // CLI session so old runs stop weighing on the context.
  async function startMailRun(accounts, { silent = false } = {}) {
    if (busy || !accounts || !accounts.length) return;
    const t = await mailThread();
    state.active = t;
    state.msgs = await loadMessages(t.id);
    await cl.storage.set(K_ACTIVE, t.id);
    if (state.msgs.length >= mail.MAIL_THREAD_RESET_AFTER) {
      t.id = newId();
      t.started = false;
      state.msgs = [];
      await cl.storage.set(mail.K_MAIL_THREAD, t.id);
      await saveThreads(state.threads);
    }
    if (!silent) cl.openModule("chat", "chat");
    renderAll();
    await send(await mail.buildRunMessage(accounts), {
      display: `📧 Przegląd nieprzeczytanych maili: ${accounts.join(", ")}`,
    });
  }

  // ---------------------------------------------------------------- chat UI
  const state = {
    threads: [],
    active: null,
    msgs: [],
    loaded: false,
    chatEl: null,
    pending: null,
  };

  async function ensureLoaded() {
    if (state.loaded) return;
    await dropLegacyHistory();
    const list = await loadThreads();
    state.threads = list;
    const activeId = await cl.storage.get(K_ACTIVE);
    state.active = list.find((t) => t.id === activeId) || list[0] || null;
    state.msgs = state.active ? await loadMessages(state.active.id) : [];
    state.loaded = true;
  }

  async function switchThread(id) {
    const t = state.threads.find((x) => x.id === id);
    if (!t || busy) return;
    state.active = t;
    state.msgs = await loadMessages(t.id);
    await cl.storage.set(K_ACTIVE, t.id);
    renderAll();
  }

  async function newThread() {
    if (busy) return;
    state.active = await createThread(state.threads);
    state.msgs = [];
    await cl.storage.set(K_ACTIVE, state.active.id);
    renderAll();
    focusInput();
  }

  async function deleteThread(id) {
    if (busy) return;
    const t = state.threads.find((x) => x.id === id);
    if (!t) return;
    if (!confirm(`Usunąć wątek „${t.title}”?`)) return;
    state.threads = state.threads.filter((x) => x.id !== id);
    await saveThreads(state.threads);
    await removeThreadData(id);
    if (state.active && state.active.id === id) {
      state.active = state.threads[0] || null;
      state.msgs = state.active ? await loadMessages(state.active.id) : [];
      await cl.storage.set(K_ACTIVE, state.active ? state.active.id : "");
    }
    renderAll();
  }

  function bubbleHtml(m) {
    if (m.role === "user") {
      return `<div class="cb-row user"><div class="cb-bubble">${esc(m.text)}</div></div>`;
    }
    const body = m.text ? mdToHtml(m.text) : '<span class="cb-typing">myśli…</span>';
    const cls = m.error ? "cb-bubble cb-err" : "cb-bubble";
    return `<div class="cb-row bot"><div class="${cls}">${m.error ? esc(m.text) : body}</div></div>`;
  }

  function renderThreads() {
    if (!state.chatEl) return;
    const box = state.chatEl.querySelector(".cb-threads");
    if (!box) return;
    box.innerHTML = state.threads
      .map(
        (t) => `
        <div class="cb-thread ${state.active && t.id === state.active.id ? "active" : ""}" data-id="${esc(t.id)}" title="${esc(t.title)}">
          <div class="cb-thread-title">${esc(t.title)}</div>
          <div class="cb-meta">${fmtWhen(t.updatedAt)}</div>
          <button class="cb-thread-del" title="Usuń wątek">✕</button>
        </div>`,
      )
      .join("");
    box.querySelectorAll(".cb-thread").forEach((el) => {
      el.addEventListener("click", (e) => {
        if (e.target.closest(".cb-thread-del")) {
          deleteThread(el.dataset.id);
          return;
        }
        switchThread(el.dataset.id);
      });
    });
  }

  function renderScroll() {
    if (!state.chatEl) return;
    const scroll = state.chatEl.querySelector(".cb-scroll");
    if (!scroll) return;
    if (!state.msgs.length) {
      scroll.innerHTML =
        '<div class="cb-empty">🤖 <b>Cyber Bot</b><br>Zapytaj o cokolwiek — mam dostęp do Twoich projektów, boardu, notatek, terminarza i faktur przez narzędzia Cyber Life, pamiętam cały wątek i mogę zapamiętać rzeczy na stałe.</div>';
      return;
    }
    scroll.innerHTML = state.msgs.map(bubbleHtml).join("");
    scroll.scrollTop = scroll.scrollHeight;
    scroll.querySelectorAll("a.cb-link").forEach((a) =>
      a.addEventListener("click", (e) => {
        e.preventDefault();
        cl.openUrl(a.dataset.href);
      }),
    );
  }

  function renderAll() {
    renderThreads();
    renderScroll();
  }

  function focusInput() {
    const ta = state.chatEl && state.chatEl.querySelector(".cb-input textarea");
    if (ta) ta.focus();
  }

  async function send(text, { display } = {}) {
    text = (text || "").trim();
    if (!text || busy) return;
    await ensureLoaded();
    if (!state.active) {
      state.active = await createThread(state.threads);
      await cl.storage.set(K_ACTIVE, state.active.id);
    }
    const thread = state.active;
    if (!state.msgs.length && !thread.kind) thread.title = truncate(text.replace(/\s+/g, " "), 48);
    state.msgs.push({ role: "user", text: display || text, ts: Date.now() });
    const bot = { role: "bot", text: "", ts: Date.now() };
    state.msgs.push(bot);
    thread.updatedAt = Date.now();
    renderAll();
    setBusyUi(true);
    try {
      const reply = await ask(thread, text, (partial) => {
        bot.text = partial;
        renderScroll();
      });
      bot.text = reply;
    } catch (e) {
      bot.text = e.message || "Coś poszło nie tak.";
      bot.error = true;
    }
    setBusyUi(false);
    thread.updatedAt = Date.now();
    renderAll();
    await saveMessages(thread.id, state.msgs);
    await saveThreads(state.threads);
  }

  function setBusyUi(on) {
    if (!state.chatEl) return;
    const btn = state.chatEl.querySelector(".cb-send");
    const ta = state.chatEl.querySelector(".cb-input textarea");
    if (btn) btn.disabled = on;
    if (ta) ta.disabled = on;
  }

  function renderChat(el) {
    injectStyle();
    state.chatEl = el;
    el.innerHTML = `
      <div class="cb-wrap">
        <div class="cb-side">
          <div class="cb-side-head"><span>Wątki</span><button class="cb-new" title="Nowy wątek">＋ Nowy</button></div>
          <div class="cb-threads"></div>
        </div>
        <div class="cb-main">
          <div class="cb-scroll"></div>
          <div class="cb-input">
            <textarea placeholder="Napisz do Cyber Bota…  (Enter = wyślij, Shift+Enter = nowa linia)"></textarea>
            <button class="cb-send">Wyślij</button>
          </div>
        </div>
      </div>`;
    const ta = el.querySelector("textarea");
    const btn = el.querySelector(".cb-send");
    const submit = () => {
      const v = ta.value;
      ta.value = "";
      send(v);
    };
    btn.addEventListener("click", submit);
    ta.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        submit();
      }
    });
    el.querySelector(".cb-new").addEventListener("click", newThread);
    ensureLoaded().then(() => {
      renderAll();
      if (state.pending) {
        const q = state.pending;
        state.pending = null;
        send(q);
      } else {
        ta.focus();
      }
    });
  }

  function chatOnShow() {
    if (state.pending && !busy) {
      const q = state.pending;
      state.pending = null;
      send(q);
    } else {
      renderAll();
    }
  }

  // ---------------------------------------------------------------- history page
  let histEl = null;
  async function renderHistory(el) {
    histEl = el;
    injectStyle();
    await ensureLoaded();
    const rows = state.threads
      .map(
        (t) => `
        <div class="cb-histrow" data-id="${esc(t.id)}">
          <div class="cb-open">
            <div>${esc(t.title)}</div>
            <div class="cb-meta">${new Date(t.updatedAt).toLocaleString("pl-PL")}</div>
          </div>
          <button class="cb-new cb-del">Usuń</button>
        </div>`,
      )
      .join("");
    el.innerHTML = `
      <div style="padding:12px;">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">
          <h2 style="margin:0;">🕑 Wątki</h2>
          <button class="cb-clear cb-send" style="height:32px;">Wyczyść wszystko</button>
        </div>
        ${rows || '<div class="cb-empty">Brak wątków.</div>'}
      </div>`;
    el.querySelectorAll(".cb-histrow").forEach((row) => {
      row.querySelector(".cb-open").addEventListener("click", async () => {
        await switchThread(row.dataset.id);
        cl.openModule("chat", "chat");
      });
      row.querySelector(".cb-del").addEventListener("click", async () => {
        await deleteThread(row.dataset.id);
        renderHistory(el);
      });
    });
    el.querySelector(".cb-clear").addEventListener("click", async () => {
      if (busy || !confirm("Usunąć wszystkie wątki?")) return;
      for (const t of state.threads) await removeThreadData(t.id);
      state.threads = [];
      state.active = null;
      state.msgs = [];
      await saveThreads([]);
      await cl.storage.set(K_ACTIVE, "");
      renderAll();
      renderHistory(el);
    });
  }

  // ---------------------------------------------------------------- module
  cl.registerModule({
    id: "chat",
    label: "Cyber Bot",
    icon: "🤖",
    pages: [
      {
        id: "chat",
        label: "Czat",
        icon: "💬",
        render: renderChat,
        onShow: chatOnShow,
        // The textarea owns all typing (incl. Esc → let it bubble to blur).
        onKey: () => false,
      },
      {
        id: "history",
        label: "Historia",
        icon: "🕑",
        render: (el) => renderHistory(el),
        onShow: () => histEl && renderHistory(histEl),
      },
      {
        id: "mail",
        label: "Maile",
        icon: "📧",
        render: (el) => {
          injectStyle();
          mail.renderPage(el);
        },
        onShow: () => {},
        onKey: () => false,
      },
    ],
  });

  // ---------------------------------------------------------------- widget
  cl.registerWidget({
    id: "ask",
    title: "Zapytaj Cyber Bota",
    icon: "🤖",
    dashboard: true,
    render(el) {
      injectStyle();
      el.innerHTML = `
        <div class="cb-ask-w">
          <input type="text" placeholder="Szybkie pytanie do bota…">
          <button class="cb-send" style="height:34px;">Zapytaj</button>
        </div>`;
      const input = el.querySelector("input");
      const go = () => {
        const q = input.value.trim();
        if (!q) return;
        input.value = "";
        state.pending = q;
        cl.openModule("chat", "chat");
      };
      el.querySelector("button").addEventListener("click", go);
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          go();
        }
      });
    },
  });

  // ---------------------------------------------------------------- settings
  cl.registerSettingsSection({
    id: "settings",
    label: "Cyber Bot",
    icon: "🤖",
    async render(el) {
      const preset = (await cl.storage.get(K_PRESET)) || DEFAULT_PRESET;
      const model = (await cl.storage.get(K_MODEL)) || "";
      const allowWrite = !!(await cl.storage.get(K_WRITE));
      const withContext = await contextLineEnabled();
      const memory = await getMemory();
      const custom = (await cl.storage.get(K_SYSTEM_PROMPT)) || "";
      const presetOpts = Object.entries(PRESETS)
        .map(
          ([k, v]) =>
            `<option value="${esc(k)}" ${k === preset ? "selected" : ""}>${esc(v.label)}</option>`,
        )
        .join("");
      const toolList = (arr) => arr.map((t) => `<code>${esc(t)}</code>`).join(" ");
      el.innerHTML = `
        <h2 class="settings-section-title">🤖 Cyber Bot</h2>
        <p class="settings-section-desc">Bot odpowiada przez <code>claude -p</code> (Claude Code CLI musi być zainstalowane i zalogowane). Każdy wątek to jedna rozmowa CLI — bot pamięta cały wątek. Ma tylko narzędzia MCP Cyber Life, bez shella i plików.</p>
        <div class="adk-form">
          <label class="adk-field"><span>Model (puste = domyślny CLI; np. <code>sonnet</code>, <code>opus</code>)</span>
            <input id="cbModel" type="text" value="${esc(model)}" placeholder="domyślny">
          </label>
          <label class="adk-field" style="flex-direction:row;align-items:center;gap:8px;">
            <input id="cbWrite" type="checkbox" ${allowWrite ? "checked" : ""}>
            <span>Pozwól botowi zapisywać (taski, komentarze, notatki, prompty)</span>
          </label>
          <label class="adk-field" style="flex-direction:row;align-items:center;gap:8px;">
            <input id="cbCtx" type="checkbox" ${withContext ? "checked" : ""}>
            <span>Dopisuj do każdej wiadomości wiersz <code>[Kontekst: data, aktywny projekt]</code></span>
          </label>
        </div>
        <p class="settings-section-desc" style="margin-top:6px;">Odczyt: ${toolList(READ_TOOLS)}<br>Zapis (po włączeniu): ${toolList(WRITE_TOOLS)}</p>
        <div style="display:flex;align-items:center;gap:8px;margin-top:10px;flex-wrap:wrap;">
          <label class="settings-section-desc" style="margin:0;">Prompt systemowy bota:</label>
          <select id="cbPreset" title="Wstaw domyślny prompt dla persony">${presetOpts}</select>
          <button class="adk-btn" id="cbPresetFill">Wstaw domyślny dla persony</button>
        </div>
        <textarea id="cbPrompt" rows="12" class="cb-ta" style="margin-top:6px;" placeholder="(puste = domyślny prompt wybranej persony)">${esc(custom)}</textarea>
        <label class="settings-section-desc" style="display:block;margin-top:10px;">Pamięć bota (CLAUDE.md — bot dopisuje tu sam przez <code>cyber-bot_remember</code>):</label>
        <textarea id="cbMemory" rows="8" class="cb-ta">${esc(memory)}</textarea>
        <div class="adk-actions" style="margin-top:8px;">
          <button class="adk-btn primary" id="cbSave">Zapisz</button>
          <button class="adk-btn" id="cbClearMem">Wyczyść pamięć</button>
          <span class="adk-status" id="cbStatus"></span>
        </div>`;
      injectStyle();
      const status = el.querySelector("#cbStatus");
      const flash = (msg) => {
        status.textContent = msg;
        setTimeout(() => (status.textContent = ""), 1500);
      };
      const promptTa = el.querySelector("#cbPrompt");
      if (!promptTa.value) promptTa.value = defaultSystemPrompt(preset, allowWrite);
      el.querySelector("#cbPresetFill").addEventListener("click", () => {
        promptTa.value = defaultSystemPrompt(
          el.querySelector("#cbPreset").value,
          el.querySelector("#cbWrite").checked,
        );
      });
      el.querySelector("#cbSave").addEventListener("click", async () => {
        const chosenPreset = el.querySelector("#cbPreset").value;
        const write = el.querySelector("#cbWrite").checked;
        const text = promptTa.value.trim();
        // an untouched default is stored as "" so it keeps tracking the write toggle
        const isDefault = text === defaultSystemPrompt(chosenPreset, write).trim();
        await cl.storage.set(K_SYSTEM_PROMPT, isDefault ? "" : text);
        await cl.storage.set(K_PRESET, chosenPreset);
        await cl.storage.set(K_MODEL, el.querySelector("#cbModel").value.trim());
        await cl.storage.set(K_WRITE, write);
        await cl.storage.set(K_CONTEXT_LINE, el.querySelector("#cbCtx").checked);
        try {
          await setMemory(el.querySelector("#cbMemory").value);
          flash("Zapisano ✓");
        } catch (e) {
          cl.log("memory save failed:", e.message);
          flash("Błąd zapisu pamięci: " + e.message);
        }
      });
      el.querySelector("#cbClearMem").addEventListener("click", async () => {
        if (!confirm("Wyczyścić całą pamięć bota?")) return;
        el.querySelector("#cbMemory").value = "";
        await setMemory("");
        flash("Pamięć wyczyszczona");
      });
    },
  });

  // ---------------------------------------------------------------- agent tools
  // The @grok analog: another agent/automation can summon the bot. Each call is
  // its own throw-away conversation.
  cl.registerAgentTool("ask", async (args) => {
    const message = String((args && args.message) || "").trim();
    if (!message) throw new Error("message is required");
    const thread = { id: newId(), started: false };
    const reply = await ask(thread, message);
    return { reply };
  });

  cl.registerAgentTool("remember", async (args) => {
    const note = String((args && args.note) || "").trim();
    if (!note) throw new Error("note is required");
    if (note.length > 500) throw new Error("note too long (max 500 chars) — condense it");
    const lines = await remember(note);
    return { ok: true, lines };
  });

  cl.registerAgentTool("mail_rules", async (args) => {
    const rules = await mail.loadRules();
    const account = String((args && args.account) || "").trim().toLowerCase();
    return { rules: account ? mail.rulesFor(account) : rules };
  });
  cl.registerAgentTool("mail_rule_save", async (args) => {
    const rule = await mail.saveRule(args || {});
    return { ok: true, rule };
  });
  cl.registerAgentTool("mail_log", async (args) => {
    const entry = await mail.appendLog({ ...(args || {}), dryRun: await mail.isDryRun() });
    return { ok: true, id: entry.id };
  });
  mail.scheduleAuto().catch((e) => cl.log("mail auto schedule failed:", e.message));

  ensureHome().catch((e) => cl.log("bot home not ready yet:", e.message));
  cl.log("Cyber Bot ready");

  // ---------------------------------------------------------------- dispose
  return async () => {
    disposed = true;
    mail.dispose();
    state.chatEl = null;
    histEl = null;
    for (const s of activeSessions) {
      try {
        await cl.api("/api/term/close", { session: s });
      } catch (e) {
        cl.log("dispose: session close skipped:", e.message);
      }
    }
    activeSessions.clear();
  };
}
