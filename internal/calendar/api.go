// Calendar list and event CRUD on top of an authorized account service.
// Everything here speaks plain structs so the HTTP layer and the agent tools
// share one shape and neither has to know the Google SDK types.
package calendar

import (
	"fmt"
	"strings"
	"sync"
	"time"

	calendarapi "google.golang.org/api/calendar/v3"
	"google.golang.org/api/googleapi"
)

// Calendar is one calendar of an account, as the settings screen shows it
type Calendar struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Primary  bool   `json:"primary,omitempty"`
	ReadOnly bool   `json:"readOnly,omitempty"`
	// Color is the calendar's background colour as hex — the default for every
	// event that does not override it.
	Color string `json:"color,omitempty"`
}

// Event is the trimmed view the API exposes; all-day events carry dates,
// timed ones RFC3339 timestamps, exactly as Google returns them.
type Event struct {
	ID     string `json:"id"`
	Title  string `json:"title"`
	Start  string `json:"start"`
	End    string `json:"end"`
	AllDay bool   `json:"allDay"`
	Note   string `json:"note,omitempty"`
	Link   string `json:"link,omitempty"`
	// Color is set only when the event overrides its calendar's colour; empty
	// means "use the calendar colour".
	Color string `json:"color,omitempty"`
}

// EventInput is what callers send when creating or updating an event. An
// empty Date means "leave as is" on update.
type EventInput struct {
	Title string `json:"title,omitempty"`
	Date  string `json:"date,omitempty"`  // YYYY-MM-DD → all-day event
	Start string `json:"start,omitempty"` // RFC3339 → timed event
	End   string `json:"end,omitempty"`
	Note  string `json:"note,omitempty"`
}

const dateLayout = "2006-01-02"

// NotFoundError marks a missing calendar or event so the HTTP layer can answer
// 404 instead of a generic failure.
type NotFoundError struct{ What string }

func (e *NotFoundError) Error() string { return e.What + " not found" }

func notFound(what string, err error) error {
	var apiErr *googleapi.Error
	if ok := asGoogleErr(err, &apiErr); ok && (apiErr.Code == 404 || apiErr.Code == 410) {
		return &NotFoundError{What: what}
	}
	return err
}

func asGoogleErr(err error, target **googleapi.Error) bool {
	if err == nil {
		return false
	}
	if ge, ok := err.(*googleapi.Error); ok {
		*target = ge
		return true
	}
	return false
}

// ListCalendars returns every calendar visible to the account.
func ListCalendars(svc *calendarapi.Service) ([]Calendar, error) {
	out := []Calendar{}
	call := svc.CalendarList.List().MaxResults(250)
	for {
		res, err := call.Do()
		if err != nil {
			return nil, fmt.Errorf("cannot list calendars: %w", err)
		}
		for _, item := range res.Items {
			out = append(out, Calendar{
				ID:      item.Id,
				Name:    firstNonEmpty(item.SummaryOverride, item.Summary, item.Id),
				Primary: item.Primary,
				// reader/freeBusyReader cannot be written to; the settings
				// screen greys those out instead of failing on first write
				ReadOnly: item.AccessRole == "reader" || item.AccessRole == "freeBusyReader",
				Color:    item.BackgroundColor,
			})
		}
		if res.NextPageToken == "" {
			return out, nil
		}
		call = call.PageToken(res.NextPageToken)
	}
}

