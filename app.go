package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/kalor62/cyberlife/internal/agentskills"
	"github.com/kalor62/cyberlife/internal/api"
	"github.com/kalor62/cyberlife/internal/automations"
	"github.com/kalor62/cyberlife/internal/calendar"
	"github.com/kalor62/cyberlife/internal/claude"
	"github.com/kalor62/cyberlife/internal/git"
	"github.com/kalor62/cyberlife/internal/gmail"
	"github.com/kalor62/cyberlife/internal/health"
	"github.com/kalor62/cyberlife/internal/iterm"
	"github.com/kalor62/cyberlife/internal/logging"
	"github.com/kalor62/cyberlife/internal/paths"
	"github.com/kalor62/cyberlife/internal/platform"
	"github.com/kalor62/cyberlife/internal/state"
	"github.com/kalor62/cyberlife/internal/structure"

	"github.com/wailsapp/wails/v2/pkg/runtime"
)

// App struct
type App struct {
	ctx              context.Context
	stateManager     *state.Manager
	gitManager       *git.Manager
	claudeDetector   *claude.Detector
	toolsManager     *claude.ToolsManager
	structureScanner *structure.Scanner
	itermController  *iterm.Controller
	automationEngine *automations.Engine
	apiServer        *api.Server
	stopBackground   chan struct{}
	gmailManager     *gmail.Manager
	calendarManager  *calendar.Manager
	gmailContacts    map[string]gmailContactsCache
	voiceProcess     *exec.Cmd
	voiceStdin       io.WriteCloser
	voiceMu          sync.Mutex
	mu               sync.RWMutex
	cachedSkillsScan []claude.UnifiedSkill // cached scan for diff/graph reuse
}

// NewApp creates a new App
func NewApp() *App {
	return &App{}
}

// startup is called when the app starts
func (a *App) startup(ctx context.Context) {
	a.ctx = ctx
	a.stopBackground = make(chan struct{})

	// Initialize logger first
	if err := logging.InitDefault(); err != nil {
		fmt.Printf("Error initializing logger: %v\n", err)
	} else {
		logging.Info("Application starting", "version", "1.0.0")
	}

	// Initialize state manager first
	stateMgr, err := state.NewManager()
	if err != nil {
		logging.Error("Failed to initialize state manager", "error", err)
	} else {
		a.stateManager = stateMgr
		a.stateManager.SetEmitter(func(event string, payload any) {
			runtime.EventsEmit(a.ctx, event, payload)
		})

		if err := a.stateManager.SeedSampleData(); err != nil {
			logging.Warn("sample data seed failed", "error", err)
		}

		a.automationEngine = automations.NewEngine(a.stateManager, automations.Actions{
			RunAgent: a.automationRunAgent,
			MoveTask: a.automationMoveTask,
			Comment:  a.automationComment,
			Notify:   a.automationNotify,
			SendMail: a.automationSendMail,
			EmitEvent: func(event string, payload map[string]string) {
				runtime.EventsEmit(a.ctx, event, payload)
			},
			OnRun: func(run state.AutomationRun) {
				runtime.EventsEmit(a.ctx, "automation-run", run)
			},
		})
		a.automationEngine.StartCron()
		go a.pollMailForAutomations()

		// Calendar manager must exist before the API server registers its hooks
		a.calendarManager = calendar.NewManager()
		a.calendarManager.SetTokenRefreshHandler(func(email, tokenJSON string) {
			a.stateManager.UpdateCalendarToken(email, tokenJSON)
		})

		// Agent-facing surface: local REST+MCP API and built-in skills
		a.apiServer = api.NewServer(a.stateManager, api.Hooks{
			OnChange: func(projectID string) {
				runtime.EventsEmit(a.ctx, "kanban-changed", projectID)
			},
			OnMove: a.onBoardMove,
			HealthReport: func(projectID string) any {
				return a.GetSelectedHealthReport(projectID)
			},
			HealthLibrary: func() any {
				return a.GetHealthLibrary()
			},
			AutoRun: func(ruleID string) (state.AutomationRun, error) {
				return a.automationEngine.RunNow(ruleID)
			},
			OnAutoChange: func() {
				runtime.EventsEmit(a.ctx, "automations-changed", nil)
			},
			OnWidgetsChange: func() {
				runtime.EventsEmit(a.ctx, "widgets-changed", nil)
			},
			TermCreate: a.automationRunAgent,
			TaskCreate: func(projectID, name, jiraKey, branch, baseBranch string, repos []string) (any, error) {
				return a.CreateProjectTask(projectID, name, jiraKey, branch, baseBranch, "", repos)
			},
			TaskDelete: func(projectID, taskID string, deleteBranch bool) error {
				return a.DeleteProjectTask(projectID, taskID, deleteBranch, false)
			},
			JiraMap: a.SetProjectJira,
			JiraSync: func(projectID string) (any, error) {
				return a.SyncJiraBoard(projectID)
			},
			Dependencies: func() any {
				return a.CheckDependencies()
			},
			Emit: func(event string) {
				runtime.EventsEmit(a.ctx, event, nil)
			},
			EmitPayload: func(event string, payload any) {
				runtime.EventsEmit(a.ctx, event, payload)
			},
			WebhookFire: func(slug string, body []byte) int {
				return a.automationEngine.FireWebhook(slug, body)
			},
			OnAddonsChange: func() {
				a.syncAgentSkills()
				runtime.EventsEmit(a.ctx, "addons-changed", nil)
			},
			Notify: a.raiseNotification,
			Notifications: func(includeArchived bool, limit int) any {
				return a.stateManager.GetNotifications(includeArchived, limit)
			},
			Calendar: a.calendarHooks(),
		})
		a.apiServer.Start()
		a.syncAgentSkills()
	}

	// Initialize git manager
	a.gitManager = git.NewManager()

	// Initialize Claude CLI detector
	a.claudeDetector = claude.NewDetector()

	// Initialize tools manager for agents, skills, hooks
	a.toolsManager = claude.NewToolsManager()

	// Initialize structure scanner
	a.structureScanner = structure.NewScanner()

	// Initialize Gmail manager
	a.gmailManager = gmail.NewManager()
	if a.stateManager != nil {
		a.gmailManager.SetTokenRefreshHandler(func(email, tokenJSON string) {
			a.stateManager.UpdateGmailToken(email, tokenJSON)
		})
	}

	// Initialize iTerm2 controller (no polling - sync on demand only)
	a.itermController = iterm.NewController()
	a.itermController.SetTmuxMode(true) // tmux is the only session mode
	logging.Info("iTerm2 controller initialized")

	// Restore window state after a short delay (needs window to be ready)
	const windowReadyDelay = 150 * time.Millisecond
	go func() {
		time.Sleep(windowReadyDelay)
		a.restoreWindowState()
	}()
}

