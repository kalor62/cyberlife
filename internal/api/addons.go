package api

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/kalor62/cyberlife/internal/addons"
	"github.com/kalor62/cyberlife/internal/logging"
)

// Addons tools: agents install, inspect and toggle addons — directories
// under ~/.cyberlife/addons with an addon.json manifest. The frontend entry
// of each enabled addon is served from this server at /addons/<id>/<path>
// and imported by the webview at startup.

type addonsRequest struct {
	Addon   string          `json:"addon,omitempty"`
	Enabled *bool           `json:"enabled,omitempty"`
	Key     string          `json:"key,omitempty"`
	Value   json.RawMessage `json:"value,omitempty"`
}

func (s *Server) opAddonsList() (any, error) {
	list := addons.LoadAll(s.manager.GetAddonsEnabled())
	dir, _ := addons.Dir()
	return map[string]any{
		"addons":     list,
		"dir":        dir,
		"categories": addons.Categories,
	}, nil
}

func (s *Server) opAddonsSetEnabled(req addonsRequest) (any, error) {
	if req.Addon == "" || req.Enabled == nil {
		return nil, fmt.Errorf("addon and enabled are required")
	}
	a, ok := addons.Get(req.Addon, s.manager.GetAddonsEnabled())
	if !ok {
		return nil, fmt.Errorf("addon %q not found (see addons_list)", req.Addon)
	}
	if *req.Enabled && a.Error != "" {
		return nil, fmt.Errorf("addon %q has a manifest problem: %s", req.Addon, a.Error)
	}
	s.manager.SetAddonEnabled(req.Addon, *req.Enabled)
	if s.onAddonsChange != nil {
		s.onAddonsChange()
	}
	return map[string]any{"ok": true, "addon": req.Addon, "enabled": *req.Enabled}, nil
}

// opAddonsReload rescans the addons directory and tells the frontend to
// re-import enabled entries (picks up new addons and edited code)
func (s *Server) opAddonsReload(req addonsRequest) (any, error) {
	if s.onAddonsChange != nil {
		s.onAddonsChange()
	}
	return s.opAddonsList()
}

func (s *Server) opAddonsStorageGet(req addonsRequest) (any, error) {
	if req.Addon == "" {
		return nil, fmt.Errorf("addon is required")
	}
	data := s.manager.GetAddonData(req.Addon)
	if req.Key != "" {
		v, ok := data[req.Key]
		if !ok {
			return map[string]any{"addon": req.Addon, "key": req.Key, "value": nil}, nil
		}
		return map[string]any{"addon": req.Addon, "key": req.Key, "value": v}, nil
	}
	return map[string]any{"addon": req.Addon, "data": data}, nil
}

func (s *Server) opAddonsStorageSet(req addonsRequest) (any, error) {
	if req.Addon == "" || req.Key == "" {
		return nil, fmt.Errorf("addon and key are required")
	}
	if len(req.Value) == 0 {
		return nil, fmt.Errorf("value is required (any JSON)")
	}
	// Storage quotas are per namespace, so namespaces must not be free to
	// invent — otherwise state.json grows without bound
	if _, ok := addons.Get(req.Addon, s.manager.GetAddonsEnabled()); !ok {
		return nil, fmt.Errorf("addon %q is not installed (see addons_list)", req.Addon)
	}
	if err := s.manager.SetAddonKey(req.Addon, req.Key, req.Value); err != nil {
		return nil, err
	}
	return map[string]any{"ok": true}, nil
}

func (s *Server) opAddonsStorageDelete(req addonsRequest) (any, error) {
	if req.Addon == "" {
		return nil, fmt.Errorf("addon is required")
	}
	s.manager.DeleteAddonKey(req.Addon, req.Key)
	return map[string]any{"ok": true}, nil
}

// ---- static serving of addon files ----

// handleAddonAsset serves addon files to the webview. Modules are fetched
// cross-origin by import(), so the app origin is allowed explicitly; no-store
// keeps addon development iterations from being cached. Paths are resolved
// through symlinks and confined to the addons directory — a symlink inside an
// addon folder must not turn this into a file-read hole. Directory listings
// and dotfiles are refused.
func (s *Server) handleAddonAsset(w http.ResponseWriter, r *http.Request) {
	root, err := addons.Dir()
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err)
		return
	}
	rel := strings.TrimPrefix(r.URL.Path, "/addons/")
	full, ok := resolveUnder(root, rel)
	if !ok {
		logging.Warn("api: addon asset outside addons dir", "path", r.URL.Path)
		http.NotFound(w, r)
		return
	}
	info, err := os.Stat(full)
	if err != nil || info.IsDir() {
		http.NotFound(w, r)
		return
	}
	if origin := r.Header.Get("Origin"); origin != "" && appOrigin(origin) {
		w.Header().Set("Access-Control-Allow-Origin", origin)
	}
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	http.ServeFile(w, r, full)
}

