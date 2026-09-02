package main

import (
	"fmt"
	"strings"
	"time"

	"github.com/kalor62/cyberlife/internal/gmail"
	"github.com/kalor62/cyberlife/internal/iterm"
	"github.com/kalor62/cyberlife/internal/logging"
	"github.com/kalor62/cyberlife/internal/state"
	"github.com/wailsapp/wails/v2/pkg/runtime"
)

// automationRunAgent launches a runner session with the prompt passed as the
// CLI argument (no fragile boot-wait + send-keys); returns the tmux session id
func (a *App) automationRunAgent(workDir, tabName, runnerID, prompt string) (string, error) {
	if a.itermController == nil || a.stateManager == nil {
		return "", fmt.Errorf("app not fully initialized")
	}
	if runnerID == "" {
		runnerID = a.stateManager.ResolveDefaultRunnerForPath(workDir)
	}
	runner := a.stateManager.GetRunner(runnerID)
	command := strings.TrimSpace(runner.Command)
	if runner.Args != "" {
		command += " " + runner.Args
	}
	if strings.TrimSpace(prompt) != "" {
		command += " " + shellQuote(prompt)
	}
	env := map[string]string{}
	for k, v := range runner.Env {
		env[k] = v
	}
	name := fmt.Sprintf("%s %s", tabName, time.Now().Format("0102-150405"))
	if err := a.itermController.CreateTabWithCommand(workDir, name, env, command); err != nil {
		return "", err
	}
	return iterm.SessionNameFor(name), nil
}

func (a *App) automationComment(projectID, taskID, author, text string) error {
	if _, err := a.stateManager.AddKanbanComment(projectID, taskID, author, text); err != nil {
		return err
	}
	runtime.EventsEmit(a.ctx, "kanban-changed", projectID)
	return nil
}

func (a *App) automationSendMail(account, to, subject, body string) error {
	settings := a.stateManager.GetGmailSettings()
	if !settings.Enabled || len(settings.Accounts) == 0 {
		return fmt.Errorf("no Gmail account linked")
	}
	if account == "" {
		account = settings.Accounts[0].Email
	}
	svc, err := a.gmailService(account)
	if err != nil {
		return err
	}
	return gmail.SendMessage(svc, to, subject, body, "", nil)
}

// pollMailForAutomations feeds new inbox threads into mail-triggered rules.
// The first pass per account only primes the seen-set so rules created later
// don't fire on the whole existing inbox.
func (a *App) pollMailForAutomations() {
	seen := map[string]map[string]bool{}
	ticker := time.NewTicker(2 * time.Minute)
	defer ticker.Stop()
	for {
		select {
		case <-a.stopBackground:
			return
		case <-ticker.C:
		}
		if a.automationEngine == nil || a.stateManager == nil || !a.automationEngine.HasMailRules() {
			continue
		}
		settings := a.stateManager.GetGmailSettings()
		if !settings.Enabled || !a.addonOn("gmail") {
			continue
		}
		for _, acc := range settings.Accounts {
			svc, err := a.gmailService(acc.Email)
			if err != nil {
				logging.Warn("automations: gmail service unavailable", "account", acc.Email, "error", err)
				continue
			}
			page, err := gmail.ListThreads(svc, "INBOX", "newer_than:2d", "")
			if err != nil {
				logging.Warn("automations: inbox poll failed", "account", acc.Email, "error", err)
				continue
			}
			known, primed := seen[acc.Email]
			if !primed {
				known = map[string]bool{}
				seen[acc.Email] = known
			}
			for _, t := range page.Threads {
				if known[t.ID] {
					continue
				}
				known[t.ID] = true
				if primed {
					a.automationEngine.MailReceived(acc.Email, t.ID, t.From, t.Subject)
				}
			}
		}
	}
}

func (a *App) GetAutomationRules() []state.AutomationRule {
	if a.stateManager == nil {
		return nil
	}
	return a.stateManager.GetAutomationRules()
}

func (a *App) SaveAutomationRule(rule state.AutomationRule) (state.AutomationRule, error) {
	if a.stateManager == nil {
		return state.AutomationRule{}, fmt.Errorf("state manager not initialized")
	}
	return a.stateManager.SaveAutomationRule(rule)
}

func (a *App) DeleteAutomationRule(id string) error {
	if a.stateManager == nil {
		return fmt.Errorf("state manager not initialized")
	}
	return a.stateManager.DeleteAutomationRule(id)
}

func (a *App) SetAutomationRuleEnabled(id string, enabled bool) error {
	if a.stateManager == nil {
		return fmt.Errorf("state manager not initialized")
	}
	return a.stateManager.SetAutomationRuleEnabled(id, enabled)
}

func (a *App) RunAutomationRule(id string) (state.AutomationRun, error) {
	if a.automationEngine == nil {
		return state.AutomationRun{}, fmt.Errorf("automation engine not initialized")
	}
	return a.automationEngine.RunNow(id)
}

func (a *App) GetAutomationRuns(limit int) []state.AutomationRun {
	if a.stateManager == nil {
		return nil
	}
	return a.stateManager.GetAutomationRuns(limit)
}
