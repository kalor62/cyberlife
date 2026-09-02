// Package api exposes Cyber Life to agents on localhost: a small REST API
// (any runner can curl it, documented by the built-in skill) and an MCP
// Streamable HTTP endpoint at /mcp (stateless) for Claude Code.
package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/kalor62/cyberlife/internal/logging"
	"github.com/kalor62/cyberlife/internal/state"
)

const Port = 8377

// maxRequestBody caps any single API request; the webhook handler applies
// its own tighter limit
const maxRequestBody = 8 << 20

func Base() string { return fmt.Sprintf("http://127.0.0.1:%d", Port) }

// Hooks are App-provided callbacks the server cannot implement itself
type Hooks struct {
	OnChange        func(projectID string)
	OnMove          func(projectID, taskID, columnID string)
	HealthReport    func(projectID string) any
	HealthLibrary   func() any
	AutoRun         func(ruleID string) (state.AutomationRun, error)
	OnAutoChange    func()
	OnWidgetsChange func()
	// M-stage coverage: App-level operations the server cannot do itself
	TermCreate     func(workDir, name, runner, prompt string) (string, error)
	TaskCreate     func(projectID, name, jiraKey, branch, baseBranch string, repos []string) (any, error)
	TaskDelete     func(projectID, taskID string, deleteBranch bool) error
	JiraMap        func(projectID, jiraKey, jiraFilter string) error
	JiraSync       func(projectID string) (any, error)
	Dependencies   func() any
	GmailMcpScript func() string
	Emit           func(event string)
	EmitPayload    func(event string, payload any)
	WebhookFire    func(slug string, body []byte) int
	OnAddonsChange func()
	Notify         func(source, title, message, link string) error
	Notifications  func(includeArchived bool, limit int) any
	Calendar       CalendarHooks
}

type Server struct {
	manager         *state.Manager
	onChange        func(projectID string)
	onMove          func(projectID, taskID, columnID string)
	healthReport    func(projectID string) any
	healthLibrary   func() any
	autoRun         func(ruleID string) (state.AutomationRun, error)
	onAutoChange    func()
	onWidgetsChange func()
	termCreate      func(workDir, name, runner, prompt string) (string, error)
	taskCreate      func(projectID, name, jiraKey, branch, baseBranch string, repos []string) (any, error)
	taskDelete      func(projectID, taskID string, deleteBranch bool) error
	jiraMap         func(projectID, jiraKey, jiraFilter string) error
	jiraSync        func(projectID string) (any, error)
	dependencies    func() any
	gmailMcpScript  func() string
	emitEvent       func(event string)
	emitPayload     func(event string, payload any)
	webhookFire     func(slug string, body []byte) int
	onAddonsChange  func()
	systemNotify    func(source, title, message, link string) error
	notifications   func(includeArchived bool, limit int) any
	calendar        CalendarHooks
	http            *http.Server

	addonCallsMu sync.Mutex
	addonCalls   map[string]pendingAddonCall

	backupsMu sync.Mutex
	backups   map[string]*backupJob
}

func NewServer(manager *state.Manager, hooks Hooks) *Server {
	return &Server{
		manager:         manager,
		onChange:        hooks.OnChange,
		onMove:          hooks.OnMove,
		healthReport:    hooks.HealthReport,
		healthLibrary:   hooks.HealthLibrary,
		autoRun:         hooks.AutoRun,
		onAutoChange:    hooks.OnAutoChange,
		onWidgetsChange: hooks.OnWidgetsChange,
		termCreate:      hooks.TermCreate,
		taskCreate:      hooks.TaskCreate,
		taskDelete:      hooks.TaskDelete,
		jiraMap:         hooks.JiraMap,
		jiraSync:        hooks.JiraSync,
		dependencies:    hooks.Dependencies,
		gmailMcpScript:  hooks.GmailMcpScript,
		emitEvent:       hooks.Emit,
		emitPayload:     hooks.EmitPayload,
		webhookFire:     hooks.WebhookFire,
		onAddonsChange:  hooks.OnAddonsChange,
		systemNotify:    hooks.Notify,
		notifications:   hooks.Notifications,
		calendar:        hooks.Calendar,
	}
}

