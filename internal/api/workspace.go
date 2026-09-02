package api

import (
	"encoding/json"
	"fmt"
	"sort"
	"strings"

	"github.com/kalor62/cyberlife/internal/agentskills"
	"github.com/kalor62/cyberlife/internal/paths"
	"github.com/kalor62/cyberlife/internal/state"
)

// Workspace tools: projects & groups, worktree tasks, project notes,
// prompts and a read-only system_info. Each group is gated by its own
// skill so permissions stay granular.

func (s *Server) projectsEnabled() bool { return s.groupEnabled("projects") }
func (s *Server) tasksEnabled() bool    { return s.groupEnabled("tasks") }
func (s *Server) notesEnabled() bool    { return s.groupEnabled("notes") }
func (s *Server) promptsEnabled() bool  { return s.groupEnabled("prompts") }
func (s *Server) systemEnabled() bool   { return s.groupEnabled("system") }

type workspaceRequest struct {
	Project string  `json:"project,omitempty"`
	Name    string  `json:"name,omitempty"`
	Path    string  `json:"path,omitempty"`
	Color   string  `json:"color,omitempty"`
	Icon    string  `json:"icon,omitempty"`
	Group   string  `json:"group,omitempty"`
	Pinned  *bool   `json:"pinned,omitempty"`
	GroupID string  `json:"groupId,omitempty"`
	Runner  *string `json:"runner,omitempty"`
	// tasks
	TaskID       string   `json:"taskId,omitempty"`
	JiraKey      string   `json:"jiraKey,omitempty"`
	Branch       string   `json:"branch,omitempty"`
	BaseBranch   string   `json:"baseBranch,omitempty"`
	Repos        []string `json:"repos,omitempty"`
	DeleteBranch bool     `json:"deleteBranch,omitempty"`
	// notes
	Content string `json:"content,omitempty"`
	Text    string `json:"text,omitempty"`
	// prompts
	PromptID string `json:"promptId,omitempty"`
	Title    string `json:"title,omitempty"`
	Category string `json:"category,omitempty"`
	Global   bool   `json:"global,omitempty"`
}

// ============================================
// projects_*
// ============================================

func (s *Server) opProjectsCreate(req workspaceRequest) (any, error) {
	if req.Name == "" || req.Path == "" {
		return nil, fmt.Errorf("name and path are required")
	}
	project, err := s.manager.CreateProject(req.Name, req.Path)
	if err != nil {
		return nil, err
	}
	s.emit("projects-changed")
	return map[string]any{"project": map[string]string{"id": project.ID, "name": project.Name, "path": project.Path}}, nil
}

func (s *Server) opProjectsUpdate(req workspaceRequest) (any, error) {
	project, ok := s.manager.ResolveProject(req.Project)
	if !ok {
		return nil, fmt.Errorf("project %q not found", req.Project)
	}
	updated := *project
	if req.Name != "" {
		updated.Name = req.Name
	}
	if req.Color != "" {
		updated.Color = req.Color
	}
	if req.Icon != "" {
		updated.Icon = req.Icon
	}
	if req.Pinned != nil {
		updated.Pinned = *req.Pinned
	}
	if req.Group != "" {
		group := s.resolveGroup(req.Group)
		if group == nil {
			return nil, fmt.Errorf("group %q not found", req.Group)
		}
		updated.GroupID = group.ID
	}
	if req.Runner != nil {
		updated.DefaultRunner = strings.TrimSpace(*req.Runner)
	}
	if err := s.manager.UpdateProject(&updated); err != nil {
		return nil, err
	}
	s.emit("projects-changed")
	return map[string]any{"ok": true}, nil
}

func (s *Server) opProjectsSetActive(req workspaceRequest) (any, error) {
	project, ok := s.manager.ResolveProject(req.Project)
	if !ok {
		return nil, fmt.Errorf("project %q not found", req.Project)
	}
	s.manager.SetActiveProject(project.ID)
	return map[string]any{"active": project.Name}, nil
}

func (s *Server) resolveGroup(ref string) *state.ProjectGroup {
	for _, g := range s.manager.GetProjectGroups() {
		if g.ID == ref || strings.EqualFold(g.Name, ref) {
			return g
		}
	}
	return nil
}

