package main

import (
	"fmt"
	"strings"
	"time"

	"github.com/kalor62/cyberlife/internal/logging"
	"github.com/kalor62/cyberlife/internal/platform"
	"github.com/kalor62/cyberlife/internal/state"
	"github.com/wailsapp/wails/v2/pkg/runtime"
)

// raiseNotification is the one path every producer goes through: it records
// the entry in the notification center, shows the desktop toast and tells the
// UI to refresh the bell. A failing toast (no notifier on this platform) must
// not lose the entry, so it is only logged.
func (a *App) raiseNotification(source, title, message, link string) error {
	title = strings.TrimSpace(title)
	if title == "" {
		return fmt.Errorf("notification title is required")
	}
	if a.stateManager == nil {
		return fmt.Errorf("state manager not initialized")
	}
	a.stateManager.AddNotification(state.Notification{
		Title:   title,
		Message: strings.TrimSpace(message),
		Source:  strings.TrimSpace(source),
		Link:    strings.TrimSpace(link),
	})
	a.emitNotificationsChanged()
	if err := platform.Notify(title, message); err != nil {
		logging.Warn("desktop notification failed (entry kept in center)", "source", source, "error", err)
	}
	return nil
}

func (a *App) emitNotificationsChanged() {
	if a.ctx != nil {
		runtime.EventsEmit(a.ctx, "notifications-changed", nil)
	}
}

func (a *App) automationNotify(title, message string) error {
	return a.raiseNotification("automation", title, message, "")
}

func (a *App) GetNotifications(includeArchived bool) []state.Notification {
	if a.stateManager == nil {
		return nil
	}
	return a.stateManager.GetNotifications(includeArchived, 0)
}

func (a *App) GetUnreadNotificationCount() int {
	if a.stateManager == nil {
		return 0
	}
	return a.stateManager.UnreadNotificationCount()
}

// MarkNotificationRead with an empty id marks every non-archived entry.
func (a *App) MarkNotificationRead(id string) error {
	if a.stateManager == nil {
		return fmt.Errorf("state manager not initialized")
	}
	now := time.Now()
	a.stateManager.UpdateNotification(id, func(n *state.Notification) {
		if n.ReadAt == nil {
			t := now
			n.ReadAt = &t
		}
	})
	a.emitNotificationsChanged()
	return nil
}

func (a *App) ArchiveNotification(id string) error {
	if a.stateManager == nil {
		return fmt.Errorf("state manager not initialized")
	}
	if id == "" {
		return fmt.Errorf("notification id is required")
	}
	now := time.Now()
	if !a.stateManager.UpdateNotification(id, func(n *state.Notification) {
		t := now
		n.ArchivedAt = &t
		if n.ReadAt == nil {
			n.ReadAt = &t
		}
	}) {
		return fmt.Errorf("notification %q not found", id)
	}
	a.emitNotificationsChanged()
	return nil
}

func (a *App) DeleteNotification(id string) error {
	if a.stateManager == nil {
		return fmt.Errorf("state manager not initialized")
	}
	if !a.stateManager.DeleteNotification(id) {
		return fmt.Errorf("notification %q not found", id)
	}
	a.emitNotificationsChanged()
	return nil
}