func (s *Server) Start() {
	mux := http.NewServeMux()
	mux.HandleFunc("/api/projects", s.handleProjects)
	mux.HandleFunc("/api/board", s.handleBoard)
	mux.HandleFunc("/api/board/task", s.handleTask)
	mux.HandleFunc("/api/board/move", s.handleMove)
	mux.HandleFunc("/api/board/comment", s.handleComment)
	mux.HandleFunc("/api/notify", s.handleNotify)
	mux.HandleFunc("/api/calendar/accounts", s.handleCalendarAccounts)
	mux.HandleFunc("/api/calendar/events", s.handleCalendarEvents)
	mux.HandleFunc("/api/health", s.handleHealth)
	mux.HandleFunc("/api/health/library", s.handleHealthLibrary)
	mux.HandleFunc("/api/health/track", groupPost[healthRequest](s, "health", s.opHealthTrack))
	mux.HandleFunc("/api/health/check", groupPost[healthRequest](s, "health", s.opHealthAddCheck))
	mux.HandleFunc("/api/health/set", groupPost[healthRequest](s, "health", s.opHealthSetCheck))
	mux.HandleFunc("/api/auto/rules", s.handleAutoRules)
	mux.HandleFunc("/api/auto/rules/delete", groupPost[autoRequest](s, "auto", s.opAutoDeleteRule))
	mux.HandleFunc("/api/auto/enable", groupPost[autoRequest](s, "auto", s.opAutoSetEnabled))
	mux.HandleFunc("/api/auto/run", groupPost[autoRequest](s, "auto", s.opAutoRun))
	mux.HandleFunc("/api/auto/runs", s.handleAutoRuns)
	mux.HandleFunc("/api/widgets", s.handleWidgets)
	mux.HandleFunc("/api/widgets/catalog", s.handleWidgetsCatalog)
	mux.HandleFunc("/api/widgets/sidebar", groupPost[widgetsRequest](s, "widgets", s.opWidgetsSetSidebar))
	mux.HandleFunc("/api/widgets/width", groupPost[widgetsRequest](s, "widgets", s.opWidgetsSetWidth))
	mux.HandleFunc("/api/widgets/dashboard", groupPost[widgetsRequest](s, "widgets", s.opWidgetsSaveDashboard))
	mux.HandleFunc("/api/widgets/dashboard/delete", groupPost[widgetsRequest](s, "widgets", s.opWidgetsDeleteDashboard))
	mux.HandleFunc("/api/board/jira/map", groupPost[taskRequest](s, "board", s.opJiraMapReq))
	mux.HandleFunc("/api/board/jira/sync", groupPost[taskRequest](s, "board", s.opJiraSyncReq))
	mux.HandleFunc("/api/term", s.handleTermList)
	mux.HandleFunc("/api/term/create", groupPost[termRequest](s, "term", s.opTermCreate))
	mux.HandleFunc("/api/term/read", groupPost[termRequest](s, "term", s.opTermRead))
	mux.HandleFunc("/api/term/send", groupPost[termRequest](s, "term", s.opTermSend))
	mux.HandleFunc("/api/term/close", groupPost[termRequest](s, "term", s.opTermClose))
	mux.HandleFunc("/api/projects/create", groupPost[workspaceRequest](s, "projects", s.opProjectsCreate))
	mux.HandleFunc("/api/projects/update", groupPost[workspaceRequest](s, "projects", s.opProjectsUpdate))
	mux.HandleFunc("/api/projects/active", groupPost[workspaceRequest](s, "projects", s.opProjectsSetActive))
	mux.HandleFunc("/api/projects/groups", groupPost[workspaceRequest](s, "projects", func(r workspaceRequest) (any, error) { return s.opProjectsGroups() }))
	mux.HandleFunc("/api/projects/groups/save", groupPost[workspaceRequest](s, "projects", s.opProjectsSaveGroup))
	mux.HandleFunc("/api/tasks", groupPost[workspaceRequest](s, "tasks", s.opTasksList))
	mux.HandleFunc("/api/tasks/create", groupPost[workspaceRequest](s, "tasks", s.opTasksCreate))
	mux.HandleFunc("/api/tasks/delete", groupPost[workspaceRequest](s, "tasks", s.opTasksDelete))
	mux.HandleFunc("/api/notes", groupPost[workspaceRequest](s, "notes", s.opNotesGet))
	mux.HandleFunc("/api/notes/set", groupPost[workspaceRequest](s, "notes", s.opNotesSet))
	mux.HandleFunc("/api/notes/append", groupPost[workspaceRequest](s, "notes", s.opNotesAppend))
	mux.HandleFunc("/api/prompts", groupPost[workspaceRequest](s, "prompts", s.opPromptsList))
	mux.HandleFunc("/api/prompts/save", groupPost[workspaceRequest](s, "prompts", s.opPromptsSave))
	mux.HandleFunc("/api/prompts/delete", groupPost[workspaceRequest](s, "prompts", s.opPromptsDelete))
	mux.HandleFunc("/api/system", groupPost[workspaceRequest](s, "system", func(r workspaceRequest) (any, error) { return s.opSystemInfo() }))
	mux.HandleFunc("/api/addons", s.handleAddonsList)
	mux.HandleFunc("/api/addons/enable", groupPost[addonsRequest](s, "addons", s.opAddonsSetEnabled))
	mux.HandleFunc("/api/addons/reload", groupPost[addonsRequest](s, "addons", s.opAddonsReload))
	mux.HandleFunc("/api/addons/storage/get", groupPost[addonsRequest](s, "addons", s.opAddonsStorageGet))
	mux.HandleFunc("/api/addons/storage/set", groupPost[addonsRequest](s, "addons", s.opAddonsStorageSet))
	mux.HandleFunc("/api/addons/storage/delete", groupPost[addonsRequest](s, "addons", s.opAddonsStorageDelete))
	mux.HandleFunc("/api/addons/http", s.handleAddonHTTP)
	mux.HandleFunc("/api/addons/pdftext", s.handleAddonPdfText)
	mux.HandleFunc("/api/addons/preview", s.handleAddonPreview)
	mux.HandleFunc("/api/addons/datafile", s.handleAddonDataFile)
	mux.HandleFunc("/api/addons/pdfmerge", s.handleAddonPdfMerge)
	mux.HandleFunc("/api/addons/htmltopdf", s.handleAddonHTMLToPdf)
	mux.HandleFunc("/api/addons/tool-result", s.handleAddonToolResult)
	mux.HandleFunc("/api/addons/backup", s.handleAddonBackup)
	mux.HandleFunc("/api/mail/image", s.handleMailImage)
	mux.HandleFunc("/addons/", s.handleAddonAsset)
	mux.HandleFunc("/addons-data/", s.handleAddonDataAsset)
	mux.HandleFunc("/api/hooks/", s.handleWebhook)
	mux.HandleFunc("/mcp", s.handleMCP)

	srv := &http.Server{
		Addr:              fmt.Sprintf("127.0.0.1:%d", Port),
		Handler:           localOnly(mux),
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       30 * time.Second,
		WriteTimeout:      60 * time.Second,
		IdleTimeout:       120 * time.Second,
	}
	s.http = srv
	go func() {
		logging.Info("Agent API listening", "addr", srv.Addr)
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			logging.Error("Agent API server failed", "error", err)
		}
	}()
}

