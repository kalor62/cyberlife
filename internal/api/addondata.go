// Per-addon blob storage under ~/.cyberlife/addon-data/<addonId>/ — the
// KV storage caps values at 64KB, so binary artifacts (invoice PDFs,
// attachments) live here instead: written over POST /api/addons/datafile,
// served back to the webview from GET /addons-data/<addonId>/<path>.
package api

import (
	"bytes"
	"context"
	"encoding/base64"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/kalor62/cyberlife/internal/addons"
	"github.com/kalor62/cyberlife/internal/logging"
	"github.com/kalor62/cyberlife/internal/paths"
	"github.com/kalor62/cyberlife/internal/platform"
)

const maxDataFileBytes = 30 << 20

type addonDataFileRequest struct {
	Addon      string `json:"addon"`
	Path       string `json:"path"`
	DataBase64 string `json:"dataBase64,omitempty"`
	ToPdf      bool   `json:"toPdf,omitempty"`
	Delete     bool   `json:"delete,omitempty"`
}

func cleanRelPath(rel string) (string, bool) {
	if rel == "" || strings.Contains(rel, "\x00") {
		return "", false
	}
	clean := filepath.Clean("/" + filepath.ToSlash(rel))
	for _, part := range strings.Split(clean, "/") {
		if strings.HasPrefix(part, ".") && part != "" {
			return "", false
		}
	}
	return strings.TrimPrefix(clean, "/"), true
}

func (s *Server) handleAddonDataFile(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeErr(w, http.StatusMethodNotAllowed, fmt.Errorf("POST only"))
		return
	}
	var req addonDataFileRequest
	if !decodeBody(w, r, &req) {
		return
	}
	addon, ok := addons.Get(req.Addon, s.manager.GetAddonsEnabled())
	if !ok || !addon.Enabled {
		writeErr(w, http.StatusForbidden, fmt.Errorf("addon %q is not enabled", req.Addon))
		return
	}
	rel, ok := cleanRelPath(req.Path)
	if !ok {
		writeErr(w, http.StatusBadRequest, fmt.Errorf("invalid path %q", req.Path))
		return
	}
	root, err := paths.AddonData()
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err)
		return
	}
	full := filepath.Join(root, addon.ID, filepath.FromSlash(rel))

	if req.Delete {
		if err := os.Remove(full); err != nil && !os.IsNotExist(err) {
			writeErr(w, http.StatusInternalServerError, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
		return
	}

	data, err := base64.StdEncoding.DecodeString(req.DataBase64)
	if err != nil {
		writeErr(w, http.StatusBadRequest, fmt.Errorf("dataBase64 is not valid base64"))
		return
	}
	if len(data) == 0 || len(data) > maxDataFileBytes {
		writeErr(w, http.StatusBadRequest, fmt.Errorf("file must be 1 byte to %d MB", maxDataFileBytes>>20))
		return
	}
	if req.ToPdf && !bytes.HasPrefix(data, []byte("%PDF")) {
		ctx, cancel := context.WithTimeout(r.Context(), 60*time.Second)
		defer cancel()
		data, err = imageToPdf(ctx, data)
		if err != nil {
			writeErr(w, http.StatusUnprocessableEntity, fmt.Errorf("image to PDF conversion failed: %w", err))
			return
		}
	}
	if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
		writeErr(w, http.StatusInternalServerError, err)
		return
	}
	if err := os.WriteFile(full, data, 0o644); err != nil {
		writeErr(w, http.StatusInternalServerError, err)
		return
	}
	logging.Info("addon data file written", "addon", addon.ID, "path", rel, "bytes", len(data))
	writeJSON(w, http.StatusOK, map[string]any{
		"ok":   true,
		"path": rel,
		"size": len(data),
		"url":  "/addons-data/" + addon.ID + "/" + rel,
	})
}

