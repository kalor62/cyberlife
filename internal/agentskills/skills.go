package agentskills

import (
	"fmt"
	"os"
	"path/filepath"

	"github.com/kalor62/cyberlife/internal/logging"
)

// Skill is a built-in agent skill shipped with Cyber Life. Enabled skills
// are installed into ~/.claude/skills/<dir>/SKILL.md so every Claude session
// picks them up; other runners get the same content injected by automations.
type Skill struct {
	ID          string
	Dir         string
	Title       string
	Description string
	Content     string
	Default     bool
}

func Registry(apiBase string) []Skill {
	return []Skill{
		{
			ID:          "board",
			Dir:         "cyberlife-board",
			Title:       "Cyber Life Board",
			Description: "Create and manage kanban tasks on the Cyber Life board",
			Default:     true,
			Content:     boardSkill(apiBase),
		},
		{
			ID:          "health",
			Dir:         "cyberlife-health",
			Title:       "Cyber Life Health",
			Description: "Track and evaluate project health checks — including custom checks you define and verify",
			Default:     true,
			Content:     healthSkill(apiBase),
		},
		{
			ID:          "auto",
			Dir:         "cyberlife-auto",
			Title:       "Cyber Life Automations",
			Description: "Create and manage trigger → action automation rules (board moves, schedules, incoming mail)",
			Default:     true,
			Content:     autoSkill(apiBase),
		},
		{
			ID:          "term",
			Dir:         "cyberlife-term",
			Title:       "Cyber Life Terminals",
			Description: "List, spawn, read and drive agent sessions (tmux) — agent-to-agent orchestration",
			Default:     true,
			Content:     termSkill(apiBase),
		},
		{
			ID:          "projects",
			Dir:         "cyberlife-projects",
			Title:       "Cyber Life Projects",
			Description: "Create and organize projects and groups, switch the active project",
			Default:     true,
			Content:     projectsSkill(apiBase),
		},
		{
			ID:          "tasks",
			Dir:         "cyberlife-tasks",
			Title:       "Cyber Life Tasks",
			Description: "Worktree tasks: git branch + worktree + resumable Claude session per work item",
			Default:     true,
			Content:     tasksSkill(apiBase),
		},
		{
			ID:          "notes",
			Dir:         "cyberlife-notes",
			Title:       "Cyber Life Notes",
			Description: "Read and update per-project notes — shared memory between the user and agents",
			Default:     true,
			Content:     notesSkill(apiBase),
		},
		{
			ID:          "prompts",
			Dir:         "cyberlife-prompts",
			Title:       "Cyber Life Prompts",
			Description: "Manage saved prompts (global and per project)",
			Default:     true,
			Content:     promptsSkill(apiBase),
		},
		{
			ID:          "system",
			Dir:         "cyberlife-system",
			Title:       "Cyber Life System",
			Description: "Read-only overview: runners, dependencies, skill states, active project",
			Default:     true,
			Content:     systemSkill(apiBase),
		},
		{
			ID:          "widgets",
			Dir:         "cyberlife-widgets",
			Title:       "Cyber Life Widgets",
			Description: "Configure the sidebar widget area and user dashboards",
			Default:     true,
			Content:     widgetsSkill(apiBase),
		},
		{
			ID:          "gmail",
			Dir:         "cyberlife-gmail",
			Title:       "Gmail",
			Description: "Read, search, reply and send mail through the accounts linked in Cyber Life",
			Default:     true,
			Content:     gmailSkill(),
		},
		{
			ID:          "addons",
			Dir:         "cyberlife-addons",
			Title:       "Cyber Life Addons",
			Description: "Install, build, enable and manage Cyber Life addons (plugins adding pages, widgets and integrations)",
			Default:     true,
			Content:     addonsSkill(apiBase),
		},
	}
}