// Shutdown stops accepting requests and lets in-flight agent calls finish
func (s *Server) Shutdown(ctx context.Context) {
	if s.http == nil {
		return
	}
	if err := s.http.Shutdown(ctx); err != nil {
		logging.Warn("api: shutdown failed", "error", err)
	}
}

// localOnly wraps every route with the loopback/cross-site/content-type
// checks; body-less routes skip the JSON requirement (see guard.go).
// Addon code runs in the webview, which is a different origin than this
// server, so the app's own origin gets CORS headers — every other origin is
// already rejected by allowRequest.
func localOnly(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if origin := r.Header.Get("Origin"); appOrigin(origin) {
			w.Header().Set("Access-Control-Allow-Origin", origin)
			w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
			w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
			w.Header().Set("Vary", "Origin")
			if r.Method == http.MethodOptions {
				w.WriteHeader(http.StatusNoContent)
				return
			}
		}
		requireJSON := r.Method != http.MethodGet &&
			!strings.HasPrefix(r.URL.Path, "/api/hooks/") &&
			!strings.HasPrefix(r.URL.Path, "/addons/")
		if !allowRequest(w, r, requireJSON) {
			return
		}
		limit := int64(maxRequestBody)
		// Data-file uploads carry base64 of a whole PDF/scan — the general
		// cap would reject anything over ~6MB of file
		if strings.HasPrefix(r.URL.Path, "/api/addons/datafile") {
			limit = (maxDataFileBytes * 4 / 3) + (1 << 20)
		}
		r.Body = http.MaxBytesReader(w, r.Body, limit)
		next.ServeHTTP(w, r)
	})
}

