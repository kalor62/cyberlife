package state

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/kalor62/cyberlife/internal/logging"
)

// Default colors and icons for projects
var DefaultColors = []string{
	"#6366f1", "#8b5cf6", "#ec4899", "#ef4444",
	"#f97316", "#eab308", "#22c55e", "#14b8a6",
	"#06b6d4", "#3b82f6",
}

var DefaultIcons = []string{
	// Dev & Tools
	"📁", "🚀", "⚡", "🔧", "💻",
	"🌐", "📱", "🎮", "🔬", "📊",
	"🛠️", "⚙️", "🖥️", "💾", "📡",
	"🔌", "🧪", "🧬", "🤖", "🧠",
	// Creative & Media
	"🎨", "🎵", "🎬", "📸", "✏️",
	"📝", "📐", "🖌️", "🎭", "🎪",
	// Business & Finance
	"💰", "📈", "🏦", "💼", "🏢",
	"📋", "📑", "🗂️", "📌", "🏷️",
	// Communication & Social
	"💬", "📧", "✉️", "📣", "🔔", "👥",
	"🤝", "📞", "💡", "🏆", "🎖️",
	// Security & Privacy
	"🔒", "🔑", "🛡️", "🔐", "👁️",
	// Nature & Objects
	"🌱", "🌍", "☁️", "🔥", "💎",
	"⭐", "🌙", "☀️", "🍀", "🐛",
	// Vehicles & Time
	"🏎️", "🚗", "🛞", "⏱️", "🕐",
	// Sports
	"🏓", "🎯", "🏀", "⚽", "🎾",
	// Misc
	"🧩", "📦", "🗃️", "🏗️", "🚧",
	"🔄", "📚", "🎓", "❤️", "🦊",
}

// Manager manages the centralized application state
type Manager struct {
	emit      func(event string, payload any)
	state     *AppState
	statePath string
	mu        sync.RWMutex

	// Debounced save
	saveTimer *time.Timer
	saveMu    sync.Mutex
}

// NewManager creates a new state manager
func NewManager() (*Manager, error) {
	homeDir, err := os.UserHomeDir()
	if err != nil {
		return nil, err
	}

	configDir := filepath.Join(homeDir, ".cyberlife")
	if err := os.MkdirAll(configDir, 0755); err != nil {
		return nil, err
	}

	m := &Manager{
		state:     NewAppState(),
		statePath: filepath.Join(configDir, "state.json"),
	}

	// Load existing state or migrate from old format
	if err := m.load(); err != nil {
		return nil, err
	}

	return m, nil
}

// SetEmitter injects the event sink. Keeping the desktop framework out of
// the state layer is what lets it be used (and tested) headlessly.
func (m *Manager) SetEmitter(emit func(event string, payload any)) {
	m.emit = emit
}

func (m *Manager) notify(event string, payload any) {
	if m.emit != nil {
		m.emit(event, payload)
	}
}

func (m *Manager) load() error {
	data, err := os.ReadFile(m.statePath)
	if err != nil {
		if !os.IsNotExist(err) {
			return fmt.Errorf("cannot read %s: %w", m.statePath, err)
		}
		return nil
	}
	var state AppState
	if err := json.Unmarshal(data, &state); err != nil {
		// Never start from an empty state on a parse error — the debounced
		// save would overwrite the user's real data 500ms later
		backup := m.statePath + ".corrupt"
		if werr := os.WriteFile(backup, data, 0600); werr != nil {
			logging.Error("state: backup of unreadable state failed", "error", werr)
		}
		return fmt.Errorf("state file is unreadable (kept a copy at %s): %w", backup, err)
	}
	m.state = &state
	if m.state.Projects == nil {
		m.state.Projects = make(map[string]*ProjectState)
	}
	if m.state.GlobalPrompts == nil {
		m.state.GlobalPrompts = []Prompt{}
	}
	if m.state.GlobalPromptCategories == nil {
		m.state.GlobalPromptCategories = []PromptCategory{}
	}
	for _, p := range m.state.Projects {
		if p.EnvVars == nil {
			p.EnvVars = make(map[string]string)
		}
		if p.Prompts == nil {
			p.Prompts = []Prompt{}
		}
		if p.PromptCategories == nil {
			p.PromptCategories = []PromptCategory{}
		}
	}
	return nil
}

func (m *Manager) saveImmediate() error {
	m.mu.RLock()
	data, err := json.MarshalIndent(m.state, "", "  ")
	m.mu.RUnlock()

	if err != nil {
		return err
	}

	return os.WriteFile(m.statePath, data, 0600)
}

// Save triggers a debounced save
func (m *Manager) Save() {
	m.saveMu.Lock()
	defer m.saveMu.Unlock()

	if m.saveTimer != nil {
		m.saveTimer.Stop()
	}

	m.saveTimer = time.AfterFunc(500*time.Millisecond, func() {
		if err := m.saveImmediate(); err != nil {
			logging.Error("state: debounced save failed", "error", err)
		}
	})
}