func addonsSkill(apiBase string) string {
	return fmt.Sprintf(`---
name: cyberlife-addons
description: Install, build, enable and manage Cyber Life addons — plugins that add pages, widgets and integrations to the app. Use when asked to extend Cyber Life with new functionality, install an addon, or scaffold one.
---

# Cyber Life Addons

Addons are directories under ~/.cyberlife/addons/<id>/ with an addon.json
manifest and an optional frontend entry module. The app serves addon files
at %s/addons/<id>/<path> and imports the entry of every ENABLED addon at
startup. New addons are DISABLED until the user (or you, when asked)
enables them.

## MCP tools / REST
- addons_list — manifests, enabled state, manifest errors, addons dir, categories
- addons_set_enabled {addon, enabled}
- addons_reload — rescan + hot-reload after installing or editing files
- addons_storage_get/set/delete {addon, key, value} — per-addon JSON KV store
REST equivalents: POST %s/api/addons/{enable,reload,storage/*}, GET %s/api/addons

## addon.json
{
  "id": "my-addon",            // must equal the folder name, [a-z0-9-]
  "name": "My Addon",
  "version": "0.1.0",
  "description": "…",
  "author": "…",
  "category": "productivity",  // productivity|integrations|terminal|widgets|automation|appearance|development|other
  "tags": ["…"],
  "entry": "main.js",          // ES module loaded into the app (optional)
  "permissions": ["projects", "notes"],  // API groups the addon calls
  "widgets": [{"id": "my-addon.stats", "title": "Stats", "icon": "📊", "dashboard": true}],
  "modules": [{"id": "my-addon.page", "label": "My Page", "icon": "🧩"}]
}
Widget and module ids must be namespaced "<addon-id>.<name>".

## entry module (main.js)
export default function activate(cl) { … } — called once at startup with
the addon context: cl.registerWidget({id, title, icon, render(el)}),
cl.registerModule({id, label, icon, render(el), onKey}),
cl.registerSettingsSection({id, label, icon, render(el)}) — appears in the
Settings sidebar under the Addons group, cl.events.on/off/emit
(app events like kanban-changed, projects-changed + addon-to-addon messages),
cl.storage.get/set/remove (persisted KV), cl.api(path, body) for REST calls
allowed by the manifest permissions. Full guide: docs/AGENT-MANUAL.md in the
Cyber Life repo.

## Workflow for building an addon
1. Write files into ~/.cyberlife/addons/<id>/ (addon.json + entry)
2. Call addons_reload, then addons_list to check for manifest errors
3. Ask the user before enabling unless they already asked for it
4. Never put secrets in addon files — storage values live in the app state
`, apiBase, apiBase, apiBase)
}

func healthSkill(apiBase string) string {
	return fmt.Sprintf(`---
name: cyberlife-health
description: Manage Cyber Life project health checks — read the report, define custom checks and act as their evaluator. Use when asked to audit a project, verify a quality aspect, or track a recurring standard.
---

# Cyber Life Health

Each project tracks a subset of a check library (built-in per stack plus
custom checks). **You are the evaluator of custom checks**: when a custom
check exists, verifying it is your job — inspect the codebase, decide
pass/fail, and record the result with a comment.

Preferred: MCP tools (server "cyberlife", health_* tools) if available.
Fallback: the REST API below. "project" accepts a name or any path inside
the project — pass your working directory.

## Workflow

1. health_get_report — see what the project tracks and what is red
2. health_library — discover available checks and their ids
3. health_track {add:[...], remove:[...]} — change what a project tracks
4. health_add_check {title, description, stack, category, trackIn} —
   define a new custom check when asked to enforce a new standard
5. health_set_check {checkId, passed, comment, author} — after actually
   verifying the thing; the comment must say what you inspected

## REST fallback (base %s)

    curl -s "%s/api/health?project=$PWD"
    curl -s %s/api/health/library
    curl -s -X POST %s/api/health/track   -d '{"project":"'"$PWD"'","add":["ci:test"]}'
    curl -s -X POST %s/api/health/check   -d '{"title":"GDPR banner reviewed","stack":"custom","category":"Compliance","trackIn":"'"$PWD"'"}'
    curl -s -X POST %s/api/health/set     -d '{"project":"'"$PWD"'","checkId":"custom:<id>","passed":true,"author":"claude","comment":"Verified consent flow in src/app/layout.tsx"}'

## Conventions

- Never set a check to passed without actually verifying it
- Set author to your model/agent name; comments are the audit trail
- Auto checks (kind "auto") evaluate themselves — do not set them
`, apiBase, apiBase, apiBase, apiBase, apiBase, apiBase)
}

