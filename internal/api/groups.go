package api

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"

	"github.com/kalor62/cyberlife/internal/addons"
	"github.com/kalor62/cyberlife/internal/agentskills"
)

// Every agent-facing capability is a group: a skill id that doubles as the
// MCP tool prefix and the permission toggle. Gating, the "disabled" message
// and the REST handler shape are defined once here instead of being
// re-implemented per group.

// addonBackedGroups map a group to the built-in addon that owns it — turning
// that addon off takes the group's tools and endpoints down with it
var addonBackedGroups = map[string]string{"health": "health"}

func (s *Server) groupEnabled(id string) bool {
	// An addon tool group's enable switch is the addon toggle itself
	if !s.staticGroupIDs()[id] {
		if a, ok := addons.Get(id, s.manager.GetAddonsEnabled()); ok && len(a.AgentTools) > 0 {
			return a.Enabled
		}
	}
	if !agentskills.Enabled(id, s.manager.GetAgentSkills()) {
		return false
	}
	if addon, ok := addonBackedGroups[id]; ok {
		return addons.Enabled(addon, s.manager.GetAddonsEnabled())
	}
	return true
}

func groupDisabledErr(id string) error {
	return fmt.Errorf("%s skill is disabled in Cyber Life settings", id)
}

// guardGroup writes the standard 403 when a group is off
func (s *Server) guardGroup(w http.ResponseWriter, id string) bool {
	if !s.groupEnabled(id) {
		writeErr(w, http.StatusForbidden, groupDisabledErr(id))
		return false
	}
	return true
}

// groupPost builds a REST handler for one op: gate, decode, run, encode.
// GET requests carry no body, so the request struct stays zero-valued
// except for a "project" query parameter when the type supports it.
func groupPost[T any](s *Server, id string, op func(T) (any, error)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !s.guardGroup(w, id) {
			return
		}
		var req T
		if r.Method != http.MethodGet && !decodeBody(w, r, &req) {
			return
		}
		if r.Method == http.MethodGet {
			if p, ok := any(&req).(interface{ setProject(string) }); ok {
				p.setProject(r.URL.Query().Get("project"))
			}
		}
		out, err := op(req)
		if err != nil {
			writeErr(w, http.StatusBadRequest, err)
			return
		}
		writeJSON(w, http.StatusOK, out)
	}
}

// toolGroup binds a group id to its MCP surface; tools/list and tools/call
// walk this table rather than repeating a branch per group
type toolGroup struct {
	id    string
	tools func() []mcpTool
	call  func(name string, args json.RawMessage) (any, error)
}

func (s *Server) toolGroups() []toolGroup {
	return append(s.staticToolGroups(), s.addonToolGroups()...)
}

// staticGroupIDs is derived from the group table rather than hand-listed, so
// a new core group can never be silently shadowed by an addon of the same id
func (s *Server) staticGroupIDs() map[string]bool {
	groups := s.staticToolGroups()
	out := make(map[string]bool, len(groups))
	for _, g := range groups {
		out[g.id] = true
	}
	return out
}

func (s *Server) staticToolGroups() []toolGroup {
	return []toolGroup{
		{"board", s.mcpTools, s.callTool},
		{"health", s.healthTools, s.callHealthTool},
		{"auto", s.autoTools, s.callAutoTool},
		{"widgets", s.widgetsTools, s.callWidgetsTool},
		{"term", s.termTools, s.callTermTool},
		{"addons", s.addonsTools, s.callAddonsTool},
		{"projects", s.projectsTools, s.callWorkspaceTool},
		{"tasks", s.tasksTools, s.callWorkspaceTool},
		{"notes", s.notesTools, s.callWorkspaceTool},
		{"prompts", s.promptsTools, s.callWorkspaceTool},
		{"system", s.systemTools, s.callWorkspaceTool},
	}
}

// groupForTool resolves a tool name by its group prefix ("board_get" -> board)
func (s *Server) groupForTool(name string) (toolGroup, bool) {
	for _, g := range s.toolGroups() {
		if strings.HasPrefix(name, g.id+"_") {
			return g, true
		}
	}
	return toolGroup{}, false
}
