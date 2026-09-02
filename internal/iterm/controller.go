package iterm

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/kalor62/cyberlife/internal/logging"
)

// ITermTab represents a tab in iTerm2
type ITermTab struct {
	WindowID  int    `json:"windowId"`
	TabIndex  int    `json:"tabIndex"`
	SessionID string `json:"sessionId"`
	Name      string `json:"name"`
	Path      string `json:"path"`
	IsActive  bool   `json:"isActive"`
}

// ITermStatus represents the current iTerm2 status
type ITermStatus struct {
	Running bool       `json:"running"`
	Tabs    []ITermTab `json:"tabs"`
}

// Controller manages iTerm2 integration via AppleScript
type Controller struct {
	mu             sync.RWMutex
	lastStatus     *ITermStatus
	onStatusChange func(status *ITermStatus)
	pollTicker     *time.Ticker
	stopPolling    chan struct{}

	// Content watching (plain text fallback)
	contentWatchMu      sync.Mutex
	contentWatchStop    chan struct{}
	contentWatchSession string
	lastContentHash     string

	// tmux single-window mode (see tmux.go)
	tmuxMode          bool
	tmuxMu            sync.Mutex
	tmuxHostTTY       string
	tmuxHostSessionID string
	tmuxPollStop      chan struct{}
	tmuxPollHash      string
	tmuxControl       *tmuxControlWatcher
	tmuxViewCols      int
	tmuxViewRows      int
}

// NewController creates a new iTerm2 controller
func NewController() *Controller {
	return &Controller{
		stopPolling: make(chan struct{}),
	}
}

// SetStatusChangeHandler sets the callback for status changes
func (c *Controller) SetStatusChangeHandler(handler func(status *ITermStatus)) {
	c.mu.Lock()
	c.onStatusChange = handler
	c.mu.Unlock()
}

// StartPolling starts polling iTerm2 for status changes
func (c *Controller) StartPolling(interval time.Duration) {
	c.pollTicker = time.NewTicker(interval)
	go func() {
		// Initial fetch
		c.pollStatus()

		for {
			select {
			case <-c.pollTicker.C:
				c.pollStatus()
			case <-c.stopPolling:
				c.pollTicker.Stop()
				return
			}
		}
	}()
	logging.Info("iTerm2 polling started", "interval", interval)
}

// StopPolling stops the polling loop (safe to call multiple times)
func (c *Controller) StopPolling() {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.stopPolling != nil {
		close(c.stopPolling)
		c.stopPolling = nil
	}
}

func (c *Controller) pollStatus() {
	status, err := c.GetStatus()
	if err != nil {
		logging.Error("Failed to poll iTerm2 status", "error", err)
		return
	}

	c.mu.Lock()
	changed := c.hasStatusChanged(status)
	c.lastStatus = status
	handler := c.onStatusChange
	c.mu.Unlock()

	if changed && handler != nil {
		handler(status)
	}
}

func (c *Controller) hasStatusChanged(newStatus *ITermStatus) bool {
	if c.lastStatus == nil {
		return true
	}
	if c.lastStatus.Running != newStatus.Running {
		return true
	}
	if len(c.lastStatus.Tabs) != len(newStatus.Tabs) {
		return true
	}
	// Compare tabs by session ID, name, and active state
	for i, tab := range newStatus.Tabs {
		if i >= len(c.lastStatus.Tabs) {
			return true
		}
		old := c.lastStatus.Tabs[i]
		if tab.SessionID != old.SessionID || tab.Name != old.Name || tab.IsActive != old.IsActive || tab.TabIndex != old.TabIndex {
			return true
		}
	}
	return false
}

// IsRunning checks if iTerm2 is running
func (c *Controller) IsRunning() bool {
	script := `tell application "System Events" to (name of processes) contains "iTerm2"`
	output, err := c.runAppleScript(script)
	if err != nil {
		return false
	}
	return strings.TrimSpace(output) == "true"
}