// SaveSync immediately saves state (for shutdown)
func (m *Manager) SaveSync() error {
	m.saveMu.Lock()
	if m.saveTimer != nil {
		m.saveTimer.Stop()
		m.saveTimer = nil
	}
	m.saveMu.Unlock()

	return m.saveImmediate()
}

// GetState returns the full app state
func (m *Manager) GetState() *AppState {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return clone(m.state)
}

// GetActiveProjectID returns the active project ID
func (m *Manager) GetActiveProjectID() string {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.state.ActiveProject
}

// SetActiveProject changes the active project
func (m *Manager) SetActiveProject(projectID string) {
	m.mu.Lock()
	m.state.ActiveProject = projectID
	if p, ok := m.state.Projects[projectID]; ok {
		p.LastOpened = time.Now()
	}
	m.mu.Unlock()

	m.Save()

	m.mu.RLock()
	project := clone(m.state.Projects[projectID])
	m.mu.RUnlock()
	m.notify("active-project-changed", map[string]any{
		"projectId": projectID,
		"state":     project,
	})
}

// GetProjects returns all projects
func (m *Manager) GetProjects() []*ProjectState {
	m.mu.RLock()
	defer m.mu.RUnlock()

	projects := make([]*ProjectState, 0, len(m.state.Projects))
	for _, p := range m.state.Projects {
		projects = append(projects, p)
	}
	return cloneSlice(projects)
}

// GetProject returns a project by ID
func (m *Manager) GetProject(id string) *ProjectState {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return clone(m.state.Projects[id])
}

// CreateProject creates a new project
func (m *Manager) CreateProject(name, path string) (*ProjectState, error) {
	absPath, err := filepath.Abs(path)
	if err != nil {
		return nil, err
	}

	info, err := os.Stat(absPath)
	if err != nil {
		return nil, err
	}
	if !info.IsDir() {
		return nil, os.ErrNotExist
	}

	id := uuid.New().String()
	colorIdx := len(m.state.Projects) % len(DefaultColors)
	iconIdx := len(m.state.Projects) % len(DefaultIcons)

	project := NewProjectState(id, name, absPath, DefaultColors[colorIdx], DefaultIcons[iconIdx])

	m.mu.Lock()
	m.state.Projects[id] = project
	m.mu.Unlock()

	m.Save()

	{
		m.notify("project-created", project)
	}

	return project, nil
}

// UpdateProject updates a project's basic info
func (m *Manager) UpdateProject(project *ProjectState) error {
	m.mu.Lock()
	if existing, ok := m.state.Projects[project.ID]; ok {
		// Update allowed fields
		existing.Name = project.Name
		if project.Path != "" {
			existing.Path = project.Path
		}
		existing.Color = project.Color
		existing.Icon = project.Icon
		existing.Pinned = project.Pinned
		existing.GroupID = project.GroupID
		existing.ClaudeConfigDir = project.ClaudeConfigDir
		existing.DefaultRunner = project.DefaultRunner
		existing.EnvVars = project.EnvVars
		existing.Notes = project.Notes
	}
	m.mu.Unlock()

	m.Save()

	{
		m.notify("project-updated", project)
	}

	return nil
}

// DeleteProject deletes a project
func (m *Manager) DeleteProject(id string) error {
	m.mu.Lock()
	delete(m.state.Projects, id)
	if m.state.ActiveProject == id {
		m.state.ActiveProject = ""
	}
	m.mu.Unlock()

	m.Save()

	{
		m.notify("project-deleted", map[string]string{"projectId": id})
	}

	return nil
}

// Project group operations

// GetProjectGroups returns all project groups
func (m *Manager) GetProjectGroups() []*ProjectGroup {
	m.mu.RLock()
	defer m.mu.RUnlock()
	if m.state.ProjectGroups == nil {
		return []*ProjectGroup{}
	}
	return cloneSlice(m.state.ProjectGroups)
}

// CreateProjectGroup creates a new project group
func (m *Manager) CreateProjectGroup(name, icon, color string) (*ProjectGroup, error) {
	group := &ProjectGroup{
		ID:    uuid.New().String(),
		Name:  name,
		Icon:  icon,
		Color: color,
	}

	m.mu.Lock()
	m.state.ProjectGroups = append(m.state.ProjectGroups, group)
	m.mu.Unlock()

	m.Save()
	return group, nil
}

// UpdateProjectGroup updates a group's name, icon and collapsed state
func (m *Manager) UpdateProjectGroup(group *ProjectGroup) error {
	m.mu.Lock()
	for _, g := range m.state.ProjectGroups {
		if g.ID == group.ID {
			g.Name = group.Name
			g.Icon = group.Icon
			g.Collapsed = group.Collapsed
			break
		}
	}
	m.mu.Unlock()

	m.Save()
	return nil
}

