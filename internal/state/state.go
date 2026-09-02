package state

import (
	"encoding/json"
	"time"
)

// KanbanColumn is one board column; its ID is the surface automation rules
// bind to ("task entered column X")
type KanbanColumn struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Order     int    `json:"order"`
	WipLimit  int    `json:"wipLimit,omitempty"`
	Collapsed bool   `json:"collapsed,omitempty"`
}

// KanbanComment is a note on a task; Author distinguishes humans from agents
type KanbanComment struct {
	ID        string    `json:"id"`
	Author    string    `json:"author"`
	Text      string    `json:"text"`
	CreatedAt time.Time `json:"createdAt"`
}

// KanbanTask is a card on the project board
type KanbanTask struct {
	ID          string          `json:"id"`
	Title       string          `json:"title"`
	Description string          `json:"description,omitempty"`
	ColumnID    string          `json:"columnId"`
	Order       int             `json:"order"`
	Category    string          `json:"category,omitempty"`
	Priority    string          `json:"priority,omitempty"` // low | medium | high
	Blocked     bool            `json:"blocked,omitempty"`
	Archived    bool            `json:"archived,omitempty"`
	Pinned      bool            `json:"pinned,omitempty"`
	DueDate     *time.Time      `json:"dueDate,omitempty"`
	JiraKey     string          `json:"jiraKey,omitempty"`
	Comments    []KanbanComment `json:"comments,omitempty"`
	CreatedAt   time.Time       `json:"createdAt"`
	UpdatedAt   time.Time       `json:"updatedAt"`
}

// ClaudeAccount maps a named Claude login to a CLAUDE_CONFIG_DIR.
// An empty ConfigDir means the default account (~/.claude).
type ClaudeAccount struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	ConfigDir string `json:"configDir"`
}

// ProjectGroup is a project tag/filter; its Color is the accent shown on
// every project card belonging to the group
type ProjectGroup struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Icon      string `json:"icon"`
	Color     string `json:"color,omitempty"`
	Collapsed bool   `json:"collapsed"`
}

// TaskRepoState is one repository checked out (as a git worktree) for a task
type TaskRepoState struct {
	RepoName     string `json:"repoName"`
	RepoPath     string `json:"repoPath"`
	WorktreePath string `json:"worktreePath"`
	Branch       string `json:"branch"`
}

// TaskState is a work item (e.g. a Jira issue) with git worktrees (one per involved repo)
// and a persistent Claude session that can be resumed at any time
type TaskState struct {
	ID        string `json:"id"`
	ProjectID string `json:"projectId"`
	Name      string `json:"name"`
	JiraKey   string `json:"jiraKey,omitempty"`
	Status    string `json:"status"` // active | blocked | done
	Branch    string `json:"branch"`
	// WorktreePath is the Claude session cwd: the single repo's worktree,
	// or the task root folder containing all worktrees for multi-repo tasks
	WorktreePath    string          `json:"worktreePath"`
	Repos           []TaskRepoState `json:"repos,omitempty"`
	ClaudeSessionID string          `json:"claudeSessionId"`
	ClaudeConfigDir string          `json:"claudeConfigDir,omitempty"`
	SessionStarted  bool            `json:"sessionStarted"`
	CreatedAt       time.Time       `json:"createdAt"`
	LastOpened      time.Time       `json:"lastOpened"`
}

// WindowState represents the application window position and size
type WindowState struct {
	X         int  `json:"x"`
	Y         int  `json:"y"`
	Width     int  `json:"width"`
	Height    int  `json:"height"`
	Maximized bool `json:"maximized"`
}

