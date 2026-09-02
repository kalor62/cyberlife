// Notifications raised by addons through cl.notify() and by agents through
// the notify tool: each one lands in the in-app notification center and as a
// desktop toast. The manifest "notify" permission is enforced in the addon
// host; this endpoint validates the payload and rate-limits.
package api

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"time"
)

const (
	maxNotifyTitleLen   = 120
	maxNotifyMessageLen = 500
	// A buggy addon loop must not be able to bury the desktop under toasts;
	// legitimate use (reminders on a schedule) never approaches this.
	notifyWindow = time.Minute
	notifyBurst  = 12
)

type notifyRequest struct {
	Title   string `json:"title"`
	Message string `json:"message"`
	Source  string `json:"source,omitempty"`
	Link    string `json:"link,omitempty"`
}

const maxNotifyLinkLen = 500

var notifyRate struct {
	sync.Mutex
	windowStart time.Time
	count       int
}

// notifyAllowed reports whether another notification fits in the current
// window, starting a fresh window once the old one has elapsed.
func notifyAllowed(now time.Time) bool {
	notifyRate.Lock()
	defer notifyRate.Unlock()
	if now.Sub(notifyRate.windowStart) >= notifyWindow {
		notifyRate.windowStart = now
		notifyRate.count = 0
	}
	if notifyRate.count >= notifyBurst {
		return false
	}
	notifyRate.count++
	return true
}

func (s *Server) handleNotify(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeErr(w, http.StatusMethodNotAllowed, fmt.Errorf("POST only"))
		return
	}
	var req notifyRequest
	if !decodeBody(w, r, &req) {
		return
	}
	title := strings.TrimSpace(req.Title)
	if title == "" {
		writeErr(w, http.StatusBadRequest, fmt.Errorf("title is required"))
		return
	}
	if s.systemNotify == nil {
		writeErr(w, http.StatusServiceUnavailable, fmt.Errorf("notifications are unavailable"))
		return
	}
	if !notifyAllowed(time.Now()) {
		writeErr(w, http.StatusTooManyRequests, fmt.Errorf("notification rate limit: max %d per minute", notifyBurst))
		return
	}
	if err := s.raiseNotification(req); err != nil {
		writeErr(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (s *Server) raiseNotification(req notifyRequest) error {
	source := strings.TrimSpace(req.Source)
	if source == "" {
		source = "agent"
	}
	return s.systemNotify(
		trunc(source, 60),
		trunc(strings.TrimSpace(req.Title), maxNotifyTitleLen),
		trunc(strings.TrimSpace(req.Message), maxNotifyMessageLen),
		trunc(strings.TrimSpace(req.Link), maxNotifyLinkLen),
	)
}

func trunc(s string, max int) string {
	runes := []rune(s)
	if len(runes) <= max {
		return s
	}
	return string(runes[:max-1]) + "…"
}

func (s *Server) opNotify(args json.RawMessage) (any, error) {
	var req notifyRequest
	if len(args) > 0 {
		if err := json.Unmarshal(args, &req); err != nil {
			return nil, fmt.Errorf("invalid arguments: %w", err)
		}
	}
	if strings.TrimSpace(req.Title) == "" {
		return nil, fmt.Errorf("title is required")
	}
	if s.systemNotify == nil {
		return nil, fmt.Errorf("notifications are unavailable")
	}
	if !notifyAllowed(time.Now()) {
		return nil, fmt.Errorf("notification rate limit: max %d per minute", notifyBurst)
	}
	if err := s.raiseNotification(req); err != nil {
		return nil, err
	}
	return map[string]bool{"ok": true}, nil
}

func (s *Server) opNotificationsList(args json.RawMessage) (any, error) {
	var req struct {
		IncludeArchived bool `json:"includeArchived"`
		Limit           int  `json:"limit"`
	}
	if len(args) > 0 {
		if err := json.Unmarshal(args, &req); err != nil {
			return nil, fmt.Errorf("invalid arguments: %w", err)
		}
	}
	if s.notifications == nil {
		return nil, fmt.Errorf("notifications are unavailable")
	}
	if req.Limit <= 0 {
		req.Limit = 50
	}
	return map[string]any{"notifications": s.notifications(req.IncludeArchived, req.Limit)}, nil
}