// GetStatus returns the current iTerm2 status including all tabs
func (c *Controller) GetStatus() (*ITermStatus, error) {
	// tmux is the session backend; iTerm2 only adds its own tabs on top and
	// hosts the viewer. Every exit below therefore ends in tmuxOnly() or a
	// merge — a missing or misbehaving iTerm2 must never hide real sessions.
	if !c.IsRunning() {
		return c.tmuxOnly(false), nil
	}

	// AppleScript to get all tabs with their info using quote constant to avoid escape issues
	script := `
set q to quote
tell application "iTerm2"
	set output to "["
	set isFirst to true
	repeat with w in windows
		set windowId to id of w
		set currentSessId to ""
		try
			set currentSessId to id of current session of current tab of w
		end try

		set tabIdx to 0
		repeat with t in tabs of w
			set tabIdx to tabIdx + 1
			set sess to current session of t
			set sessName to name of sess
			set sessId to id of sess

			-- Get working directory from session variable
			set sessPath to ""
			try
				tell sess
					set sessPath to variable named "path"
				end tell
			end try
			if sessPath is missing value then set sessPath to ""

			-- Quotes and backslashes would break the hand-built JSON below
			set safePath to ""
			repeat with pc in sessPath
				set pc to pc as text
				if pc is q then
					set safePath to safePath & "'"
				else if pc is "\\" then
					set safePath to safePath & "/"
				else
					set safePath to safePath & pc
				end if
			end repeat

			-- Strip process suffix using offset (avoids text item delimiters issues)
			set cleanName to sessName
			try
				set parenPos to offset of " (" in sessName
				if parenPos > 0 then
					set cleanName to text 1 thru (parenPos - 1) of sessName
				end if
			end try

			-- Quotes and backslashes would break the hand-built JSON below.
			-- Shell-escaped process titles ("next-server\\ \\(v1\\)") are the
			-- common source of backslashes, so dropping them also reads better.
			set safeName to ""
			repeat with c in cleanName
				set c to c as text
				if c is q then
					set safeName to safeName & "'"
				else if c is not "\\" then
					set safeName to safeName & c
				end if
			end repeat

			set isActive to (sessId is currentSessId)

			if not isFirst then
				set output to output & ","
			end if
			set isFirst to false

			set output to output & "{" & q & "windowId" & q & ":" & windowId & "," & q & "tabIndex" & q & ":" & tabIdx & "," & q & "sessionId" & q & ":" & q & sessId & q & "," & q & "name" & q & ":" & q & safeName & q & "," & q & "path" & q & ":" & q & safePath & q & "," & q & "isActive" & q & ":" & isActive & "}"
		end repeat
	end repeat
	set output to output & "]"
	return output
end tell
`

	output, err := c.runAppleScript(script)
	if err != nil {
		logging.Error("Failed to get iTerm2 tabs", "error", err)
		return c.tmuxOnly(true), nil
	}

	var tabs []ITermTab
	if err := json.Unmarshal([]byte(output), &tabs); err != nil {
		// The payload is a whole tab list: titles and working paths. Logging
		// it in full on every poll floods the file and copies the user's
		// workspace into it, so only a short head goes in.
		logging.Error("Failed to parse iTerm2 tabs JSON", "error", err, "outputHead", snippet(output, 160))
		return c.tmuxOnly(true), nil
	}

	status := &ITermStatus{Running: true, Tabs: tabs}
	if c.IsTmuxMode() {
		c.augmentStatusWithTmux(status)
	}
	return status, nil
}

// tmuxOnly reports the sessions that exist independently of iTerm2 — used
// on Linux, when iTerm2 is not running, and whenever querying it fails
func (c *Controller) tmuxOnly(itermRunning bool) *ITermStatus {
	status := &ITermStatus{Running: itermRunning, Tabs: []ITermTab{}}
	if c.IsTmuxMode() {
		c.augmentStatusWithTmux(status)
	}
	return status
}

// LaunchITerm launches iTerm2 application
func (c *Controller) LaunchITerm() error {
	script := `tell application "iTerm2" to activate`
	_, err := c.runAppleScript(script)
	if err != nil {
		logging.Error("Failed to launch iTerm2", "error", err)
		return err
	}
	logging.Info("iTerm2 launched")
	return nil
}

// SwitchTab switches to a specific tab in iTerm2 without stealing focus
func (c *Controller) SwitchTab(windowID, tabIndex int) error {
	script := fmt.Sprintf(`
tell application "iTerm2"
	repeat with w in windows
		if id of w is %d then
			select tab %d of w
			return true
		end if
	end repeat
	return false
end tell
`, windowID, tabIndex)

	output, err := c.runAppleScript(script)
	if err != nil {
		logging.Error("Failed to switch iTerm2 tab", "windowId", windowID, "tabIndex", tabIndex, "error", err)
		return err
	}

	if strings.TrimSpace(output) != "true" {
		return fmt.Errorf("tab not found: window %d, tab %d", windowID, tabIndex)
	}

	logging.Info("Switched iTerm2 tab", "windowId", windowID, "tabIndex", tabIndex)
	return nil
}