// shutdown is called when the app is closing
func (a *App) shutdown(ctx context.Context) {
	// Save window state before closing
	a.saveWindowState()

	if a.stopBackground != nil {
		close(a.stopBackground)
	}
	if a.automationEngine != nil {
		a.automationEngine.StopCron()
	}
	if a.apiServer != nil {
		a.apiServer.Shutdown(ctx)
	}

	// Stop iTerm2 polling and content watching
	if a.itermController != nil {
		a.itermController.StopStyledContentWatching()
		a.itermController.StopPolling()
	}
	if a.stateManager != nil {
		a.stateManager.SaveSync()
	}
}

// restoreWindowState restores the window position and size from saved state
func (a *App) restoreWindowState() {
	if a.stateManager == nil {
		return
	}

	ws := a.stateManager.GetWindowState()
	if ws == nil {
		logging.Debug("No window state to restore")
		return
	}

	// Restore maximized state first if set
	if ws.Maximized {
		runtime.WindowMaximise(a.ctx)
		logging.Info("Window state restored (maximized)")
		return
	}

	// Validate position is within reasonable bounds (supports multi-monitor)
	positionValid := ws.X >= minWindowX && ws.X <= maxWindowX &&
		ws.Y >= minWindowY && ws.Y <= maxWindowY

	// Validate size is reasonable
	sizeValid := ws.Width >= minWindowWidth && ws.Height >= minWindowHeight

	if positionValid {
		runtime.WindowSetPosition(a.ctx, ws.X, ws.Y)
	} else {
		logging.Warn("Skipping window position restore - out of bounds", "x", ws.X, "y", ws.Y)
	}

	if sizeValid {
		runtime.WindowSetSize(a.ctx, ws.Width, ws.Height)
	} else {
		logging.Warn("Skipping window size restore - invalid", "width", ws.Width, "height", ws.Height)
	}

	logging.Info("Window state restored", "x", ws.X, "y", ws.Y, "width", ws.Width, "height", ws.Height)
}

// saveWindowState saves the current window position and size
func (a *App) saveWindowState() {
	if a.stateManager == nil {
		return
	}

	maximized := runtime.WindowIsMaximised(a.ctx)

	var x, y, width, height int

	if maximized {
		// When maximized, try to preserve the previous non-maximized state
		existing := a.stateManager.GetWindowState()
		if existing != nil && !existing.Maximized {
			x, y = existing.X, existing.Y
			width, height = existing.Width, existing.Height
		} else {
			// Use current values as fallback
			x, y = runtime.WindowGetPosition(a.ctx)
			width, height = runtime.WindowGetSize(a.ctx)
		}
	} else {
		x, y = runtime.WindowGetPosition(a.ctx)
		width, height = runtime.WindowGetSize(a.ctx)
	}

	ws := &state.WindowState{
		X:         x,
		Y:         y,
		Width:     width,
		Height:    height,
		Maximized: maximized,
	}

	a.stateManager.SetWindowState(ws)
	logging.Info("Window state saved", "x", x, "y", y, "width", width, "height", height, "maximized", maximized)
}

// GetState returns the full application state
func (a *App) GetState() *state.AppState {
	if a.stateManager == nil {
		return state.NewAppState()
	}
	return a.stateManager.GetState()
}

// GetProjects returns all projects
func (a *App) GetProjects() []*state.ProjectState {
	if a.stateManager == nil {
		return []*state.ProjectState{}
	}
	return a.stateManager.GetProjects()
}

// GetProject returns a project by ID
func (a *App) GetProject(id string) *state.ProjectState {
	if a.stateManager == nil {
		return nil
	}
	return a.stateManager.GetProject(id)
}

// CreateProject creates a new project
func (a *App) CreateProject(name, path string) (*state.ProjectState, error) {
	if a.stateManager == nil {
		return nil, fmt.Errorf("state manager not initialized")
	}
	return a.stateManager.CreateProject(name, path)
}

func expandHomePath(path string) string {
	path = strings.TrimSpace(path)
	if path == "~" {
		home, _ := os.UserHomeDir()
		return home
	}
	if strings.HasPrefix(path, "~/") {
		home, _ := os.UserHomeDir()
		return filepath.Join(home, path[2:])
	}
	return path
}

// ExpandPath resolves ~ to the user's home directory
func (a *App) ExpandPath(path string) string {
	return expandHomePath(path)
}