func autoSkill(apiBase string) string {
	return fmt.Sprintf(`---
name: cyberlife-auto
description: Manage Cyber Life automation rules — trigger → action workflows fired by board column changes, schedules or incoming mail. Use when asked to automate something recurring, react to task status changes, or set up scheduled agent runs.
---

# Cyber Life Automations

A rule = one trigger + a list of actions, scoped to a project or global
(no projectId). The app evaluates triggers while it runs and logs every
execution.

Preferred: MCP tools (server "cyberlife", auto_* tools) if available.
Fallback: the REST API below.

## Triggers

- task-status {column} — a board task entered that column (name or id)
- cron {everyMinutes} or {dailyAt: "HH:MM"} — schedule
- mail {account?, fromContains?, subjectContains?} — new inbox thread
- webhook {slug} — POST %s/api/hooks/<slug> fires the rule; top-level
  string fields of a JSON payload become {{hook.<key>}} placeholders
- manual — fires only via auto_run_rule / "Run now"

## Actions

- run-agent {runner?, prompt, workDir?} — launch an agent session; runner
  omitted = the project/global default runner; workDir omitted = the
  rule's project path
- move-task {column} — move the triggering task (task-status rules only)
- comment {text} — comment on the triggering task
- notify {title?, message} — desktop notification
- send-mail {account?, to, subject, body} — send through a linked account
- webhook {url, method?, body?} — call any HTTP endpoint; this is how
  rules post to communicators (Slack/Discord/Telegram incoming webhooks)
- emit-event {event, body?} — broadcast on the in-app event bus; addons
  subscribe with cl.events.on(event, fn), payload carries the trigger
  placeholders plus the expanded body

Placeholders in text fields: {{task.id}} {{task.title}} {{column}}
{{project.name}} {{project.path}} {{mail.from}} {{mail.subject}}
{{hook.body}} {{hook.<key>}} {{rule.name}}

## Tools

1. auto_list_rules {project?} — see what exists before creating
2. auto_save_rule {rule} — create (no id) or update (with id)
3. auto_run_rule {ruleId} — execute now, returns the run record
4. auto_list_runs {limit?} — history with per-run status and links
5. auto_set_enabled / auto_delete_rule — manage lifecycle

## REST fallback (base %s)

    curl -s "%s/api/auto/rules?project=$PWD"
    curl -s -X POST %s/api/auto/rules -d '{"rule":{"name":"Review on done","projectId":"'"$PWD"'","trigger":{"type":"task-status","column":"Done"},"actions":[{"type":"comment","text":"{{task.title}} reached Done"}]}}'
    curl -s -X POST %s/api/auto/run -d '{"ruleId":"<id>"}'
    curl -s %s/api/auto/runs

## Conventions

- Automation-made task moves do not fire other rules (no cascades)
- Prefer notify/comment actions when experimenting; run-agent opens a
  real terminal session the user will see
- Never create send-mail or webhook rules without the user naming the
  recipient/endpoint; webhook URLs often embed secrets — never echo them
`, apiBase, apiBase, apiBase, apiBase, apiBase, apiBase)
}

func termSkill(apiBase string) string {
	return fmt.Sprintf(`---
name: cyberlife-term
description: Control Cyber Life terminal sessions (tmux) — list running agent sessions, spawn new ones with any runner, read their output, send input, close them. Use for orchestrating other agents or checking what a session is doing.
---

# Cyber Life Terminals

Sessions are tmux sessions the user sees in the Term module. You can
orchestrate: spawn an agent, poll its output, react.

Preferred: MCP tools (server "cyberlife", term_* tools).
REST fallback (base %s): GET /api/term, POST /api/term/create|read|send|close.

## Tools

1. term_list — running sessions with paths and owning projects
2. term_create {project|workDir, name?, runner?, prompt?} — spawn; the
   prompt is passed on the runner's CLI; runner omitted uses the
   project/global default; returns the session id
3. term_read {session, lines?} — plain-text tail of the session output
4. term_send {session, text, enter?} — type into a session
5. term_close {session} — kill a session

## Conventions

- Sessions you did not create belong to the user — read freely, but
  never term_send or term_close them unless explicitly asked
- Poll term_read with restraint (the output is a full tail each call)
- Runner ids come from system_info
`, apiBase)
}