// SwitchTabBySessionID switches to a tab by its session ID (more reliable than tabIndex)
func (c *Controller) SwitchTabBySessionID(sessionID string) error {
	if isTmuxSessionID(sessionID) {
		return c.showTmuxSession(tmuxNameFromID(sessionID))
	}
	script := fmt.Sprintf(`
tell application "iTerm2"
	repeat with w in windows
		set tabIdx to 0
		repeat with t in tabs of w
			set tabIdx to tabIdx + 1
			set sess to current session of t
			if id of sess is "%s" then
				select tab tabIdx of w
				return true
			end if
		end repeat
	end repeat
	return false
end tell
`, sessionID)

	output, err := c.runAppleScript(script)
	if err != nil {
		logging.Error("Failed to switch iTerm2 tab by session ID", "sessionId", sessionID, "error", err)
		return err
	}

	if strings.TrimSpace(output) != "true" {
		return fmt.Errorf("session not found: %s", sessionID)
	}

	logging.Info("Switched iTerm2 tab by session ID", "sessionId", sessionID)
	return nil
}

// tmuxSessionName converts a tab name into a valid tmux session name.
// tmux rejects ':' and '.' in names; keep it to a safe charset.
func tmuxSessionName(tabName string) string {
	var b strings.Builder
	for _, r := range tabName {
		if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || r == '-' || r == '_' {
			b.WriteRune(r)
		} else {
			b.WriteRune('-')
		}
	}
	name := b.String()
	for strings.Contains(name, "--") {
		name = strings.ReplaceAll(name, "--", "-")
	}
	name = strings.Trim(name, "-")
	if name == "" {
		name = "cyberlife"
	}
	return name
}

// SessionNameFor maps a tab name to the tmux session id it will get
func SessionNameFor(tabName string) string {
	return tmuxSessionName(tabName)
}

// CreateTab creates a new tab in iTerm2 with the specified working directory and name.
// claudeArgs is appended to the claude launch command (e.g. "--resume <uuid>").
// In tmux mode claude runs in a detached tmux session shown through the single host tab.
func (c *Controller) CreateTab(workingDir, tabName, claudeConfigDir, claudeArgs string) error {
	env := map[string]string{}
	if claudeConfigDir != "" {
		env["CLAUDE_CONFIG_DIR"] = claudeConfigDir
	}
	command := "claude"
	if claudeArgs != "" {
		sanitizedArgs := strings.ReplaceAll(claudeArgs, "\"", "")
		sanitizedArgs = strings.ReplaceAll(sanitizedArgs, "\\", "")
		command = "claude " + sanitizedArgs
	}
	return c.CreateTabWithCommand(workingDir, tabName, env, command)
}

// CreateTabWithCommand launches an arbitrary runner command in a new session
// (tmux mode or a plain iTerm2 tab) with the given environment
func (c *Controller) CreateTabWithCommand(workingDir, tabName string, env map[string]string, command string) error {
	// Escape special characters for shell and AppleScript safety
	escapedPath := strings.ReplaceAll(workingDir, "'", "'\\''")

	// Sanitize tab name: remove newlines, escape backslashes and quotes
	escapedName := strings.ReplaceAll(tabName, "\n", "")
	escapedName = strings.ReplaceAll(escapedName, "\r", "")
	escapedName = strings.ReplaceAll(escapedName, "\\", "\\\\")
	escapedName = strings.ReplaceAll(escapedName, "'", "'\\''")
	escapedName = strings.ReplaceAll(escapedName, "\"", "\\\"")

	envPrefix := ""
	for k, v := range env {
		escapedVal := strings.ReplaceAll(v, "'", "'\\''")
		envPrefix += fmt.Sprintf("export %s='%s' && ", k, escapedVal)
	}

	claudeCmd := command

	if c.IsTmuxMode() {
		if findTmuxPath() == "" {
			logging.Warn("tmux not found, launching runner without tmux")
		} else {
			name := tmuxSessionName(tabName)
			if err := c.ensureTmuxSession(name, workingDir, env, command); err != nil {
				logging.Error("Failed to create tmux session", "name", name, "error", err)
				return err
			}
			return c.showTmuxSession(name)
		}
	}

	// Use escape sequences to set both tab title (OSC 1) and window title (OSC 2)
	// This is more reliable than AppleScript's "set name" which can be overridden by profile settings
	// Only activate (steal focus) if no windows exist - otherwise create tab silently
	script := fmt.Sprintf(`
tell application "iTerm2"
	if (count of windows) is 0 then
		activate
		create window with default profile
	end if
	tell current window
		create tab with default profile
		tell current session
			set name to "%s"
			write text "%scd '%s' && clear && printf '\\033]1;%s\\007\\033]2;%s\\007\\033]1337;CurrentDir=%s\\007' && %s"
		end tell
	end tell
end tell
`, escapedName, envPrefix, escapedPath, escapedName, escapedName, escapedPath, claudeCmd)

	_, err := c.runAppleScript(script)
	if err != nil {
		logging.Error("Failed to create iTerm2 tab", "workingDir", logging.MaskPath(workingDir), "error", err)
		return err
	}

	logging.Info("Created iTerm2 tab", "workingDir", logging.MaskPath(workingDir))
	return nil
}