// PathExists reports whether a filesystem path exists
func (a *App) PathExists(path string) bool {
	_, err := os.Stat(expandHomePath(path))
	return err == nil
}

// CreateDirectory creates a directory (with parents)
func (a *App) CreateDirectory(path string) error {
	return os.MkdirAll(expandHomePath(path), 0o755)
}

// ConfirmDialog shows a native yes/no dialog (WKWebView has no working window.confirm)
func (a *App) ConfirmDialog(title, message string) (bool, error) {
	result, err := runtime.MessageDialog(a.ctx, runtime.MessageDialogOptions{
		Type:          runtime.QuestionDialog,
		Title:         title,
		Message:       message,
		Buttons:       []string{"Yes", "No"},
		DefaultButton: "Yes",
		CancelButton:  "No",
	})
	if err != nil {
		return false, err
	}
	return result == "Yes", nil
}

// projectsChanged tells the UI to redraw anything listing projects. The agent
// API emits the same event, so a rename made in the app and one made by an
// agent land on screen the same way.
func (a *App) projectsChanged(err error) error {
	if err == nil {
		runtime.EventsEmit(a.ctx, "projects-changed", nil)
	}
	return err
}

// UpdateProject updates a project
func (a *App) UpdateProject(p state.ProjectState) error {
	if a.stateManager == nil {
		return fmt.Errorf("state manager not initialized")
	}
	return a.projectsChanged(a.stateManager.UpdateProject(&p))
}

// DeleteProject deletes a project
func (a *App) DeleteProject(id string) error {
	if a.stateManager == nil {
		return fmt.Errorf("state manager not initialized")
	}
	return a.projectsChanged(a.stateManager.DeleteProject(id))
}

// GetProjectGroups returns all project groups
func (a *App) GetProjectGroups() []*state.ProjectGroup {
	if a.stateManager == nil {
		return []*state.ProjectGroup{}
	}
	return a.stateManager.GetProjectGroups()
}

// CreateProjectGroup creates a new project group
func (a *App) CreateProjectGroup(name, icon, color string) (*state.ProjectGroup, error) {
	if a.stateManager == nil {
		return nil, fmt.Errorf("state manager not initialized")
	}
	group, err := a.stateManager.CreateProjectGroup(name, icon, color)
	return group, a.projectsChanged(err)
}

// UpdateProjectGroup updates a project group
func (a *App) UpdateProjectGroup(g state.ProjectGroup) error {
	if a.stateManager == nil {
		return fmt.Errorf("state manager not initialized")
	}
	return a.projectsChanged(a.stateManager.UpdateProjectGroup(&g))
}

// DeleteProjectGroup deletes a project group and unassigns its projects
func (a *App) DeleteProjectGroup(id string) error {
	if a.stateManager == nil {
		return fmt.Errorf("state manager not initialized")
	}
	return a.projectsChanged(a.stateManager.DeleteProjectGroup(id))
}

func uniquePath(path string) string {
	candidate := path
	for i := 2; ; i++ {
		if _, err := os.Stat(candidate); os.IsNotExist(err) {
			return candidate
		}
		candidate = fmt.Sprintf("%s-%d", path, i)
	}
}

func copySeedFile(projectPath, worktreePath, rel string) error {
	src := filepath.Join(projectPath, rel)
	dst := filepath.Join(worktreePath, rel)

	data, err := os.ReadFile(src)
	if err != nil {
		return err
	}
	if _, err := os.Stat(dst); err == nil {
		return nil
	}
	if err := os.MkdirAll(filepath.Dir(dst), 0755); err != nil {
		return err
	}
	return os.WriteFile(dst, data, 0644)
}

// ListProjectRepos returns the repos a task can span: the project folder itself
// when it's a git repo, otherwise its direct subfolders that are git repos
func (a *App) ListProjectRepos(projectID string) ([]ProjectRepo, error) {
	if a.stateManager == nil || a.gitManager == nil {
		return nil, fmt.Errorf("not initialized")
	}
	project := a.stateManager.GetProject(projectID)
	if project == nil {
		return nil, fmt.Errorf("project not found")
	}

	if a.gitManager.IsGitRepo(project.Path) {
		return []ProjectRepo{{Name: filepath.Base(project.Path), Path: project.Path}}, nil
	}

	entries, err := os.ReadDir(project.Path)
	if err != nil {
		return nil, err
	}
	repos := []ProjectRepo{}
	for _, e := range entries {
		if !e.IsDir() || strings.HasPrefix(e.Name(), ".") {
			continue
		}
		sub := filepath.Join(project.Path, e.Name())
		if a.gitManager.IsGitRepo(sub) {
			repos = append(repos, ProjectRepo{Name: e.Name(), Path: sub})
		}
	}
	return repos, nil
}

func copyDirRecursive(src, dst string) error {
	return filepath.WalkDir(src, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(src, path)
		if err != nil {
			return err
		}
		target := filepath.Join(dst, rel)
		info, err := d.Info()
		if err != nil {
			return err
		}
		if d.IsDir() {
			return os.MkdirAll(target, 0755)
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		return os.WriteFile(target, data, info.Mode().Perm())
	})
}

func (a *App) seedWorktree(repoPath, worktreePath string) {
	for _, rel := range worktreeSeedFiles {
		if err := copySeedFile(repoPath, worktreePath, rel); err != nil && !os.IsNotExist(err) {
			logging.Warn("Failed to copy seed file into worktree", "file", rel, "error", err)
		}
	}
}

// SetActiveProject sets the currently active project
func (a *App) SetActiveProject(id string) {
	if a.stateManager != nil {
		a.stateManager.SetActiveProject(id)
	}
}