func projectsSkill(apiBase string) string {
	return fmt.Sprintf(`---
name: cyberlife-projects
description: Manage Cyber Life projects — create projects, edit their name/icon/color/group, organize groups, switch the active project. Use when asked to register a repo, reorganize the workspace, or focus the app on a project.
---

# Cyber Life Projects

Preferred: MCP tools (server "cyberlife", projects_* tools).
REST fallback (base %s): POST /api/projects/create|update|active|groups|groups/save.

## Tools

1. projects_create {name, path} — path must be an absolute existing dir
2. projects_update {project, name?, color?, icon?, pinned?, group?, runner?}
   — runner is the default Term runner id (empty = inherit global)
3. projects_set_active {project} — switches what the user is looking at
4. projects_groups / projects_save_group {name, icon?, groupId?}

## Conventions

- board_list_projects (board skill) lists existing projects — check
  before creating duplicates
- projects_set_active changes the user's screen — only when asked
`, apiBase)
}

func tasksSkill(apiBase string) string {
	return fmt.Sprintf(`---
name: cyberlife-tasks
description: Cyber Life worktree tasks — one git branch + worktree (+ resumable Claude session) per work item, optionally linked to a Jira key. Use when starting a separate piece of work that deserves its own branch and session.
---

# Cyber Life Tasks (worktrees)

A task gives a work item its own isolated checkout: branch + git
worktree per repo, with a persistent Claude session cwd'd there. The
user opens tasks from the Projects module.

Preferred: MCP tools (server "cyberlife", tasks_* tools).
REST fallback (base %s): POST /api/tasks|/api/tasks/create|/api/tasks/delete.

## Tools

1. tasks_list {project}
2. tasks_create {project, name, jiraKey?, branch?, baseBranch?, repos?}
   — branch defaults to a slug of the name
3. tasks_delete {project, taskId, deleteBranch?}

## Conventions

- Never delete a task with uncommitted work without explicit approval
- Multi-repo projects: pass repos (paths inside the project) to check
  out several worktrees under one task
`, apiBase)
}

func notesSkill(apiBase string) string {
	return fmt.Sprintf(`---
name: cyberlife-notes
description: Read and update Cyber Life per-project notes (markdown) — shared memory between the user and agents. Use to log findings, decisions or handoffs the user should see in the Notes module.
---

# Cyber Life Notes

Preferred: MCP tools (server "cyberlife", notes_* tools).
REST fallback (base %s): GET /api/notes?project=..., POST /api/notes/set|append.

## Tools

1. notes_get {project}
2. notes_append {project, text} — the safe default for adding findings
3. notes_set {project, content} — full replace; ALWAYS notes_get first

## Conventions

- Prefer append over set; never wipe user content
- Date-stamp appended entries (e.g. "## 2026-07-25 — deploy notes")
`, apiBase)
}

func promptsSkill(apiBase string) string {
	return fmt.Sprintf(`---
name: cyberlife-prompts
description: Manage Cyber Life saved prompts — reusable prompt snippets, global or per project. Use when asked to save a prompt for later or to review the prompt library.
---

# Cyber Life Prompts

Preferred: MCP tools (server "cyberlife", prompts_* tools).
REST fallback (base %s): GET /api/prompts?project=..., POST /api/prompts/save|delete.

## Tools

1. prompts_list {project?} — global prompts, plus the project's if given
2. prompts_save {title, content, category?, global?|project, promptId?}
3. prompts_delete {promptId, global?|project}

## Conventions

- global: true for prompts useful in every project; otherwise scope to
  the project you are working in
- Update (promptId) instead of creating near-duplicates
`, apiBase)
}