// ListEvents returns single events of a calendar between from and to
// (YYYY-MM-DD, inclusive), recurring ones already expanded.
func ListEvents(svc *calendarapi.Service, calendarID, from, to string) ([]Event, error) {
	start, err := time.ParseInLocation(dateLayout, from, time.Local)
	if err != nil {
		return nil, fmt.Errorf("from must be YYYY-MM-DD")
	}
	end, err := time.ParseInLocation(dateLayout, to, time.Local)
	if err != nil {
		return nil, fmt.Errorf("to must be YYYY-MM-DD")
	}
	if end.Before(start) {
		return nil, fmt.Errorf("from (%s) is after to (%s)", from, to)
	}
	// Google treats timeMax as exclusive, so the last day needs a full day added
	call := svc.Events.List(calendarID).
		SingleEvents(true).
		OrderBy("startTime").
		TimeMin(start.Format(time.RFC3339)).
		TimeMax(end.AddDate(0, 0, 1).Format(time.RFC3339)).
		MaxResults(2500)
	out := []Event{}
	var palette map[string]string
	// paginate: a busy calendar in a wide window exceeds one page, and a
	// silently truncated list would look like "nothing more is scheduled"
	for {
		res, err := call.Do()
		if err != nil {
			return nil, notFound("calendar", err)
		}
		for _, item := range res.Items {
			ev := toEvent(item)
			// Google sends a palette index, not a colour; resolving it costs no
			// extra call for the eleven standard ids.
			if item.ColorId != "" {
				ev.Color = eventColor(svc, item.ColorId, &palette)
			}
			out = append(out, ev)
		}
		if res.NextPageToken == "" {
			return out, nil
		}
		call = call.PageToken(res.NextPageToken)
	}
}

// The event palette is identical for every account and changes about never,
// so one fetch per day covers the whole app. A failed fetch is not worth
// surfacing — colours are decoration, and the previous palette (or none at
// all) still renders a usable calendar.
var colorPalette struct {
	sync.Mutex
	fetchedAt time.Time
	byID      map[string]string
}

const paletteTTL = 24 * time.Hour

// Google's Colors endpoint still serves the pre-2018 palette (colorId 2 comes
// back as #7ae7bf), while the Calendar UI paints those very events with the
// current material shades. Rendering the API values would leave every coloured
// event a visibly different colour than the one the user picked, so the eleven
// known ids are mapped to what Google actually shows; anything unknown still
// falls back to the palette from the API.
var modernEventColors = map[string]string{
	"1":  "#7986CB", // Lawenda
	"2":  "#33B679", // Szałwia
	"3":  "#8E24AA", // Winogrono
	"4":  "#E67C73", // Flaming
	"5":  "#F6BF26", // Banan
	"6":  "#F4511E", // Mandarynka
	"7":  "#039BE5", // Paw
	"8":  "#616161", // Grafit
	"9":  "#3F51B5", // Borówka
	"10": "#0B8043", // Bazylia
	"11": "#D50000", // Pomidor
}

func eventColor(svc *calendarapi.Service, colorID string, palette *map[string]string) string {
	if hex, ok := modernEventColors[colorID]; ok {
		return hex
	}
	if *palette == nil {
		*palette = eventPalette(svc)
	}
	return (*palette)[colorID]
}

func eventPalette(svc *calendarapi.Service) map[string]string {
	colorPalette.Lock()
	defer colorPalette.Unlock()
	if colorPalette.byID != nil && time.Since(colorPalette.fetchedAt) < paletteTTL {
		return colorPalette.byID
	}
	res, err := svc.Colors.Get().Do()
	if err != nil {
		return colorPalette.byID // may be nil — callers treat that as "no colour"
	}
	byID := make(map[string]string, len(res.Event))
	for id, def := range res.Event {
		byID[id] = def.Background
	}
	colorPalette.byID = byID
	colorPalette.fetchedAt = time.Now()
	return byID
}

func CreateEvent(svc *calendarapi.Service, calendarID string, in EventInput) (*Event, error) {
	if strings.TrimSpace(in.Title) == "" {
		return nil, fmt.Errorf("title is required")
	}
	ev, err := applyInput(&calendarapi.Event{}, in, true)
	if err != nil {
		return nil, err
	}
	created, err := svc.Events.Insert(calendarID, ev).Do()
	if err != nil {
		return nil, notFound("calendar", err)
	}
	res := toEvent(created)
	return &res, nil
}