// AppState represents the entire application state
type AppState struct {
	Version       int                      `json:"version"`
	ActiveProject string                   `json:"activeProjectId"`
	Projects      map[string]*ProjectState `json:"projects"`
	ProjectGroups []*ProjectGroup          `json:"projectGroups,omitempty"`
	// Global prompts accessible across all projects
	GlobalPrompts          []Prompt         `json:"globalPrompts"`
	GlobalPromptCategories []PromptCategory `json:"globalPromptCategories"`
	// Terminal theme (global for all terminals)
	TerminalTheme string `json:"terminalTheme"`
	// Terminal font size (global for all terminals)
	TerminalFontSize int `json:"terminalFontSize"`
	// ALL view font size
	AllViewFontSize int `json:"allViewFontSize"`
	// Voice input settings
	VoiceLang       string `json:"voiceLang"`
	VoiceAutoSubmit *bool  `json:"voiceAutoSubmit"`
	// TranscriptionEngine selects the speech-to-text backend: "native" (macOS Speech) or "scribe" (ElevenLabs Scribe v2 Realtime)
	TranscriptionEngine string `json:"transcriptionEngine"`
	// ElevenLabsAPIKey authenticates the Scribe v2 Realtime websocket
	ElevenLabsAPIKey string `json:"elevenLabsApiKey"`
	// Dashboard fullscreen mode (hide tools panel and browser tabs)
	DashboardFullscreen bool `json:"dashboardFullscreen"`
	// Pinned terminal per project (projectName -> terminal tab name)
	PinnedTerminals map[string]string `json:"pinnedTerminals,omitempty"`
	// Custom terminal tab names (sessionId -> custom name) — fallback when iTerm2 overrides
	TerminalNameOverrides map[string]string `json:"terminalNameOverrides,omitempty"`
	// Claude account per terminal session (sessionId -> CLAUDE_CONFIG_DIR)
	TerminalAccounts map[string]string `json:"terminalAccounts,omitempty"`
	// Window state (position, size)
	Window *WindowState `json:"window"`
	// Pomodoro timer settings
	Pomodoro *PomodoroSettings `json:"pomodoro"`
	// Global prompt wrapper - prepended/appended to every prompt sent to terminal
	GlobalPromptPrefix string `json:"globalPromptPrefix"`
	GlobalPromptSuffix string `json:"globalPromptSuffix"`
	// Claude accounts (named CLAUDE_CONFIG_DIR profiles) selectable per project/terminal
	ClaudeAccounts []ClaudeAccount `json:"claudeAccounts,omitempty"`
	// Jira integration (auto-fills task details from issue keys)
	Jira *JiraSettings `json:"jira,omitempty"`
	// Gmail integration (multi-account email client)
	Gmail *GmailSettings `json:"gmail,omitempty"`

	Calendar *CalendarSettings `json:"calendar,omitempty"`
	// Built-in agent skills: skill id -> enabled. Missing key = skill default.
	// Disabled skills are uninstalled from ~/.claude/skills and their API
	// endpoints reject calls.
	AgentSkills map[string]bool `json:"agentSkills,omitempty"`
	// User-defined session runners (models/CLIs beyond the built-in Claude)
	Runners []Runner `json:"runners,omitempty"`
	// Default runner for new terminals when a project does not override it.
	// Empty or "claude" = the built-in Claude runner.
	DefaultRunner string `json:"defaultRunner,omitempty"`
	// Runner per terminal session (sessionId -> runner ID); absent = claude
	TerminalRunners map[string]string `json:"terminalRunners,omitempty"`
	// User-defined health checks (always manual), shown in the library
	CustomHealthChecks []CustomHealthCheck `json:"customHealthChecks,omitempty"`
	// Automation rules (trigger → actions), per project or global
	Automations []AutomationRule `json:"automations,omitempty"`
	// Recent automation executions (newest first, capped)
	AutomationRuns []AutomationRun `json:"automationRuns,omitempty"`
	// In-app notification center entries (newest first, capped)
	Notifications []Notification `json:"notifications,omitempty"`
	// Right-sidebar widget area configuration
	Widgets *WidgetSettings `json:"widgets,omitempty"`
	// User-chosen module tab order (module ids); empty = default order
	ModuleOrder []string `json:"moduleOrder,omitempty"`
	// Module tabs the user hid from the bar (still reachable via keys/palette)
	HiddenModules []string `json:"hiddenModules,omitempty"`
	// User dashboards (tabs of widgets) shown by the Dash module
	Dashboards []Dashboard `json:"dashboards,omitempty"`
	// Installed addons the user turned on (addon id -> true). Newly
	// discovered addons are off until enabled here.
	AddonsEnabled map[string]bool `json:"addonsEnabled,omitempty"`
	// Per-addon key-value storage (addon id -> key -> JSON value)
	AddonData map[string]map[string]json.RawMessage `json:"addonData,omitempty"`
	// First-run Sample Project was created (never reseed after deletion)
	SampleSeeded bool `json:"sampleSeeded,omitempty"`
}

// WidgetSettings configures the right-sidebar widget area: which widgets
// show (in order), whether the sidebar is collapsed to the icon strip,
// its default width and per-module width overrides (moduleId -> px)
type WidgetSettings struct {
	Sidebar      []string       `json:"sidebar,omitempty"`
	Collapsed    bool           `json:"collapsed,omitempty"`
	Width        int            `json:"width,omitempty"`
	ModuleWidths map[string]int `json:"moduleWidths,omitempty"`
}

// Dashboard is a user-named tab of widgets (HOME is the built-in default)
type Dashboard struct {
	ID      string   `json:"id"`
	Name    string   `json:"name"`
	Icon    string   `json:"icon,omitempty"`
	Widgets []string `json:"widgets"`
}