// CloseTab closes a specific tab in iTerm2
func (c *Controller) CloseTab(windowID, tabIndex int) error {
	script := fmt.Sprintf(`
tell application "iTerm2"
	repeat with w in windows
		if id of w is %d then
			close tab %d of w
			return true
		end if
	end repeat
	return false
end tell
`, windowID, tabIndex)

	output, err := c.runAppleScript(script)
	if err != nil {
		logging.Error("Failed to close iTerm2 tab", "windowId", windowID, "tabIndex", tabIndex, "error", err)
		return err
	}

	if strings.TrimSpace(output) != "true" {
		return fmt.Errorf("tab not found: window %d, tab %d", windowID, tabIndex)
	}

	logging.Info("Closed iTerm2 tab", "windowId", windowID, "tabIndex", tabIndex)
	return nil
}

// CloseTabBySessionID closes the tab containing a specific session
func (c *Controller) CloseTabBySessionID(sessionID string) error {
	if isTmuxSessionID(sessionID) {
		_, err := tmuxExec("kill-session", "-t", "="+tmuxNameFromID(sessionID))
		return err
	}
	script := fmt.Sprintf(`
tell application "iTerm2"
	repeat with w in windows
		set tabIdx to 0
		repeat with t in tabs of w
			set tabIdx to tabIdx + 1
			set sess to current session of t
			if id of sess is "%s" then
				close tab tabIdx of w
				return true
			end if
		end repeat
	end repeat
	return false
end tell
`, sessionID)

	output, err := c.runAppleScript(script)
	if err != nil {
		logging.Error("Failed to close iTerm2 tab by session ID", "sessionId", sessionID, "error", err)
		return err
	}

	if strings.TrimSpace(output) != "true" {
		return fmt.Errorf("session not found: %s", sessionID)
	}

	logging.Info("Closed iTerm2 tab by session ID", "sessionId", sessionID)
	return nil
}

// RenameTab renames a specific tab in iTerm2
func (c *Controller) RenameTab(windowID, tabIndex int, newName string) error {
	// Sanitize the new name
	escapedName := strings.ReplaceAll(newName, "\n", "")
	escapedName = strings.ReplaceAll(escapedName, "\r", "")
	escapedName = strings.ReplaceAll(escapedName, "\\", "\\\\")
	escapedName = strings.ReplaceAll(escapedName, "\"", "\\\"")

	script := fmt.Sprintf(`
tell application "iTerm2"
	repeat with w in windows
		if id of w is %d then
			tell tab %d of w
				tell current session
					set name to "%s"
				end tell
			end tell
			return true
		end if
	end repeat
	return false
end tell
`, windowID, tabIndex, escapedName)

	output, err := c.runAppleScript(script)
	if err != nil {
		logging.Error("Failed to rename iTerm2 tab", "windowId", windowID, "tabIndex", tabIndex, "error", err)
		return err
	}

	if strings.TrimSpace(output) != "true" {
		return fmt.Errorf("tab not found: window %d, tab %d", windowID, tabIndex)
	}

	logging.Info("Renamed iTerm2 tab", "windowId", windowID, "tabIndex", tabIndex, "newName", newName)
	return nil
}