// GetActiveProject returns the active project ID
func (a *App) GetActiveProject() string {
	if a.stateManager == nil {
		return ""
	}
	return a.stateManager.GetActiveProjectID()
}

// SelectDirectory opens a directory picker
func (a *App) SelectDirectory() (string, error) {
	return runtime.OpenDirectoryDialog(a.ctx, runtime.OpenDialogOptions{
		Title: "Select Project Directory",
	})
}

// GetDefaultColors returns available colors
func (a *App) GetDefaultColors() []string {
	return state.DefaultColors
}

// GetDefaultIcons returns available icons
func (a *App) GetDefaultIcons() []string {
	return state.DefaultIcons
}

func findClaudeCLI() string {
	if p, err := exec.LookPath("claude"); err == nil {
		return p
	}
	if p, err := exec.LookPath("claude"); err == nil {
		return p
	}
	home, _ := os.UserHomeDir()
	for _, p := range []string{
		filepath.Join(home, ".claude", "local", "claude"),
		"/opt/homebrew/bin/claude",
		"/usr/local/bin/claude",
	} {
		if _, err := os.Stat(p); err == nil {
			return p
		}
	}
	return ""
}

// GetClaudeSessions lists live Claude Code processes on this machine, read
// from the heartbeat files under ~/.claude/sessions (any terminal, not just
// Cyber Life's own).
func (a *App) GetClaudeSessions() []claude.SessionInfo {
	return claude.LiveSessions()
}

// KillClaudeSession terminates a live Claude Code session by pid (SIGTERM,
// or SIGKILL with force). Refuses pids that are not live Claude sessions.
func (a *App) KillClaudeSession(pid int, force bool) error {
	return claude.KillSession(pid, force)
}

// GetTerminalTheme returns the current terminal theme name
func (a *App) GetTerminalTheme() string {
	if a.stateManager == nil {
		return "dracula"
	}
	return a.stateManager.GetTerminalTheme()
}

// SetTerminalTheme sets the terminal theme for all terminals
func (a *App) SetTerminalTheme(themeName string) {
	if a.stateManager != nil {
		a.stateManager.SetTerminalTheme(themeName)
	}
}

// GetTerminalFontSize returns the current terminal font size
func (a *App) GetTerminalFontSize() int {
	if a.stateManager == nil {
		return 12
	}
	return a.stateManager.GetTerminalFontSize()
}

// SetTerminalFontSize sets the terminal font size for all terminals
func (a *App) SetTerminalFontSize(size int) {
	if a.stateManager != nil {
		a.stateManager.SetTerminalFontSize(size)
	}
}

// GetAllViewFontSize returns the saved ALL view font size
func (a *App) GetAllViewFontSize() int {
	if a.stateManager == nil {
		return 9
	}
	return a.stateManager.GetAllViewFontSize()
}

// SetAllViewFontSize saves the ALL view font size
func (a *App) SetAllViewFontSize(size int) {
	if a.stateManager != nil {
		a.stateManager.SetAllViewFontSize(size)
	}
}

// GetTranscriptionEngine returns the selected speech-to-text engine ("native" or "scribe")
func (a *App) GetTranscriptionEngine() string {
	if a.stateManager == nil {
		return "native"
	}
	return a.stateManager.GetTranscriptionEngine()
}

// SetTranscriptionEngine saves the selected speech-to-text engine
func (a *App) SetTranscriptionEngine(engine string) {
	if a.stateManager != nil {
		a.stateManager.SetTranscriptionEngine(engine)
	}
}

// GetElevenLabsAPIKey returns the saved ElevenLabs API key
func (a *App) GetElevenLabsAPIKey() string {
	if a.stateManager == nil {
		return ""
	}
	return a.stateManager.GetElevenLabsAPIKey()
}

// SetElevenLabsAPIKey saves the ElevenLabs API key
func (a *App) SetElevenLabsAPIKey(key string) {
	if a.stateManager != nil {
		a.stateManager.SetElevenLabsAPIKey(key)
	}
}

// GetClaudeAccounts returns the saved Claude accounts (named CLAUDE_CONFIG_DIR profiles)
func (a *App) GetClaudeAccounts() []state.ClaudeAccount {
	if a.stateManager == nil {
		return []state.ClaudeAccount{{ID: "default", Name: "Personal · Max", ConfigDir: ""}}
	}
	return a.stateManager.GetClaudeAccounts()
}

// SetClaudeAccounts replaces the saved Claude accounts
func (a *App) SetClaudeAccounts(accounts []state.ClaudeAccount) {
	if a.stateManager != nil {
		a.stateManager.SetClaudeAccounts(accounts)
	}
}

// GetDashboardFullscreen returns the saved dashboard fullscreen state
func (a *App) GetDashboardFullscreen() bool {
	if a.stateManager == nil {
		return false
	}
	return a.stateManager.GetDashboardFullscreen()
}

// SetDashboardFullscreen saves the dashboard fullscreen state
func (a *App) SetDashboardFullscreen(enabled bool) {
	if a.stateManager != nil {
		a.stateManager.SetDashboardFullscreen(enabled)
	}
}

// GetTerminalNameOverrides returns all custom terminal name overrides
func (a *App) GetTerminalNameOverrides() map[string]string {
	if a.stateManager == nil {
		return map[string]string{}
	}
	return a.stateManager.GetTerminalNameOverrides()
}

// SetTerminalNameOverride stores a custom name for a session
func (a *App) SetTerminalNameOverride(sessionID, name string) {
	if a.stateManager != nil {
		a.stateManager.SetTerminalNameOverride(sessionID, name)
	}
}