func (s *Server) notify(projectID string) {
	if s.onChange != nil {
		s.onChange(projectID)
	}
}

// ============================================
// Shared board operations (REST + MCP call the same core)
// ============================================

type taskRequest struct {
	Project     string  `json:"project"`
	TaskID      string  `json:"taskId,omitempty"`
	Title       *string `json:"title,omitempty"`
	Description *string `json:"description,omitempty"`
	Column      string  `json:"column,omitempty"`
	Priority    *string `json:"priority,omitempty"`
	Category    *string `json:"category,omitempty"`
	Blocked     *bool   `json:"blocked,omitempty"`
	Archived    *bool   `json:"archived,omitempty"`
	Index       *int    `json:"index,omitempty"`
	Author      string  `json:"author,omitempty"`
	Text        string  `json:"text,omitempty"`
	JiraKey     string  `json:"jiraKey,omitempty"`
	JiraFilter  string  `json:"jiraFilter,omitempty"`
}

// opJiraMapReq binds a project's board to a Jira project key (empty unmaps)
func (s *Server) opJiraMapReq(req taskRequest) (any, error) {
	if s.jiraMap == nil {
		return nil, fmt.Errorf("jira unavailable")
	}
	project, ok := s.manager.ResolveProject(req.Project)
	if !ok {
		return nil, fmt.Errorf("project %q not found", req.Project)
	}
	if err := s.jiraMap(project.ID, req.JiraKey, req.JiraFilter); err != nil {
		return nil, err
	}
	s.notify(project.ID)
	return map[string]any{"project": project.Name, "jiraProject": req.JiraKey, "jiraFilter": req.JiraFilter}, nil
}

func (s *Server) opJiraSyncReq(req taskRequest) (any, error) {
	if s.jiraSync == nil {
		return nil, fmt.Errorf("jira unavailable")
	}
	project, ok := s.manager.ResolveProject(req.Project)
	if !ok {
		return nil, fmt.Errorf("project %q not found", req.Project)
	}
	return s.jiraSync(project.ID)
}

func (s *Server) resolveColumn(projectID, ref string) (string, error) {
	if ref == "" {
		return "", nil
	}
	columns, _, err := s.manager.GetKanban(projectID)
	if err != nil {
		return "", err
	}
	for _, c := range columns {
		if c.ID == ref || strings.EqualFold(c.Name, ref) {
			return c.ID, nil
		}
	}
	return "", fmt.Errorf("column %q not found", ref)
}

func (s *Server) opProjects() (any, error) {
	type projectInfo struct {
		ID   string `json:"id"`
		Name string `json:"name"`
		Path string `json:"path"`
	}
	var out []projectInfo
	for _, p := range s.manager.GetProjects() {
		out = append(out, projectInfo{ID: p.ID, Name: p.Name, Path: p.Path})
	}
	return map[string]any{"projects": out}, nil
}

func (s *Server) opBoard(projectRef string) (any, error) {
	project, ok := s.manager.ResolveProject(projectRef)
	if !ok {
		return nil, fmt.Errorf("project %q not found", projectRef)
	}
	columns, tasks, err := s.manager.GetKanban(project.ID)
	if err != nil {
		return nil, err
	}
	return map[string]any{
		"project": map[string]string{"id": project.ID, "name": project.Name},
		"columns": columns,
		"tasks":   tasks,
	}, nil
}