func (s *Server) opProjectsGroups() (any, error) {
	return map[string]any{"groups": s.manager.GetProjectGroups()}, nil
}

func (s *Server) opProjectsSaveGroup(req workspaceRequest) (any, error) {
	if req.Name == "" {
		return nil, fmt.Errorf("name is required")
	}
	if req.GroupID != "" {
		group := s.resolveGroup(req.GroupID)
		if group == nil {
			return nil, fmt.Errorf("group %q not found", req.GroupID)
		}
		updated := *group
		updated.Name = req.Name
		if req.Icon != "" {
			updated.Icon = req.Icon
		}
		if req.Color != "" {
			updated.Color = req.Color
		}
		if err := s.manager.UpdateProjectGroup(&updated); err != nil {
			return nil, err
		}
		s.emit("projects-changed")
		return map[string]any{"group": updated}, nil
	}
	group, err := s.manager.CreateProjectGroup(req.Name, req.Icon, req.Color)
	if err != nil {
		return nil, err
	}
	s.emit("projects-changed")
	return map[string]any{"group": group}, nil
}

// ============================================
// tasks_* (worktree work items)
// ============================================

func (s *Server) opTasksList(req workspaceRequest) (any, error) {
	project, ok := s.manager.ResolveProject(req.Project)
	if !ok {
		return nil, fmt.Errorf("project %q not found", req.Project)
	}
	tasks := project.Tasks
	sort.SliceStable(tasks, func(i, j int) bool { return tasks[i].CreatedAt.After(tasks[j].CreatedAt) })
	return map[string]any{"tasks": tasks}, nil
}

func (s *Server) opTasksCreate(req workspaceRequest) (any, error) {
	if s.taskCreate == nil {
		return nil, fmt.Errorf("task creation unavailable")
	}
	project, ok := s.manager.ResolveProject(req.Project)
	if !ok {
		return nil, fmt.Errorf("project %q not found", req.Project)
	}
	if req.Name == "" {
		return nil, fmt.Errorf("name is required")
	}
	task, err := s.taskCreate(project.ID, req.Name, req.JiraKey, req.Branch, req.BaseBranch, req.Repos)
	if err != nil {
		return nil, err
	}
	s.emit("tasks-changed")
	return map[string]any{"task": task}, nil
}

func (s *Server) opTasksDelete(req workspaceRequest) (any, error) {
	if s.taskDelete == nil {
		return nil, fmt.Errorf("task deletion unavailable")
	}
	project, ok := s.manager.ResolveProject(req.Project)
	if !ok {
		return nil, fmt.Errorf("project %q not found", req.Project)
	}
	if req.TaskID == "" {
		return nil, fmt.Errorf("taskId is required")
	}
	if err := s.taskDelete(project.ID, req.TaskID, req.DeleteBranch); err != nil {
		return nil, err
	}
	s.emit("tasks-changed")
	return map[string]any{"ok": true}, nil
}

// ============================================
// notes_*
// ============================================

func (s *Server) opNotesGet(req workspaceRequest) (any, error) {
	project, ok := s.manager.ResolveProject(req.Project)
	if !ok {
		return nil, fmt.Errorf("project %q not found", req.Project)
	}
	return map[string]any{"project": project.Name, "notes": project.Notes}, nil
}

func (s *Server) saveNotes(project *state.ProjectState, notes string) error {
	updated := *project
	updated.Notes = notes
	if err := s.manager.UpdateProject(&updated); err != nil {
		return err
	}
	s.emit("notes-changed")
	return nil
}

func (s *Server) opNotesSet(req workspaceRequest) (any, error) {
	project, ok := s.manager.ResolveProject(req.Project)
	if !ok {
		return nil, fmt.Errorf("project %q not found", req.Project)
	}
	if err := s.saveNotes(project, req.Content); err != nil {
		return nil, err
	}
	return map[string]any{"ok": true}, nil
}