// DeleteProjectGroup deletes a group and unassigns its projects
func (m *Manager) DeleteProjectGroup(id string) error {
	m.mu.Lock()
	groups := m.state.ProjectGroups[:0]
	for _, g := range m.state.ProjectGroups {
		if g.ID != id {
			groups = append(groups, g)
		}
	}
	m.state.ProjectGroups = groups
	for _, p := range m.state.Projects {
		if p.GroupID == id {
			p.GroupID = ""
		}
	}
	m.mu.Unlock()

	m.Save()
	return nil
}

// Task operations

// CreateTask stores a prepared task (worktrees already created), assigning its identity
func (m *Manager) CreateTask(projectID string, task *TaskState) (*TaskState, error) {
	task.ID = uuid.New().String()
	task.ProjectID = projectID
	task.Status = "active"
	task.ClaudeSessionID = uuid.New().String()
	task.CreatedAt = time.Now()

	m.mu.Lock()
	project, ok := m.state.Projects[projectID]
	if !ok {
		m.mu.Unlock()
		return nil, os.ErrNotExist
	}
	project.Tasks = append(project.Tasks, task)
	m.mu.Unlock()

	m.Save()

	{
		m.notify("task-created", task)
	}

	return task, nil
}

// GetTask returns a task by project and task ID
func (m *Manager) GetTask(projectID, taskID string) *TaskState {
	m.mu.RLock()
	defer m.mu.RUnlock()
	project, ok := m.state.Projects[projectID]
	if !ok {
		return nil
	}
	for _, t := range project.Tasks {
		if t.ID == taskID {
			return clone(t)
		}
	}
	return nil
}

// UpdateTask updates a task's mutable fields (name, status, account)
func (m *Manager) UpdateTask(projectID string, task *TaskState) error {
	m.mu.Lock()
	if project, ok := m.state.Projects[projectID]; ok {
		for _, t := range project.Tasks {
			if t.ID == task.ID {
				t.Name = task.Name
				t.Status = task.Status
				t.ClaudeConfigDir = task.ClaudeConfigDir
				break
			}
		}
	}
	m.mu.Unlock()

	m.Save()

	{
		m.notify("task-updated", task)
	}

	return nil
}

// MarkTaskOpened records that the task's Claude session has been started at least once,
// which switches subsequent opens from --session-id to --resume
func (m *Manager) MarkTaskOpened(projectID, taskID string) {
	m.mu.Lock()
	if project, ok := m.state.Projects[projectID]; ok {
		for _, t := range project.Tasks {
			if t.ID == taskID {
				t.SessionStarted = true
				t.LastOpened = time.Now()
				break
			}
		}
	}
	m.mu.Unlock()

	m.Save()
}

// DeleteTask removes a task from a project
func (m *Manager) DeleteTask(projectID, taskID string) error {
	m.mu.Lock()
	if project, ok := m.state.Projects[projectID]; ok {
		tasks := project.Tasks[:0]
		for _, t := range project.Tasks {
			if t.ID != taskID {
				tasks = append(tasks, t)
			}
		}
		project.Tasks = tasks
	}
	m.mu.Unlock()

	m.Save()

	{
		m.notify("task-deleted", map[string]string{"projectId": projectID, "taskId": taskID})
	}

	return nil
}

// Terminal operations

// UI operations

// ============================================
// Prompt operations
// ============================================

// GetProjectPrompts returns all prompts for a project
func (m *Manager) GetProjectPrompts(projectID string) []Prompt {
	m.mu.RLock()
	defer m.mu.RUnlock()

	project, ok := m.state.Projects[projectID]
	if !ok || project.Prompts == nil {
		return []Prompt{}
	}

	return project.Prompts
}

// CreatePrompt creates a new prompt in a project
func (m *Manager) CreatePrompt(projectID string, prompt Prompt) (*Prompt, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	project, ok := m.state.Projects[projectID]
	if !ok {
		return nil, os.ErrNotExist
	}

	if project.Prompts == nil {
		project.Prompts = []Prompt{}
	}

	prompt.ID = uuid.New().String()
	now := time.Now()
	prompt.CreatedAt = now
	prompt.UpdatedAt = now
	prompt.IsGlobal = false

	project.Prompts = append(project.Prompts, prompt)

	go m.Save()

	return &prompt, nil
}

// UpdatePrompt updates an existing prompt in a project
func (m *Manager) UpdatePrompt(projectID, promptID string, prompt Prompt) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	project, ok := m.state.Projects[projectID]
	if !ok {
		return os.ErrNotExist
	}

	for i, p := range project.Prompts {
		if p.ID == promptID {
			prompt.ID = promptID
			prompt.CreatedAt = p.CreatedAt
			prompt.UpdatedAt = time.Now()
			prompt.IsGlobal = false
			project.Prompts[i] = prompt
			go m.Save()
			return nil
		}
	}

	return os.ErrNotExist
}

// DeletePrompt deletes a prompt from a project
func (m *Manager) DeletePrompt(projectID, promptID string) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	project, ok := m.state.Projects[projectID]
	if !ok {
		return os.ErrNotExist
	}

	for i, p := range project.Prompts {
		if p.ID == promptID {
			project.Prompts = append(project.Prompts[:i], project.Prompts[i+1:]...)
			go m.Save()
			return nil
		}
	}

	return os.ErrNotExist
}

