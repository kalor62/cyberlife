package main

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/kalor62/cyberlife/internal/gmail"
	"github.com/kalor62/cyberlife/internal/logging"
	"github.com/kalor62/cyberlife/internal/paths"
	"github.com/kalor62/cyberlife/internal/platform"
	"github.com/wailsapp/wails/v2/pkg/runtime"
	gmailapi "google.golang.org/api/gmail/v1"
)

// GetGmailConfig returns Gmail settings with account emails (tokens stay backend-side)
func (a *App) GetGmailConfig() GmailConfig {
	if a.stateManager == nil {
		return GmailConfig{}
	}
	settings := a.stateManager.GetGmailSettings()
	cfg := GmailConfig{
		Enabled:      settings.Enabled,
		McpEnabled:   settings.McpEnabled,
		ClientID:     settings.ClientID,
		ClientSecret: settings.ClientSecret,
		Accounts:     []GmailAccountInfo{},
	}
	for _, acc := range settings.Accounts {
		cfg.Accounts = append(cfg.Accounts, GmailAccountInfo{Email: acc.Email, McpEnabled: acc.McpEnabled})
	}
	return cfg
}

// GmailSetAccountMcp toggles MCP exposure for one account
func (a *App) GmailSetAccountMcp(email string, enabled bool) {
	if a.stateManager != nil {
		a.stateManager.SetGmailAccountMcp(email, enabled)
	}
}

func findGmailMcpScript() string {
	execPath, err := os.Executable()
	if err != nil {
		return ""
	}
	baseDir := filepath.Dir(execPath)
	candidates := []string{
		filepath.Join(baseDir, "..", "..", "..", "..", "..", "mcp-gmail", "dist", "index.js"),
		filepath.Join(baseDir, "..", "..", "mcp-gmail", "dist", "index.js"),
		filepath.Join(baseDir, "mcp-gmail", "dist", "index.js"),
	}
	for _, c := range candidates {
		if abs, err := filepath.Abs(c); err == nil {
			if _, err := os.Stat(abs); err == nil {
				return abs
			}
		}
	}
	return ""
}

// GmailMcpInstalled reports whether the built-in Gmail MCP is registered in Claude Code
func (a *App) GmailMcpInstalled() bool {
	home, err := os.UserHomeDir()
	if err != nil {
		return false
	}
	data, err := os.ReadFile(filepath.Join(home, ".claude.json"))
	if err != nil {
		return false
	}
	var cfg struct {
		McpServers map[string]json.RawMessage `json:"mcpServers"`
	}
	if err := json.Unmarshal(data, &cfg); err != nil {
		return false
	}
	_, ok := cfg.McpServers["gmail"]
	return ok
}

// GmailInstallMcp registers the built-in Gmail MCP server in Claude Code (user scope)
func (a *App) GmailInstallMcp() (string, error) {
	script := findGmailMcpScript()
	if script == "" {
		return "", fmt.Errorf("mcp-gmail/dist/index.js not found — run 'npm install && npm run build' in mcp-gmail/")
	}
	cli := findClaudeCLI()
	if cli == "" {
		return "", fmt.Errorf("claude CLI not found in PATH")
	}
	// Re-register idempotently
	_ = exec.Command(cli, "mcp", "remove", "--scope", "user", "gmail").Run()
	out, err := exec.Command(cli, "mcp", "add", "--scope", "user", "gmail", "--", "node", script).CombinedOutput()
	if err != nil {
		return "", fmt.Errorf("claude mcp add failed: %s", strings.TrimSpace(string(out)))
	}
	logging.Info("Gmail MCP registered in Claude Code", "script", logging.MaskPath(script))
	return script, nil
}

// SetGmailConfig saves enabled state and OAuth client credentials
func (a *App) SetGmailConfig(enabled bool, clientID, clientSecret string) {
	if a.stateManager == nil {
		return
	}
	a.stateManager.SetGmailConfig(enabled, clientID, clientSecret)
	a.syncAgentSkills()
}

