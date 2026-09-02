# Cyber Life Agent Manual

This is the **developer manual for agents** extending Cyber Life itself.
The user manual lives in the in-app Help module; this document is for you —
an AI agent asked to add a module, a widget, an automation capability, or
any other feature. Read it fully before writing code.

**Default to building an ADDON, not a core change.** Almost every feature
request (a new page, a widget, an integration, a tracker) fits the addon
platform and ships without touching this repo. Modify core only when the
platform itself is missing a seam.

## What Cyber Life is

A macOS desktop app (Wails v2: Go backend + vanilla JS frontend, no
framework) that is the control center for the user's projects: terminal
sessions (tmux only), kanban boards, health checks, mail, automations,
widgets. Agents are first-class citizens: the app runs a local REST + MCP
API and installs skills that teach every agent how to use it.

## Hard rules (never violate)

1. **English only** in all UI strings, code, comments, and skill content.
2. **tmux is the only session mode.** Never reintroduce AppleScript
   polling, the removed Python bridge, or non-tmux launch paths.
3. **No model names in code.** Model CLIs are user-defined Runners
   (`internal/state/runners.go`); Claude is the only listed built-in. The
   hidden `shell` runner (`sh -c <prompt>`) exists for API callers that
   need the full command line — addons, automations — never for pickers.
4. **Keyboard first.** Every new surface needs keys (j/k lists, verbs,
   Esc closes layers) registered in `shortcuts-data.js`.
5. **Forms use `fc-*` components, Help content uses `hc-*` components.**
   Fluid sizing: em-based, driven by `--fs-base`.
6. **Comments** only for non-obvious *why* — never restating what code does.
7. **Every catch logs** (Go: `logging.Warn/Debug` with fields; JS:
   `console.warn/error` with context). No silent swallows.
8. **Escape once, correctly.** Use `escapeHtml`/`escapeAttr` from
   `utils.js` — never a local copy. Markup declares behaviour with
   `data-act` + delegation; inline `onclick=` is banned (the CSP blocks
   it, and it needs double-context escaping).
9. **The API guard is load-bearing.** New routes go through the mux that
   `localOnly` wraps; never bypass the loopback/cross-site/JSON checks.

## Build & run loop

```bash
pkill -f "CyberLife.app/Contents/MacOS/CyberLife" 2>/dev/null
bash build.sh && open build/bin/CyberLife.app
```

`bash build.sh` runs `wails build` which **regenerates the JS bindings**
(`frontend/wailsjs/`). After adding any Go binding method you must run the
full build once — `npm run build` alone fails with "X is not exported by
wailsjs". Before committing: `go test ./internal/...`, `cd frontend &&
npm run lint` (eslint's no-undef catches missing imports the bundler
happily builds around) and `golangci-lint run ./...`.

## Architecture map

```
app.go                     Wails bindings + startup wiring (hooks, engine, pollers)
internal/
  state/                   persisted AppState (state.json) + Manager (mutex + Save)
  api/                     agent-facing surface: REST + MCP (server.go, mcp.go,
                           per-group files: automations.go, health.go, widgets.go)
  agentskills/             built-in SKILL.md registry, synced to ~/.claude/skills
  automations/             trigger → rule → action engine
  iterm/                   tmux control-mode streaming, session management
  health/ jira/ gmail/     integrations
frontend/src/
  main.js                  DOM skeleton + init order
  modules/shell.js         module registry, modes (NORMAL/INSERT/TERM), bars
  modules/module-host.js   module descriptors + generic tab switching + addon pages
  modules/addon-host.js    addon loader + per-addon SDK context
  modules/bus.js           app event bus (Wails bridge + addon messaging)
  modules/keyboard-shortcuts.js   key routing layers + g-chords
  modules/shortcuts-data.js       canonical shortcut registry (feeds ? and Help)
  modules/widgets.js       widget registry + sidebar widget area
  modules/help-content.js  Help guides (hc-* markdown)
  modules/<feature>-module.js     one file per module
