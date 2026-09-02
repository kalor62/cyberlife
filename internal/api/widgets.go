package api

import (
	"encoding/json"
	"fmt"
	"net/http"

	"github.com/kalor62/cyberlife/internal/state"
)

// Widget tools: agents configure the sidebar widget area and user dashboards.
// The catalog here is the authoritative list of widget ids — the frontend
// registry (frontend/src/modules/widgets.js) maps the same ids to renderers,
// so a new widget must be added in both places (see docs/AGENT-MANUAL.md).

type widgetInfo struct {
	ID          string `json:"id"`
	Title       string `json:"title"`
	Icon        string `json:"icon"`
	Description string `json:"description"`
	Dashboard   bool   `json:"dashboard"` // usable on custom dashboards (instance-safe)
}

func widgetCatalog() []widgetInfo {
	return []widgetInfo{
		{ID: "git", Title: "Git", Icon: "🌿", Description: "Working tree status and diffs for the active project", Dashboard: false},
		{ID: "pomodoro", Title: "Pomodoro", Icon: "🍅", Description: "Focus timer", Dashboard: false},
		{ID: "notes", Title: "Notes", Icon: "📝", Description: "Project notes quick view", Dashboard: false},
		{ID: "board-summary", Title: "Board", Icon: "📋", Description: "Per-column task counts and current in-progress tasks", Dashboard: true},
		{ID: "recent-automations", Title: "Automations", Icon: "⚡", Description: "Recent automation runs with status", Dashboard: true},
		{ID: "unread-mail", Title: "Unread Mail", Icon: "✉️", Description: "Unread inbox counts per linked Gmail account", Dashboard: true},
		{ID: "claude-sessions", Title: "Claude Code", Icon: "✳️", Description: "Live Claude Code sessions on this machine with working/waiting/idle status", Dashboard: true},
	}
}

type widgetsRequest struct {
	Sidebar      []string         `json:"sidebar,omitempty"`
	Collapsed    *bool            `json:"collapsed,omitempty"`
	Dashboard    *state.Dashboard `json:"dashboard,omitempty"`
	DashboardID  string           `json:"dashboardId,omitempty"`
	Project      string           `json:"project,omitempty"`
	Width        *int             `json:"width,omitempty"`
	ModuleWidths map[string]int   `json:"moduleWidths,omitempty"`
}

const (
	minSidebarWidth = 180
	maxSidebarWidth = 1200
)

// opWidgetsSetWidth sets the default sidebar width and/or per-module
// overrides; an override of 0 removes it (back to the default)
func (s *Server) opWidgetsSetWidth(req widgetsRequest) (any, error) {
	if req.Width == nil && req.ModuleWidths == nil {
		return nil, fmt.Errorf("width and/or moduleWidths is required")
	}
	current := s.manager.GetWidgetSettings()
	if req.Width != nil {
		if *req.Width < minSidebarWidth || *req.Width > maxSidebarWidth {
			return nil, fmt.Errorf("width must be %d-%d px", minSidebarWidth, maxSidebarWidth)
		}
		current.Width = *req.Width
	}
	if req.ModuleWidths != nil {
		if current.ModuleWidths == nil {
			current.ModuleWidths = map[string]int{}
		}
		for module, w := range req.ModuleWidths {
			if w == 0 {
				delete(current.ModuleWidths, module)
				continue
			}
			if w < minSidebarWidth || w > maxSidebarWidth {
				return nil, fmt.Errorf("module %q width must be %d-%d px (0 removes the override)", module, minSidebarWidth, maxSidebarWidth)
			}
			current.ModuleWidths[module] = w
		}
	}
	s.manager.SetWidgetSettings(current)
	s.notifyWidgets()
	return map[string]any{"global": current}, nil
}

func (s *Server) opWidgetsCatalog() (any, error) {
	return map[string]any{"widgets": s.fullWidgetCatalog()}, nil
}

func (s *Server) opWidgetsConfig(req widgetsRequest) (any, error) {
	out := map[string]any{
		"global":     s.manager.GetWidgetSettings(),
		"dashboards": s.manager.GetDashboards(),
	}
	if req.Project != "" {
		project, ok := s.manager.ResolveProject(req.Project)
		if !ok {
			return nil, fmt.Errorf("project %q not found", req.Project)
		}
		out["project"] = map[string]any{
			"id":      project.ID,
			"name":    project.Name,
			"widgets": s.manager.GetProjectWidgets(project.ID),
		}
	}
	return out, nil
}

// opWidgetsSetSidebar writes the global list (project empty) or one
// project's extra widgets; the visible sidebar is global + project
func (s *Server) opWidgetsSetSidebar(req widgetsRequest) (any, error) {
	if req.Sidebar == nil && req.Collapsed == nil {
		return nil, fmt.Errorf("sidebar and/or collapsed is required")
	}
	for _, id := range req.Sidebar {
		if _, ok := s.widgetByIDFull(id); !ok {
			return nil, fmt.Errorf("unknown widget %q (see widgets_catalog)", id)
		}
	}
	if req.Project != "" {
		project, ok := s.manager.ResolveProject(req.Project)
		if !ok {
			return nil, fmt.Errorf("project %q not found", req.Project)
		}
		if req.Sidebar == nil {
			return nil, fmt.Errorf("sidebar is required for a project scope")
		}
		if err := s.manager.SetProjectWidgets(project.ID, req.Sidebar); err != nil {
			return nil, err
		}
		s.notifyWidgets()
		return map[string]any{"project": project.Name, "widgets": req.Sidebar}, nil
	}
	current := s.manager.GetWidgetSettings()
	if req.Sidebar != nil {
		current.Sidebar = req.Sidebar
	}
	if req.Collapsed != nil {
		current.Collapsed = *req.Collapsed
	}
	s.manager.SetWidgetSettings(current)
	s.notifyWidgets()
	return map[string]any{"global": current}, nil
}

