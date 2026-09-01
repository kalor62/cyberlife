package api

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"

	"github.com/kalor62/cyberlife/internal/iterm"
)

// Terminal tools: agents list, spawn, read and drive tmux sessions — the
// same sessions the user sees in the Term module. Creation goes through an
// App hook so runner resolution and naming match the UI path.

func (s *Server) termEnabled() bool { return s.groupEnabled("term") }

type termRequest struct {
	Session string `json:"session,omitempty"`
	Project string `json:"project,omitempty"`
	WorkDir string `json:"workDir,omitempty"`
	Name    string `json:"name,omitempty"`
	Runner  string `json:"runner,omitempty"`
	Prompt  string `json:"prompt,omitempty"`
	Text    string `json:"text,omitempty"`
	Enter   *bool  `json:"enter,omitempty"`
	Lines   int    `json:"lines,omitempty"`
}

func (s *Server) opTermList() (any, error) {
	type sessionInfo struct {
		Session string `json:"session"`
		Path    string `json:"path,omitempty"`
		Project string `json:"project,omitempty"`
	}
	var out []sessionInfo
	for _, sess := range iterm.ListSessions() {
		info := sessionInfo{Session: sess.Name, Path: sess.Path}
		if p, ok := s.manager.ResolveProject(sess.Path); ok {
			info.Project = p.Name
		}
		out = append(out, info)
	}
	return map[string]any{"sessions": out}, nil
}

func (s *Server) opTermCreate(req termRequest) (any, error) {
	if s.termCreate == nil {
		return nil, fmt.Errorf("terminal control unavailable")
	}
	workDir := req.WorkDir
	if req.Project != "" {
		project, ok := s.manager.ResolveProject(req.Project)
		if !ok {
			return nil, fmt.Errorf("project %q not found", req.Project)
		}
		if workDir == "" {
			workDir = project.Path
		}
	}
	if workDir == "" {
		return nil, fmt.Errorf("project or workDir is required")
	}
	name := strings.TrimSpace(req.Name)
	if name == "" {
		name = "agent"
	}
	session, err := s.termCreate(workDir, name, req.Runner, req.Prompt)
	if err != nil {
		return nil, err
	}
	return map[string]any{"session": session}, nil
}

func (s *Server) opTermRead(req termRequest) (any, error) {
	if req.Session == "" {
		return nil, fmt.Errorf("session is required")
	}
	if !iterm.SessionExists(req.Session) {
		return nil, fmt.Errorf("session %q not found (see term_list)", req.Session)
	}
	lines := req.Lines
	if lines <= 0 {
		lines = 200
	}
	if lines > 2000 {
		lines = 2000
	}
	text, err := iterm.CaptureSessionText(req.Session, lines)
	if err != nil {
		return nil, err
	}
	return map[string]any{"session": req.Session, "text": text}, nil
}

func (s *Server) opTermSend(req termRequest) (any, error) {
	if req.Session == "" || req.Text == "" {
		return nil, fmt.Errorf("session and text are required")
	}
	if !iterm.SessionExists(req.Session) {
		return nil, fmt.Errorf("session %q not found (see term_list)", req.Session)
	}
	enter := req.Enter == nil || *req.Enter
	if err := iterm.WriteSessionText(req.Session, req.Text, enter); err != nil {
		return nil, err
	}
	return map[string]any{"ok": true}, nil
}

func (s *Server) opTermClose(req termRequest) (any, error) {
	if req.Session == "" {
		return nil, fmt.Errorf("session is required")
	}
	if !iterm.SessionExists(req.Session) {
		return nil, fmt.Errorf("session %q not found", req.Session)
	}
	if err := iterm.KillSession(req.Session); err != nil {
		return nil, err
	}
	return map[string]any{"ok": true}, nil
}

// ---- REST ----

func (s *Server) handleTermList(w http.ResponseWriter, r *http.Request) {
	if !s.guardGroup(w, "term") {
		return
	}
	out, err := s.opTermList()
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// ---- MCP tools ----

func (s *Server) termTools() []mcpTool {
	return []mcpTool{
		{
			Name:        "term_list",
			Description: "List running tmux sessions (name, working path, owning project)",
			InputSchema: objSchema(nil, map[string]any{}),
		},
		{
			Name:        "term_create",
			Description: "Launch a new agent session (tmux) in a project or directory; runner omitted = the project's default runner, else the global default, else Claude; prompt is passed on the CLI. runner \"shell\" runs the prompt as a `sh -c` script instead. Returns the session id.",
			InputSchema: objSchema(nil, map[string]any{
				"project": projectProp,
				"workDir": map[string]any{"type": "string", "description": "Overrides the project path"},
				"name":    map[string]any{"type": "string"},
				"runner":  map[string]any{"type": "string", "description": "Runner id (see system_info) or \"shell\""},
				"prompt":  map[string]any{"type": "string"},
			}),
		},
		{
			Name:        "term_read",
			Description: "Read the last lines of a session's output as plain text (default 200, max 2000)",
			InputSchema: objSchema([]string{"session"}, map[string]any{
				"session": map[string]any{"type": "string"},
				"lines":   map[string]any{"type": "integer"},
			}),
		},
		{
			Name:        "term_send",
			Description: "Type text into a session (enter defaults to true). Be careful with sessions you did not create — the user may be working in them.",
			InputSchema: objSchema([]string{"session", "text"}, map[string]any{
				"session": map[string]any{"type": "string"},
				"text":    map[string]any{"type": "string"},
				"enter":   map[string]any{"type": "boolean"},
			}),
		},
		{
			Name:        "term_close",
			Description: "Kill a tmux session. Only close sessions you created unless explicitly asked.",
			InputSchema: objSchema([]string{"session"}, map[string]any{"session": map[string]any{"type": "string"}}),
		},
	}
}

func (s *Server) callTermTool(name string, args json.RawMessage) (any, error) {
	var req termRequest
	if len(args) > 0 {
		if err := json.Unmarshal(args, &req); err != nil {
			return nil, fmt.Errorf("invalid arguments: %w", err)
		}
	}
	switch name {
	case "term_list":
		return s.opTermList()
	case "term_create":
		return s.opTermCreate(req)
	case "term_read":
		return s.opTermRead(req)
	case "term_send":
		return s.opTermSend(req)
	case "term_close":
		return s.opTermClose(req)
	}
	return nil, fmt.Errorf("unknown tool %q", name)
}