```

State flow: frontend calls Wails bindings (`App.*` methods in app.go) →
`state.Manager` (lock, mutate, `Save()`). Agents go through
`internal/api` instead; both paths emit Wails events so open views repaint
live (`kanban-changed`, `automations-changed`, `widgets-changed`, …).

## Checklist: build an ADDON (the default path)

1. Scaffold `~/.cyberlife/addons/<id>/` — `addon.json` + `main.js`
   (template: `addons/hello-world`). Manifest fields:
   `id` (= folder name, `[a-z0-9-]`), `name`, `icon`, `version`,
   `description`, `category` (productivity | integrations | terminal |
   widgets | automation | appearance | development | other), `tags`,
   `entry`, `permissions` (only the API groups you call), plus declared
   `widgets`/`modules` (ids namespaced `<id>.<name>`; a multi-page module
   also declares `pages: [{id, label, icon}]` — page ids are
   module-scoped, not namespaced). Integration addons
   may also declare `hosts` (outbound HTTPS allowlist for `cl.http`,
   exact hostnames or `*.domain` wildcards) and `agentTools`
   (`[{name, description, schema}]` — exposed over MCP as
   `<id>_<name>`, gated by the addon's enable toggle).
2. Entry module: `export default async function activate(cl) { … }`,
   optionally return a dispose function. The `cl` context:
   - `cl.registerModule({id, label, icon, render(el), onKey, onShow})` —
     full page; tab, digit, palette and reorder support come free.
     **One addon = one shell tab.** An addon with several views registers
     ONE module and replaces `render` with
     `pages: [{id, label, icon, render(el), onKey, onShow}]` — the shell
     then adds a compact, always-visible page bar under the module tab
     (click or ⇧1..⇧9 switch pages, each page renders lazily and gets
     `onKey` while active). Never register a second top-level module for
     what is really a page of the same feature.
     A paged module may also pass `renderBar(el)` — the shell hands it a
     slot anchored at the right end of the page bar for addon-owned
     controls that scope EVERY page (a company/account picker, a global
     filter). The slot survives page switches; the addon keeps the `el`
     reference and re-renders it itself (e.g. from pages' `onShow`).
     Style with `.addon-subbar-label` / plain `select`/`input` — the
     shell styles them to match the bar. Keep it compact: 1-2 controls,
     no buttons duplicating page actions.
   - `cl.registerWidget({id, title, icon, render(el), dashboard})`
   - `cl.registerSettingsSection({id, label, icon, render(el)})` — a
     section in the Settings sidebar under the Addons group
   - `cl.events.on/off/emit` — core events (`kanban-changed`,
     `projects-changed`, `automations-changed`, `widgets-changed`,
     `automation-run`, `addons-changed`, `state:*`) plus any custom
     addon↔addon names; automation rules can broadcast to you via the
     `emit-event` action
   - `cl.storage.get/set/remove/all` — persisted per-addon KV (JSON;
     256 keys x 64KB per addon — chunk big datasets)
   - `cl.api(path, body?)` — REST calls allowed by manifest permissions
   - `cl.http({url, method?, headers?, body?})` — outbound HTTPS through
     the app proxy (webview CORS does not apply); host must be in the
     manifest `hosts` allowlist. Returns `{status, headers, body}`.
   - `cl.registerAgentTool(name, async handler(args))` — implements a
     manifest `agentTools` entry; the returned value becomes the MCP
     tool result (throw to report an error)
   - `cl.notify(title, message, {link?})` — raises a notification: an
     entry in the notification center (bell in the status bar, ⌘N) plus
     the desktop toast automations use; `source` is the addon id. Needs
     the `notify` permission in the manifest; without it the call rejects
     and the addon keeps running
   - `cl.openModule(id, pageId?)` — switch the app to one of the addon's
     modules, optionally straight to one of its pages
   - `cl.registerTermMenuItem({id, label, hint?, run(ctx)})` — an entry in
     the Term menu (⌘M) under "Addons"; `ctx` = `{session, project,
     lastPrompt}` of the session being viewed (session may be null)
   - `cl.pdfText(dataBase64)` — layout-preserving text of a PDF via the
     app's pdftotext bridge (needs poppler installed; ≤15MB)
   - `cl.mergePdfs(keys, outPath, {open})` — concatenate stored PDFs
     (poppler pdfunite) into a new blob-store file; `open: true` also
     opens the result in the system viewer
   - `cl.htmlToPdf(html, outPath)` — render HTML to a real PDF in the
     blob store (headless Chrome) — for email attachments
   - `cl.sendEmail({account?, to, cc?, subject, body, attachmentKeys})`
     — send through the app's Gmail integration; attachments are BLOB
     STORE KEYS (host confines them to this addon's storage); empty
     account uses the first configured Gmail account
   - `cl.putDataFile(path, dataBase64, {toPdf})` / `cl.dataFileUrl(path)`
     / `cl.deleteDataFile(path)` — per-addon blob store for binary
     artifacts too big for `cl.storage` (≤30MB per file), kept under
     `~/.cyberlife/addon-data/<id>/`. `toPdf: true` converts PNG/JPEG
     to PDF on the host (sips/ImageMagick). `dataFileUrl` returns a URL
     the webview can load directly (`<embed>` renders PDFs natively) —
     keep only file KEYS in `cl.storage`, never the bytes
   - `cl.backup(action, config?, {job?, keys?})` — mirror the addon's blob
     store into an S3-compatible bucket (Cloudflare R2). `'start'` launches
     a background job on the host, `'status'` polls it (the final status
     carries an `objects` manifest of `relPath → {etag, size}`), `'test'`
     verifies credentials by listing the bucket. `config` is
     `{endpoint, bucket, accessKeyId, secretAccessKey, prefix?}` — the
     addon stores it (in `cl.storage`); the host keeps it only for the
     running job. `job` keeps concurrent backups of one addon apart (e.g.
     one bucket per company — pass the same `job` when polling), `keys`
     limits the upload to those blob-store paths. Upload-only: nothing is
     deleted remotely.
   - `cl.openUrl(url)` — open an http(s) URL in the system browser
     (in-webview navigation would replace the app)
   - `cl.log(…)` — prefixed console logging
3. `addons_reload` (hot reload), then `addons_list` to check for manifest
   errors. New addons are DISABLED until enabled (`addons_set_enabled`
   or Settings → Addons) — ask the user unless they already asked.
   Hot reload re-imports the **entry** with a cache-busting query; files it
   imports relatively stay cached until the app restarts, so verify edits to
   sub-modules after a restart (or keep iterating inside the entry).
4. Never put secrets in addon files; keep values in `cl.storage`.
5. Keyboard-first applies to addon pages too: implement `onKey`, return
   `true` for consumed keys, let Esc bubble.
6. **UI must use the app design system** — the tokens from `app.css`
   (`--bg-primary/secondary/tertiary/surface`, `--text-primary/secondary/muted`,
   `--accent`, `--success`, `--warning`, `--error`, `--border`) and the
   shared **addon UI kit** classes (`app.css`, section "Addon UI kit"):
   - `.adk-card` — a section/entity card (works as `<details>` too);
     `.adk-subcard` — nested read-only panel with `.adk-subcard-head`
   - `.adk-form` + `.adk-field` (`<label class="adk-field"><span>Label</span>
     <input></label>`) — responsive two-column form with consistent inputs
   - `.adk-actions` + `.adk-btn` (`.primary`, `.danger`) — button rows
   - `.adk-kv`, `.adk-muted`, `.adk-status` — key-value info and status lines
   Never hardcode palette colors in addon CSS; when a bespoke style is
   unavoidable, reference the tokens with a matching fallback, e.g.
   `var(--accent, #89b4fa)`. This keeps every addon coherent with the app
   and with future theme changes.

## Checklist: add a CORE module (full-screen view)

Only when the feature genuinely belongs in this repo:

1. `frontend/src/modules/<name>-module.js` exporting:
   `<NAME>_TAB_ID`, `show<Name>Panel(show)`, `render<Name>Panel()`,
   optional `<name>ModuleOnKey(e)` (return `true` when the key is consumed).
2. Panel div in `main.js` DOM skeleton: `<div id="<name>Panel" style="display:none">`.
3. One descriptor entry in `module-host.js` `CORE_MODULES`
   (order = digit): `{id, label, icon, show, onShow, onKey}`.
4. g-chord letter in `keyboard-shortcuts.js` `G_CHORD_TARGETS`.
5. Shortcut section in `shortcuts-data.js` with `moduleId: '<name>-tab'`.
6. Help guide in `help-content.js` (hc-* components: `:::tip`, `:::steps`,
   `[[kbd:x]]`, tables).
7. CSS in `app.css`: `.<name>-panel` (copy the `.auto-panel` block as the
   template — flex column, `font-size: var(--fs-base)`).
8. Full build; verify digits, g-chord, `?` modal section, Esc behavior.

## Checklist: add a widget

Widgets live in **two registries that must stay in sync by id**:

1. **Go catalog** — `internal/api/widgets.go` `widgetCatalog()`: id, title,
   icon, description, `Dashboard: true` if instance-safe. This is what
   agents see via `widgets_catalog` and what validates config writes.
2. **Frontend registry** — `frontend/src/modules/widgets.js` `WIDGETS`:
   same id plus a **render function** `render(el)` that fills a container.
   Instance-safe renderers (no fixed DOM ids, no singletons) may be used on
   dashboards; add refresh scopes in `REFRESH_SCOPES` if the widget should
   live-update (`project`, `board`, `automation`, `interval`).

A widget renderer should: fetch via bindings, render compact HTML
(`widget-*` CSS classes), set `el.onclick` to jump to the related module,
and degrade gracefully (`widget-empty` div on error).

## Checklist: add an agent capability (API group)

The established pattern — copy `internal/api/automations.go`:

1. **Ops + tools file** `internal/api/<group>.go`: shared `op*` functions,
   REST handlers, `<group>Tools()` (MCP schemas), `call<Group>Tool()`.
   Tool names share one prefix: `<group>_*`.
2. **Gate** with a skill: `<group>Enabled()` via `agentskills.Enabled`.
   Register routes in `server.go`, add the prefix branch in `mcp.go`
   (tools/list + tools/call) — disabled = tools hidden + calls rejected.
3. **Skill** in `internal/agentskills/skills.go`: SKILL.md content with
   tool list, REST fallback (curl), conventions. Add the Registry entry
   (availability-gate it if the backing integration can be unconfigured).
4. **Permission UI** appears automatically in Settings → Agent Skills.
5. If the UI must react to agent writes, add an `On<X>Change` hook in
   `Hooks` (server.go) and emit a Wails event from app.go startup wiring.
6. Verify with curl against `http://127.0.0.1:8377/mcp`
   (initialize → tools/list → tools/call).

## Agent API quick reference

- MCP (Streamable HTTP, stateless): `http://127.0.0.1:8377/mcp`
  Register in Claude Code: `claude mcp add --transport http cyberlife http://127.0.0.1:8377/mcp`
- REST base: `http://127.0.0.1:8377/api/…` (each skill documents its routes)
- Groups: `board_*` (incl. Jira sync), `health_*`, `auto_*`, `widgets_*`,
  `term_*` (session orchestration), `projects_*`, `tasks_*` (worktrees),
  `notes_*`, `prompts_*`, `system_info`, `addons_*` (install/toggle/
  storage + hot reload) — plus Gmail via the separate stdio server in
  `mcp-gmail/`
- "project" parameters accept a name, id, or any path inside the project.
- Built-in integrations (gmail, jira, elevenlabs, health, pomodoro,
  iterm) are toggleable addons — when one is off its features and API
  groups refuse; check `addons_list` before assuming availability.

## Verification bar

A change is done when: `go build ./...` and the full `bash build.sh` pass,
the app launches, the feature works via keyboard, agent-facing parts are
verified with curl, and Help/shortcuts reflect reality. Report honestly
what was and was not verified.