func (s *Server) opNotesAppend(req workspaceRequest) (any, error) {
	project, ok := s.manager.ResolveProject(req.Project)
	if !ok {
		return nil, fmt.Errorf("project %q not found", req.Project)
	}
	if strings.TrimSpace(req.Text) == "" {
		return nil, fmt.Errorf("text is required")
	}
	notes := project.Notes
	if notes != "" && !strings.HasSuffix(notes, "\n") {
		notes += "\n"
	}
	notes += req.Text
	if err := s.saveNotes(project, notes); err != nil {
		return nil, err
	}
	return map[string]any{"ok": true}, nil
}

// ============================================
// prompts_*
// ============================================

func (s *Server) opPromptsList(req workspaceRequest) (any, error) {
	out := map[string]any{"global": s.manager.GetGlobalPrompts()}
	if req.Project != "" {
		project, ok := s.manager.ResolveProject(req.Project)
		if !ok {
			return nil, fmt.Errorf("project %q not found", req.Project)
		}
		out["project"] = s.manager.GetProjectPrompts(project.ID)
	}
	return out, nil
}

func (s *Server) opPromptsSave(req workspaceRequest) (any, error) {
	if req.Title == "" || req.Content == "" {
		return nil, fmt.Errorf("title and content are required")
	}
	prompt := state.Prompt{
		ID:       req.PromptID,
		Title:    req.Title,
		Content:  req.Content,
		Category: req.Category,
		IsGlobal: req.Global,
	}
	if req.Global {
		if req.PromptID != "" {
			if err := s.manager.UpdateGlobalPrompt(req.PromptID, prompt); err != nil {
				return nil, err
			}
			s.emit("prompts-changed")
			return map[string]any{"prompt": prompt}, nil
		}
		saved, err := s.manager.CreateGlobalPrompt(prompt)
		if err != nil {
			return nil, err
		}
		s.emit("prompts-changed")
		return map[string]any{"prompt": saved}, nil
	}
	project, ok := s.manager.ResolveProject(req.Project)
	if !ok {
		return nil, fmt.Errorf("project %q not found (or pass global: true)", req.Project)
	}
	if req.PromptID != "" {
		if err := s.manager.UpdatePrompt(project.ID, req.PromptID, prompt); err != nil {
			return nil, err
		}
		s.emit("prompts-changed")
		return map[string]any{"prompt": prompt}, nil
	}
	saved, err := s.manager.CreatePrompt(project.ID, prompt)
	if err != nil {
		return nil, err
	}
	s.emit("prompts-changed")
	return map[string]any{"prompt": saved}, nil
}

func (s *Server) opPromptsDelete(req workspaceRequest) (any, error) {
	if req.PromptID == "" {
		return nil, fmt.Errorf("promptId is required")
	}
	if req.Global {
		if err := s.manager.DeleteGlobalPrompt(req.PromptID); err != nil {
			return nil, err
		}
		s.emit("prompts-changed")
		return map[string]any{"ok": true}, nil
	}
	project, ok := s.manager.ResolveProject(req.Project)
	if !ok {
		return nil, fmt.Errorf("project %q not found (or pass global: true)", req.Project)
	}
	if err := s.manager.DeletePrompt(project.ID, req.PromptID); err != nil {
		return nil, err
	}
	s.emit("prompts-changed")
	return map[string]any{"ok": true}, nil
}

// ============================================
// system_info
// ============================================

// opSystemInfo is the agent's one-stop overview; runner env VALUES are
// deliberately omitted (they may hold secrets) — only the keys are listed
func (s *Server) opSystemInfo() (any, error) {
	var runners []map[string]any
	for _, r := range s.manager.GetRunners() {
		envKeys := make([]string, 0, len(r.Env))
		for k := range r.Env {
			envKeys = append(envKeys, k)
		}
		sort.Strings(envKeys)
		runners = append(runners, map[string]any{
			"id": r.ID, "name": r.Name, "command": r.Command, "args": r.Args,
			"builtIn": r.BuiltIn, "envKeys": envKeys,
		})
	}
	defaultRunner := s.manager.GetDefaultRunner()
	if defaultRunner == "" {
		defaultRunner = "claude"
	}

	skillStates := map[string]bool{}
	settings := s.manager.GetAgentSkills()
	for _, sk := range agentskills.Registry("") {
		skillStates[sk.ID] = agentskills.Enabled(sk.ID, settings)
	}

	info := map[string]any{
		"app":           "Cyber Life",
		"apiBase":       Base(),
		"mcp":           Base() + "/mcp",
		"projects":      len(s.manager.GetProjects()),
		"runners":       runners,
		"defaultRunner": defaultRunner,
		"skills":        skillStates,
	}
	if project := s.manager.GetProject(s.manager.GetActiveProjectID()); project != nil {
		info["activeProject"] = map[string]string{
			"id": project.ID, "name": project.Name, "path": project.Path,
			"defaultRunner": s.manager.ResolveDefaultRunner(project.ID),
		}
	}
	if s.dependencies != nil {
		info["dependencies"] = s.dependencies()
	}
	if root, err := paths.AddonData(); err == nil {
		info["addonData"] = root
	}
	if s.gmailMcpScript != nil {
		if script := s.gmailMcpScript(); script != "" {
			info["gmailMcp"] = map[string]any{"command": "node", "args": []string{script}}
		}
	}
	return info, nil
}