func systemSkill(apiBase string) string {
	return fmt.Sprintf(`---
name: cyberlife-system
description: Read-only Cyber Life overview — configured runners (ids for launching sessions), dependency health, skill permission states, the active project. Use before spawning sessions or diagnosing why a capability is unavailable.
---

# Cyber Life System

Tools:
- system_info — app metadata, the active project, runner ids (for
  term_create and automation run-agent actions — env values are hidden,
  only key names are listed), dependency checks (tmux, claude, iTerm2,
  node) and which agent skills are enabled.
- system_notify {title, message?, source?, link?} — raise a notification: it
  lands in the notification center (bell in the status bar) and as a
  desktop toast. Use it for anything the user must see even when not
  watching your session. Rate limited to 12/min.
- system_notifications {includeArchived?, limit?} — read the center.

REST fallback (base %s): GET /api/system, POST /api/notify.

## First contact — onboarding a new user

When the user seems new to Cyber Life (the "Sample Project" is still
their only project, or they ask what this app is), open with a short
orientation before doing anything else:

1. The whole system is keyboard-driven — it pays off to learn the keys.
   Point them at "?" (context shortcuts) and Cmd+K (the palette shows
   the direct shortcut next to every command, so it teaches the keys).
2. Everything they see — projects, the board, widgets, automations,
   addons — can be configured and driven by YOU through this MCP. They
   can simply ask instead of clicking.
3. The Auto module runs trigger-to-action rules (board moves, cron,
   mail, webhooks) that can launch agent sessions — their agent can
   work while they sleep. The Sample Project ships a disabled example.
4. They can extend the app with addons (Settings -> Addons), and you can
   build addons for them — see the cyberlife-addons skill.
5. Best first step: offer to create their own project for a real repo
   (projects_create), then walk the Sample Project board together.
`, apiBase)
}

func widgetsSkill(apiBase string) string {
	return fmt.Sprintf(`---
name: cyberlife-widgets
description: Configure Cyber Life's widget area and dashboards — sidebar widgets, their order, collapsed state, and user-named dashboard tabs of widgets. Use when asked to change what shows in the sidebar or to build a dashboard view.
---

# Cyber Life Widgets

Widgets are small live views (board summary, recent automation runs,
unread mail, git status, pomodoro…). They appear in two places:

- the **right sidebar** — an ordered list, collapsible to an icon strip
- **dashboards** — user-named tabs of widgets in the Dash module
  ("home" is the built-in default dashboard)

Preferred: MCP tools (server "cyberlife", widgets_* tools).
Fallback: the REST API below.

## Scopes

The sidebar has two layers: **global** widgets appear in every project;
each project can add its own on top. The visible sidebar = global +
project (in that order).

## Tools

1. widgets_catalog — always start here; some widgets are sidebar-only
2. widgets_get_config {project?} — global config, dashboards, and the
   project's extra widgets when project is given
3. widgets_set_sidebar {sidebar:[ids], collapsed?, project?} — without
   project sets the GLOBAL list; with project sets that project's extras
4. widgets_set_width {width?, moduleWidths?} — default sidebar width in
   px plus per-module overrides keyed by module id (e.g. board-tab,
   dashboard-tab, email-tab); 0 removes an override; range 180-1200
5. widgets_save_dashboard {dashboard:{id?, name, icon, widgets:[ids]}}
6. widgets_delete_dashboard {dashboardId} — "home" cannot be deleted

## REST fallback (base %s)

    curl -s %s/api/widgets/catalog
    curl -s %s/api/widgets
    curl -s -X POST %s/api/widgets/sidebar -d '{"sidebar":["git","pomodoro","recent-automations"]}'
    curl -s -X POST %s/api/widgets/dashboard -d '{"dashboard":{"name":"Ops","icon":"🛠️","widgets":["board-summary","recent-automations"]}}'

## Conventions

- widgets_set_sidebar replaces the whole list — read the current config
  first and modify it, never guess
- Only dashboard-capable widgets (catalog "dashboard": true) may be put
  on dashboards
- The UI updates live; no restart needed
`, apiBase, apiBase, apiBase, apiBase, apiBase)
}

func gmailSkill() string {
	return `---
name: cyberlife-gmail
description: Read, search, label, reply to and send Gmail through the accounts linked in Cyber Life. Use for any email task — checking the inbox, finding a message, drafting or sending replies.
---

# Gmail (via Cyber Life)

Cyber Life manages Gmail accounts (OAuth) and ships an MCP server that
exposes them. Prefer the MCP tools; they are named gmail_*:

- gmail_status, gmail_inbox, gmail_search, gmail_read
- gmail_reply, gmail_draft_reply, gmail_create_draft, gmail_send
- gmail_trash, gmail_list_labels, gmail_create_label, gmail_delete_label
- gmail_list_filters, gmail_create_filter, gmail_get_filter, gmail_delete_filter

If the tools are missing, the server is not registered in this Claude
Code profile yet — ask the user to click "Install Claude integration"
in Cyber Life's Mail view, or run the registration themselves.

## Conventions

- Multi-account: most tools accept an "account" parameter; omit it for
  the default account, or call gmail_status to list accounts
- Never send mail without an explicit instruction to send; prefer
  gmail_create_draft / gmail_draft_reply so the user reviews first
- Quote only the minimum context in replies
`
}

