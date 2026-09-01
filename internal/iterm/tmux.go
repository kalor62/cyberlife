package iterm

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/kalor62/cyberlife/internal/logging"
)

// In tmux mode each tmux session is exposed to the dashboard as a virtual
// terminal with SessionID "tmux:<session-name>". All of them are displayed
// through a single iTerm2 "host" tab that runs an attached tmux client.
const tmuxIDPrefix = "tmux:"

func isTmuxSessionID(id string) bool { return strings.HasPrefix(id, tmuxIDPrefix) }

func tmuxNameFromID(id string) string { return strings.TrimPrefix(id, tmuxIDPrefix) }

var (
	tmuxPathOnce sync.Once
	tmuxPath     string
)

// FindTmuxPath exposes the resolved tmux binary path for dependency checks
func FindTmuxPath() string { return findTmuxPath() }

// findTmuxPath resolves the tmux binary; the .app bundle PATH may not include homebrew
func findTmuxPath() string {
	tmuxPathOnce.Do(func() {
		if p, err := exec.LookPath("tmux"); err == nil {
			tmuxPath = p
			return
		}
		for _, p := range []string{"/opt/homebrew/bin/tmux", "/usr/local/bin/tmux", "/usr/bin/tmux"} {
			if _, err := os.Stat(p); err == nil {
				tmuxPath = p
				return
			}
		}
	})
	return tmuxPath
}

func (c *Controller) sessionGridSize() (cols, rows int) {
	c.tmuxMu.Lock()
	cols, rows = c.tmuxViewCols, c.tmuxViewRows
	c.tmuxMu.Unlock()
	if cols == 0 {
		return tmuxControlCols, tmuxControlRows
	}
	return cols, rows
}

func tmuxExec(args ...string) (string, error) {
	bin := findTmuxPath()
	if bin == "" {
		return "", fmt.Errorf("tmux not found")
	}
	// A wedged tmux server must not hang the caller forever
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, bin, args...).Output()
	if err != nil {
		if exitErr, ok := err.(*exec.ExitError); ok {
			return "", fmt.Errorf("tmux %s: %s", args[0], strings.TrimSpace(string(exitErr.Stderr)))
		}
		return "", err
	}
	return strings.TrimRight(string(out), "\n"), nil
}

// TmuxSession describes one tmux session shown as a virtual dashboard terminal
type TmuxSession struct {
	Name string
	Path string
}

// splitTmuxFields splits a line of `-F` output on the \x1f field separator.
// tmux 3.4+ octal-escapes non-printable characters in format output, so the
// separator arrives as the literal text `\037` there — unambiguously, since a
// real backslash in the data would itself have been escaped as `\134`.
func splitTmuxFields(line string, n int) []string {
	if strings.Contains(line, "\x1f") {
		return strings.SplitN(line, "\x1f", n)
	}
	return strings.SplitN(line, `\037`, n)
}

func listTmuxSessions() []TmuxSession {
	out, err := tmuxExec("list-sessions", "-F", "#{session_name}\x1f#{session_path}")
	if err != nil {
		// "no server running" is the normal empty state
		logging.Debug("tmux list-sessions", "error", err)
		return nil
	}
	var sessions []TmuxSession
	for _, line := range strings.Split(out, "\n") {
		if line == "" {
			continue
		}
		parts := splitTmuxFields(line, 2)
		s := TmuxSession{Name: parts[0]}
		if len(parts) > 1 {
			s.Path = parts[1]
		}
		sessions = append(sessions, s)
	}
	return sessions
}

// ListSessions returns every tmux session (name + working path) — the
// agent-facing view of running terminals
func ListSessions() []TmuxSession {
	return listTmuxSessions()
}

// SessionExists reports whether a tmux session with this exact name exists
func SessionExists(name string) bool {
	return tmuxHasSession(name)
}

// WriteSessionText types text into a session (optionally pressing Enter)
func WriteSessionText(name, text string, pressEnter bool) error {
	return writeTmuxText(name, text, pressEnter)
}