// RenameTabBySessionID renames a tab by its session ID
// Uses both AppleScript name + OSC escape sequences for persistence
func (c *Controller) RenameTabBySessionID(sessionID, newName string) error {
	if isTmuxSessionID(sessionID) {
		_, err := tmuxExec("rename-session", "-t", "="+tmuxNameFromID(sessionID), tmuxSessionName(newName))
		return err
	}
	// Sanitize the new name
	escapedName := strings.ReplaceAll(newName, "\n", "")
	escapedName = strings.ReplaceAll(escapedName, "\r", "")
	escapedName = strings.ReplaceAll(escapedName, "\\", "\\\\")
	escapedName = strings.ReplaceAll(escapedName, "\"", "\\\"")

	// Use both set name (AppleScript) AND OSC 1/2 escape sequences
	// OSC sequences are more persistent against profile auto-title settings
	script := fmt.Sprintf(`
tell application "iTerm2"
	repeat with w in windows
		repeat with t in tabs of w
			set sess to current session of t
			if id of sess is "%s" then
				set name of sess to "%s"
				tell sess
					write text "printf '\\033]1;%s\\007\\033]2;%s\\007'" without newline
					write text (character id 13) without newline
				end tell
				return true
			end if
		end repeat
	end repeat
	return false
end tell
`, sessionID, escapedName, escapedName, escapedName)

	output, err := c.runAppleScript(script)
	if err != nil {
		logging.Error("Failed to rename iTerm2 tab by session ID", "sessionId", sessionID, "error", err)
		return err
	}

	if strings.TrimSpace(output) != "true" {
		return fmt.Errorf("session not found: %s", sessionID)
	}

	logging.Info("Renamed iTerm2 tab by session ID", "sessionId", sessionID, "newName", newName)
	return nil
}

// FocusITerm brings iTerm2 to the foreground
func (c *Controller) FocusITerm() error {
	script := `tell application "iTerm2" to activate`
	_, err := c.runAppleScript(script)
	return err
}

// WriteText writes text to the active iTerm2 session
func (c *Controller) WriteText(text string, pressEnter bool) error {
	if !c.IsRunning() {
		return fmt.Errorf("iTerm2 is not running")
	}

	// Escape special characters for AppleScript
	escapedText := strings.ReplaceAll(text, "\\", "\\\\")
	escapedText = strings.ReplaceAll(escapedText, "\"", "\\\"")
	escapedText = strings.ReplaceAll(escapedText, "\n", "\\n")
	escapedText = strings.ReplaceAll(escapedText, "\r", "\\r")
	escapedText = strings.ReplaceAll(escapedText, "\t", "\\t")

	writeCmd := fmt.Sprintf(`write text "%s" without newline`, escapedText)

	var script string
	if pressEnter {
		script = fmt.Sprintf(`
tell application "iTerm2"
	tell current session of current window
		%s
		write text (character id 13) without newline
	end tell
end tell
`, writeCmd)
	} else {
		script = fmt.Sprintf(`
tell application "iTerm2"
	tell current session of current window
		%s
	end tell
end tell
`, writeCmd)
	}

	_, err := c.runAppleScript(script)
	if err != nil {
		logging.Error("Failed to write text to iTerm2", "error", err)
		return err
	}

	logging.Debug("Wrote text to iTerm2", "length", len(text), "pressEnter", pressEnter)
	return nil
}

// GetSessionContentsByID returns the last N lines from a specific iTerm2 session
func (c *Controller) GetSessionContentsByID(sessionID string, lines int) (string, error) {
	if lines <= 0 {
		lines = 200
	}

	if isTmuxSessionID(sessionID) {
		return tmuxExec("capture-pane", "-p", "-t", tmuxPaneTarget(tmuxNameFromID(sessionID)), "-S", fmt.Sprintf("-%d", lines))
	}

	if !c.IsRunning() {
		return "", fmt.Errorf("iTerm2 is not running")
	}

	script := fmt.Sprintf(`
tell application "iTerm2"
	repeat with w in windows
		repeat with t in tabs of w
			set sess to current session of t
			if id of sess is "%s" then
				return get contents of sess
			end if
		end repeat
	end repeat
	return "ERROR:SESSION_NOT_FOUND"
end tell
`, sessionID)

	output, err := c.runAppleScript(script)
	if err != nil {
		logging.Error("Failed to get session contents by ID", "sessionId", sessionID, "error", err)
		return "", err
	}

	if output == "ERROR:SESSION_NOT_FOUND" {
		return "", fmt.Errorf("session not found: %s", sessionID)
	}

	// Trim to last N lines
	allLines := strings.Split(output, "\n")
	if len(allLines) > lines {
		allLines = allLines[len(allLines)-lines:]
	}

	return strings.Join(allLines, "\n"), nil
}