// GetTerminalAccounts returns the Claude account (CLAUDE_CONFIG_DIR) per terminal session
func (a *App) GetTerminalAccounts() map[string]string {
	if a.stateManager == nil {
		return map[string]string{}
	}
	return a.stateManager.GetTerminalAccounts()
}

// SetTerminalAccount records which Claude account a terminal session uses
func (a *App) SetTerminalAccount(sessionID, configDir string) {
	if a.stateManager != nil {
		a.stateManager.SetTerminalAccount(sessionID, configDir)
	}
}

// ClearTerminalAccount removes the recorded account for a closed session
func (a *App) ClearTerminalAccount(sessionID string) {
	if a.stateManager != nil {
		a.stateManager.ClearTerminalAccount(sessionID)
	}
}

// GetPinnedTerminals returns all pinned terminals (projectName -> tabName)
func (a *App) GetPinnedTerminals() map[string]string {
	if a.stateManager == nil {
		return map[string]string{}
	}
	return a.stateManager.GetPinnedTerminals()
}

// SetPinnedTerminal sets or clears the pinned terminal for a project
func (a *App) SetPinnedTerminal(projectName, tabName string) {
	if a.stateManager != nil {
		a.stateManager.SetPinnedTerminal(projectName, tabName)
	}
}

// GetPomodoroSettings returns the saved pomodoro timer settings
func (a *App) GetPomodoroSettings() *state.PomodoroSettings {
	if a.stateManager == nil {
		return &state.PomodoroSettings{SessionMinutes: 25, BreakMinutes: 5}
	}
	return a.stateManager.GetPomodoroSettings()
}

// SavePomodoroSettings saves the pomodoro timer settings
func (a *App) SavePomodoroSettings(sessionMinutes, breakMinutes int) {
	if a.stateManager != nil {
		a.stateManager.SavePomodoroSettings(sessionMinutes, breakMinutes)
	}
}

func (a *App) CheckDependencies() []DependencyStatus {
	tmuxPath := iterm.FindTmuxPath()
	claudePath := findClaudeCLI()
	itermErr := fmt.Errorf("mac-only")
	if platform.IsMac() {
		_, itermErr = os.Stat("/Applications/iTerm.app")
	}
	nodePath, _ := exec.LookPath("node")
	if nodePath == "" {
		for _, p := range []string{"/opt/homebrew/bin/node", "/usr/local/bin/node"} {
			if _, err := os.Stat(p); err == nil {
				nodePath = p
				break
			}
		}
	}

	// Install hints have to name the platform's own package manager, or they
	// send a Linux user to a command that does not exist there.
	install := func(mac, linux string) string {
		if platform.IsMac() {
			return mac
		}
		return linux
	}

	deps := []DependencyStatus{
		{
			ID: "tmux", Name: "tmux", OK: tmuxPath != "", Required: true, Path: tmuxPath,
			Purpose: "Runs every session — sessions survive app restarts and stream into the dashboard",
			Hint:    install("brew install tmux", "sudo apt install tmux"),
		},
		{
			ID: "claude", Name: "Claude Code CLI", OK: claudePath != "", Required: true, Path: claudePath,
			Purpose: "The built-in default runner",
			Hint:    "npm install -g @anthropic-ai/claude-code",
		},
		{
			ID: "node", Name: "Node.js", OK: nodePath != "", Required: false, Path: nodePath,
			Purpose: "Optional — powers the built-in Gmail MCP server",
			Hint:    install("brew install node", "sudo apt install nodejs npm"),
		},
	}
	// iTerm2 is a macOS application; on Linux the row would only ever be a
	// permanent failure for something the platform cannot have.
	if platform.IsMac() {
		deps = append(deps, DependencyStatus{
			ID: "iterm", Name: "iTerm2", OK: itermErr == nil, Required: false,
			Purpose: "Optional — open a session in a real terminal window (o / ⤴)",
			Hint:    "brew install --cask iterm2",
		})
	}
	return deps
}

func (a *App) GetRunners() []state.Runner {
	if a.stateManager == nil {
		return nil
	}
	return a.stateManager.GetRunners()
}

func (a *App) SaveRunner(r state.Runner) (state.Runner, error) {
	if a.stateManager == nil {
		return state.Runner{}, fmt.Errorf("state manager not initialized")
	}
	return a.stateManager.SaveRunner(r)
}

func (a *App) DeleteRunner(id string) error {
	if a.stateManager == nil {
		return fmt.Errorf("state manager not initialized")
	}
	return a.stateManager.DeleteRunner(id)
}

func (a *App) GetDefaultRunner() string {
	if a.stateManager == nil {
		return ""
	}
	return a.stateManager.GetDefaultRunner()
}

func (a *App) SetDefaultRunner(id string) error {
	if a.stateManager == nil {
		return fmt.Errorf("state manager not initialized")
	}
	return a.stateManager.SetDefaultRunner(id)
}

func (a *App) GetTerminalRunners() map[string]string {
	if a.stateManager == nil {
		return map[string]string{}
	}
	return a.stateManager.GetTerminalRunners()
}

func (a *App) SetTerminalRunner(sessionID, runnerID string) {
	if a.stateManager != nil {
		a.stateManager.SetTerminalRunner(sessionID, runnerID)
	}
}