func imageToPdf(ctx context.Context, data []byte) ([]byte, error) {
	var ext string
	switch {
	case bytes.HasPrefix(data, []byte("\x89PNG")):
		ext = "png"
	case bytes.HasPrefix(data, []byte("\xff\xd8")):
		ext = "jpg"
	default:
		return nil, fmt.Errorf("unsupported input (expected PDF, PNG or JPEG)")
	}
	dir, err := os.MkdirTemp("", "addon-topdf-*")
	if err != nil {
		return nil, err
	}
	defer func() {
		if err := os.RemoveAll(dir); err != nil {
			logging.Debug("topdf temp remove failed", "error", err)
		}
	}()
	in := filepath.Join(dir, "in."+ext)
	out := filepath.Join(dir, "out.pdf")
	if err := os.WriteFile(in, data, 0o600); err != nil {
		return nil, err
	}
	var cmd *exec.Cmd
	if sips, err := exec.LookPath("sips"); err == nil {
		cmd = exec.CommandContext(ctx, sips, "-s", "format", "pdf", in, "--out", out)
	} else if magick, err := exec.LookPath("magick"); err == nil {
		cmd = exec.CommandContext(ctx, magick, in, out)
	} else if convert, err := exec.LookPath("convert"); err == nil {
		cmd = exec.CommandContext(ctx, convert, in, out)
	} else {
		return nil, fmt.Errorf("no converter available — install ImageMagick")
	}
	if outBytes, err := cmd.CombinedOutput(); err != nil {
		return nil, fmt.Errorf("%v: %s", err, strings.TrimSpace(string(outBytes)))
	}
	return os.ReadFile(out)
}

type addonHTMLToPdfRequest struct {
	Addon   string `json:"addon"`
	HTML    string `json:"html"`
	OutPath string `json:"outPath"`
}

func findChrome() string {
	for _, c := range []string{
		"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
		"/Applications/Chromium.app/Contents/MacOS/Chromium",
	} {
		if _, err := os.Stat(c); err == nil {
			return c
		}
	}
	for _, name := range []string{"google-chrome", "chromium", "chromium-browser"} {
		if p, err := exec.LookPath(name); err == nil {
			return p
		}
	}
	return ""
}

// handleAddonHTMLToPdf renders HTML to a PDF in the addon blob store via
// headless Chrome — WKWebView cannot print without a window, and email
// attachments need real PDFs, not printable pages.
func (s *Server) handleAddonHTMLToPdf(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeErr(w, http.StatusMethodNotAllowed, fmt.Errorf("POST only"))
		return
	}
	var req addonHTMLToPdfRequest
	if !decodeBody(w, r, &req) {
		return
	}
	addon, ok := addons.Get(req.Addon, s.manager.GetAddonsEnabled())
	if !ok || !addon.Enabled {
		writeErr(w, http.StatusForbidden, fmt.Errorf("addon %q is not enabled", req.Addon))
		return
	}
	if req.HTML == "" || len(req.HTML) > maxPreviewBytes {
		writeErr(w, http.StatusBadRequest, fmt.Errorf("html must be 1 byte to %d MB", maxPreviewBytes>>20))
		return
	}
	outRel, ok := cleanRelPath(req.OutPath)
	if !ok {
		writeErr(w, http.StatusBadRequest, fmt.Errorf("invalid outPath %q", req.OutPath))
		return
	}
	chrome := findChrome()
	if chrome == "" {
		writeErr(w, http.StatusNotImplemented, fmt.Errorf("no Chrome/Chromium found for HTML→PDF rendering"))
		return
	}
	root, err := paths.AddonData()
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err)
		return
	}
	tmp, err := os.CreateTemp("", "addon-htmlpdf-*.html")
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err)
		return
	}
	defer func() {
		if err := os.Remove(tmp.Name()); err != nil {
			logging.Debug("htmltopdf temp remove failed", "error", err)
		}
	}()
	if _, err := tmp.WriteString(req.HTML); err != nil {
		writeErr(w, http.StatusInternalServerError, err)
		return
	}
	if err := tmp.Close(); err != nil {
		logging.Debug("htmltopdf temp close failed", "error", err)
	}
	outFull := filepath.Join(root, addon.ID, filepath.FromSlash(outRel))
	if err := os.MkdirAll(filepath.Dir(outFull), 0o755); err != nil {
		writeErr(w, http.StatusInternalServerError, err)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 60*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, chrome,
		"--headless", "--disable-gpu", "--no-pdf-header-footer",
		"--print-to-pdf="+outFull, "file://"+tmp.Name())
	if out, err := cmd.CombinedOutput(); err != nil {
		writeErr(w, http.StatusUnprocessableEntity, fmt.Errorf("chrome print failed: %v: %s", err, strings.TrimSpace(string(out))))
		return
	}
	info, err := os.Stat(outFull)
	if err != nil || info.Size() == 0 {
		writeErr(w, http.StatusUnprocessableEntity, fmt.Errorf("chrome produced no PDF"))
		return
	}
	logging.Info("addon html→pdf", "addon", addon.ID, "out", outRel, "bytes", info.Size())
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "path": outRel, "size": info.Size()})
}