// IncrementPromptUsage increments the usage count for a prompt
func (m *Manager) IncrementPromptUsage(projectID, promptID string, isGlobal bool) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	if isGlobal {
		for i, p := range m.state.GlobalPrompts {
			if p.ID == promptID {
				m.state.GlobalPrompts[i].UsageCount++
				m.state.GlobalPrompts[i].UpdatedAt = time.Now()
				go m.Save()
				return nil
			}
		}
	} else {
		project, ok := m.state.Projects[projectID]
		if !ok {
			return os.ErrNotExist
		}

		for i, p := range project.Prompts {
			if p.ID == promptID {
				project.Prompts[i].UsageCount++
				project.Prompts[i].UpdatedAt = time.Now()
				go m.Save()
				return nil
			}
		}
	}

	return os.ErrNotExist
}

// TogglePromptPinned toggles the pinned status of a prompt
func (m *Manager) TogglePromptPinned(projectID, promptID string, isGlobal bool) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	if isGlobal {
		for i, p := range m.state.GlobalPrompts {
			if p.ID == promptID {
				m.state.GlobalPrompts[i].Pinned = !m.state.GlobalPrompts[i].Pinned
				m.state.GlobalPrompts[i].UpdatedAt = time.Now()
				go m.Save()
				return nil
			}
		}
	} else {
		project, ok := m.state.Projects[projectID]
		if !ok {
			return os.ErrNotExist
		}

		for i, p := range project.Prompts {
			if p.ID == promptID {
				project.Prompts[i].Pinned = !project.Prompts[i].Pinned
				project.Prompts[i].UpdatedAt = time.Now()
				go m.Save()
				return nil
			}
		}
	}

	return os.ErrNotExist
}

// ============================================
// Global Prompt operations
// ============================================

// GetGlobalPrompts returns all global prompts
func (m *Manager) GetGlobalPrompts() []Prompt {
	m.mu.RLock()
	defer m.mu.RUnlock()

	if m.state.GlobalPrompts == nil {
		return []Prompt{}
	}

	return m.state.GlobalPrompts
}

// CreateGlobalPrompt creates a new global prompt
func (m *Manager) CreateGlobalPrompt(prompt Prompt) (*Prompt, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	if m.state.GlobalPrompts == nil {
		m.state.GlobalPrompts = []Prompt{}
	}

	prompt.ID = uuid.New().String()
	now := time.Now()
	prompt.CreatedAt = now
	prompt.UpdatedAt = now
	prompt.IsGlobal = true

	m.state.GlobalPrompts = append(m.state.GlobalPrompts, prompt)

	go m.Save()

	return &prompt, nil
}

// UpdateGlobalPrompt updates an existing global prompt
func (m *Manager) UpdateGlobalPrompt(promptID string, prompt Prompt) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	for i, p := range m.state.GlobalPrompts {
		if p.ID == promptID {
			prompt.ID = promptID
			prompt.CreatedAt = p.CreatedAt
			prompt.UpdatedAt = time.Now()
			prompt.IsGlobal = true
			m.state.GlobalPrompts[i] = prompt
			go m.Save()
			return nil
		}
	}

	return os.ErrNotExist
}

// DeleteGlobalPrompt deletes a global prompt
func (m *Manager) DeleteGlobalPrompt(promptID string) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	for i, p := range m.state.GlobalPrompts {
		if p.ID == promptID {
			m.state.GlobalPrompts = append(m.state.GlobalPrompts[:i], m.state.GlobalPrompts[i+1:]...)
			go m.Save()
			return nil
		}
	}

	return os.ErrNotExist
}

// ============================================
// Prompt Category operations
// ============================================

// GetPromptCategories returns all categories for a project
func (m *Manager) GetPromptCategories(projectID string) []PromptCategory {
	m.mu.RLock()
	defer m.mu.RUnlock()

	project, ok := m.state.Projects[projectID]
	if !ok || project.PromptCategories == nil {
		return []PromptCategory{}
	}

	return project.PromptCategories
}

// GetGlobalPromptCategories returns all global categories
func (m *Manager) GetGlobalPromptCategories() []PromptCategory {
	m.mu.RLock()
	defer m.mu.RUnlock()

	if m.state.GlobalPromptCategories == nil {
		return []PromptCategory{}
	}

	return m.state.GlobalPromptCategories
}

// CreatePromptCategory creates a new prompt category
func (m *Manager) CreatePromptCategory(projectID, name string, isGlobal bool) (*PromptCategory, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	category := PromptCategory{
		ID:       uuid.New().String(),
		Name:     name,
		IsGlobal: isGlobal,
	}

	if isGlobal {
		if m.state.GlobalPromptCategories == nil {
			m.state.GlobalPromptCategories = []PromptCategory{}
		}
		category.Order = len(m.state.GlobalPromptCategories)
		m.state.GlobalPromptCategories = append(m.state.GlobalPromptCategories, category)
	} else {
		project, ok := m.state.Projects[projectID]
		if !ok {
			return nil, os.ErrNotExist
		}

		if project.PromptCategories == nil {
			project.PromptCategories = []PromptCategory{}
		}
		category.Order = len(project.PromptCategories)
		project.PromptCategories = append(project.PromptCategories, category)
	}

	go m.Save()

	return &category, nil
}