// RequestStyledHistory requests styled scrollback history via Python bridge
func (a *App) RequestStyledHistory(sessionID string) error {
	if a.itermController == nil {
		return fmt.Errorf("iTerm controller not initialized")
	}
	return a.itermController.RequestStyledHistory(sessionID, func(content *iterm.StyledContent) {
		linesJSON, err := json.Marshal(content.Lines)
		if err != nil {
			return
		}
		runtime.EventsEmit(a.ctx, "iterm-session-history", map[string]interface{}{
			"sessionId":   content.SessionID,
			"lines":       string(linesJSON),
			"historySize": content.HistorySize,
		})
	})
}

// IsGitRepo checks if a path is a git repository
func (a *App) IsGitRepo(path string) bool {
	if a.gitManager == nil {
		return false
	}
	return a.gitManager.IsGitRepo(path)
}

// GetGitChangedFiles returns list of changed files in repo
func (a *App) GetGitChangedFiles(path string) ([]git.ChangedFile, error) {
	if a.gitManager == nil {
		return nil, fmt.Errorf("git manager not initialized")
	}
	return a.gitManager.GetChangedFiles(path)
}

// GetGitFileDiff returns the diff for a specific file
func (a *App) GetGitFileDiff(repoPath, filePath string) (*git.FileDiff, error) {
	if a.gitManager == nil {
		return nil, fmt.Errorf("git manager not initialized")
	}
	return a.gitManager.GetFileDiff(repoPath, filePath)
}

// GetGitCurrentBranch returns the current branch name
func (a *App) GetGitCurrentBranch(path string) string {
	if a.gitManager == nil {
		return ""
	}
	return a.gitManager.GetCurrentBranch(path)
}

// GetGitStatus returns git status counts (staged, unstaged, untracked)
func (a *App) GetGitStatus(path string) map[string]int {
	if a.gitManager == nil {
		return map[string]int{"staged": 0, "unstaged": 0, "untracked": 0}
	}
	staged, unstaged, untracked := a.gitManager.GetStatus(path)
	return map[string]int{
		"staged":    staged,
		"unstaged":  unstaged,
		"untracked": untracked,
	}
}

// GetProjectDependencies reads dependencies from package.json
func (a *App) GetProjectDependencies(projectPath string) map[string]string {
	if a.toolsManager == nil {
		return map[string]string{}
	}
	deps, _ := a.toolsManager.GetProjectDependencies(projectPath)
	return deps
}

// getProjectsMap builds a name->path map of registered projects (M1: deduplicated)
func (a *App) getProjectsMap() map[string]string {
	projects := make(map[string]string)
	if a.stateManager != nil {
		for _, p := range a.stateManager.GetProjects() {
			if p.Path != "" {
				projects[p.Name] = p.Path
			}
		}
	}
	return projects
}

// isRegisteredProject checks if a path is a registered project
func (a *App) isRegisteredProject(path string) bool {
	if a.stateManager == nil {
		return false
	}
	for _, p := range a.stateManager.GetProjects() {
		if p.Path == path {
			return true
		}
	}
	return false
}

// GetManualChecks returns manual check states for a project
func (a *App) GetManualChecks(projectPath string) map[string]health.ManualCheckState {
	return health.GetManualChecks(projectPath)
}

// SetManualCheck sets a manual check state
func (a *App) SetManualCheck(projectPath, checkID string, checked bool, comment string) error {
	return health.SetManualCheck(projectPath, checkID, checked, comment)
}

// SaveNotes saves notes for a project
func (a *App) SaveNotes(projectID, notes string) error {
	if a.stateManager == nil {
		return fmt.Errorf("state manager not initialized")
	}
	project := a.stateManager.GetProject(projectID)
	if project == nil {
		return fmt.Errorf("project not found")
	}
	project.Notes = notes
	return a.stateManager.UpdateProject(project)
}

// GetNotes returns notes for a project
func (a *App) GetNotes(projectID string) string {
	if a.stateManager == nil {
		return ""
	}
	project := a.stateManager.GetProject(projectID)
	if project == nil {
		return ""
	}
	return project.Notes
}

// ============================================
// SaveScreenshot stores an image pasted into the terminal input and returns
// its path; the filename comes from the webview, so it is confined to the
// project's screenshot folder
func (a *App) SaveScreenshot(projectID, base64Data, filename string) (string, error) {
	dir, err := paths.Screenshots(projectID)
	if err != nil {
		return "", err
	}
	filename = filepath.Base(strings.TrimSpace(filename))
	if filename == "" || filename == "." || filename == ".." || strings.HasPrefix(filename, ".") {
		filename = fmt.Sprintf("screenshot_%d.png", time.Now().UnixMilli())
	}
	data, err := base64.StdEncoding.DecodeString(base64Data)
	if err != nil {
		return "", fmt.Errorf("invalid image data: %w", err)
	}
	fullPath := filepath.Join(dir, filename)
	if err := os.WriteFile(fullPath, data, 0o600); err != nil {
		return "", err
	}
	return fullPath, nil
}

// GetProjectStructure returns the full file tree for a project (JS/TS files only)
func (a *App) GetProjectStructure(projectPath string) (*structure.FileNode, error) {
	if a.structureScanner == nil {
		return nil, fmt.Errorf("structure scanner not initialized")
	}
	return a.structureScanner.ScanProject(projectPath)
}

// GetProjectFolderHierarchy returns only the folder hierarchy (no files) for graph visualization
func (a *App) GetProjectFolderHierarchy(projectPath string) (*structure.FileNode, error) {
	if a.structureScanner == nil {
		return nil, fmt.Errorf("structure scanner not initialized")
	}
	return a.structureScanner.GetFolderHierarchy(projectPath)
}