type addonPdfMergeRequest struct {
	Addon   string   `json:"addon"`
	Keys    []string `json:"keys"`
	OutPath string   `json:"outPath"`
	Open    bool     `json:"open,omitempty"`
}

// handleAddonPdfMerge concatenates stored PDFs (poppler's pdfunite) into a
// new blob-store file — the "all non-KSeF invoices of the month in one PDF
// for the accountant" path — and optionally opens the result.
func (s *Server) handleAddonPdfMerge(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeErr(w, http.StatusMethodNotAllowed, fmt.Errorf("POST only"))
		return
	}
	var req addonPdfMergeRequest
	if !decodeBody(w, r, &req) {
		return
	}
	addon, ok := addons.Get(req.Addon, s.manager.GetAddonsEnabled())
	if !ok || !addon.Enabled {
		writeErr(w, http.StatusForbidden, fmt.Errorf("addon %q is not enabled", req.Addon))
		return
	}
	if len(req.Keys) == 0 || len(req.Keys) > 300 {
		writeErr(w, http.StatusBadRequest, fmt.Errorf("keys must hold 1-300 stored PDF paths"))
		return
	}
	outRel, ok := cleanRelPath(req.OutPath)
	if !ok {
		writeErr(w, http.StatusBadRequest, fmt.Errorf("invalid outPath %q", req.OutPath))
		return
	}
	bin, err := exec.LookPath("pdfunite")
	if err != nil {
		writeErr(w, http.StatusNotImplemented, fmt.Errorf("pdfunite not installed — install poppler (brew install poppler / apt install poppler-utils)"))
		return
	}
	root, err := paths.AddonData()
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err)
		return
	}
	args := make([]string, 0, len(req.Keys)+1)
	for _, key := range req.Keys {
		rel, ok := cleanRelPath(key)
		if !ok {
			writeErr(w, http.StatusBadRequest, fmt.Errorf("invalid key %q", key))
			return
		}
		full := filepath.Join(root, addon.ID, filepath.FromSlash(rel))
		if _, err := os.Stat(full); err != nil {
			writeErr(w, http.StatusNotFound, fmt.Errorf("stored file %q not found", key))
			return
		}
		args = append(args, full)
	}
	outFull := filepath.Join(root, addon.ID, filepath.FromSlash(outRel))
	if err := os.MkdirAll(filepath.Dir(outFull), 0o755); err != nil {
		writeErr(w, http.StatusInternalServerError, err)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 60*time.Second)
	defer cancel()
	if out, err := exec.CommandContext(ctx, bin, append(args, outFull)...).CombinedOutput(); err != nil {
		writeErr(w, http.StatusUnprocessableEntity, fmt.Errorf("pdfunite failed: %v: %s", err, strings.TrimSpace(string(out))))
		return
	}
	if req.Open {
		if err := platform.OpenExternal(outFull); err != nil {
			logging.Warn("pdfmerge open failed", "error", err)
		}
	}
	info, _ := os.Stat(outFull)
	logging.Info("addon pdf merge", "addon", addon.ID, "inputs", len(req.Keys), "out", outRel)
	writeJSON(w, http.StatusOK, map[string]any{
		"ok":   true,
		"path": outRel,
		"url":  "/addons-data/" + addon.ID + "/" + outRel,
		"size": info.Size(),
	})
}