func UpdateEvent(svc *calendarapi.Service, calendarID, eventID string, in EventInput) (*Event, error) {
	if eventID == "" {
		return nil, fmt.Errorf("event id is required")
	}
	// A deleted event lingers as status "cancelled" and Patch would happily
	// bring it back to life, so check first — from the caller's side a deleted
	// event does not exist.
	current, err := svc.Events.Get(calendarID, eventID).Do()
	if err != nil {
		return nil, notFound("event", err)
	}
	if current.Status == "cancelled" {
		return nil, &NotFoundError{What: "event"}
	}
	// Patch, not Update: a full Update means echoing back the event we read,
	// and Google rejects its own reminders block coming back
	// ("cannotUseDefaultRemindersAndSpecifyOverride"). Patch sends only what
	// changed and leaves server-managed fields alone.
	patch, err := applyInput(&calendarapi.Event{}, in, false)
	if err != nil {
		return nil, err
	}
	updated, err := svc.Events.Patch(calendarID, eventID, patch).Do()
	if err != nil {
		return nil, notFound("event", err)
	}
	res := toEvent(updated)
	return &res, nil
}

func DeleteEvent(svc *calendarapi.Service, calendarID, eventID string) error {
	if eventID == "" {
		return fmt.Errorf("event id is required")
	}
	current, err := svc.Events.Get(calendarID, eventID).Do()
	if err != nil {
		return notFound("event", err)
	}
	if current.Status == "cancelled" {
		return &NotFoundError{What: "event"}
	}
	if err := svc.Events.Delete(calendarID, eventID).Do(); err != nil {
		return notFound("event", err)
	}
	return nil
}

// applyInput folds an EventInput into a Google event. On create the caller
// must supply a date or a start/end pair; on update only the given fields move.
func applyInput(ev *calendarapi.Event, in EventInput, requireWhen bool) (*calendarapi.Event, error) {
	if in.Title != "" {
		ev.Summary = in.Title
	}
	if in.Note != "" {
		ev.Description = in.Note
	}
	switch {
	case in.Date != "":
		day, err := time.ParseInLocation(dateLayout, in.Date, time.Local)
		if err != nil {
			return nil, fmt.Errorf("date must be YYYY-MM-DD")
		}
		// all-day events use exclusive end dates in Google's model
		ev.Start = &calendarapi.EventDateTime{Date: in.Date}
		ev.End = &calendarapi.EventDateTime{Date: day.AddDate(0, 0, 1).Format(dateLayout)}
	case in.Start != "":
		if _, err := time.Parse(time.RFC3339, in.Start); err != nil {
			return nil, fmt.Errorf("start must be RFC3339")
		}
		end := in.End
		if end == "" {
			// a timed event with no end lasts an hour, like the Google UI default
			t, _ := time.Parse(time.RFC3339, in.Start)
			end = t.Add(time.Hour).Format(time.RFC3339)
		} else if _, err := time.Parse(time.RFC3339, end); err != nil {
			return nil, fmt.Errorf("end must be RFC3339")
		}
		ev.Start = &calendarapi.EventDateTime{DateTime: in.Start}
		ev.End = &calendarapi.EventDateTime{DateTime: end}
	case requireWhen:
		return nil, fmt.Errorf("date (YYYY-MM-DD) or start (RFC3339) is required")
	}
	return ev, nil
}

func toEvent(item *calendarapi.Event) Event {
	out := Event{ID: item.Id, Title: item.Summary, Note: item.Description, Link: item.HtmlLink}
	if item.Start != nil {
		if item.Start.Date != "" {
			out.AllDay = true
			out.Start = item.Start.Date
		} else {
			out.Start = item.Start.DateTime
		}
	}
	if item.End != nil {
		if item.End.Date != "" {
			out.End = item.End.Date
		} else {
			out.End = item.End.DateTime
		}
	}
	return out
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if v != "" {
			return v
		}
	}
	return ""
}