// KillSession terminates a tmux session
func KillSession(name string) error {
	_, err := tmuxExec("kill-session", "-t", "="+name)
	return err
}

// CaptureSessionText returns the last `lines` of a session as plain text
// (screen + scrollback, no styling — meant for agents reading output). -J
// re-joins lines the pane wrapped at its width, so a reader gets the logical
// lines the program printed rather than a break in the middle of a word.
func CaptureSessionText(name string, lines int) (string, error) {
	if lines <= 0 {
		lines = 200
	}
	out, err := tmuxExec("capture-pane", "-p", "-J", "-t", tmuxPaneTarget(name), "-S", fmt.Sprintf("-%d", lines))
	if err != nil {
		return "", err
	}
	return strings.TrimRight(out, "\n"), nil
}

// tmuxHostClient returns the tty and currently displayed session of the first
// attached regular client; our own control-mode watcher clients are skipped
func tmuxHostClient() (tty string, activeSession string) {
	out, err := tmuxExec("list-clients", "-F", "#{client_control_mode}\x1f#{client_tty}\x1f#{client_session}")
	if err != nil || out == "" {
		return "", ""
	}
	for _, line := range strings.Split(out, "\n") {
		parts := splitTmuxFields(line, 3)
		if len(parts) < 3 || parts[0] == "1" {
			continue
		}
		return parts[1], parts[2]
	}
	return "", ""
}

func tmuxHasSession(name string) bool {
	_, err := tmuxExec("has-session", "-t", "="+name)
	return err == nil
}

// tmuxPaneTarget builds the target for pane-level commands (send-keys, capture-pane,
// display-message): "=name" alone only resolves for session-level commands
func tmuxPaneTarget(name string) string { return "=" + name + ":" }

var tmuxKeyNames = map[string]string{
	"ctrl-c":    "C-c",
	"ctrl-d":    "C-d",
	"ctrl-z":    "C-z",
	"ctrl-l":    "C-l",
	"ctrl-a":    "C-a",
	"ctrl-e":    "C-e",
	"ctrl-u":    "C-u",
	"ctrl-k":    "C-k",
	"ctrl-r":    "C-r",
	"ctrl-v":    "C-v",
	"tab":       "Tab",
	"shift-tab": "BTab",
	"backspace": "BSpace",
	"esc":       "Escape",
	"up":        "Up",
	"down":      "Down",
	"left":      "Left",
	"right":     "Right",
	"enter":     "Enter",
}

