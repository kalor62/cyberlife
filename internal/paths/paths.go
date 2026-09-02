// Package paths owns every location Cyber Life writes to under the user's
// home directory, so the layout is defined once instead of being rebuilt
// (with divergent error handling) in each package that needs a folder.
package paths

import (
	"os"
	"path/filepath"
)

const dirName = ".cyberlife"

// Root returns ~/.cyberlife, creating it when missing
func Root() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	dir := filepath.Join(home, dirName)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", err
	}
	return dir, nil
}

// Sub returns a subdirectory of Root, creating it when missing
func Sub(parts ...string) (string, error) {
	root, err := Root()
	if err != nil {
		return "", err
	}
	dir := filepath.Join(append([]string{root}, parts...)...)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", err
	}
	return dir, nil
}

// File returns a path inside Root without creating the file itself
func File(parts ...string) (string, error) {
	root, err := Root()
	if err != nil {
		return "", err
	}
	return filepath.Join(append([]string{root}, parts...)...), nil
}

func Addons() (string, error) { return Sub("addons") }

// AddonData is the per-addon blob store (binary artifacts too big for the
// addon KV storage); layout is addon-data/<addonId>/<relative path>
func AddonData() (string, error) { return Sub("addon-data") }
func Logs() (string, error)      { return Sub("logs") }
func Screenshots(projectID string) (string, error) {
	return Sub("screenshots", filepath.Base(projectID))
}
