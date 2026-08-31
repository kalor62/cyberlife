package main

import (
	"context"
	"fmt"

	calendarapi "google.golang.org/api/calendar/v3"

	"github.com/kalor62/cyberlife/internal/api"
	"github.com/kalor62/cyberlife/internal/calendar"
	"github.com/kalor62/cyberlife/internal/logging"
)

// CalendarAccountInfo is what the settings screen sees: the account, its
// calendars and which of them are shared with addons. Tokens stay backend-side.
type CalendarAccountInfo struct {
	Email     string         `json:"email"`
	Calendars []CalendarInfo `json:"calendars"`
	Error     string         `json:"error,omitempty"`
}

type CalendarInfo struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Primary  bool   `json:"primary,omitempty"`
	ReadOnly bool   `json:"readOnly,omitempty"`
	Shared   bool   `json:"shared"`
	Color    string `json:"color,omitempty"`
}

// GetCalendarConfig lists connected accounts with their calendars. A failing
// account reports its error inline instead of sinking the whole screen — one
// revoked token must not hide the other accounts.
func (a *App) GetCalendarConfig() []CalendarAccountInfo {
	out := []CalendarAccountInfo{}
	if a.stateManager == nil {
		return out
	}
	for _, acc := range a.stateManager.GetCalendarSettings().Accounts {
		info := CalendarAccountInfo{Email: acc.Email, Calendars: []CalendarInfo{}}
		shared := map[string]bool{}
		for _, id := range acc.Shared {
			shared[id] = true
		}
		svc, err := a.calendarService(acc.Email)
		if err != nil {
			info.Error = err.Error()
			out = append(out, info)
			continue
		}
		cals, err := calendar.ListCalendars(svc)
		if err != nil {
			info.Error = err.Error()
			out = append(out, info)
			continue
		}
		for _, c := range cals {
			info.Calendars = append(info.Calendars, CalendarInfo{
				ID: c.ID, Name: c.Name, Primary: c.Primary, ReadOnly: c.ReadOnly,
				Shared: shared[c.ID], Color: c.Color,
			})
		}
		out = append(out, info)
	}
	return out
}

// CalendarConnect runs the OAuth flow and stores the account
func (a *App) CalendarConnect(clientID, clientSecret string) (string, error) {
	if a.calendarManager == nil || a.stateManager == nil {
		return "", fmt.Errorf("calendar manager not initialized")
	}
	ctx := a.ctx
	if ctx == nil {
		ctx = context.Background()
	}
	email, tokenJSON, err := a.calendarManager.Authorize(ctx, clientID, clientSecret)
	if err != nil {
		return "", err
	}
	a.stateManager.AddCalendarAccount(email, tokenJSON, clientID, clientSecret)
	logging.Info("Calendar account connected", "email", email)
	return email, nil
}

// CalendarDisconnect forgets an account and drops its cached service
func (a *App) CalendarDisconnect(email string) error {
	if a.stateManager == nil {
		return fmt.Errorf("state manager not initialized")
	}
	if a.calendarManager != nil {
		a.calendarManager.DropService(email)
	}
	a.stateManager.RemoveCalendarAccount(email)
	return nil
}

// CalendarSetShared replaces the calendars an account exposes to addons
func (a *App) CalendarSetShared(email string, calendarIDs []string) error {
	if a.stateManager == nil {
		return fmt.Errorf("state manager not initialized")
	}
	if !a.calendarAccountExists(email) {
		return fmt.Errorf("account %s not connected", email)
	}
	a.stateManager.SetCalendarShared(email, calendarIDs)
	return nil
}

func (a *App) calendarAccountExists(email string) bool {
	for _, acc := range a.stateManager.GetCalendarSettings().Accounts {
		if acc.Email == email {
			return true
		}
	}
	return false
}

// calendarService resolves an account to an authorized Calendar service
func (a *App) calendarService(email string) (*calendarapi.Service, error) {
	if a.calendarManager == nil || a.stateManager == nil {
		return nil, fmt.Errorf("calendar manager not initialized")
	}
	for _, acc := range a.stateManager.GetCalendarSettings().Accounts {
		if acc.Email == email {
			return a.calendarManager.Service(acc.Email, acc.TokenJSON, acc.ClientID, acc.ClientSecret)
		}
	}
	return nil, fmt.Errorf("account %s not connected (Settings → Google Calendar)", email)
}

// calendarServiceFor finds the account owning a calendar id and returns its
// service. Only calendars shared with addons are resolvable, which is what
// keeps /api/calendar scoped to the user's choice.
func (a *App) calendarServiceFor(calendarID string) (*calendarapi.Service, error) {
	if a.stateManager == nil {
		return nil, fmt.Errorf("state manager not initialized")
	}
	for _, acc := range a.stateManager.GetCalendarSettings().Accounts {
		for _, shared := range acc.Shared {
			if shared == calendarID {
				return a.calendarService(acc.Email)
			}
		}
	}
	return nil, &calendar.NotFoundError{What: "calendar"}
}

// calendarHooks wires the REST layer to the account-scoped services
func (a *App) calendarHooks() api.CalendarHooks {
	return api.CalendarHooks{
		Accounts: func() any {
			out := []map[string]any{}
			for _, acc := range a.GetCalendarConfig() {
				cals := []map[string]any{}
				for _, c := range acc.Calendars {
					if !c.Shared {
						continue
					}
					cals = append(cals, map[string]any{
						"id": c.ID, "name": c.Name, "shared": true, "readOnly": c.ReadOnly,
						"color": c.Color,
					})
				}
				out = append(out, map[string]any{"email": acc.Email, "calendars": cals})
			}
			return out
		},
		List: func(calendarID, from, to string) (any, error) {
			svc, err := a.calendarServiceFor(calendarID)
			if err != nil {
				return nil, err
			}
			return calendar.ListEvents(svc, calendarID, from, to)
		},
		Create: func(calendarID string, in calendar.EventInput) (any, error) {
			svc, err := a.calendarServiceFor(calendarID)
			if err != nil {
				return nil, err
			}
			return calendar.CreateEvent(svc, calendarID, in)
		},
		Update: func(calendarID, eventID string, in calendar.EventInput) (any, error) {
			svc, err := a.calendarServiceFor(calendarID)
			if err != nil {
				return nil, err
			}
			return calendar.UpdateEvent(svc, calendarID, eventID, in)
		},
		Delete: func(calendarID, eventID string) error {
			svc, err := a.calendarServiceFor(calendarID)
			if err != nil {
				return err
			}
			return calendar.DeleteEvent(svc, calendarID, eventID)
		},
	}
}