// handleAddonDataAsset serves stored blobs back to the webview (PDF
// preview embeds). Gated on the owning addon being enabled, path-confined
// to the addon-data root.
func (s *Server) handleAddonDataAsset(w http.ResponseWriter, r *http.Request) {
	root, err := paths.AddonData()
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err)
		return
	}
	rel := strings.TrimPrefix(r.URL.Path, "/addons-data/")
	id := strings.SplitN(rel, "/", 2)[0]
	addon, ok := addons.Get(id, s.manager.GetAddonsEnabled())
	if !ok || !addon.Enabled {
		writeErr(w, http.StatusForbidden, fmt.Errorf("addon %q is not enabled", id))
		return
	}
	full, ok := resolveUnder(root, rel)
	if !ok {
		logging.Warn("api: addon data asset outside data dir", "path", r.URL.Path)
		http.NotFound(w, r)
		return
	}
	info, err := os.Stat(full)
	if err != nil || info.IsDir() {
		http.NotFound(w, r)
		return
	}
	if origin := r.Header.Get("Origin"); origin != "" && appOrigin(origin) {
		w.Header().Set("Cache-Control", "private, max-age=60")
		w.Header().Set("Access-Control-Allow-Origin", origin)
	}
	w.Header().Set("X-Content-Type-Options", "nosniff")
	http.ServeFile(w, r, full)
}

type addonExportRequest struct {
	Addon string `json:"addon"`
	Path  string `json:"path"`
	Name  string `json:"name,omitempty"`
}

// handleAddonExport copies a stored blob into the user's Downloads folder —
// the one place addon output (merged invoice PDFs, reports) is findable
// without knowing about ~/.cyberlife. Never overwrites: a taken name gets
// a numeric suffix.
func (s *Server) handleAddonExport(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeErr(w, http.StatusMethodNotAllowed, fmt.Errorf("POST only"))
		return
	}
	var req addonExportRequest
	if !decodeBody(w, r, &req) {
		return
	}
	addon, ok := addons.Get(req.Addon, s.manager.GetAddonsEnabled())
	if !ok || !addon.Enabled {
		writeErr(w, http.StatusForbidden, fmt.Errorf("addon %q is not enabled", req.Addon))
		return
	}
	rel, ok := cleanRelPath(req.Path)
	if !ok {
		writeErr(w, http.StatusBadRequest, fmt.Errorf("invalid path %q", req.Path))
		return
	}
	root, err := paths.AddonData()
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err)
		return
	}
	src := filepath.Join(root, addon.ID, filepath.FromSlash(rel))
	data, err := os.ReadFile(src)
	if err != nil {
		writeErr(w, http.StatusNotFound, fmt.Errorf("stored file %q not found", req.Path))
		return
	}
	home, err := os.UserHomeDir()
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err)
		return
	}
	downloads := filepath.Join(home, "Downloads")
	if err := os.MkdirAll(downloads, 0o755); err != nil {
		writeErr(w, http.StatusInternalServerError, err)
		return
	}
	name := filepath.Base(filepath.FromSlash(rel))
	if n := strings.TrimSpace(req.Name); n != "" {
		name = filepath.Base(n)
	}
	dest := uniquePath(filepath.Join(downloads, name))
	if err := os.WriteFile(dest, data, 0o644); err != nil {
		writeErr(w, http.StatusInternalServerError, err)
		return
	}
	logging.Info("addon file exported to Downloads", "addon", addon.ID, "path", rel, "dest", logging.MaskPath(dest))
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "path": dest, "name": filepath.Base(dest)})
}

func uniquePath(p string) string {
	if _, err := os.Stat(p); err != nil {
		return p
	}
	ext := filepath.Ext(p)
	base := strings.TrimSuffix(p, ext)
	for i := 2; i < 1000; i++ {
		candidate := fmt.Sprintf("%s (%d)%s", base, i, ext)
		if _, err := os.Stat(candidate); err != nil {
			return candidate
		}
	}
	return fmt.Sprintf("%s-%d%s", base, time.Now().Unix(), ext)
}
