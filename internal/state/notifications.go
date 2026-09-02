package state

import (
	"time"

	"github.com/google/uuid"
)

// Notification is one entry of the in-app notification center. Everything
// that used to be only a desktop toast (automations, addons via cl.notify,
// agents via the notify tool) also lands here so it can be reviewed later.
type Notification struct {
	ID         string     `json:"id"`
	Title      string     `json:"title"`
	Message    string     `json:"message,omitempty"`
	Source     string     `json:"source,omitempty"` // "automation", addon id, agent name…
	Link       string     `json:"link,omitempty"`   // URL or in-app target the entry points at
	CreatedAt  time.Time  `json:"createdAt"`
	ReadAt     *time.Time `json:"readAt,omitempty"`
	ArchivedAt *time.Time `json:"archivedAt,omitempty"`
}

const (
	maxNotifications          = 500
	archivedNotificationTTL   = 90 * 24 * time.Hour
	unarchivedNotificationTTL = 365 * 24 * time.Hour
)

func (m *Manager) AddNotification(n Notification) Notification {
	if n.ID == "" {
		n.ID = uuid.New().String()
	}
	if n.CreatedAt.IsZero() {
		n.CreatedAt = time.Now()
	}
	m.mu.Lock()
	m.state.Notifications = append([]Notification{n}, m.state.Notifications...)
	m.pruneNotificationsLocked(time.Now())
	m.mu.Unlock()
	m.Save()
	return n
}

// pruneNotificationsLocked drops archived entries past their TTL, then anything
// past the hard cap (oldest first). Caller holds the write lock.
func (m *Manager) pruneNotificationsLocked(now time.Time) {
	kept := m.state.Notifications[:0]
	for _, n := range m.state.Notifications {
		if n.ArchivedAt != nil && now.Sub(*n.ArchivedAt) > archivedNotificationTTL {
			continue
		}
		if now.Sub(n.CreatedAt) > unarchivedNotificationTTL {
			continue
		}
		kept = append(kept, n)
	}
	if len(kept) > maxNotifications {
		kept = kept[:maxNotifications]
	}
	m.state.Notifications = kept
}

// GetNotifications returns newest-first; archived entries only when asked for.
func (m *Manager) GetNotifications(includeArchived bool, limit int) []Notification {
	m.mu.RLock()
	defer m.mu.RUnlock()
	out := make([]Notification, 0, len(m.state.Notifications))
	for _, n := range m.state.Notifications {
		if !includeArchived && n.ArchivedAt != nil {
			continue
		}
		out = append(out, n)
		if limit > 0 && len(out) >= limit {
			break
		}
	}
	return out
}

func (m *Manager) UnreadNotificationCount() int {
	m.mu.RLock()
	defer m.mu.RUnlock()
	count := 0
	for _, n := range m.state.Notifications {
		if n.ReadAt == nil && n.ArchivedAt == nil {
			count++
		}
	}
	return count
}

// UpdateNotification applies fn to the entry with the given id; empty id
// applies it to every non-archived entry (the "mark all read" case).
func (m *Manager) UpdateNotification(id string, fn func(*Notification)) bool {
	now := time.Now()
	found := false
	m.mu.Lock()
	for i := range m.state.Notifications {
		n := &m.state.Notifications[i]
		if id == "" {
			if n.ArchivedAt == nil {
				fn(n)
				found = true
			}
			continue
		}
		if n.ID == id {
			fn(n)
			found = true
			break
		}
	}
	if found {
		m.pruneNotificationsLocked(now)
	}
	m.mu.Unlock()
	if found {
		m.Save()
	}
	return found
}

func (m *Manager) DeleteNotification(id string) bool {
	m.mu.Lock()
	kept := m.state.Notifications[:0]
	found := false
	for _, n := range m.state.Notifications {
		if n.ID == id {
			found = true
			continue
		}
		kept = append(kept, n)
	}
	m.state.Notifications = kept
	m.mu.Unlock()
	if found {
		m.Save()
	}
	return found
}