func boardSkill(apiBase string) string {
	return fmt.Sprintf(`---
name: cyberlife-board
description: Manage the Cyber Life kanban board — create tasks, move them between columns, add comments. Use when asked to track work, report progress, or when finishing a piece of work worth recording.
---

# Cyber Life Board

Cyber Life (the desktop app) exposes its per-project kanban board on a local
HTTP API. You are expected to keep the board up to date: create tasks for new
work, move them as status changes, and comment with results.

Preferred: MCP tools (server "cyberlife", board_* tools) if available.
Fallback: the REST API below — always available while the app runs.

The "project" parameter accepts a project name, or any path inside the
project — pass your working directory.

## Endpoints (base %s)

List projects:

    curl -s %s/api/projects

Read a board (columns + tasks):

    curl -s "%s/api/board?project=$PWD"

Create a task (column by name, e.g. "Backlog", "In Progress", "Done";
omit for the first column):

    curl -s -X POST %s/api/board/task \
      -H 'Content-Type: application/json' \
      -d '{"project":"'"$PWD"'","title":"Fix flaky test","description":"...","column":"Backlog","priority":"high","category":"Bug"}'

Update fields of an existing task (send taskId plus fields to change):

    curl -s -X POST %s/api/board/task \
      -d '{"project":"'"$PWD"'","taskId":"<id>","blocked":true}'

Move a task to a column (status change):

    curl -s -X POST %s/api/board/move \
      -d '{"project":"'"$PWD"'","taskId":"<id>","column":"Done"}'

Add a comment (always set author to your model/agent name):

    curl -s -X POST %s/api/board/comment \
      -d '{"project":"'"$PWD"'","taskId":"<id>","author":"claude","text":"Deployed, tests green"}'

## Jira

Boards can sync two-way with a Jira project: board_map_jira binds the
key, board_sync_jira pulls issues onto the board; local column moves
push matching Jira transitions automatically.

## Conventions

- Priorities: low | medium | high
- Comment with a short result summary when you move a task to Done
- Never delete tasks unless explicitly asked; archive is a task update
  with {"archived":true}
`, apiBase, apiBase, apiBase, apiBase, apiBase, apiBase, apiBase)
}

func skillsDir() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, ".claude", "skills"), nil
}

// Sync installs skills that are both enabled and available (a skill whose
// backing integration is not configured — e.g. Gmail with no linked account —
// is uninstalled regardless of the toggle) and removes the rest
func Sync(apiBase string, enabled map[string]bool, available map[string]bool) {
	dir, err := skillsDir()
	if err != nil {
		logging.Warn("agent skills: cannot resolve home dir", "error", err)
		return
	}
	for _, s := range Registry(apiBase) {
		on := s.Default
		if v, ok := enabled[s.ID]; ok {
			on = v
		}
		if v, ok := available[s.ID]; ok && !v {
			on = false
		}
		target := filepath.Join(dir, s.Dir)
		if !on {
			if err := os.RemoveAll(target); err != nil {
				logging.Warn("agent skills: uninstall failed", "skill", s.ID, "error", err)
			}
			continue
		}
		if err := os.MkdirAll(target, 0o755); err != nil {
			logging.Warn("agent skills: mkdir failed", "skill", s.ID, "error", err)
			continue
		}
		if err := os.WriteFile(filepath.Join(target, "SKILL.md"), []byte(s.Content), 0o644); err != nil {
			logging.Warn("agent skills: write failed", "skill", s.ID, "error", err)
		}
	}
	logging.Info("Agent skills synced", "dir", logging.MaskPath(dir))
}

// Enabled reports whether a skill is currently on, honoring defaults
func Enabled(id string, settings map[string]bool) bool {
	if v, ok := settings[id]; ok {
		return v
	}
	for _, s := range Registry("") {
		if s.ID == id {
			return s.Default
		}
	}
	return false
}