// DeletePromptCategory deletes a prompt category
func (m *Manager) DeletePromptCategory(projectID, categoryID string, isGlobal bool) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	if isGlobal {
		for i, c := range m.state.GlobalPromptCategories {
			if c.ID == categoryID {
				m.state.GlobalPromptCategories = append(
					m.state.GlobalPromptCategories[:i],
					m.state.GlobalPromptCategories[i+1:]...,
				)
				go m.Save()
				return nil
			}
		}
	} else {
		project, ok := m.state.Projects[projectID]
		if !ok {
			return os.ErrNotExist
		}

		for i, c := range project.PromptCategories {
			if c.ID == categoryID {
				project.PromptCategories = append(
					project.PromptCategories[:i],
					project.PromptCategories[i+1:]...,
				)
				go m.Save()
				return nil
			}
		}
	}

	return os.ErrNotExist
}

// ============================================
// Todo operations
// ============================================

// ============================================
// Approved Remote Clients
// ============================================

// GetTerminalTheme returns the current terminal theme name
func (m *Manager) GetTerminalTheme() string {
	m.mu.RLock()
	defer m.mu.RUnlock()

	if m.state.TerminalTheme == "" {
		return "dracula" // default theme
	}
	return m.state.TerminalTheme
}

// SetTerminalTheme sets the terminal theme for all terminals
func (m *Manager) SetTerminalTheme(themeName string) {
	m.mu.Lock()
	m.state.TerminalTheme = themeName
	m.mu.Unlock()
	m.Save()

	// Emit event to notify frontend
	{
		m.notify("terminal-theme-changed", themeName)
	}
}

// GetTerminalFontSize returns the current terminal font size
func (m *Manager) GetTerminalFontSize() int {
	m.mu.RLock()
	defer m.mu.RUnlock()

	if m.state.TerminalFontSize == 0 {
		return 12 // default font size
	}
	return m.state.TerminalFontSize
}

// SetTerminalFontSize sets the terminal font size for all terminals
func (m *Manager) SetTerminalFontSize(size int) {
	if size < 10 {
		size = 10
	}
	if size > 24 {
		size = 24
	}
	m.mu.Lock()
	m.state.TerminalFontSize = size
	m.mu.Unlock()
	m.Save()
}

// GetAllViewFontSize returns the saved ALL view font size
func (m *Manager) GetAllViewFontSize() int {
	m.mu.RLock()
	defer m.mu.RUnlock()
	if m.state.AllViewFontSize == 0 {
		return 9
	}
	return m.state.AllViewFontSize
}

// SetAllViewFontSize saves the ALL view font size
func (m *Manager) SetAllViewFontSize(size int) {
	if size < 5 {
		size = 5
	}
	if size > 16 {
		size = 16
	}
	m.mu.Lock()
	m.state.AllViewFontSize = size
	m.mu.Unlock()
	m.Save()
}

// GetVoiceLang returns the saved voice input language
func (m *Manager) GetVoiceLang() string {
	m.mu.RLock()
	defer m.mu.RUnlock()
	if m.state.VoiceLang == "" {
		return "en-US"
	}
	return m.state.VoiceLang
}

// SetVoiceLang saves the voice input language
func (m *Manager) SetVoiceLang(lang string) {
	m.mu.Lock()
	m.state.VoiceLang = lang
	m.mu.Unlock()
	m.Save()
}

// GetVoiceAutoSubmit returns the saved voice auto-submit setting
func (m *Manager) GetVoiceAutoSubmit() bool {
	m.mu.RLock()
	defer m.mu.RUnlock()
	if m.state.VoiceAutoSubmit == nil {
		return true // default
	}
	return *m.state.VoiceAutoSubmit
}

// SetVoiceAutoSubmit saves the voice auto-submit setting
func (m *Manager) SetVoiceAutoSubmit(enabled bool) {
	m.mu.Lock()
	m.state.VoiceAutoSubmit = &enabled
	m.mu.Unlock()
	m.Save()
}

// GetTranscriptionEngine returns the selected speech-to-text engine ("native" or "scribe")
func (m *Manager) GetTranscriptionEngine() string {
	m.mu.RLock()
	defer m.mu.RUnlock()
	if m.state.TranscriptionEngine == "" {
		return "native"
	}
	return m.state.TranscriptionEngine
}

// SetTranscriptionEngine saves the selected speech-to-text engine
func (m *Manager) SetTranscriptionEngine(engine string) {
	m.mu.Lock()
	m.state.TranscriptionEngine = engine
	m.mu.Unlock()
	m.Save()
}