// SetGmailMcpEnabled toggles the Claude MCP integration in the email view
func (a *App) SetGmailMcpEnabled(enabled bool) {
	if a.stateManager != nil {
		a.stateManager.SetGmailMcpEnabled(enabled)
	}
}

// GmailListThreadDrafts returns drafts belonging to a thread
func (a *App) GmailListThreadDrafts(account, threadID string) ([]gmail.DraftInfo, error) {
	svc, err := a.gmailService(account)
	if err != nil {
		return nil, err
	}
	return gmail.ListThreadDrafts(svc, threadID)
}

// GmailUpdateDraft replaces a draft's recipient, subject and body
func (a *App) GmailUpdateDraft(account, draftID, to, subject, body, signatureHTML string, attachments []string) error {
	svc, err := a.gmailService(account)
	if err != nil {
		return err
	}
	return gmail.UpdateDraft(svc, draftID, to, subject, body, signatureHTML, attachments)
}

// GmailCreateDraft creates a standalone draft and returns its id
func (a *App) GmailCreateDraft(account, to, subject, body, signatureHTML string, attachments []string) (string, error) {
	svc, err := a.gmailService(account)
	if err != nil {
		return "", err
	}
	return gmail.CreateDraft(svc, to, subject, body, signatureHTML, attachments)
}

// GmailSendMessage sends a new message immediately
func (a *App) GmailSendMessage(account, to, subject, body, signatureHTML string, attachments []string) error {
	svc, err := a.gmailService(account)
	if err != nil {
		return err
	}
	return gmail.SendMessage(svc, to, subject, body, signatureHTML, attachments)
}

// AddonSendEmail sends a message on behalf of an addon: attachments are
// BLOB-STORE KEYS (addon-data/<addonId>/…), never arbitrary paths, so an
// addon cannot exfiltrate files outside its own storage. Empty account
// uses the first configured Gmail account.
func (a *App) AddonSendEmail(addonID, account, to, cc, subject, body string, attachmentKeys []string) error {
	if account == "" {
		if a.stateManager == nil {
			return fmt.Errorf("state not ready")
		}
		accounts := a.stateManager.GetGmailSettings().Accounts
		if len(accounts) == 0 {
			return fmt.Errorf("no Gmail account configured (Settings → Mail)")
		}
		account = accounts[0].Email
	}
	root, err := paths.AddonData()
	if err != nil {
		return err
	}
	attachments := make([]string, 0, len(attachmentKeys))
	for _, key := range attachmentKeys {
		clean := filepath.Clean("/" + filepath.ToSlash(key))
		if strings.Contains(clean, "..") {
			return fmt.Errorf("invalid attachment key %q", key)
		}
		full := filepath.Join(root, filepath.Base(addonID), filepath.FromSlash(clean))
		if _, err := os.Stat(full); err != nil {
			return fmt.Errorf("attachment %q not found in the addon store", key)
		}
		attachments = append(attachments, full)
	}
	svc, err := a.gmailService(account)
	if err != nil {
		return err
	}
	return gmail.SendMessageCc(svc, to, cc, subject, body, "", attachments)
}

// GmailGetSignature returns the account's default Gmail signature (HTML)
func (a *App) GmailGetSignature(account string) (string, error) {
	svc, err := a.gmailService(account)
	if err != nil {
		return "", err
	}
	return gmail.GetSignature(svc)
}

// GmailListContacts returns frequent correspondents for compose autocomplete (cached)
func (a *App) GmailListContacts(account string) ([]gmail.Contact, error) {
	a.mu.RLock()
	cached, ok := a.gmailContacts[account]
	a.mu.RUnlock()
	if ok && time.Since(cached.fetched) < time.Hour {
		return cached.contacts, nil
	}
	svc, err := a.gmailService(account)
	if err != nil {
		return nil, err
	}
	contacts, err := gmail.ListContacts(svc)
	if err != nil {
		return nil, err
	}
	a.mu.Lock()
	if a.gmailContacts == nil {
		a.gmailContacts = map[string]gmailContactsCache{}
	}
	a.gmailContacts[account] = gmailContactsCache{contacts: contacts, fetched: time.Now()}
	a.mu.Unlock()
	return contacts, nil
}

