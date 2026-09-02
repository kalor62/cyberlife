package api

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"

	"github.com/kalor62/cyberlife/internal/health"
	"github.com/kalor62/cyberlife/internal/state"
)

// Health tools: agents are the evaluators of custom checks — they define
// checks, verify them against the codebase and set the result with a comment.

type healthRequest struct {
	Project     string   `json:"project"`
	CheckID     string   `json:"checkId,omitempty"`
	Add         []string `json:"add,omitempty"`
	Remove      []string `json:"remove,omitempty"`
	Title       string   `json:"title,omitempty"`
	Description string   `json:"description,omitempty"`
	Stack       string   `json:"stack,omitempty"`
	Category    string   `json:"category,omitempty"`
	Passed      *bool    `json:"passed,omitempty"`
	Comment     string   `json:"comment,omitempty"`
	Author      string   `json:"author,omitempty"`
	TrackIn     string   `json:"trackIn,omitempty"`
}

func (s *Server) opHealthReport(projectRef string) (any, error) {
	if s.healthReport == nil {
		return nil, fmt.Errorf("health provider unavailable")
	}
	project, ok := s.manager.ResolveProject(projectRef)
	if !ok {
		return nil, fmt.Errorf("project %q not found", projectRef)
	}
	report := s.healthReport(project.ID)
	return map[string]any{
		"project": map[string]string{"id": project.ID, "name": project.Name},
		"tracked": s.manager.GetHealthSelection(project.ID),
		"report":  report,
	}, nil
}

func (s *Server) opHealthLibrary() (any, error) {
	if s.healthLibrary == nil {
		return nil, fmt.Errorf("health provider unavailable")
	}
	return s.healthLibrary(), nil
}

func (s *Server) opHealthTrack(req healthRequest) (any, error) {
	project, ok := s.manager.ResolveProject(req.Project)
	if !ok {
		return nil, fmt.Errorf("project %q not found", req.Project)
	}
	selected := s.manager.GetHealthSelection(project.ID)
	set := map[string]bool{}
	for _, id := range selected {
		set[id] = true
	}
	for _, id := range req.Add {
		set[id] = true
	}
	for _, id := range req.Remove {
		delete(set, id)
	}
	out := make([]string, 0, len(set))
	for _, id := range selected {
		if set[id] {
			out = append(out, id)
			delete(set, id)
		}
	}
	for _, id := range req.Add {
		if set[id] {
			out = append(out, id)
			delete(set, id)
		}
	}
	if err := s.manager.SetHealthSelection(project.ID, out); err != nil {
		return nil, err
	}
	s.notify(project.ID)
	return map[string]any{"tracked": out}, nil
}

func (s *Server) opHealthAddCheck(req healthRequest) (any, error) {
	if strings.TrimSpace(req.Title) == "" {
		return nil, fmt.Errorf("title is required")
	}
	check, err := s.manager.SaveCustomHealthCheck(state.CustomHealthCheck{
		Title:       req.Title,
		Description: req.Description,
		Stack:       req.Stack,
		Category:    req.Category,
	})
	if err != nil {
		return nil, err
	}
	if req.TrackIn != "" {
		if project, ok := s.manager.ResolveProject(req.TrackIn); ok {
			selected := append(s.manager.GetHealthSelection(project.ID), check.ID)
			if err := s.manager.SetHealthSelection(project.ID, selected); err == nil {
				s.notify(project.ID)
			}
		}
	}
	return map[string]any{"check": check}, nil
}

func (s *Server) opHealthSetCheck(req healthRequest) (any, error) {
	project, ok := s.manager.ResolveProject(req.Project)
	if !ok {
		return nil, fmt.Errorf("project %q not found", req.Project)
	}
	if req.CheckID == "" || req.Passed == nil {
		return nil, fmt.Errorf("checkId and passed are required")
	}
	comment := strings.TrimSpace(req.Comment)
	author := req.Author
	if author == "" {
		author = "agent"
	}
	if comment != "" {
		comment = author + ": " + comment
	}
	if err := health.SetManualCheck(project.Path, req.CheckID, *req.Passed, comment); err != nil {
		return nil, err
	}
	s.notify(project.ID)
	return map[string]any{"ok": true}, nil
}

// ---- REST ----

func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	if !s.guardGroup(w, "health") {
		return
	}
	out, err := s.opHealthReport(r.URL.Query().Get("project"))
	if err != nil {
		writeErr(w, http.StatusNotFound, err)
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (s *Server) handleHealthLibrary(w http.ResponseWriter, r *http.Request) {
	if !s.guardGroup(w, "health") {
		return
	}
	out, err := s.opHealthLibrary()
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// ---- MCP tools ----

func (s *Server) healthTools() []mcpTool {
	return []mcpTool{
		{
			Name:        "health_get_report",
			Description: "Read a project's health report: only its tracked checks with pass/fail status",
			InputSchema: objSchema([]string{"project"}, map[string]any{"project": projectProp}),
		},
		{
			Name:        "health_library",
			Description: "List every available health check (built-in per stack + custom), with ids and kinds",
			InputSchema: objSchema(nil, map[string]any{}),
		},
		{
			Name:        "health_track",
			Description: "Add and/or remove check ids from the set a project tracks",
			InputSchema: objSchema([]string{"project"}, map[string]any{
				"project": projectProp,
				"add":     map[string]any{"type": "array", "items": map[string]any{"type": "string"}},
				"remove":  map[string]any{"type": "array", "items": map[string]any{"type": "string"}},
			}),
		},
		{
			Name:        "health_add_check",
			Description: "Define a new custom check (you become its evaluator — verify it and report with health_set_check). Optionally start tracking it in a project via trackIn.",
			InputSchema: objSchema([]string{"title"}, map[string]any{
				"title":       map[string]any{"type": "string"},
				"description": map[string]any{"type": "string"},
				"stack":       map[string]any{"type": "string", "description": "generic|node|nextjs|express|go|java|custom"},
				"category":    map[string]any{"type": "string"},
				"trackIn":     projectProp,
			}),
		},
		{
			Name:        "health_set_check",
			Description: "Set the result of a manual/custom check after verifying it; always include a comment explaining what you checked and set author to your model name",
			InputSchema: objSchema([]string{"project", "checkId", "passed"}, map[string]any{
				"project": projectProp,
				"checkId": map[string]any{"type": "string"},
				"passed":  map[string]any{"type": "boolean"},
				"comment": map[string]any{"type": "string"},
				"author":  map[string]any{"type": "string"},
			}),
		},
	}
}

func (s *Server) callHealthTool(name string, args json.RawMessage) (any, error) {
	var req healthRequest
	if len(args) > 0 {
		if err := json.Unmarshal(args, &req); err != nil {
			return nil, fmt.Errorf("invalid arguments: %w", err)
		}
	}
	switch name {
	case "health_get_report":
		return s.opHealthReport(req.Project)
	case "health_library":
		return s.opHealthLibrary()
	case "health_track":
		return s.opHealthTrack(req)
	case "health_add_check":
		return s.opHealthAddCheck(req)
	case "health_set_check":
		return s.opHealthSetCheck(req)
	}
	return nil, fmt.Errorf("unknown tool %q", name)
}