// AutomationTrigger decides when a rule fires:
//
//	task-status — a board task entered a column (Column matches by name or ID)
//	cron        — EveryMinutes interval, or DailyAt "HH:MM"
//	mail        — a new inbox thread arrived (optional From/Subject filters)
//	webhook     — a POST hit /api/hooks/<Slug> (communicators, scripts, CI)
//	manual      — only via "Run now" (UI, MCP or REST)
type AutomationTrigger struct {
	Type            string `json:"type"`
	Column          string `json:"column,omitempty"`
	EveryMinutes    int    `json:"everyMinutes,omitempty"`
	DailyAt         string `json:"dailyAt,omitempty"`
	Account         string `json:"account,omitempty"`
	FromContains    string `json:"fromContains,omitempty"`
	SubjectContains string `json:"subjectContains,omitempty"`
	Slug            string `json:"slug,omitempty"`
}

// AutomationAction is one step a rule executes. Text fields accept
// placeholders: {{task.id}} {{task.title}} {{project.name}} {{project.path}}
// {{column}} {{mail.from}} {{mail.subject}} {{rule.name}}
type AutomationAction struct {
	Type string `json:"type"` // run-agent | move-task | comment | notify | send-mail | webhook | emit-event
	// run-agent
	Runner  string `json:"runner,omitempty"`
	Prompt  string `json:"prompt,omitempty"`
	WorkDir string `json:"workDir,omitempty"`
	// move-task
	Column string `json:"column,omitempty"`
	// comment
	Text string `json:"text,omitempty"`
	// notify + send-mail
	Title   string `json:"title,omitempty"`
	Message string `json:"message,omitempty"`
	Account string `json:"account,omitempty"`
	To      string `json:"to,omitempty"`
	Subject string `json:"subject,omitempty"`
	Body    string `json:"body,omitempty"`
	// webhook (outbound — Slack/Discord/Telegram/anything with an HTTP API)
	URL    string `json:"url,omitempty"`
	Method string `json:"method,omitempty"`
	// emit-event (frontend bus — addons and open views subscribe)
	Event string `json:"event,omitempty"`
}

// AutomationRule binds a trigger to actions; empty ProjectID = global rule
// (applies to every project)
type AutomationRule struct {
	ID        string             `json:"id"`
	Name      string             `json:"name"`
	ProjectID string             `json:"projectId,omitempty"`
	Enabled   bool               `json:"enabled"`
	Trigger   AutomationTrigger  `json:"trigger"`
	Actions   []AutomationAction `json:"actions"`
	LastRunAt *time.Time         `json:"lastRunAt,omitempty"`
	CreatedAt time.Time          `json:"createdAt"`
	UpdatedAt time.Time          `json:"updatedAt"`
}

// AutomationRun is one execution record; the optional IDs link the run to the
// session, task or mail thread it touched so the UI can jump across modules
type AutomationRun struct {
	ID           string    `json:"id"`
	RuleID       string    `json:"ruleId"`
	RuleName     string    `json:"ruleName"`
	ProjectID    string    `json:"projectId,omitempty"`
	TaskID       string    `json:"taskId,omitempty"`
	SessionID    string    `json:"sessionId,omitempty"`
	MailThreadID string    `json:"mailThreadId,omitempty"`
	Trigger      string    `json:"trigger"`
	Status       string    `json:"status"` // ok | error
	Detail       string    `json:"detail,omitempty"`
	StartedAt    time.Time `json:"startedAt"`
}

// CustomHealthCheck is a user-defined manual check in the health library
type CustomHealthCheck struct {
	ID          string `json:"id"`
	Title       string `json:"title"`
	Description string `json:"description,omitempty"`
	Stack       string `json:"stack"`
	Category    string `json:"category"`
}

// Runner is a CLI an agent session can run (claude is built-in; others are
// user-defined so no model names live in code)
type Runner struct {
	ID      string            `json:"id"`
	Name    string            `json:"name"`
	Command string            `json:"command"`
	Args    string            `json:"args,omitempty"`
	Env     map[string]string `json:"env,omitempty"`
	Icon    string            `json:"icon,omitempty"`
	Color   string            `json:"color,omitempty"`
	BuiltIn bool              `json:"builtIn,omitempty"`
}

// GmailSettings configures the built-in Gmail client
type GmailSettings struct {
	Enabled      bool           `json:"enabled"`
	McpEnabled   bool           `json:"mcpEnabled"`
	ClientID     string         `json:"clientId"`
	ClientSecret string         `json:"clientSecret"`
	Accounts     []GmailAccount `json:"accounts"`
}