// GmailPickAttachments opens the native file picker for compose attachments
func (a *App) GmailPickAttachments() ([]string, error) {
	paths, err := runtime.OpenMultipleFilesDialog(a.ctx, runtime.OpenDialogOptions{Title: "Attach files"})
	if err != nil {
		return nil, err
	}
	return paths, nil
}

// GmailSendDraft sends a draft
func (a *App) GmailSendDraft(account, draftID string) error {
	svc, err := a.gmailService(account)
	if err != nil {
		return err
	}
	return gmail.SendDraft(svc, draftID)
}

// GmailDeleteDraft discards a draft
func (a *App) GmailDeleteDraft(account, draftID string) error {
	svc, err := a.gmailService(account)
	if err != nil {
		return err
	}
	return gmail.DeleteDraft(svc, draftID)
}

// GmailAddAccount runs the OAuth flow with the given credentials and stores the
// account together with them — each mailbox can use its own Google Cloud project
func (a *App) GmailAddAccount(clientID, clientSecret string) (string, error) {
	if a.gmailManager == nil || a.stateManager == nil {
		return "", fmt.Errorf("gmail manager not initialized")
	}
	clientID = strings.TrimSpace(clientID)
	clientSecret = strings.TrimSpace(clientSecret)
	email, tokenJSON, err := a.gmailManager.Authorize(a.ctx, clientID, clientSecret)
	if err != nil {
		return "", err
	}
	a.stateManager.AddGmailAccount(email, tokenJSON, clientID, clientSecret)
	return email, nil
}

// GmailReauthAccount re-runs the OAuth flow for an existing account. Credentials
// priority: explicitly passed → stored on the account → global defaults.
func (a *App) GmailReauthAccount(email, clientID, clientSecret string) (string, error) {
	if a.gmailManager == nil || a.stateManager == nil {
		return "", fmt.Errorf("gmail manager not initialized")
	}
	clientID = strings.TrimSpace(clientID)
	clientSecret = strings.TrimSpace(clientSecret)
	settings := a.stateManager.GetGmailSettings()
	if clientID == "" {
		for _, acc := range settings.Accounts {
			if acc.Email == email {
				clientID, clientSecret = acc.ClientID, acc.ClientSecret
				break
			}
		}
	}
	if clientID == "" {
		clientID, clientSecret = settings.ClientID, settings.ClientSecret
	}
	if clientID == "" {
		return "", fmt.Errorf("no credentials known for %s — paste its Client ID/Secret in the Add account fields and retry", email)
	}
	a.gmailManager.DropService(email)
	authEmail, tokenJSON, err := a.gmailManager.Authorize(a.ctx, clientID, clientSecret)
	if err != nil {
		return "", err
	}
	a.stateManager.AddGmailAccount(authEmail, tokenJSON, clientID, clientSecret)
	a.syncAgentSkills()
	if authEmail != email {
		return authEmail, fmt.Errorf("authorized %s, but expected %s — pick the right Google account in the browser", authEmail, email)
	}
	return authEmail, nil
}

// GmailRemoveAccount forgets an authorized account
func (a *App) GmailRemoveAccount(email string) {
	if a.stateManager != nil {
		a.stateManager.RemoveGmailAccount(email)
		a.syncAgentSkills()
	}
	if a.gmailManager != nil {
		a.gmailManager.DropService(email)
	}
}

func (a *App) gmailService(account string) (*gmailapi.Service, error) {
	if a.gmailManager == nil || a.stateManager == nil {
		return nil, fmt.Errorf("gmail manager not initialized")
	}
	settings := a.stateManager.GetGmailSettings()
	for _, acc := range settings.Accounts {
		if acc.Email == account {
			clientID, clientSecret := acc.ClientID, acc.ClientSecret
			if clientID == "" {
				// Accounts added before per-account credentials used the global pair
				clientID, clientSecret = settings.ClientID, settings.ClientSecret
			}
			return a.gmailManager.Service(acc.Email, acc.TokenJSON, clientID, clientSecret)
		}
	}
	return nil, fmt.Errorf("account not found: %s", account)
}