// tmuxPasteText stages the text in a tmux buffer (load-buffer reads stdin, so
// no command-line quoting touches the payload) and pastes it with -p, which
// wraps it in bracketed-paste markers when the program asked for them.
func (c *Controller) tmuxPasteText(name, text string) error {
	bin := findTmuxPath()
	if bin == "" {
		return fmt.Errorf("tmux not found")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	load := exec.CommandContext(ctx, bin, "load-buffer", "-b", "cyberlife-paste", "-")
	load.Stdin = strings.NewReader(text)
	if out, err := load.CombinedOutput(); err != nil {
		return fmt.Errorf("tmux load-buffer: %s", strings.TrimSpace(string(out)))
	}
	target := tmuxPaneTarget(name)
	if c.tmuxControlCommand("paste-buffer -p -d -b cyberlife-paste -t " + tmuxQuote(target)) {
		return nil
	}
	_, err := tmuxExec("paste-buffer", "-p", "-d", "-b", "cyberlife-paste", "-t", target)
	return err
}

func writeTmuxText(name, text string, pressEnter bool) error {
	target := tmuxPaneTarget(name)
	if text != "" {
		if _, err := tmuxExec("send-keys", "-t", target, "-l", "--", text); err != nil {
			return err
		}
	}
	if pressEnter {
		if _, err := tmuxExec("send-keys", "-t", target, "Enter"); err != nil {
			return err
		}
	}
	return nil
}

// SetTmuxMode toggles single-window tmux mode for Claude sessions
func (c *Controller) SetTmuxMode(enabled bool) {
	c.mu.Lock()
	c.tmuxMode = enabled
	c.mu.Unlock()
}

// IsTmuxMode returns whether Claude sessions run inside tmux
func (c *Controller) IsTmuxMode() bool {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.tmuxMode
}

// ensureTmuxSession creates a detached tmux session running the runner
// command if it doesn't exist yet
func (c *Controller) ensureTmuxSession(name, workingDir string, env map[string]string, runnerCmd string) error {
	if tmuxHasSession(name) {
		return nil
	}
	shell := os.Getenv("SHELL")
	if shell == "" {
		shell = "/bin/zsh"
	}
	// Interactive (-i) as well as login: PATH entries for CLI runners typically
	// live in .zshrc, which a non-interactive shell never sources. A fresh tmux
	// server inherits the .app bundle's minimal environment, so -lc alone exits
	// with 127.
	// runnerCmd already carries shell quoting around its arguments, so it must
	// be passed as its own argv element — wrapping it in another quoted string
	// would let a quote inside a prompt break out and execute. tmux execs argv
	// directly, so the shell replaces the pane process without an `exec` builtin.
	inner := []string{shell, "-lic", runnerCmd}
	cols, rows := c.sessionGridSize()
	// history-limit must be in place before the pane exists (it's fixed at pane
	// creation) and a bare set-option won't start the server, hence one command
	// sequence: set the option, then create the session at the dashboard's
	// character grid so a fullscreen TUI never paints at 80x24 / 200x50 and
	// wraps when the real size arrives.
	args := []string{"set-option", "-g", "history-limit", "50000", ";",
		"new-session", "-d",
		"-x", strconv.Itoa(cols), "-y", strconv.Itoa(rows),
		"-s", name, "-c", workingDir}
	for k, v := range env {
		args = append(args, "-e", k+"="+v)
	}
	// Claude Code 2.1+ defaults to a fullscreen TUI on the alternate screen,
	// where tmux accumulates no history — the dashboard's scrollback viewer
	// (capture-pane -S) then has nothing to show. Force the inline renderer.
	if _, ok := env["CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN"]; !ok {
		args = append(args, "-e", "CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1")
	}
	args = append(args, inner...)
	if _, err := tmuxExec(args...); err != nil {
		return err
	}
	if err := waitTmuxSessionAlive(name); err != nil {
		return err
	}
	logging.Info("Created tmux session", "name", name, "workingDir", logging.MaskPath(workingDir))
	return nil
}

// waitTmuxSessionAlive catches a session whose command exits immediately (bad PATH,
// missing binary): tmux reports new-session as successful, then tears the session down
func waitTmuxSessionAlive(name string) error {
	deadline := time.Now().Add(600 * time.Millisecond)
	for time.Now().Before(deadline) {
		time.Sleep(150 * time.Millisecond)
		if !tmuxHasSession(name) {
			return fmt.Errorf("tmux session %q exited immediately — the runner command likely failed to start", name)
		}
	}
	return nil
}

// liveTmuxHost returns the attached client's tty plus the iTerm session hosting it.
// A client whose tty no longer maps to an iTerm session (window closed, client attached
// from another terminal app) counts as no host at all.
func (c *Controller) liveTmuxHost() (tty, hostID, activeSession string) {
	tty, activeSession = tmuxHostClient()
	if tty == "" {
		return "", "", ""
	}
	hostID = c.hostSessionIDForTTY(tty)
	if hostID == "" {
		return "", "", ""
	}
	return tty, hostID, activeSession
}

// showTmuxSession switches an attached iTerm host (if any) to the session.
// Watching no longer needs a host — content streams via control mode — so a
// missing host is fine; OpenTmuxInITerm creates one on explicit request.
func (c *Controller) showTmuxSession(name string) error {
	tty, hostID, active := c.liveTmuxHost()
	if tty == "" {
		return nil
	}
	if active != name {
		if _, err := tmuxExec("switch-client", "-c", tty, "-t", "="+name); err != nil {
			return err
		}
	}
	if err := c.SwitchTabBySessionID(hostID); err != nil {
		logging.Debug("tmux host tab select failed", "error", err)
	}
	return nil
}

// OpenTmuxInITerm shows the session in the iTerm host tab, creating the host
// (and an iTerm window) when none exists — the explicit "open in iTerm" action
func (c *Controller) OpenTmuxInITerm(name string) error {
	if tty, _, _ := c.liveTmuxHost(); tty != "" {
		return c.showTmuxSession(name)
	}
	return c.createTmuxHostTab(name)
}

// createTmuxHostTab opens the single iTerm2 tab that hosts the attached tmux client,
// launching iTerm2 and a window first when none is open
func (c *Controller) createTmuxHostTab(name string) error {
	safeName := strings.ReplaceAll(name, "'", "")
	tmuxBin := findTmuxPath()
	if tmuxBin == "" {
		return fmt.Errorf("tmux not found")
	}
	// No exec: a failed attach leaves the error on screen instead of closing the tab,
	// and detaching drops back to a shell rather than killing the window
	attachCmd := fmt.Sprintf("clear && '%s' attach-session -t '=%s'", tmuxBin, safeName)
	script := fmt.Sprintf(`
tell application "iTerm2"
	if (count of windows) is 0 then
		activate
		set hostWindow to (create window with default profile)
	else
		set hostWindow to current window
		tell hostWindow to create tab with default profile
	end if
	tell current session of hostWindow
		set name to "tmux"
		write text "%s"
	end tell
end tell
`, attachCmd)
	if _, err := c.runAppleScript(script); err != nil {
		logging.Error("Failed to create tmux host tab", "error", err)
		return err
	}
	c.tmuxMu.Lock()
	c.tmuxHostTTY = ""
	c.tmuxHostSessionID = ""
	c.tmuxMu.Unlock()

	if err := c.waitTmuxHostAttached(); err != nil {
		logging.Warn("tmux host tab created but no client attached", "session", name, "error", err)
		return err
	}
	logging.Info("Created tmux host tab", "session", name)
	return nil
}

// waitTmuxHostAttached blocks until the freshly opened tab has attached its tmux client,
// so callers can immediately switch and watch the session
func (c *Controller) waitTmuxHostAttached() error {
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		time.Sleep(200 * time.Millisecond)
		if tty, _, _ := c.liveTmuxHost(); tty != "" {
			return nil
		}
	}
	return fmt.Errorf("tmux client did not attach within 5s")
}