// WriteTextBySessionID writes text to a specific iTerm2 session by its session ID
func (c *Controller) WriteTextBySessionID(sessionID string, text string, pressEnter bool) error {
	if isTmuxSessionID(sessionID) {
		name := tmuxNameFromID(sessionID)
		if c.tmuxSendKeysFast(name, text, pressEnter) {
			return nil
		}
		return writeTmuxText(name, text, pressEnter)
	}
	if !c.IsRunning() {
		return fmt.Errorf("iTerm2 is not running")
	}

	// Escape special characters for AppleScript
	escapedText := strings.ReplaceAll(text, "\\", "\\\\")
	escapedText = strings.ReplaceAll(escapedText, "\"", "\\\"")
	escapedText = strings.ReplaceAll(escapedText, "\n", "\\n")
	escapedText = strings.ReplaceAll(escapedText, "\r", "\\r")
	escapedText = strings.ReplaceAll(escapedText, "\t", "\\t")

	writeCmd := fmt.Sprintf(`write text "%s" without newline`, escapedText)

	var script string
	if pressEnter {
		script = fmt.Sprintf(`
tell application "iTerm2"
	repeat with w in windows
		repeat with t in tabs of w
			set sess to current session of t
			if id of sess is "%s" then
				tell sess
					%s
					write text (character id 13) without newline
				end tell
				return true
			end if
		end repeat
	end repeat
	return false
end tell
`, sessionID, writeCmd)
	} else {
		script = fmt.Sprintf(`
tell application "iTerm2"
	repeat with w in windows
		repeat with t in tabs of w
			set sess to current session of t
			if id of sess is "%s" then
				tell sess
					%s
				end tell
				return true
			end if
		end repeat
	end repeat
	return false
end tell
`, sessionID, writeCmd)
	}

	output, err := c.runAppleScript(script)
	if err != nil {
		logging.Error("Failed to write text by session ID", "sessionId", sessionID, "error", err)
		return err
	}

	if strings.TrimSpace(output) != "true" {
		return fmt.Errorf("session not found: %s", sessionID)
	}

	logging.Debug("Wrote text to iTerm2 session", "sessionId", sessionID, "length", len(text), "pressEnter", pressEnter)
	return nil
}

// PasteTextBySessionID delivers text as a single tmux bracketed paste; the
// receiving program sees one paste event instead of typed lines
func (c *Controller) PasteTextBySessionID(sessionID, text string) error {
	if isTmuxSessionID(sessionID) {
		return c.tmuxPasteText(tmuxNameFromID(sessionID), text)
	}
	return c.WriteTextBySessionID(sessionID, text, false)
}

// SendSpecialKeyBySessionID sends a special key/control sequence to a specific session
func (c *Controller) SendSpecialKeyBySessionID(sessionID string, key string) error {
	if isTmuxSessionID(sessionID) {
		tmuxKey, ok := tmuxKeyNames[key]
		if !ok {
			return fmt.Errorf("unknown special key: %s", key)
		}
		target := tmuxPaneTarget(tmuxNameFromID(sessionID))
		if c.tmuxControlCommand("send-keys -t " + tmuxQuote(target) + " " + tmuxKey) {
			return nil
		}
		_, err := tmuxExec("send-keys", "-t", target, tmuxKey)
		return err
	}
	if !c.IsRunning() {
		return fmt.Errorf("iTerm2 is not running")
	}

	// Map key names to AppleScript expressions
	var asExpr string
	switch key {
	case "ctrl-c":
		asExpr = `ASCII character 3`
	case "ctrl-d":
		asExpr = `ASCII character 4`
	case "ctrl-z":
		asExpr = `ASCII character 26`
	case "ctrl-l":
		asExpr = `ASCII character 12`
	case "ctrl-a":
		asExpr = `ASCII character 1`
	case "ctrl-e":
		asExpr = `ASCII character 5`
	case "ctrl-u":
		asExpr = `ASCII character 21`
	case "ctrl-k":
		asExpr = `ASCII character 11`
	case "ctrl-r":
		asExpr = `ASCII character 18`
	case "ctrl-v":
		asExpr = `ASCII character 22`
	case "tab":
		asExpr = `ASCII character 9`
	case "shift-tab":
		asExpr = `(ASCII character 27) & "[Z"`
	case "esc":
		asExpr = `ASCII character 27`
	case "up":
		asExpr = `(ASCII character 27) & "[A"`
	case "down":
		asExpr = `(ASCII character 27) & "[B"`
	case "left":
		asExpr = `(ASCII character 27) & "[D"`
	case "right":
		asExpr = `(ASCII character 27) & "[C"`
	case "enter":
		asExpr = `return`
	default:
		return fmt.Errorf("unknown special key: %s", key)
	}

	script := fmt.Sprintf(`
tell application "iTerm2"
	repeat with w in windows
		repeat with t in tabs of w
			set sess to current session of t
			if id of sess is "%s" then
				tell sess
					write text (%s) without newline
				end tell
				return true
			end if
		end repeat
	end repeat
	return false
end tell
`, sessionID, asExpr)

	output, err := c.runAppleScript(script)
	if err != nil {
		logging.Error("Failed to send special key", "sessionId", sessionID, "key", key, "error", err)
		return err
	}

	if strings.TrimSpace(output) != "true" {
		return fmt.Errorf("session not found: %s", sessionID)
	}

	logging.Debug("Sent special key to iTerm2 session", "sessionId", sessionID, "key", key)
	return nil
}

