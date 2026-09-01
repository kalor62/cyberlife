# Cyber Bot 🤖

A Grok-style chat bot for Cyber Life. You talk to it in a chat tab; it answers
through the **Claude Code CLI** (no API key of its own), **remembers each
thread**, **uses Cyber Life's tools** instead of guessing and keeps a
**long-term memory** it appends to itself.

## What you get

- **Chat tab "Cyber Bot"** (`💬 Czat`) — threads on the left, conversation on
  the right, markdown replies. Each thread is one CLI conversation, so the bot
  remembers everything said in it.
- **`🕑 Historia`** — all threads, open / delete / clear.
- **Widget "Zapytaj Cyber Bota"** — a quick-ask box for the sidebar / dashboard.
- **Tools** — the bot can read your projects, boards, notes, tasks, prompts,
  terminarz, KSeF invoices/bank data and nitroarena summaries through the
  local MCP server. Writing (tasks, comments, notes, prompts) is **off by
  default** — enable it in *Settings → Cyber Bot*.
- **Memory** — `cyber-bot_remember` appends one-line facts to the bot's
  `CLAUDE.md`; the CLI loads it every turn. View/edit/clear it in settings.
- **Agent tools** (MCP): `cyber-bot_ask {message}` — another agent or an
  automation summons the bot (the `@grok` analog); `cyber-bot_remember {note}`.
- **Persona presets** (Zadziorny / Rzeczowy / Mentor) + a custom persona,
  optional model override (`sonnet`, `opus`, …).

## How a turn works

1. The addon writes the message to `threads/<id>/turn.txt` in its home dir
   (`~/.cyberlife/addon-data/cyber-bot/`) — user text never meets shell quoting.
2. It launches a Cyber Life session with the built-in `shell` runner:
   `claude -p --session-id <thread>` (first turn) or `--resume <thread>`,
   `--permission-mode manual --tools "" --mcp-config mcp.json
   --strict-mcp-config --allowedTools <whitelist>`, persona as
   `--append-system-prompt`, then prints `<<<CBEND>>>` and idles.
3. It polls the pane, streams the text into the bubble, stops at the marker and
   closes the session. Persistence lives in the CLI's own session store, not in
   a live process.

`--permission-mode manual` + the whitelist is a hard boundary: in print mode
there is nobody to approve anything else, so a tool outside the list is simply
refused. Built-in tools (shell, file edits, web) are disabled entirely.

## Requirements

- `claude` (Claude Code CLI) on PATH and logged in.
- Cyber Life ≥ the version that exposes `addonData` in `system_info` and the
  `shell` runner (both shipped together with this addon version).

## Storage & limits

Threads (max 20, oldest dropped) and their messages live in the addon's
`cl.storage`; each thread's messages are trimmed to ~56 KB. Memory is capped at
24 KB. The bot answers one question at a time (single-flight).