func (s *Server) opWidgetsSaveDashboard(req widgetsRequest) (any, error) {
	if req.Dashboard == nil {
		return nil, fmt.Errorf("dashboard is required")
	}
	for _, id := range req.Dashboard.Widgets {
		w, ok := s.widgetByIDFull(id)
		if !ok {
			return nil, fmt.Errorf("unknown widget %q (see widgets_catalog)", id)
		}
		if !w.Dashboard {
			return nil, fmt.Errorf("widget %q is sidebar-only", id)
		}
	}
	saved, err := s.manager.SaveDashboard(*req.Dashboard)
	if err != nil {
		return nil, err
	}
	s.notifyWidgets()
	return map[string]any{"dashboard": saved}, nil
}

func (s *Server) opWidgetsDeleteDashboard(req widgetsRequest) (any, error) {
	if req.DashboardID == "" {
		return nil, fmt.Errorf("dashboardId is required")
	}
	if err := s.manager.DeleteDashboard(req.DashboardID); err != nil {
		return nil, err
	}
	s.notifyWidgets()
	return map[string]any{"ok": true}, nil
}

func (s *Server) notifyWidgets() {
	if s.onWidgetsChange != nil {
		s.onWidgetsChange()
	}
}

// ---- REST ----

func (s *Server) handleWidgets(w http.ResponseWriter, r *http.Request) {
	if !s.guardGroup(w, "widgets") {
		return
	}
	out, err := s.opWidgetsConfig(widgetsRequest{Project: r.URL.Query().Get("project")})
	if err != nil {
		writeErr(w, http.StatusNotFound, err)
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (s *Server) handleWidgetsCatalog(w http.ResponseWriter, r *http.Request) {
	if !s.guardGroup(w, "widgets") {
		return
	}
	out, _ := s.opWidgetsCatalog()
	writeJSON(w, http.StatusOK, out)
}

// ---- MCP tools ----

func (s *Server) widgetsTools() []mcpTool {
	return []mcpTool{
		{
			Name:        "widgets_catalog",
			Description: "List available widgets (id, title, whether usable on dashboards)",
			InputSchema: objSchema(nil, map[string]any{}),
		},
		{
			Name:        "widgets_get_config",
			Description: "Widget configuration: global sidebar widgets (shown everywhere), all dashboards, and — when project is given — that project's extra widgets. The visible sidebar is global + project.",
			InputSchema: objSchema(nil, map[string]any{"project": projectProp}),
		},
		{
			Name:        "widgets_set_sidebar",
			Description: "Set sidebar widgets (ordered ids). Without project: the GLOBAL list shown in every project (collapsed also settable). With project: that project's extra widgets, shown after the global ones.",
			InputSchema: objSchema(nil, map[string]any{
				"sidebar":   map[string]any{"type": "array", "items": map[string]any{"type": "string"}},
				"collapsed": map[string]any{"type": "boolean"},
				"project":   projectProp,
			}),
		},
		{
			Name:        "widgets_set_width",
			Description: "Set the sidebar width: width = default px for all modules; moduleWidths = per-module overrides keyed by module id (e.g. board-tab, dashboard-tab, email-tab; 0 removes an override). Range 180-1200.",
			InputSchema: objSchema(nil, map[string]any{
				"width": map[string]any{"type": "integer"},
				"moduleWidths": map[string]any{
					"type":                 "object",
					"additionalProperties": map[string]any{"type": "integer"},
					"description":          "moduleId -> px; module ids come from widgets_get_config (moduleWidths keys) or the module bar: projects-tab, board-tab, dashboard-tab (Term), health-tab, structure-tab, auto-tab, email-tab, notes-tab, settings-tab, dash-tab, help-tab",
				},
			}),
		},
		{
			Name:        "widgets_save_dashboard",
			Description: "Create or update a dashboard (user-named tab of widgets; id \"home\" is the default one). Only dashboard-capable widgets allowed.",
			InputSchema: objSchema([]string{"dashboard"}, map[string]any{
				"dashboard": map[string]any{
					"type": "object",
					"properties": map[string]any{
						"id":      map[string]any{"type": "string", "description": "Omit to create"},
						"name":    map[string]any{"type": "string"},
						"icon":    map[string]any{"type": "string", "description": "Emoji"},
						"widgets": map[string]any{"type": "array", "items": map[string]any{"type": "string"}},
					},
					"required": []string{"name", "widgets"},
				},
			}),
		},
		{
			Name:        "widgets_delete_dashboard",
			Description: "Delete a dashboard by id (HOME cannot be deleted)",
			InputSchema: objSchema([]string{"dashboardId"}, map[string]any{"dashboardId": map[string]any{"type": "string"}}),
		},
	}
}

func (s *Server) callWidgetsTool(name string, args json.RawMessage) (any, error) {
	var req widgetsRequest
	if len(args) > 0 {
		if err := json.Unmarshal(args, &req); err != nil {
			return nil, fmt.Errorf("invalid arguments: %w", err)
		}
	}
	switch name {
	case "widgets_catalog":
		return s.opWidgetsCatalog()
	case "widgets_get_config":
		return s.opWidgetsConfig(req)
	case "widgets_set_sidebar":
		return s.opWidgetsSetSidebar(req)
	case "widgets_set_width":
		return s.opWidgetsSetWidth(req)
	case "widgets_save_dashboard":
		return s.opWidgetsSaveDashboard(req)
	case "widgets_delete_dashboard":
		return s.opWidgetsDeleteDashboard(req)
	}
	return nil, fmt.Errorf("unknown tool %q", name)
}
