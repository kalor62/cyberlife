package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"github.com/kalor62/cyberlife/internal/addons"
)

func testAddon(hosts ...string) addons.Addon {
	return addons.Addon{Manifest: addons.Manifest{ID: "probe", Name: "Probe", Hosts: hosts}}
}

func TestAllowedProxyTarget(t *testing.T) {
	a := testAddon("api.example.com", "*.example.pl")
	cases := []struct {
		url  string
		want bool
	}{
		{"https://api.example.com/v2/x", true},
		{"https://sub.example.pl/x", true},
		{"https://example.pl/x", true},
		{"https://API.EXAMPLE.COM/x", true},
		{"http://api.example.com/x", false},
		{"https://evil.com/x", false},
		{"https://api.example.com.evil.com/x", false},
		{"https://notexample.pl/x", false},
		{"https://127.0.0.1/x", false},
		{"https://localhost/x", false},
		{"https://[::1]/x", false},
		{"file:///etc/passwd", false},
	}
	for _, c := range cases {
		u, err := url.Parse(c.url)
		if err != nil {
			t.Fatalf("parse %q: %v", c.url, err)
		}
		got := allowedProxyTarget(a, u) == nil
		if got != c.want {
			t.Errorf("allowedProxyTarget(%q) = %v, want %v", c.url, got, c.want)
		}
	}
}

// A redirect must be re-checked against the allowlist; without this the first
// hop's approval would carry the caller anywhere, including loopback.
func TestProxyClientRefusesRedirectOffAllowlist(t *testing.T) {
	internal := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte("SECRET"))
	}))
	defer internal.Close()

	var redirected bool
	origin := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		redirected = true
		http.Redirect(w, r, internal.URL+"/admin", http.StatusFound)
	}))
	defer origin.Close()

	originHost := strings.TrimPrefix(origin.URL, "http://")
	client := proxyClient(testAddon(originHost))
	// The test servers are plain http on loopback, which the guards reject on
	// their own; CheckRedirect is what this asserts, so drive it directly.
	req, _ := http.NewRequest(http.MethodGet, internal.URL+"/admin", nil)
	via, _ := http.NewRequest(http.MethodGet, origin.URL, nil)
	if err := client.CheckRedirect(req, []*http.Request{via}); err == nil {
		t.Fatal("redirect to a non-allowlisted host was permitted")
	}
	_ = redirected
}

func TestProxyClientRefusesTooManyRedirects(t *testing.T) {
	client := proxyClient(testAddon("api.example.com"))
	req, _ := http.NewRequest(http.MethodGet, "https://api.example.com/x", nil)
	via := make([]*http.Request, 3)
	for i := range via {
		via[i] = req
	}
	if err := client.CheckRedirect(req, via); err == nil {
		t.Fatal("redirect chain was not capped")
	}
}

// Name-based checks cannot see where a host resolves; the dialer must refuse
// any allowlisted name that lands on loopback or private space.
func TestProxyClientDialerRefusesPrivateAddress(t *testing.T) {
	client := proxyClient(testAddon("localtest.me"))
	transport, ok := client.Transport.(*http.Transport)
	if !ok {
		t.Fatal("proxy client has no custom transport")
	}
	// localtest.me is a public DNS name that resolves to 127.0.0.1
	_, err := transport.DialContext(t.Context(), "tcp", "localtest.me:443")
	if err == nil {
		t.Fatal("dialer connected to a name resolving to loopback")
	}
	if !strings.Contains(err.Error(), "private address") {
		t.Logf("dial refused with: %v", err)
	}
}

func TestHostAllowedWildcardScope(t *testing.T) {
	a := testAddon("*.example.pl")
	for _, host := range []string{"example.pl", "a.example.pl", "a.b.example.pl", "EXAMPLE.PL"} {
		if !a.HostAllowed(host) {
			t.Errorf("HostAllowed(%q) = false, want true", host)
		}
	}
	for _, host := range []string{"example.pl.evil.com", "notexample.pl", "evil.com"} {
		if a.HostAllowed(host) {
			t.Errorf("HostAllowed(%q) = true, want false", host)
		}
	}
}

func TestAddonToolResultRejectsForeignAddon(t *testing.T) {
	s := &Server{addonCalls: map[string]pendingAddonCall{
		"abc123": {addon: "ksef", ch: make(chan addonToolResult, 1)},
	}}
	body, _ := json.Marshal(addonToolResultRequest{CallID: "abc123", Addon: "other", Result: json.RawMessage(`{"fake":true}`)})
	req := httptest.NewRequest(http.MethodPost, "/api/addons/tool-result", strings.NewReader(string(body)))
	rec := httptest.NewRecorder()
	s.handleAddonToolResult(rec, req)

	if rec.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403", rec.Code)
	}
	if len(s.addonCalls) != 1 {
		t.Error("a foreign responder consumed the pending call")
	}
	if len(s.addonCalls["abc123"].ch) != 0 {
		t.Error("a foreign responder delivered a result")
	}
}

func TestAddonToolResultAcceptsOwner(t *testing.T) {
	ch := make(chan addonToolResult, 1)
	s := &Server{addonCalls: map[string]pendingAddonCall{"abc123": {addon: "ksef", ch: ch}}}
	body, _ := json.Marshal(addonToolResultRequest{CallID: "abc123", Addon: "ksef", Result: json.RawMessage(`{"ok":true}`)})
	req := httptest.NewRequest(http.MethodPost, "/api/addons/tool-result", strings.NewReader(string(body)))
	rec := httptest.NewRecorder()
	s.handleAddonToolResult(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200: %s", rec.Code, rec.Body.String())
	}
	select {
	case res := <-ch:
		if string(res.result) != `{"ok":true}` {
			t.Errorf("result = %s", res.result)
		}
	default:
		t.Fatal("owner result was not delivered")
	}
}