func (s *Server) emit(event string) {
	if s.emitEvent != nil {
		s.emitEvent(event)
	}
}

// ============================================
// REST
// ============================================

func (r *workspaceRequest) setProject(p string) { r.Project = p }

// ============================================
// MCP tools
// ============================================

func (s *Server) projectsTools() []mcpTool {
	nameProp := map[string]any{"type": "string"}
	return []mcpTool{
		{
			Name:        "projects_create",
			Description: "Register a new project (name + absolute path)",
			InputSchema: objSchema([]string{"name", "path"}, map[string]any{"name": nameProp, "path": nameProp}),
		},
		{
			Name:        "projects_update",
			Description: "Update project fields: name, color (hex), icon (emoji), pinned, group (name or id), runner (default runner id for new Term sessions; empty inherits the global default)",
			InputSchema: objSchema([]string{"project"}, map[string]any{
				"project": projectProp, "name": nameProp, "color": nameProp,
				"icon": nameProp, "pinned": map[string]any{"type": "boolean"}, "group": nameProp,
				"runner": nameProp,
			}),
		},
		{
			Name:        "projects_set_active",
			Description: "Switch the app's active project (what the user sees)",
			InputSchema: objSchema([]string{"project"}, map[string]any{"project": projectProp}),
		},
		{
			Name:        "projects_groups",
			Description: "List project groups",
			InputSchema: objSchema(nil, map[string]any{}),
		},
		{
			Name:        "projects_save_group",
			Description: "Create or update a group (groupId to update). The color (hex) becomes the accent on every project card in the group.",
			InputSchema: objSchema([]string{"name"}, map[string]any{"name": nameProp, "icon": nameProp, "color": nameProp, "groupId": nameProp}),
		},
	}
}

func (s *Server) tasksTools() []mcpTool {
	str := map[string]any{"type": "string"}
	return []mcpTool{
		{
			Name:        "tasks_list",
			Description: "List a project's worktree tasks (branch, worktree path, status, Claude session)",
			InputSchema: objSchema([]string{"project"}, map[string]any{"project": projectProp}),
		},
		{
			Name:        "tasks_create",
			Description: "Create a worktree task: makes a git branch + worktree (per repo for multi-repo projects) with a resumable Claude session. branch defaults to a slug of the name.",
			InputSchema: objSchema([]string{"project", "name"}, map[string]any{
				"project": projectProp, "name": str, "jiraKey": str,
				"branch": str, "baseBranch": str,
				"repos": map[string]any{"type": "array", "items": str, "description": "Repo paths inside the project; omit for the project root"},
			}),
		},
		{
			Name:        "tasks_delete",
			Description: "Delete a worktree task (removes the worktree; deleteBranch also removes the git branch)",
			InputSchema: objSchema([]string{"project", "taskId"}, map[string]any{
				"project": projectProp, "taskId": str, "deleteBranch": map[string]any{"type": "boolean"},
			}),
		},
	}
}

