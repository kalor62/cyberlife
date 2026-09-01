package state

import (
	"fmt"
	"os"
	"strings"

	"github.com/google/uuid"
)

// ClaudeRunnerID is the built-in default runner
const ClaudeRunnerID = "claude"

// ShellRunnerID runs the prompt itself as a `sh -c` script. It is for API
// callers (addons, automations) that need full control of the command line,
// so it is resolvable by id but never listed: in the UI pickers it would only
// ever launch `sh -c` with no script.
const ShellRunnerID = "shell"

func builtinShellRunner() Runner {
	return Runner{
		ID:      ShellRunnerID,
		Name:    "Shell script",
		Command: "sh",
		Args:    "-c",
		Icon:    "🐚",
		Color:   "#94a3b8",
		BuiltIn: true,
	}
}

func builtinClaudeRunner() Runner {
	return Runner{
		ID:      ClaudeRunnerID,
		Name:    "Claude",
		Command: "claude",
		Icon:    "✳️",
		Color:   "#d97757",
		BuiltIn: true,
	}
}

// GetRunners returns the built-in Claude runner followed by user-defined ones
func (m *Manager) GetRunners() []Runner {
	m.mu.RLock()
	defer m.mu.RUnlock()
	out := []Runner{builtinClaudeRunner()}
	out = append(out, m.state.Runners...)
	return out
}

// GetRunner resolves a runner by ID; empty or unknown falls back to Claude
func (m *Manager) GetRunner(id string) Runner {
	if id == ShellRunnerID {
		return builtinShellRunner()
	}
	for _, r := range m.GetRunners() {
		if r.ID == id {
			return r
		}
	}
	return builtinClaudeRunner()
}

func (m *Manager) SaveRunner(r Runner) (Runner, error) {
	if r.ID == ClaudeRunnerID || r.BuiltIn {
		return Runner{}, fmt.Errorf("the built-in Claude runner cannot be edited")
	}
	if r.Name == "" || r.Command == "" {
		return Runner{}, fmt.Errorf("name and command are required")
	}
	m.mu.Lock()
	if r.ID == "" {
		r.ID = uuid.New().String()
		m.state.Runners = append(m.state.Runners, r)
	} else {
		found := false
		for i := range m.state.Runners {
			if m.state.Runners[i].ID == r.ID {
				m.state.Runners[i] = r
				found = true
				break
			}
		}
		if !found {
			m.mu.Unlock()
			return Runner{}, os.ErrNotExist
		}
	}
	m.mu.Unlock()
	m.Save()
	return r, nil
}

func (m *Manager) DeleteRunner(id string) error {
	if id == ClaudeRunnerID {
		return fmt.Errorf("the built-in Claude runner cannot be deleted")
	}
	m.mu.Lock()
	runners := m.state.Runners[:0]
	for _, r := range m.state.Runners {
		if r.ID != id {
			runners = append(runners, r)
		}
	}
	m.state.Runners = runners
	if m.state.DefaultRunner == id {
		m.state.DefaultRunner = ""
	}
	for _, p := range m.state.Projects {
		if p != nil && p.DefaultRunner == id {
			p.DefaultRunner = ""
		}
	}
	for sid, rid := range m.state.TerminalRunners {
		if rid == id {
			delete(m.state.TerminalRunners, sid)
		}
	}
	m.mu.Unlock()
	m.Save()
	return nil
}

func (m *Manager) GetDefaultRunner() string {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.state.DefaultRunner
}

func (m *Manager) SetDefaultRunner(id string) error {
	id = strings.TrimSpace(id)
	if id == ClaudeRunnerID {
		id = ""
	}
	if id != "" && !m.runnerKnown(id) {
		return fmt.Errorf("unknown runner")
	}
	m.mu.Lock()
	m.state.DefaultRunner = id
	m.mu.Unlock()
	m.Save()
	return nil
}

// ResolveDefaultRunner is project override → global default → Claude.
func (m *Manager) ResolveDefaultRunner(projectID string) string {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.resolveDefaultRunnerLocked(projectID)
}

// ResolveDefaultRunnerForPath looks up the project that owns workDir, then
// resolves the default the same way a new Term tab would.
func (m *Manager) ResolveDefaultRunnerForPath(workDir string) string {
	if p, ok := m.ResolveProject(workDir); ok {
		return m.ResolveDefaultRunner(p.ID)
	}
	return m.ResolveDefaultRunner("")
}

func (m *Manager) resolveDefaultRunnerLocked(projectID string) string {
	if projectID != "" {
		if p := m.state.Projects[projectID]; p != nil && m.runnerKnownLocked(p.DefaultRunner) {
			return p.DefaultRunner
		}
	}
	if m.runnerKnownLocked(m.state.DefaultRunner) {
		return m.state.DefaultRunner
	}
	return ClaudeRunnerID
}

func (m *Manager) runnerKnown(id string) bool {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.runnerKnownLocked(id)
}

func (m *Manager) runnerKnownLocked(id string) bool {
	if id == "" {
		return false
	}
	if id == ClaudeRunnerID {
		return true
	}
	for _, r := range m.state.Runners {
		if r.ID == id {
			return true
		}
	}
	return false
}

func (m *Manager) GetTerminalRunners() map[string]string {
	m.mu.RLock()
	defer m.mu.RUnlock()
	out := map[string]string{}
	for k, v := range m.state.TerminalRunners {
		out[k] = v
	}
	return out
}

func (m *Manager) SetTerminalRunner(sessionID, runnerID string) {
	m.mu.Lock()
	if m.state.TerminalRunners == nil {
		m.state.TerminalRunners = map[string]string{}
	}
	if runnerID == "" || runnerID == ClaudeRunnerID {
		delete(m.state.TerminalRunners, sessionID)
	} else {
		m.state.TerminalRunners[sessionID] = runnerID
	}
	m.mu.Unlock()
	m.Save()
}