// GmailInboxUnread returns the INBOX unread conversation count for an account
func (a *App) GmailInboxUnread(account string) (int64, error) {
	svc, err := a.gmailService(account)
	if err != nil {
		return 0, err
	}
	return gmail.GetInboxUnread(svc)
}

// GmailListLabels returns the account's labels with unread counts
func (a *App) GmailListLabels(account string) ([]gmail.Label, error) {
	svc, err := a.gmailService(account)
	if err != nil {
		return nil, err
	}
	return gmail.ListLabels(svc)
}

// GmailListThreads returns a page of thread summaries for a label or query
func (a *App) GmailListThreads(account, labelID, query, pageToken string) (*gmail.ThreadPage, error) {
	svc, err := a.gmailService(account)
	if err != nil {
		return nil, err
	}
	return gmail.ListThreads(svc, labelID, query, pageToken)
}

// GmailGetThread returns full messages of a thread (HTML bodies, attachments)
func (a *App) GmailGetThread(account, threadID string) (*gmail.ThreadDetail, error) {
	svc, err := a.gmailService(account)
	if err != nil {
		return nil, err
	}
	return gmail.GetThread(svc, threadID)
}

// GmailModifyThread adds/removes labels (read/unread, archive, star, user labels)
func (a *App) GmailModifyThread(account, threadID string, addLabels, removeLabels []string) error {
	svc, err := a.gmailService(account)
	if err != nil {
		return err
	}
	return gmail.ModifyThread(svc, threadID, addLabels, removeLabels)
}

// GmailTrashThread moves a thread to trash
func (a *App) GmailTrashThread(account, threadID string) error {
	svc, err := a.gmailService(account)
	if err != nil {
		return err
	}
	return gmail.TrashThread(svc, threadID)
}

// GmailUntrashThread restores a thread from trash
func (a *App) GmailUntrashThread(account, threadID string) error {
	svc, err := a.gmailService(account)
	if err != nil {
		return err
	}
	return gmail.UntrashThread(svc, threadID)
}

// GmailGetAttachment returns attachment bytes as base64 (for in-app preview)
func (a *App) GmailGetAttachment(account, messageID, attachmentID string) (string, error) {
	svc, err := a.gmailService(account)
	if err != nil {
		return "", err
	}
	data, err := gmail.FetchAttachment(svc, messageID, attachmentID)
	if err != nil {
		return "", err
	}
	return base64.StdEncoding.EncodeToString(data), nil
}

// GmailSaveAttachment downloads an attachment to ~/Downloads and returns the path
func (a *App) GmailSaveAttachment(account, messageID, attachmentID, filename string) (string, error) {
	svc, err := a.gmailService(account)
	if err != nil {
		return "", err
	}
	data, err := gmail.FetchAttachment(svc, messageID, attachmentID)
	if err != nil {
		return "", err
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	safeName := filepath.Base(filename)
	if safeName == "" || safeName == "." {
		safeName = "attachment"
	}
	target := filepath.Join(home, "Downloads", safeName)
	for i := 1; ; i++ {
		if _, statErr := os.Stat(target); os.IsNotExist(statErr) {
			break
		}
		ext := filepath.Ext(safeName)
		base := strings.TrimSuffix(safeName, ext)
		target = filepath.Join(home, "Downloads", fmt.Sprintf("%s-%d%s", base, i, ext))
	}
	if err := os.WriteFile(target, data, 0o644); err != nil {
		return "", err
	}
	logging.Info("Saved Gmail attachment", "path", logging.MaskPath(target))
	return target, nil
}

// GmailOpenAttachment saves to Downloads then opens with the default app
func (a *App) GmailOpenAttachment(account, messageID, attachmentID, filename string) (string, error) {
	path, err := a.GmailSaveAttachment(account, messageID, attachmentID, filename)
	if err != nil {
		return "", err
	}
	if err := platform.OpenExternal(path); err != nil {
		return path, err
	}
	return path, nil
}