// GetElevenLabsAPIKey returns the saved ElevenLabs API key
func (m *Manager) GetElevenLabsAPIKey() string {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.state.ElevenLabsAPIKey
}

// SetElevenLabsAPIKey saves the ElevenLabs API key
func (m *Manager) SetElevenLabsAPIKey(key string) {
	m.mu.Lock()
	m.state.ElevenLabsAPIKey = key
	m.mu.Unlock()
	m.Save()
}

// GetJiraSettings returns the Jira integration settings
func (m *Manager) GetJiraSettings() JiraSettings {
	m.mu.RLock()
	defer m.mu.RUnlock()
	if m.state.Jira == nil {
		return JiraSettings{}
	}
	return *m.state.Jira
}

// SetJiraSettings saves the Jira integration settings
func (m *Manager) SetJiraSettings(s JiraSettings) {
	m.mu.Lock()
	m.state.Jira = &s
	m.mu.Unlock()
	m.Save()
}

// GetDashboardFullscreen returns the saved dashboard fullscreen state
func (m *Manager) GetDashboardFullscreen() bool {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.state.DashboardFullscreen
}

// SetDashboardFullscreen saves the dashboard fullscreen state
func (m *Manager) SetDashboardFullscreen(enabled bool) {
	m.mu.Lock()
	m.state.DashboardFullscreen = enabled
	m.mu.Unlock()
	m.Save()
}

// GetGmailSettings returns a copy of the Gmail integration settings
func (m *Manager) GetGmailSettings() GmailSettings {
	m.mu.RLock()
	defer m.mu.RUnlock()
	if m.state.Gmail == nil {
		return GmailSettings{}
	}
	settings := *m.state.Gmail
	settings.Accounts = append([]GmailAccount(nil), m.state.Gmail.Accounts...)
	return settings
}

// SetGmailConfig updates enabled/credentials, preserving authorized accounts.
// Accounts that still rely on the old global credential pair get it frozen in
// before the defaults change — their refresh tokens only work with that client.
func (m *Manager) SetGmailConfig(enabled bool, clientID, clientSecret string) {
	m.mu.Lock()
	if m.state.Gmail == nil {
		m.state.Gmail = &GmailSettings{}
	}
	oldID, oldSecret := m.state.Gmail.ClientID, m.state.Gmail.ClientSecret
	if oldID != "" && oldID != clientID {
		for i := range m.state.Gmail.Accounts {
			if m.state.Gmail.Accounts[i].ClientID == "" {
				m.state.Gmail.Accounts[i].ClientID = oldID
				m.state.Gmail.Accounts[i].ClientSecret = oldSecret
			}
		}
	}
	m.state.Gmail.Enabled = enabled
	m.state.Gmail.ClientID = clientID
	m.state.Gmail.ClientSecret = clientSecret
	m.mu.Unlock()
	m.Save()
}

// SetGmailMcpEnabled toggles the Claude MCP integration in the email view
func (m *Manager) SetGmailMcpEnabled(enabled bool) {
	m.mu.Lock()
	if m.state.Gmail == nil {
		m.state.Gmail = &GmailSettings{}
	}
	m.state.Gmail.McpEnabled = enabled
	m.mu.Unlock()
	m.Save()
}

// AddGmailAccount stores an authorized account with the credentials it was authorized against
func (m *Manager) AddGmailAccount(email, tokenJSON, clientID, clientSecret string) {
	m.mu.Lock()
	if m.state.Gmail == nil {
		m.state.Gmail = &GmailSettings{}
	}
	found := false
	for i := range m.state.Gmail.Accounts {
		if m.state.Gmail.Accounts[i].Email == email {
			m.state.Gmail.Accounts[i].TokenJSON = tokenJSON
			m.state.Gmail.Accounts[i].ClientID = clientID
			m.state.Gmail.Accounts[i].ClientSecret = clientSecret
			found = true
			break
		}
	}
	if !found {
		m.state.Gmail.Accounts = append(m.state.Gmail.Accounts, GmailAccount{
			Email: email, TokenJSON: tokenJSON, ClientID: clientID, ClientSecret: clientSecret,
		})
	}
	m.mu.Unlock()
	m.Save()
}

// SetGmailAccountMcp toggles MCP exposure for one account
func (m *Manager) SetGmailAccountMcp(email string, enabled bool) {
	m.mu.Lock()
	if m.state.Gmail != nil {
		for i := range m.state.Gmail.Accounts {
			if m.state.Gmail.Accounts[i].Email == email {
				m.state.Gmail.Accounts[i].McpEnabled = enabled
				break
			}
		}
	}
	m.mu.Unlock()
	m.Save()
}

// UpdateGmailToken persists a refreshed token without touching account credentials
func (m *Manager) UpdateGmailToken(email, tokenJSON string) {
	m.mu.Lock()
	if m.state.Gmail != nil {
		for i := range m.state.Gmail.Accounts {
			if m.state.Gmail.Accounts[i].Email == email {
				m.state.Gmail.Accounts[i].TokenJSON = tokenJSON
				break
			}
		}
	}
	m.mu.Unlock()
	m.Save()
}