// resolveUnder joins a request-supplied relative path onto root and verifies
// the fully resolved result (symlinks included) still lives under root
func resolveUnder(root, rel string) (string, bool) {
	if rel == "" || strings.Contains(rel, "\x00") {
		return "", false
	}
	clean := filepath.Clean("/" + rel)
	for _, part := range strings.Split(clean, "/") {
		if strings.HasPrefix(part, ".") && part != "" {
			return "", false
		}
	}
	full := filepath.Join(root, clean)
	realFull, err := filepath.EvalSymlinks(full)
	if err != nil {
		return "", false
	}
	realRoot, err := filepath.EvalSymlinks(root)
	if err != nil {
		return "", false
	}
	if realFull != realRoot && !strings.HasPrefix(realFull, realRoot+string(filepath.Separator)) {
		return "", false
	}
	return realFull, true
}

// ---- REST ----

func (s *Server) handleAddonsList(w http.ResponseWriter, r *http.Request) {
	if !s.guardGroup(w, "addons") {
		return
	}
	out, err := s.opAddonsList()
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// ---- MCP tools ----

func (s *Server) addonsTools() []mcpTool {
	addonProp := map[string]any{"type": "string", "description": "Addon id (folder name under the addons dir)"}
	return []mcpTool{
		{
			Name:        "addons_list",
			Description: "List installed addons: manifest (name, version, category, tags, permissions, contributed widgets/modules), enabled state and any manifest error. Also returns the addons directory path and valid categories.",
			InputSchema: objSchema(nil, map[string]any{}),
		},
		{
			Name:        "addons_set_enabled",
			Description: "Enable or disable an addon. Newly installed addons are disabled until enabled here or in Settings. Enabling is refused while the manifest has errors.",
			InputSchema: objSchema([]string{"addon", "enabled"}, map[string]any{
				"addon":   addonProp,
				"enabled": map[string]any{"type": "boolean"},
			}),
		},
		{
			Name:        "addons_reload",
			Description: "Rescan the addons directory and hot-reload enabled addons in the app. Call after installing or editing addon files.",
			InputSchema: objSchema(nil, map[string]any{}),
		},
		{
			Name:        "addons_storage_get",
			Description: "Read an addon's key-value storage (one key, or all keys when key is omitted)",
			InputSchema: objSchema([]string{"addon"}, map[string]any{
				"addon": addonProp,
				"key":   map[string]any{"type": "string"},
			}),
		},
		{
			Name:        "addons_storage_set",
			Description: "Store a JSON value under a key in an addon's namespace (64KB/value, 256 keys)",
			InputSchema: objSchema([]string{"addon", "key", "value"}, map[string]any{
				"addon": addonProp,
				"key":   map[string]any{"type": "string"},
				"value": map[string]any{"description": "Any JSON value"},
			}),
		},
		{
			Name:        "addons_storage_delete",
			Description: "Delete one key from an addon's storage, or the whole namespace when key is omitted",
			InputSchema: objSchema([]string{"addon"}, map[string]any{
				"addon": addonProp,
				"key":   map[string]any{"type": "string"},
			}),
		},
	}
}

func (s *Server) callAddonsTool(name string, args json.RawMessage) (any, error) {
	var req addonsRequest
	if len(args) > 0 {
		if err := json.Unmarshal(args, &req); err != nil {
			return nil, fmt.Errorf("invalid arguments: %w", err)
		}
	}
	switch name {
	case "addons_list":
		return s.opAddonsList()
	case "addons_set_enabled":
		return s.opAddonsSetEnabled(req)
	case "addons_reload":
		return s.opAddonsReload(req)
	case "addons_storage_get":
		return s.opAddonsStorageGet(req)
	case "addons_storage_set":
		return s.opAddonsStorageSet(req)
	case "addons_storage_delete":
		return s.opAddonsStorageDelete(req)
	}
	return nil, fmt.Errorf("unknown tool %q", name)
}

// Core widgets owned by built-in addons disappear from the catalog when
// their addon is off
var builtinWidgetOwners = map[string]string{
	"unread-mail": "gmail",
	"pomodoro":    "pomodoro",
}

// fullWidgetCatalog merges the core catalog with widgets contributed by
// enabled addons, so agent-side validation accepts addon widget ids.
func (s *Server) fullWidgetCatalog() []widgetInfo {
	enabled := s.manager.GetAddonsEnabled()
	var out []widgetInfo
	for _, w := range widgetCatalog() {
		if owner, ok := builtinWidgetOwners[w.ID]; ok && !addons.Enabled(owner, enabled) {
			continue
		}
		out = append(out, w)
	}
	for _, d := range addons.EnabledWidgetDecls(s.manager.GetAddonsEnabled()) {
		out = append(out, widgetInfo{
			ID: d.ID, Title: d.Title, Icon: d.Icon,
			Description: d.Description, Dashboard: d.Dashboard,
		})
	}
	return out
}

func (s *Server) widgetByIDFull(id string) (widgetInfo, bool) {
	for _, w := range s.fullWidgetCatalog() {
		if w.ID == id {
			return w, true
		}
	}
	return widgetInfo{}, false
}
