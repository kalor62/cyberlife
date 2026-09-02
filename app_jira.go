package main

import (
	"fmt"
	"strings"

	"github.com/kalor62/cyberlife/internal/jira"
	"github.com/kalor62/cyberlife/internal/logging"
	"github.com/kalor62/cyberlife/internal/state"
	"github.com/wailsapp/wails/v2/pkg/runtime"
)

// GetJiraSettings returns the Jira integration settings
func (a *App) GetJiraSettings() state.JiraSettings {
	if a.stateManager == nil {
		return state.JiraSettings{}
	}
	return a.stateManager.GetJiraSettings()
}

// SetJiraSettings saves the Jira integration settings
func (a *App) SetJiraSettings(s state.JiraSettings) {
	if a.stateManager != nil {
		a.stateManager.SetJiraSettings(s)
	}
}

// TestJiraConnection verifies the given Jira credentials and returns the account's display name
func (a *App) TestJiraConnection(s state.JiraSettings) (string, error) {
	return jira.TestConnection(s.BaseURL, s.Email, s.APIToken)
}

func jiraPriorityToLocal(p string) string {
	switch strings.ToLower(p) {
	case "highest", "high", "critical", "blocker":
		return "high"
	case "medium":
		return "medium"
	case "low", "lowest", "minor", "trivial":
		return "low"
	}
	return ""
}

// jiraColumnFor maps a Jira status onto a board column: exact name match wins,
// otherwise the status category picks first (new), middle (in progress) or
// last (done) column.
func jiraColumnFor(columns []state.KanbanColumn, status, category string) string {
	for _, c := range columns {
		if strings.EqualFold(c.Name, status) {
			return c.ID
		}
	}
	switch category {
	case "done":
		return columns[len(columns)-1].ID
	case "indeterminate":
		if len(columns) > 2 {
			return columns[1].ID
		}
		return columns[0].ID
	default:
		return columns[0].ID
	}
}

// SetProjectJira binds a project's board to a Jira project key
func (a *App) SetProjectJira(projectID, jiraProject, jiraFilter string) error {
	if a.stateManager == nil {
		return fmt.Errorf("state manager not initialized")
	}
	if !a.addonOn("jira") {
		return fmt.Errorf("jira addon is disabled (Settings → Addons)")
	}
	return a.stateManager.SetProjectJira(projectID,
		strings.ToUpper(strings.TrimSpace(jiraProject)), strings.TrimSpace(jiraFilter))
}

// SyncJiraBoard pulls the mapped Jira project's issues onto the board
func (a *App) SyncJiraBoard(projectID string) (JiraSyncResult, error) {
	if a.stateManager == nil {
		return JiraSyncResult{}, fmt.Errorf("state manager not initialized")
	}
	if !a.addonOn("jira") {
		return JiraSyncResult{}, fmt.Errorf("jira addon is disabled (Settings → Addons)")
	}
	settings := a.stateManager.GetJiraSettings()
	if !settings.Enabled {
		return JiraSyncResult{}, fmt.Errorf("jira integration is disabled — enable it in Settings → Jira")
	}
	project, ok := a.stateManager.ResolveProject(projectID)
	if !ok {
		return JiraSyncResult{}, fmt.Errorf("project not found")
	}
	if project.JiraProject == "" {
		return JiraSyncResult{}, fmt.Errorf("no Jira project mapped for this board")
	}

	columns, _, err := a.stateManager.GetKanban(project.ID)
	if err != nil {
		return JiraSyncResult{}, err
	}
	if len(columns) == 0 {
		return JiraSyncResult{}, fmt.Errorf("board has no columns")
	}

	// Open issues plus anything that changed recently (to move cards to Done),
	// narrowed by the board's own filter when one is set
	jql := fmt.Sprintf("project = %s AND (statusCategory != Done OR updated >= -7d)", project.JiraProject)
	if f := strings.TrimSpace(project.JiraFilter); f != "" {
		jql += " AND (" + f + ")"
	}
	jql += " ORDER BY updated DESC"
	issues, err := jira.SearchIssues(settings.BaseURL, settings.Email, settings.APIToken, jql, 100)
	if err != nil {
		return JiraSyncResult{}, err
	}

	items := make([]state.JiraSyncItem, 0, len(issues))
	for _, issue := range issues {
		items = append(items, state.JiraSyncItem{
			Key:      issue.Key,
			Title:    issue.Summary,
			Priority: jiraPriorityToLocal(issue.Priority),
			ColumnID: jiraColumnFor(columns, issue.Status, issue.StatusCategory),
		})
	}

	created, updated, err := a.stateManager.ApplyJiraSync(project.ID, items)
	if err != nil {
		return JiraSyncResult{}, err
	}
	if created > 0 || updated > 0 {
		runtime.EventsEmit(a.ctx, "kanban-changed", project.ID)
	}
	logging.Info("Jira board synced", "project", project.Name, "jira", project.JiraProject,
		"issues", len(issues), "created", created, "updated", updated)
	return JiraSyncResult{Created: created, Updated: updated, Total: len(issues), Project: project.JiraProject}, nil
}

// pushJiraTransition moves the Jira issue when a jira-backed card changes
// column locally; best effort — a missing matching transition just logs
func (a *App) pushJiraTransition(projectID, taskID, columnID string) {
	if a.stateManager == nil {
		return
	}
	settings := a.stateManager.GetJiraSettings()
	if !settings.Enabled {
		return
	}
	columns, tasks, err := a.stateManager.GetKanban(projectID)
	if err != nil {
		return
	}
	var jiraKey string
	for _, t := range tasks {
		if t.ID == taskID {
			jiraKey = t.JiraKey
			break
		}
	}
	if jiraKey == "" {
		return
	}
	var columnName string
	for _, c := range columns {
		if c.ID == columnID {
			columnName = c.Name
			break
		}
	}
	if columnName == "" {
		return
	}

	transitions, err := jira.ListTransitions(settings.BaseURL, settings.Email, settings.APIToken, jiraKey)
	if err != nil {
		logging.Warn("jira: transitions fetch failed", "key", jiraKey, "error", err)
		return
	}
	for _, t := range transitions {
		if strings.EqualFold(t.ToName, columnName) || strings.EqualFold(t.Name, columnName) {
			if err := jira.DoTransition(settings.BaseURL, settings.Email, settings.APIToken, jiraKey, t.ID); err != nil {
				logging.Warn("jira: transition failed", "key", jiraKey, "to", columnName, "error", err)
			} else {
				logging.Info("jira: issue transitioned", "key", jiraKey, "to", columnName)
			}
			return
		}
	}
	logging.Debug("jira: no matching transition", "key", jiraKey, "column", columnName)
}