func (s *Server) opTask(req taskRequest) (any, error) {
	project, ok := s.manager.ResolveProject(req.Project)
	if !ok {
		return nil, fmt.Errorf("project %q not found", req.Project)
	}

	var task state.KanbanTask
	if req.TaskID != "" {
		_, tasks, err := s.manager.GetKanban(project.ID)
		if err != nil {
			return nil, err
		}
		found := false
		for _, t := range tasks {
			if t.ID == req.TaskID {
				task = t
				found = true
				break
			}
		}
		if !found {
			return nil, fmt.Errorf("task %q not found", req.TaskID)
		}
	}

	if req.Title != nil {
		task.Title = *req.Title
	}
	if req.Description != nil {
		task.Description = *req.Description
	}
	if req.Priority != nil {
		task.Priority = *req.Priority
	}
	if req.Category != nil {
		task.Category = *req.Category
	}
	if req.Blocked != nil {
		task.Blocked = *req.Blocked
	}
	if req.Archived != nil {
		task.Archived = *req.Archived
	}
	if req.Column != "" {
		columnID, err := s.resolveColumn(project.ID, req.Column)
		if err != nil {
			return nil, err
		}
		task.ColumnID = columnID
	}
	if task.Title == "" {
		return nil, fmt.Errorf("title is required")
	}

	saved, err := s.manager.UpsertKanbanTask(project.ID, task)
	if err != nil {
		return nil, err
	}
	s.notify(project.ID)
	return map[string]any{"task": saved}, nil
}

func (s *Server) opMove(req taskRequest) (any, error) {
	project, ok := s.manager.ResolveProject(req.Project)
	if !ok {
		return nil, fmt.Errorf("project %q not found", req.Project)
	}
	columnID, err := s.resolveColumn(project.ID, req.Column)
	if err != nil {
		return nil, err
	}
	if columnID == "" {
		return nil, fmt.Errorf("column is required")
	}
	index := 1 << 30 // default: append at the end
	if req.Index != nil {
		index = *req.Index
	}
	if err := s.manager.MoveKanbanTask(project.ID, req.TaskID, columnID, index); err != nil {
		return nil, err
	}
	if s.onMove != nil {
		go s.onMove(project.ID, req.TaskID, columnID)
	}
	s.notify(project.ID)
	return map[string]any{"ok": true}, nil
}

func (s *Server) opComment(req taskRequest) (any, error) {
	project, ok := s.manager.ResolveProject(req.Project)
	if !ok {
		return nil, fmt.Errorf("project %q not found", req.Project)
	}
	author := req.Author
	if author == "" {
		author = "agent"
	}
	if strings.TrimSpace(req.Text) == "" {
		return nil, fmt.Errorf("text is required")
	}
	comment, err := s.manager.AddKanbanComment(project.ID, req.TaskID, author, req.Text)
	if err != nil {
		return nil, err
	}
	s.notify(project.ID)
	return map[string]any{"comment": comment}, nil
}

// ============================================
// REST handlers
// ============================================

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(v); err != nil {
		logging.Debug("api: response encode failed", "error", err)
	}
}

func writeErr(w http.ResponseWriter, status int, err error) {
	writeJSON(w, status, map[string]string{"error": err.Error()})
}

func decodeBody(w http.ResponseWriter, r *http.Request, v any) bool {
	if err := json.NewDecoder(r.Body).Decode(v); err != nil {
		writeErr(w, http.StatusBadRequest, fmt.Errorf("invalid JSON body: %w", err))
		return false
	}
	return true
}

func (s *Server) handleProjects(w http.ResponseWriter, r *http.Request) {
	if !s.guardGroup(w, "board") {
		return
	}
	out, err := s.opProjects()
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (s *Server) handleBoard(w http.ResponseWriter, r *http.Request) {
	if !s.guardGroup(w, "board") {
		return
	}
	out, err := s.opBoard(r.URL.Query().Get("project"))
	if err != nil {
		writeErr(w, http.StatusNotFound, err)
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (s *Server) handleTask(w http.ResponseWriter, r *http.Request) {
	if !s.guardGroup(w, "board") {
		return
	}
	var req taskRequest
	if !decodeBody(w, r, &req) {
		return
	}
	out, err := s.opTask(req)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err)
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (s *Server) handleMove(w http.ResponseWriter, r *http.Request) {
	if !s.guardGroup(w, "board") {
		return
	}
	var req taskRequest
	if !decodeBody(w, r, &req) {
		return
	}
	out, err := s.opMove(req)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err)
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (s *Server) handleComment(w http.ResponseWriter, r *http.Request) {
	if !s.guardGroup(w, "board") {
		return
	}
	var req taskRequest
	if !decodeBody(w, r, &req) {
		return
	}
	out, err := s.opComment(req)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err)
		return
	}
	writeJSON(w, http.StatusOK, out)
}
