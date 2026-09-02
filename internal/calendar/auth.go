// Google Calendar accounts: loopback OAuth, per-account credentials and
// token refresh persisted back into app state — the same shape as
// internal/gmail, so one mental model covers both integrations.
package calendar

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"html"
	"net"
	"net/http"
	"sync"
	"time"

	"golang.org/x/oauth2"
	"golang.org/x/oauth2/google"
	calendarapi "google.golang.org/api/calendar/v3"
	"google.golang.org/api/option"

	"github.com/kalor62/cyberlife/internal/logging"
	"github.com/kalor62/cyberlife/internal/platform"
)

// Full calendar scope: the app creates, edits and deletes events, not just reads.
// Changing this list invalidates stored tokens — every account has to authorize again.
var scopes = []string{calendarapi.CalendarScope}

// Manager caches per-account Calendar services; each account carries its own
// OAuth client credentials, so separate Google Cloud projects per mailbox work.
type Manager struct {
	mu       sync.Mutex
	services map[string]*calendarapi.Service
	// onTokenRefresh persists a refreshed token for an account
	onTokenRefresh func(email, tokenJSON string)
}

func NewManager() *Manager {
	return &Manager{services: map[string]*calendarapi.Service{}}
}

func (m *Manager) SetTokenRefreshHandler(fn func(email, tokenJSON string)) {
	m.mu.Lock()
	m.onTokenRefresh = fn
	m.mu.Unlock()
}

func oauthConfig(clientID, clientSecret, redirectURL string) (*oauth2.Config, error) {
	if clientID == "" || clientSecret == "" {
		return nil, fmt.Errorf("Calendar Client ID/Secret not configured (Settings → Google Calendar)")
	}
	return &oauth2.Config{
		ClientID:     clientID,
		ClientSecret: clientSecret,
		Endpoint:     google.Endpoint,
		RedirectURL:  redirectURL,
		Scopes:       scopes,
	}, nil
}

// Authorize runs the loopback OAuth flow: opens the browser, waits for the
// redirect, exchanges the code, and returns the account email + token JSON.
func (m *Manager) Authorize(ctx context.Context, clientID, clientSecret string) (email string, tokenJSON string, err error) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return "", "", fmt.Errorf("cannot open local port: %w", err)
	}
	defer func() {
		if err := listener.Close(); err != nil {
			logging.Debug("OAuth listener close failed", "error", err)
		}
	}()

	redirect := fmt.Sprintf("http://%s/oauth/callback", listener.Addr().String())
	cfg, err := oauthConfig(clientID, clientSecret, redirect)
	if err != nil {
		return "", "", err
	}

	stateBytes := make([]byte, 16)
	if _, err := rand.Read(stateBytes); err != nil {
		return "", "", err
	}
	state := hex.EncodeToString(stateBytes)

	codeCh := make(chan string, 1)
	errCh := make(chan error, 1)
	server := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/oauth/callback" {
			http.NotFound(w, r)
			return
		}
		q := r.URL.Query()
		if q.Get("state") != state {
			http.Error(w, "state mismatch", http.StatusBadRequest)
			errCh <- fmt.Errorf("OAuth state mismatch")
			return
		}
		if errMsg := q.Get("error"); errMsg != "" {
			// escaped: the value comes from the request, and this page renders
			// in the user's browser
			writePage(w, fmt.Sprintf("<html><body style='font-family:sans-serif'><h2>Authorization failed</h2><p>%s</p></body></html>", html.EscapeString(errMsg)))
			errCh <- fmt.Errorf("authorization denied: %s", errMsg)
			return
		}
		writePage(w, "<html><body style='font-family:sans-serif;background:#0f172a;color:#e2e8f0;display:flex;align-items:center;justify-content:center;height:100vh'><div style='text-align:center'><h2>✅ Google Calendar connected</h2><p>You can close this window and return to Cyber Life.</p></div></body></html>")
		codeCh <- q.Get("code")
	})}
	go func() {
		if serveErr := server.Serve(listener); serveErr != nil && serveErr != http.ErrServerClosed {
			logging.Debug("OAuth callback server closed", "error", serveErr)
		}
	}()
	defer func() {
		if err := server.Close(); err != nil {
			logging.Debug("OAuth callback server close failed", "error", err)
		}
	}()

	authURL := cfg.AuthCodeURL(state, oauth2.AccessTypeOffline, oauth2.SetAuthURLParam("prompt", "consent"))
	if err := platform.OpenExternal(authURL); err != nil {
		return "", "", fmt.Errorf("cannot open browser: %w", err)
	}

	var code string
	select {
	case code = <-codeCh:
	case err := <-errCh:
		return "", "", err
	case <-time.After(3 * time.Minute):
		return "", "", fmt.Errorf("authorization timed out (3 min)")
	case <-ctx.Done():
		return "", "", ctx.Err()
	}

	token, err := cfg.Exchange(ctx, code)
	if err != nil {
		return "", "", fmt.Errorf("token exchange failed: %w", err)
	}

	svc, err := calendarapi.NewService(ctx, option.WithTokenSource(cfg.TokenSource(ctx, token)))
	if err != nil {
		return "", "", err
	}
	// "primary" always resolves to the signing-in user, so its id doubles as
	// the account identity without asking for an extra profile scope.
	primary, err := svc.Calendars.Get("primary").Do()
	if err != nil {
		return "", "", fmt.Errorf("cannot read primary calendar: %w", err)
	}

	tokenBytes, err := json.Marshal(token)
	if err != nil {
		return "", "", err
	}

	m.mu.Lock()
	m.services[primary.Id] = svc
	m.mu.Unlock()

	logging.Info("Calendar account authorized", "email", primary.Id)
	return primary.Id, string(tokenBytes), nil
}