// StartContentWatching starts watching a session's content for changes.
// Only one session can be watched at a time - calling again stops the previous watcher.
func (c *Controller) StartContentWatching(sessionID string, lines int, interval time.Duration, onChange func(string)) {
	c.StopContentWatching()

	c.contentWatchMu.Lock()
	c.contentWatchSession = sessionID
	c.contentWatchStop = make(chan struct{})
	stopCh := c.contentWatchStop
	c.lastContentHash = ""
	c.contentWatchMu.Unlock()

	go func() {
		// Initial fetch
		c.pollContent(sessionID, lines, onChange)

		ticker := time.NewTicker(interval)
		defer ticker.Stop()

		for {
			select {
			case <-ticker.C:
				c.pollContent(sessionID, lines, onChange)
			case <-stopCh:
				return
			}
		}
	}()

	logging.Info("Content watching started", "sessionId", sessionID, "interval", interval)
}

// StopContentWatching stops the content watcher
func (c *Controller) StopContentWatching() {
	c.contentWatchMu.Lock()
	defer c.contentWatchMu.Unlock()

	if c.contentWatchStop != nil {
		close(c.contentWatchStop)
		c.contentWatchStop = nil
		c.contentWatchSession = ""
		c.lastContentHash = ""
		logging.Info("Content watching stopped")
	}
}

func (c *Controller) pollContent(sessionID string, lines int, onChange func(string)) {
	contents, err := c.GetSessionContentsByID(sessionID, lines)
	if err != nil {
		logging.Debug("Content poll error", "sessionId", sessionID, "error", err)
		// Emit error marker so frontend knows session is gone
		onChange("[Session disconnected]")
		return
	}

	// Simple hash: use content length + first/last chars as quick check
	hash := fmt.Sprintf("%d:%s", len(contents), contents)

	c.contentWatchMu.Lock()
	changed := hash != c.lastContentHash
	if changed {
		c.lastContentHash = hash
	}
	c.contentWatchMu.Unlock()

	if changed {
		onChange(contents)
	}
}

func (c *Controller) runAppleScript(script string) (string, error) {
	if runtime.GOOS != "darwin" {
		return "", fmt.Errorf("AppleScript unavailable on %s (iTerm integration is mac-only)", runtime.GOOS)
	}
	// Write script to temp file to avoid -e escaping issues
	tmpFile, err := os.CreateTemp("", "applescript-*.scpt")
	if err != nil {
		return "", fmt.Errorf("failed to create temp file: %w", err)
	}
	defer func() {
		if err := os.Remove(tmpFile.Name()); err != nil {
			logging.Debug("applescript temp file remove failed", "error", err)
		}
	}()

	if _, err := tmpFile.WriteString(script); err != nil {
		_ = tmpFile.Close()
		return "", fmt.Errorf("failed to write script: %w", err)
	}
	// Ensure data is written to disk before running
	if err := tmpFile.Sync(); err != nil {
		_ = tmpFile.Close()
		return "", fmt.Errorf("failed to sync script: %w", err)
	}
	if err := tmpFile.Close(); err != nil {
		return "", fmt.Errorf("failed to close script: %w", err)
	}

	cmd := exec.Command("osascript", tmpFile.Name())
	output, err := cmd.Output()
	if err != nil {
		if exitErr, ok := err.(*exec.ExitError); ok {
			return "", fmt.Errorf("AppleScript error: %s", string(exitErr.Stderr))
		}
		return "", err
	}
	return strings.TrimSpace(string(output)), nil
}