// hostSessionIDForTTY finds the iTerm session whose tty hosts the tmux client (cached)
func (c *Controller) hostSessionIDForTTY(tty string) string {
	c.tmuxMu.Lock()
	if c.tmuxHostTTY == tty && c.tmuxHostSessionID != "" {
		id := c.tmuxHostSessionID
		c.tmuxMu.Unlock()
		return id
	}
	c.tmuxMu.Unlock()

	script := fmt.Sprintf(`
tell application "iTerm2"
	repeat with w in windows
		repeat with t in tabs of w
			set sess to current session of t
			if tty of sess is "%s" then
				return id of sess
			end if
		end repeat
	end repeat
	return ""
end tell
`, tty)
	out, err := c.runAppleScript(script)
	if err != nil || strings.TrimSpace(out) == "" {
		logging.Debug("iTerm session lookup by tty failed", "tty", tty, "error", err)
		return ""
	}
	id := strings.TrimSpace(out)
	c.tmuxMu.Lock()
	c.tmuxHostTTY = tty
	c.tmuxHostSessionID = id
	c.tmuxMu.Unlock()
	return id
}

// augmentStatusWithTmux hides the host tab and appends tmux sessions as virtual tabs
func (c *Controller) augmentStatusWithTmux(status *ITermStatus) {
	sessions := listTmuxSessions()
	_, hostID, active := c.liveTmuxHost()

	hostWindow, hostTab := 0, 0
	tabs := make([]ITermTab, 0, len(status.Tabs)+len(sessions))
	for _, t := range status.Tabs {
		if hostID != "" && t.SessionID == hostID {
			hostWindow, hostTab = t.WindowID, t.TabIndex
			continue
		}
		tabs = append(tabs, t)
	}
	for _, s := range sessions {
		tabs = append(tabs, ITermTab{
			WindowID:  hostWindow,
			TabIndex:  hostTab,
			SessionID: tmuxIDPrefix + s.Name,
			Name:      s.Name,
			Path:      s.Path,
			IsActive:  s.Name == active,
		})
	}
	status.Tabs = tabs
}