// persistingTokenSource saves refreshed tokens back to the app state
type persistingTokenSource struct {
	inner oauth2.TokenSource
	mgr   *Manager
	email string
	last  string
}

func (p *persistingTokenSource) Token() (*oauth2.Token, error) {
	token, err := p.inner.Token()
	if err != nil {
		return nil, err
	}
	if data, jsonErr := json.Marshal(token); jsonErr == nil && string(data) != p.last {
		p.last = string(data)
		p.mgr.mu.Lock()
		handler := p.mgr.onTokenRefresh
		p.mgr.mu.Unlock()
		if handler != nil {
			handler(p.email, string(data))
		}
	}
	return token, nil
}

// Service returns a cached or freshly built Calendar service for an account
func (m *Manager) Service(email, tokenJSON, clientID, clientSecret string) (*calendarapi.Service, error) {
	m.mu.Lock()
	if svc, ok := m.services[email]; ok {
		m.mu.Unlock()
		return svc, nil
	}
	m.mu.Unlock()

	cfg, err := oauthConfig(clientID, clientSecret, "http://127.0.0.1/oauth/callback")
	if err != nil {
		return nil, err
	}
	var token oauth2.Token
	if err := json.Unmarshal([]byte(tokenJSON), &token); err != nil {
		return nil, fmt.Errorf("invalid stored token for %s: %w", email, err)
	}
	ctx := context.Background()
	source := &persistingTokenSource{
		inner: cfg.TokenSource(ctx, &token),
		mgr:   m,
		email: email,
		last:  tokenJSON,
	}
	svc, err := calendarapi.NewService(ctx, option.WithTokenSource(oauth2.ReuseTokenSource(&token, source)))
	if err != nil {
		return nil, err
	}

	m.mu.Lock()
	m.services[email] = svc
	m.mu.Unlock()
	return svc, nil
}

func (m *Manager) DropService(email string) {
	m.mu.Lock()
	delete(m.services, email)
	m.mu.Unlock()
}

// writePage sends the browser-facing OAuth result page; a failed write only
// means the user closed the tab early, the token exchange is unaffected.
func writePage(w http.ResponseWriter, page string) {
	if _, err := fmt.Fprint(w, page); err != nil {
		logging.Debug("OAuth result page write failed", "error", err)
	}
}