// GmailAccount is one authorized Gmail mailbox with its own OAuth client credentials.
// McpEnabled exposes the account to the built-in Gmail MCP server (mcp-gmail/).
type GmailAccount struct {
	Email        string `json:"email"`
	TokenJSON    string `json:"tokenJson"`
	ClientID     string `json:"clientId,omitempty"`
	ClientSecret string `json:"clientSecret,omitempty"`
	McpEnabled   bool   `json:"mcpEnabled,omitempty"`
}

// CalendarSettings holds the Google Calendar accounts the user connected.
// Credentials live per account (like Gmail) so separate Google Cloud projects
// per mailbox work.
type CalendarSettings struct {
	Accounts []CalendarAccount `json:"accounts"`
}

// CalendarAccount is one authorized Google account. Shared lists the calendar
// ids the user ticked as visible to addons — everything else stays private to
// the app even though the token can read it.
type CalendarAccount struct {
	Email        string   `json:"email"`
	TokenJSON    string   `json:"tokenJson"`
	ClientID     string   `json:"clientId,omitempty"`
	ClientSecret string   `json:"clientSecret,omitempty"`
	Shared       []string `json:"shared,omitempty"`
}

// JiraSettings configures the Jira REST integration used to fetch issue details
type JiraSettings struct {
	Enabled  bool   `json:"enabled"`
	BaseURL  string `json:"baseUrl"`
	Email    string `json:"email"`
	APIToken string `json:"apiToken"`
}

// PomodoroSettings stores the user's pomodoro timer preferences
type PomodoroSettings struct {
	SessionMinutes int `json:"sessionMinutes"`
	BreakMinutes   int `json:"breakMinutes"`
}

// ProjectState represents a single project with all its state
type ProjectState struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	Path string `json:"path"`

	// UI customization
	Color           string `json:"color"`
	Icon            string `json:"icon"`
	Pinned          bool   `json:"pinned"`
	GroupID         string `json:"groupId,omitempty"`
	ClaudeConfigDir string `json:"claudeConfigDir,omitempty"`
	// Default runner for new terminals in this project. Empty inherits
	// AppState.DefaultRunner; "claude" forces the built-in even when the
	// global default is something else.
	DefaultRunner string `json:"defaultRunner,omitempty"`

	// Tasks (worktree + resumable Claude session per work item)
	Tasks []*TaskState `json:"tasks,omitempty"`

	// Project notes (markdown)
	Notes string `json:"notes"`

	// Custom prompts for Claude Code
	Prompts          []Prompt         `json:"prompts"`
	PromptCategories []PromptCategory `json:"promptCategories"`

	// Kanban board (Board module); columns double as automation trigger surface
	KanbanColumns []KanbanColumn `json:"kanbanColumns,omitempty"`
	KanbanTasks   []KanbanTask   `json:"kanbanTasks,omitempty"`
	// Jira project key this board syncs with (empty = no sync)
	JiraProject string `json:"jiraProject,omitempty"`
	// Extra JQL ANDed onto the sync query — the board mirrors a filtered
	// slice of the project (a sprint, a component, your own issues) rather
	// than every issue in it
	JiraFilter string `json:"jiraFilter,omitempty"`

	// Health check IDs tracked for this project (subset of the library)
	HealthSelected []string `json:"healthSelected,omitempty"`

	// Sidebar widgets shown only in this project (on top of the global ones)
	SidebarWidgets []string `json:"sidebarWidgets,omitempty"`

	// Metadata
	EnvVars    map[string]string `json:"envVars"`
	LastOpened time.Time         `json:"lastOpened"`
	CreatedAt  time.Time         `json:"createdAt"`
}

// Prompt represents a custom prompt for Claude Code
type Prompt struct {
	ID         string    `json:"id"`
	Title      string    `json:"title"`
	Content    string    `json:"content"`
	Category   string    `json:"category"`
	UsageCount int       `json:"usageCount"`
	Pinned     bool      `json:"pinned"`
	IsGlobal   bool      `json:"isGlobal"`
	CreatedAt  time.Time `json:"createdAt"`
	UpdatedAt  time.Time `json:"updatedAt"`
}

// PromptCategory represents a category for organizing prompts
type PromptCategory struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Order    int    `json:"order"`
	IsGlobal bool   `json:"isGlobal"`
}

// NewAppState creates a new empty app state
func NewAppState() *AppState {
	return &AppState{
		Version:  1,
		Projects: make(map[string]*ProjectState),
	}
}

// NewProjectState creates a new project state with defaults
func NewProjectState(id, name, path, color, icon string) *ProjectState {
	now := time.Now()
	return &ProjectState{
		ID:               id,
		Name:             name,
		Path:             path,
		Color:            color,
		Icon:             icon,
		EnvVars:          make(map[string]string),
		Prompts:          []Prompt{},
		PromptCategories: []PromptCategory{},
		LastOpened:       now,
		CreatedAt:        now,
	}
}