// ParseTabIndex parses a tab index from a string (for URL params, etc.)
func ParseTabIndex(s string) (int, error) {
	return strconv.Atoi(s)
}

// SessionInfo contains information about the active iTerm2 session
type SessionInfo struct {
	Name           string `json:"name"`
	ProfileName    string `json:"profileName"`
	Columns        int    `json:"columns"`
	Rows           int    `json:"rows"`
	CurrentCommand string `json:"currentCommand"`
	JobPid         int    `json:"jobPid"`
	IsProcessing   bool   `json:"isProcessing"`
}

// GetSessionContents returns the last N lines from the active iTerm2 session
// Returns raw terminal output - xterm.js handles ANSI codes and formatting
func (c *Controller) GetSessionContents(lines int) (string, error) {
	if !c.IsRunning() {
		return "", fmt.Errorf("iTerm2 is not running")
	}

	if lines <= 0 {
		lines = 50
	}

	script := `
tell application "iTerm2"
	tell current session of current window
		get contents
	end tell
end tell
`

	output, err := c.runAppleScript(script)
	if err != nil {
		logging.Error("Failed to get session contents", "error", err)
		return "", err
	}

	// Only limit lines, preserve all formatting for xterm.js
	allLines := strings.Split(output, "\n")
	if len(allLines) > lines {
		allLines = allLines[len(allLines)-lines:]
	}

	return strings.Join(allLines, "\n"), nil
}

// GetSessionInfo returns information about the active iTerm2 session
func (c *Controller) GetSessionInfo() (*SessionInfo, error) {
	if !c.IsRunning() {
		return nil, fmt.Errorf("iTerm2 is not running")
	}

	script := `
tell application "iTerm2"
	tell current session of current window
		set sessName to name
		set profName to profile name
		set cols to columns
		set rws to rows
		return sessName & "|||" & profName & "|||" & cols & "|||" & rws
	end tell
end tell
`

	output, err := c.runAppleScript(script)
	if err != nil {
		logging.Error("Failed to get session info", "error", err)
		return nil, err
	}

	parts := strings.Split(output, "|||")
	if len(parts) < 4 {
		return nil, fmt.Errorf("unexpected output format: %s", output)
	}

	cols, _ := strconv.Atoi(strings.TrimSpace(parts[2]))
	rows, _ := strconv.Atoi(strings.TrimSpace(parts[3]))
	jobPid := 0
	isProcessing := false

	// Extract current command from session name (usually "command (process)")
	name := strings.TrimSpace(parts[0])
	currentCommand := ""
	if idx := strings.LastIndex(name, " ("); idx > 0 {
		currentCommand = strings.TrimSuffix(name[idx+2:], ")")
	}

	return &SessionInfo{
		Name:           name,
		ProfileName:    strings.TrimSpace(parts[1]),
		Columns:        cols,
		Rows:           rows,
		CurrentCommand: currentCommand,
		JobPid:         jobPid,
		IsProcessing:   isProcessing,
	}, nil
}

// ============================================
// Styled Content (tmux-only)
// ============================================

// StartStyledContentWatching streams a tmux-backed session's styled content.
// tmux is the only session mode; plain iTerm tabs cannot be watched.
func (c *Controller) StartStyledContentWatching(
	sessionID string,
	styledHandler func(*StyledContent),
	profileHandler func(*ProfileData),
) error {
	if isTmuxSessionID(sessionID) {
		return c.startTmuxWatching(sessionID, styledHandler, profileHandler)
	}
	c.stopTmuxPolling()
	return fmt.Errorf("session is not tmux-backed — create sessions from Cyber Life to watch them here")
}

// RequestStyledHistory returns tmux scrollback as styled lines
func (c *Controller) RequestStyledHistory(sessionID string, handler func(*StyledContent)) error {
	if isTmuxSessionID(sessionID) {
		lines, size := tmuxHistory(tmuxNameFromID(sessionID))
		handler(&StyledContent{
			SessionID:   sessionID,
			Lines:       lines,
			HistorySize: size,
		})
		return nil
	}
	return fmt.Errorf("session is not tmux-backed")
}

// StopStyledContentWatching stops plain and tmux content watching
func (c *Controller) StopStyledContentWatching() {
	c.StopContentWatching()
	c.stopTmuxPolling()
}

// snippet trims a payload for logging without cutting a multi-byte rune
func snippet(s string, max int) string {
	if len(s) <= max {
		return s
	}
	return strings.ToValidUTF8(s[:max], "") + "…"
}