// RemoveGmailAccount forgets an account and its token
func (m *Manager) RemoveGmailAccount(email string) {
	m.mu.Lock()
	if m.state.Gmail != nil {
		accounts := m.state.Gmail.Accounts[:0]
		for _, a := range m.state.Gmail.Accounts {
			if a.Email != email {
				accounts = append(accounts, a)
			}
		}
		m.state.Gmail.Accounts = accounts
	}
	m.mu.Unlock()
	m.Save()
}

// GetGlobalPromptPrefix returns the global prompt prefix (added before every prompt)
func (m *Manager) GetGlobalPromptPrefix() string {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.state.GlobalPromptPrefix
}

// SetGlobalPromptPrefix sets the global prompt prefix
func (m *Manager) SetGlobalPromptPrefix(s string) {
	m.mu.Lock()
	m.state.GlobalPromptPrefix = s
	m.mu.Unlock()
	m.Save()
}

// GetGlobalPromptSuffix returns the global prompt suffix (added after every prompt)
func (m *Manager) GetGlobalPromptSuffix() string {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.state.GlobalPromptSuffix
}

// SetGlobalPromptSuffix sets the global prompt suffix
func (m *Manager) SetGlobalPromptSuffix(s string) {
	m.mu.Lock()
	m.state.GlobalPromptSuffix = s
	m.mu.Unlock()
	m.Save()
}

func defaultClaudeAccount() ClaudeAccount {
	return ClaudeAccount{ID: "default", Name: "Personal · Max", ConfigDir: ""}
}

func hasDefaultClaudeAccount(accounts []ClaudeAccount) bool {
	for _, a := range accounts {
		if a.ConfigDir == "" {
			return true
		}
	}
	return false
}

// GetClaudeAccounts returns the saved Claude accounts, always including a default (~/.claude) entry first
func (m *Manager) GetClaudeAccounts() []ClaudeAccount {
	m.mu.RLock()
	defer m.mu.RUnlock()
	accounts := make([]ClaudeAccount, len(m.state.ClaudeAccounts))
	copy(accounts, m.state.ClaudeAccounts)
	if !hasDefaultClaudeAccount(accounts) {
		accounts = append([]ClaudeAccount{defaultClaudeAccount()}, accounts...)
	}
	return accounts
}

// SetClaudeAccounts replaces the saved Claude accounts
func (m *Manager) SetClaudeAccounts(accounts []ClaudeAccount) {
	m.mu.Lock()
	m.state.ClaudeAccounts = accounts
	m.mu.Unlock()
	m.Save()
}

// GetTerminalNameOverrides returns all custom terminal name overrides
func (m *Manager) GetTerminalNameOverrides() map[string]string {
	m.mu.RLock()
	defer m.mu.RUnlock()
	if m.state.TerminalNameOverrides == nil {
		return map[string]string{}
	}
	// Return a copy
	result := make(map[string]string, len(m.state.TerminalNameOverrides))
	for k, v := range m.state.TerminalNameOverrides {
		result[k] = v
	}
	return result
}

// SetTerminalNameOverride stores a custom name for a session
func (m *Manager) SetTerminalNameOverride(sessionID, name string) {
	m.mu.Lock()
	if m.state.TerminalNameOverrides == nil {
		m.state.TerminalNameOverrides = make(map[string]string)
	}
	if name == "" {
		delete(m.state.TerminalNameOverrides, sessionID)
	} else {
		m.state.TerminalNameOverrides[sessionID] = name
	}
	m.mu.Unlock()
	m.Save()
}

// ClearTerminalNameOverride removes a custom name for a session
func (m *Manager) ClearTerminalNameOverride(sessionID string) {
	m.SetTerminalNameOverride(sessionID, "")
}

// GetTerminalAccounts returns the Claude account (CLAUDE_CONFIG_DIR) per terminal session
func (m *Manager) GetTerminalAccounts() map[string]string {
	m.mu.RLock()
	defer m.mu.RUnlock()
	result := make(map[string]string, len(m.state.TerminalAccounts))
	for k, v := range m.state.TerminalAccounts {
		result[k] = v
	}
	return result
}

// SetTerminalAccount records which Claude account a terminal session uses (empty configDir = default account)
func (m *Manager) SetTerminalAccount(sessionID, configDir string) {
	m.mu.Lock()
	if m.state.TerminalAccounts == nil {
		m.state.TerminalAccounts = make(map[string]string)
	}
	m.state.TerminalAccounts[sessionID] = configDir
	m.mu.Unlock()
	m.Save()
}

// ClearTerminalAccount removes the recorded account for a closed session
func (m *Manager) ClearTerminalAccount(sessionID string) {
	m.mu.Lock()
	delete(m.state.TerminalAccounts, sessionID)
	m.mu.Unlock()
	m.Save()
}