// projectScopedPath resolves a path the Files module asked for and refuses
// anything outside a registered project (or its task worktrees). The webview
// reaches these bindings, so an XSS must not become arbitrary file access.
func (a *App) projectScopedPath(filePath string) (string, error) {
	if a.stateManager == nil {
		return "", fmt.Errorf("state manager not initialized")
	}
	resolved, err := filepath.Abs(filePath)
	if err != nil {
		return "", err
	}
	if real, err := filepath.EvalSymlinks(resolved); err == nil {
		resolved = real
	}
	for _, p := range a.stateManager.GetProjects() {
		if p.Path == "" {
			continue
		}
		root, err := filepath.EvalSymlinks(p.Path)
		if err != nil {
			root = p.Path
		}
		if resolved == root || strings.HasPrefix(resolved, root+string(filepath.Separator)) {
			return resolved, nil
		}
		if tasks := filepath.Dir(root) + string(filepath.Separator) + filepath.Base(root) + "-tasks"; strings.HasPrefix(resolved, tasks+string(filepath.Separator)) {
			return resolved, nil
		}
	}
	return "", fmt.Errorf("path is outside every registered project")
}

// ReadFileContent reads and returns the content of a file inside a project
func (a *App) ReadFileContent(filePath string) (string, error) {
	safe, err := a.projectScopedPath(filePath)
	if err != nil {
		logging.Warn("file read refused", "error", err)
		return "", err
	}
	content, err := os.ReadFile(safe)
	if err != nil {
		return "", err
	}
	return string(content), nil
}

// SaveFileContent saves content to a file inside a project
func (a *App) SaveFileContent(filePath string, content string) error {
	safe, err := a.projectScopedPath(filePath)
	if err != nil {
		logging.Warn("file write refused", "error", err)
		return err
	}
	return os.WriteFile(safe, []byte(content), 0644)
}

// Log receives log messages from the frontend and routes them through the centralized logger
func (a *App) Log(level, module, message string, data map[string]interface{}) {
	logging.LogFromFrontend(logging.LogEntry{
		Level:   level,
		Module:  module,
		Message: message,
		Data:    data,
	})
}

// IsDevMode returns whether the application is running in development mode
func (a *App) IsDevMode() bool {
	return logging.IsDevMode()
}

// onBoardMove fans a column change out to every listener (Jira push,
// automation triggers)
func (a *App) onBoardMove(projectID, taskID, columnID string) {
	a.pushJiraTransition(projectID, taskID, columnID)
	if a.automationEngine != nil {
		a.automationEngine.TaskMoved(projectID, taskID, columnID)
	}
}

func shellQuote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}

func (a *App) GetWidgetSettings() state.WidgetSettings {
	if a.stateManager == nil {
		return state.WidgetSettings{}
	}
	return a.stateManager.GetWidgetSettings()
}

func (a *App) SetWidgetSettings(s state.WidgetSettings) {
	if a.stateManager == nil {
		return
	}
	a.stateManager.SetWidgetSettings(s)
}

func (a *App) GetProjectWidgets(projectID string) []string {
	if a.stateManager == nil {
		return nil
	}
	return a.stateManager.GetProjectWidgets(projectID)
}

func (a *App) SetProjectWidgets(projectID string, ids []string) error {
	if a.stateManager == nil {
		return fmt.Errorf("state manager not initialized")
	}
	return a.stateManager.SetProjectWidgets(projectID, ids)
}

func (a *App) GetModuleOrder() []string {
	if a.stateManager == nil {
		return nil
	}
	return a.stateManager.GetModuleOrder()
}

func (a *App) SetModuleOrder(ids []string) {
	if a.stateManager == nil {
		return
	}
	a.stateManager.SetModuleOrder(ids)
}

func (a *App) GetHiddenModules() []string {
	if a.stateManager == nil {
		return nil
	}
	return a.stateManager.GetHiddenModules()
}

func (a *App) SetHiddenModules(ids []string) {
	if a.stateManager == nil {
		return
	}
	a.stateManager.SetHiddenModules(ids)
}

func (a *App) GetDashboards() []state.Dashboard {
	if a.stateManager == nil {
		return nil
	}
	return a.stateManager.GetDashboards()
}

func (a *App) SaveDashboard(d state.Dashboard) (state.Dashboard, error) {
	if a.stateManager == nil {
		return state.Dashboard{}, fmt.Errorf("state manager not initialized")
	}
	return a.stateManager.SaveDashboard(d)
}

func (a *App) DeleteDashboard(id string) error {
	if a.stateManager == nil {
		return fmt.Errorf("state manager not initialized")
	}
	return a.stateManager.DeleteDashboard(id)
}

// skillAvailability maps each skill to whether its integration is ready
func (a *App) skillAvailability() (map[string]bool, map[string]string) {
	available := map[string]bool{}
	notes := map[string]string{}
	gmail := a.stateManager.GetGmailSettings()
	if !gmail.Enabled || len(gmail.Accounts) == 0 {
		available["gmail"] = false
		notes["gmail"] = "You don't have a Gmail account linked yet — add one in Settings → Gmail"
	}
	if !a.addonOn("gmail") {
		available["gmail"] = false
		notes["gmail"] = "The Gmail addon is disabled in Settings → Addons"
	}
	if !a.addonOn("health") {
		available["health"] = false
		notes["health"] = "The Project Health addon is disabled in Settings → Addons"
	}
	return available, notes
}