func (s *Server) notesTools() []mcpTool {
	return []mcpTool{
		{
			Name:        "notes_get",
			Description: "Read a project's notes (markdown)",
			InputSchema: objSchema([]string{"project"}, map[string]any{"project": projectProp}),
		},
		{
			Name:        "notes_set",
			Description: "Replace a project's notes — read first, never blind-overwrite",
			InputSchema: objSchema([]string{"project", "content"}, map[string]any{
				"project": projectProp, "content": map[string]any{"type": "string"},
			}),
		},
		{
			Name:        "notes_append",
			Description: "Append a line/paragraph to a project's notes (safe for logging findings)",
			InputSchema: objSchema([]string{"project", "text"}, map[string]any{
				"project": projectProp, "text": map[string]any{"type": "string"},
			}),
		},
	}
}

func (s *Server) promptsTools() []mcpTool {
	str := map[string]any{"type": "string"}
	return []mcpTool{
		{
			Name:        "prompts_list",
			Description: "List saved prompts: global ones, plus a project's when project is given",
			InputSchema: objSchema(nil, map[string]any{"project": projectProp}),
		},
		{
			Name:        "prompts_save",
			Description: "Create or update (promptId) a saved prompt; global: true stores it across all projects, otherwise project is required",
			InputSchema: objSchema([]string{"title", "content"}, map[string]any{
				"project": projectProp, "promptId": str, "title": str,
				"content": str, "category": str, "global": map[string]any{"type": "boolean"},
			}),
		},
		{
			Name:        "prompts_delete",
			Description: "Delete a saved prompt (global: true for global prompts, otherwise project is required)",
			InputSchema: objSchema([]string{"promptId"}, map[string]any{
				"project": projectProp, "promptId": str, "global": map[string]any{"type": "boolean"},
			}),
		},
	}
}

func (s *Server) systemTools() []mcpTool {
	return []mcpTool{
		{
			Name:        "system_info",
			Description: "App overview: active project, runners (ids for term_create/automations; env values hidden), defaultRunner, skill permission states, dependency health, API endpoints",
			InputSchema: objSchema(nil, map[string]any{}),
		},
		{
			Name:        "system_notify",
			Description: "Raise a notification for the user: lands in the Cyber Life notification center (bell) and as a desktop toast. Use for things the user must see even when not watching this session (rate limited: 12/min).",
			InputSchema: objSchema([]string{"title"}, map[string]any{
				"title":   map[string]any{"type": "string", "description": "Short headline (max 120 chars)"},
				"message": map[string]any{"type": "string", "description": "Details (max 500 chars)"},
				"source":  map[string]any{"type": "string", "description": "Who raises it, e.g. agent or addon name (default: agent)"},
				"link":    map[string]any{"type": "string", "description": "Optional URL the entry opens"},
			}),
		},
		{
			Name:        "system_notifications",
			Description: "Read the notification center (newest first). unread entries have no readAt.",
			InputSchema: objSchema(nil, map[string]any{
				"includeArchived": map[string]any{"type": "boolean"},
				"limit":           map[string]any{"type": "integer", "description": "Default 50"},
			}),
		},
	}
}

func (s *Server) callWorkspaceTool(name string, args json.RawMessage) (any, error) {
	var req workspaceRequest
	if len(args) > 0 {
		if err := json.Unmarshal(args, &req); err != nil {
			return nil, fmt.Errorf("invalid arguments: %w", err)
		}
	}
	switch name {
	case "projects_create":
		return s.opProjectsCreate(req)
	case "projects_update":
		return s.opProjectsUpdate(req)
	case "projects_set_active":
		return s.opProjectsSetActive(req)
	case "projects_groups":
		return s.opProjectsGroups()
	case "projects_save_group":
		return s.opProjectsSaveGroup(req)
	case "tasks_list":
		return s.opTasksList(req)
	case "tasks_create":
		return s.opTasksCreate(req)
	case "tasks_delete":
		return s.opTasksDelete(req)
	case "notes_get":
		return s.opNotesGet(req)
	case "notes_set":
		return s.opNotesSet(req)
	case "notes_append":
		return s.opNotesAppend(req)
	case "prompts_list":
		return s.opPromptsList(req)
	case "prompts_save":
		return s.opPromptsSave(req)
	case "prompts_delete":
		return s.opPromptsDelete(req)
	case "system_info":
		return s.opSystemInfo()
	case "system_notify":
		return s.opNotify(args)
	case "system_notifications":
		return s.opNotificationsList(args)
	}
	return nil, fmt.Errorf("unknown tool %q", name)
}