// startTmuxWatching streams a virtual tmux session directly: control-mode
// notifications trigger styled capture-pane grabs, no iTerm or bridge involved
func (c *Controller) startTmuxWatching(
	virtualID string,
	styledHandler func(*StyledContent),
	profileHandler func(*ProfileData),
) error {
	name := tmuxNameFromID(virtualID)
	c.stopTmuxPolling()

	profileHandler(&ProfileData{SessionID: virtualID, Colors: defaultTmuxColors})

	if err := c.startTmuxControlWatch(virtualID, name, styledHandler); err != nil {
		logging.Warn("tmux control mode unavailable, falling back to polling", "session", name, "error", err)
		c.startTmuxPolling(virtualID, name, styledHandler)
	}
	return nil
}

func (c *Controller) startTmuxPolling(virtualID, name string, styledHandler func(*StyledContent)) {
	c.tmuxMu.Lock()
	c.tmuxPollStop = make(chan struct{})
	stopCh := c.tmuxPollStop
	c.tmuxPollHash = ""
	c.tmuxMu.Unlock()

	go func() {
		c.pollTmuxContent(virtualID, name, styledHandler)
		ticker := time.NewTicker(700 * time.Millisecond)
		defer ticker.Stop()
		for {
			select {
			case <-ticker.C:
				c.pollTmuxContent(virtualID, name, styledHandler)
			case <-stopCh:
				return
			}
		}
	}()
	logging.Info("tmux content polling started", "session", name)
}

func (c *Controller) pollTmuxContent(virtualID, name string, styledHandler func(*StyledContent)) {
	if content := c.captureStyledTmuxScreen(virtualID, name); content != nil {
		styledHandler(content)
	}
}

// stopTmuxPolling stops both tmux watch mechanisms: the control-mode watcher
// and the plain polling fallback
func (c *Controller) stopTmuxPolling() {
	c.tmuxMu.Lock()
	watcher := c.tmuxControl
	c.tmuxControl = nil
	if c.tmuxPollStop != nil {
		close(c.tmuxPollStop)
		c.tmuxPollStop = nil
	}
	c.tmuxPollHash = ""
	c.tmuxMu.Unlock()

	if watcher != nil {
		watcher.close()
	}
}

// tmuxHistory returns scrollback (excluding the visible screen) as styled
// lines, plus the scrollback size so callers can tell when it has grown
func tmuxHistory(name string) ([][]StyledRun, int) {
	size, err := tmuxExec("display-message", "-p", "-t", tmuxPaneTarget(name), "#{history_size}")
	if err != nil {
		return [][]StyledRun{}, 0
	}
	n, convErr := strconv.Atoi(strings.TrimSpace(size))
	if convErr != nil || n <= 0 {
		return [][]StyledRun{}, 0
	}
	out, err := tmuxExec("capture-pane", "-p", "-e", "-t", tmuxPaneTarget(name), "-S", "-10000", "-E", "-1")
	if err != nil {
		return [][]StyledRun{}, 0
	}
	return parseStyledScreen(out), n
}