// GetPinnedTerminals returns all pinned terminals (projectName -> tabName)
func (m *Manager) GetPinnedTerminals() map[string]string {
	m.mu.RLock()
	defer m.mu.RUnlock()
	if m.state.PinnedTerminals == nil {
		return map[string]string{}
	}
	result := make(map[string]string, len(m.state.PinnedTerminals))
	for k, v := range m.state.PinnedTerminals {
		result[k] = v
	}
	return result
}

// SetPinnedTerminal sets or clears the pinned terminal for a project
func (m *Manager) SetPinnedTerminal(projectName, tabName string) {
	m.mu.Lock()
	if m.state.PinnedTerminals == nil {
		m.state.PinnedTerminals = make(map[string]string)
	}
	if tabName == "" {
		delete(m.state.PinnedTerminals, projectName)
	} else {
		m.state.PinnedTerminals[projectName] = tabName
	}
	m.mu.Unlock()
	m.Save()
}

// GetWindowState returns the saved window state
func (m *Manager) GetWindowState() *WindowState {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return clone(m.state.Window)
}

// SetWindowState saves the window state
func (m *Manager) SetWindowState(state *WindowState) {
	m.mu.Lock()
	m.state.Window = state
	m.mu.Unlock()
	m.Save()
}

// GetPomodoroSettings returns the saved pomodoro timer settings
func (m *Manager) GetPomodoroSettings() *PomodoroSettings {
	m.mu.RLock()
	defer m.mu.RUnlock()

	if m.state.Pomodoro == nil {
		return &PomodoroSettings{SessionMinutes: 25, BreakMinutes: 5}
	}
	return clone(m.state.Pomodoro)
}

// SavePomodoroSettings saves the pomodoro timer settings
func (m *Manager) SavePomodoroSettings(sessionMinutes, breakMinutes int) {
	m.mu.Lock()
	m.state.Pomodoro = &PomodoroSettings{
		SessionMinutes: sessionMinutes,
		BreakMinutes:   breakMinutes,
	}
	m.mu.Unlock()
	m.Save()
}

// ---- Google Calendar accounts ----

func (m *Manager) GetCalendarSettings() CalendarSettings {
	m.mu.RLock()
	defer m.mu.RUnlock()
	if m.state.Calendar == nil {
		return CalendarSettings{}
	}
	settings := CalendarSettings{Accounts: make([]CalendarAccount, len(m.state.Calendar.Accounts))}
	for i, a := range m.state.Calendar.Accounts {
		settings.Accounts[i] = a
		settings.Accounts[i].Shared = append([]string(nil), a.Shared...)
	}
	return settings
}

// AddCalendarAccount stores a freshly authorized account, or refreshes the
// token and credentials of one that is already there. Shared calendars survive
// a re-authorization, so re-consenting does not silently unshare anything.
func (m *Manager) AddCalendarAccount(email, tokenJSON, clientID, clientSecret string) {
	m.mu.Lock()
	if m.state.Calendar == nil {
		m.state.Calendar = &CalendarSettings{}
	}
	found := false
	for i := range m.state.Calendar.Accounts {
		if m.state.Calendar.Accounts[i].Email == email {
			m.state.Calendar.Accounts[i].TokenJSON = tokenJSON
			m.state.Calendar.Accounts[i].ClientID = clientID
			m.state.Calendar.Accounts[i].ClientSecret = clientSecret
			found = true
			break
		}
	}
	if !found {
		m.state.Calendar.Accounts = append(m.state.Calendar.Accounts, CalendarAccount{
			Email: email, TokenJSON: tokenJSON, ClientID: clientID, ClientSecret: clientSecret,
		})
	}
	m.mu.Unlock()
	m.Save()
}

// UpdateCalendarToken persists a refreshed token without touching credentials
func (m *Manager) UpdateCalendarToken(email, tokenJSON string) {
	m.mu.Lock()
	if m.state.Calendar != nil {
		for i := range m.state.Calendar.Accounts {
			if m.state.Calendar.Accounts[i].Email == email {
				m.state.Calendar.Accounts[i].TokenJSON = tokenJSON
				break
			}
		}
	}
	m.mu.Unlock()
	m.Save()
}

// SetCalendarShared replaces the set of calendars an account exposes to addons
func (m *Manager) SetCalendarShared(email string, calendarIDs []string) {
	m.mu.Lock()
	if m.state.Calendar != nil {
		for i := range m.state.Calendar.Accounts {
			if m.state.Calendar.Accounts[i].Email == email {
				m.state.Calendar.Accounts[i].Shared = append([]string(nil), calendarIDs...)
				break
			}
		}
	}
	m.mu.Unlock()
	m.Save()
}

// RemoveCalendarAccount forgets an account, its token and its sharing choices
func (m *Manager) RemoveCalendarAccount(email string) {
	m.mu.Lock()
	if m.state.Calendar != nil {
		accounts := m.state.Calendar.Accounts[:0]
		for _, a := range m.state.Calendar.Accounts {
			if a.Email != email {
				accounts = append(accounts, a)
			}
		}
		m.state.Calendar.Accounts = accounts
	}
	m.mu.Unlock()
	m.Save()
}