func (a *App) GetAgentSkills() []AgentSkillInfo {
	if a.stateManager == nil {
		return nil
	}
	settings := a.stateManager.GetAgentSkills()
	available, notes := a.skillAvailability()
	var out []AgentSkillInfo
	for _, s := range agentskills.Registry(api.Base()) {
		avail, hasEntry := available[s.ID]
		if !hasEntry {
			avail = true
		}
		out = append(out, AgentSkillInfo{
			ID:          s.ID,
			Title:       s.Title,
			Description: s.Description,
			Enabled:     avail && agentskills.Enabled(s.ID, settings),
			Available:   avail,
			Note:        notes[s.ID],
		})
	}
	return out
}

func (a *App) syncAgentSkills() {
	available, _ := a.skillAvailability()
	agentskills.Sync(api.Base(), a.stateManager.GetAgentSkills(), available)
}

func (a *App) SetAgentSkillEnabled(id string, enabled bool) {
	if a.stateManager == nil {
		return
	}
	a.stateManager.SetAgentSkill(id, enabled)
	a.syncAgentSkills()
}

// Window position bounds for validation (supports multi-monitor setups)
const (
	minWindowX      = -5000 // Allow negative for left-side monitors
	maxWindowX      = 10000
	minWindowY      = -5000
	maxWindowY      = 10000
	minWindowWidth  = 400
	minWindowHeight = 300
)

// ============================================
// State Methods
// ============================================
// ============================================
// Project Methods
// ============================================
// Task operations (git worktree + resumable Claude session per work item)
var worktreeSeedFiles = []string{".env", ".env.local", ".claude/settings.local.json"}

// ProjectRepo describes a git repository available to a project's tasks
type ProjectRepo struct {
	Name string `json:"name"`
	Path string `json:"path"`
}

// Jira integration
// ============================================
// Terminal Methods
// ============================================
// ============================================
// Gmail Client Methods
// ============================================
type gmailContactsCache struct {
	contacts []gmail.Contact
	fetched  time.Time
}

// GmailAccountInfo is per-account data exposed to the frontend (no tokens)
type GmailAccountInfo struct {
	Email      string `json:"email"`
	McpEnabled bool   `json:"mcpEnabled"`
}

// GmailConfig is the Gmail configuration exposed to the frontend (no tokens)
type GmailConfig struct {
	Enabled      bool               `json:"enabled"`
	McpEnabled   bool               `json:"mcpEnabled"`
	ClientID     string             `json:"clientId"`
	ClientSecret string             `json:"clientSecret"`
	Accounts     []GmailAccountInfo `json:"accounts"`
}

// ============================================
// Pomodoro Timer Methods
// ============================================
// ============================================
// iTerm2 Integration Methods
// ============================================
// ============================================
// Dependency Checks
// ============================================
// DependencyStatus reports one external tool the app relies on
type DependencyStatus struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	OK       bool   `json:"ok"`
	Required bool   `json:"required"`
	Path     string `json:"path,omitempty"`
	Purpose  string `json:"purpose"`
	Hint     string `json:"hint"`
}

// ============================================
// Runner Methods
// ============================================
// ============================================
// Voice Input Methods
// ============================================
// ============================================
// Agent Teams Methods
// ============================================
// ============================================
// UI State Methods
// ============================================
// ============================================
// Test History Methods
// ============================================
// ============================================
// Prompt Methods
// ============================================
// ============================================
// Docker Methods
// ============================================
// ============================================
// Git Methods
// ============================================
// ============================================
// Claude Tools Methods (Agents, Libs, Skills, Hooks)
// ============================================
// ============================================
// Commands Methods
// ============================================
// ============================================
// Unified Skills Dashboard Methods
// ============================================
// ============================================
// Health Dashboard
// ============================================
// GetProjectHealth runs health checks for a single project
// HealthLibrary bundles the check library for the configuration UI
type HealthLibrary struct {
	Stacks []string          `json:"stacks"`
	Checks []health.CheckDef `json:"checks"`
}

// ============================================
// F14: Composition Builder
// ============================================
// ============================================
// F15: Skill Analytics & Usage Tracking
// ============================================
// ============================================
// MCP Methods
// ============================================
// ============================================
// Enhanced Hooks Methods
// ============================================
// ============================================
// Template Repository Methods
// ============================================
// ============================================
// Notes Methods
// ============================================
// ============================================
// Screenshot Methods
// ============================================
// ============================================
// Test Watcher Methods
// ============================================
// ============================================
// Coverage Watcher Methods
// ============================================
// ============================================
// Structure Scanner Methods
// ============================================
// ============================================
// Logging Methods
// ============================================
// ============================================
// Kanban Board Methods
// ============================================
// KanbanBoard bundles a project's columns and tasks for the Board module
type KanbanBoard struct {
	Columns []state.KanbanColumn `json:"columns"`
	Tasks   []state.KanbanTask   `json:"tasks"`
}

// ============================================
// Jira <-> Board sync
// ============================================
// JiraSyncResult summarizes one board sync pass
type JiraSyncResult struct {
	Created int    `json:"created"`
	Updated int    `json:"updated"`
	Total   int    `json:"total"`
	Project string `json:"project"`
}

// ============================================
// Automations: action executors + bindings
// ============================================
// ============================================
// Widgets + dashboards
// ============================================
// AgentSkillInfo describes one built-in skill plus its permission state.
// Available=false means the backing integration is not configured; Note
// explains what is missing.
type AgentSkillInfo struct {
	ID          string `json:"id"`
	Title       string `json:"title"`
	Description string `json:"description"`
	Enabled     bool   `json:"enabled"`
	Available   bool   `json:"available"`
	Note        string `json:"note,omitempty"`
}

// ============================================
// Todo Methods
// ============================================
// ============================================
// Prompt History Methods
// ============================================
// ============================================
// Test Scanner Methods
// ============================================
