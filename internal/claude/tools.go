package claude

import (
	"encoding/json"
	"os"
	"path/filepath"
)

// Agent represents a Claude Code agent
type Agent struct {
	Name     string `json:"name"`
	Path     string `json:"path"`
	IsGlobal bool   `json:"isGlobal"`
	Format   string `json:"format"` // "yaml" | "md"
}

// Skill represents a Claude Code skill
type Skill struct {
	Name        string `json:"name"`
	Path        string `json:"path"`
	Description string `json:"description"`
	Installed   bool   `json:"installed"`
}

// Command represents a Claude Code slash command
type Command struct {
	Name        string `json:"name"`
	Path        string `json:"path"`
	Description string `json:"description"`
	IsGlobal    bool   `json:"isGlobal"`
	Content     string `json:"content,omitempty"`
}

// LibStatus represents the installation status of a library
type LibStatus struct {
	Name      string   `json:"name"`
	Installed bool     `json:"installed"`
	Version   string   `json:"version,omitempty"`
	Apps      []string `json:"apps,omitempty"` // List of apps where this library is installed
}

// UnifiedSkill represents a skill or command with full metadata across projects
type UnifiedSkill struct {
	Name         string            `json:"name"`
	Description  string            `json:"description"`
	Path         string            `json:"path"`
	DirPath      string            `json:"dirPath"`     // Directory containing the skill
	Project      string            `json:"project"`     // Project name (or "global")
	ProjectPath  string            `json:"projectPath"` // Project root path
	Source       string            `json:"source"`      // "skills" or "commands"
	IsGlobal     bool              `json:"isGlobal"`
	Content      string            `json:"content,omitempty"`
	Frontmatter  map[string]string `json:"frontmatter,omitempty"`
	HasSupport   bool              `json:"hasSupport"` // Has supporting files beyond SKILL.md
	SupportFiles []string          `json:"supportFiles,omitempty"`
}

const (
	SourceTypeSkills   = "skills"
	SourceTypeCommands = "commands"
)

// ToolsManager handles Claude Code tools (agents, skills, hooks)
type ToolsManager struct {
	homeDir string
}

// NewToolsManager creates a new tools manager
func NewToolsManager() *ToolsManager {
	home, err := os.UserHomeDir()
	if err != nil {
		home = ""
	}
	return &ToolsManager{
		homeDir: home,
	}
}

// AppDependencies holds dependencies for a specific app/package
type AppDependencies struct {
	AppName string
	Deps    map[string]string
}

// GetProjectDependencies reads dependencies from package.json (root only, for backward compat)
func (m *ToolsManager) GetProjectDependencies(projectPath string) (map[string]string, error) {
	deps := make(map[string]string)

	packagePath := filepath.Join(projectPath, "package.json")
	content, err := os.ReadFile(packagePath)
	if err != nil {
		if os.IsNotExist(err) {
			return deps, nil
		}
		return deps, err
	}

	var pkg map[string]interface{}
	if err := json.Unmarshal(content, &pkg); err != nil {
		return deps, err
	}

	// Merge dependencies and devDependencies
	for _, key := range []string{"dependencies", "devDependencies"} {
		if depsMap, ok := pkg[key].(map[string]interface{}); ok {
			for name, version := range depsMap {
				if v, ok := version.(string); ok {
					deps[name] = v
				}
			}
		}
	}

	return deps, nil
}

// GetAllProjectDependencies reads dependencies from root and all apps in monorepo structure
func (m *ToolsManager) GetAllProjectDependencies(projectPath string) ([]AppDependencies, error) {
	var allDeps []AppDependencies

	// Read root package.json
	rootDeps, err := m.readPackageJson(filepath.Join(projectPath, "package.json"))
	if err == nil && len(rootDeps) > 0 {
		allDeps = append(allDeps, AppDependencies{
			AppName: "root",
			Deps:    rootDeps,
		})
	}

	// Check for monorepo structures: apps/, packages/, workspaces/
	monorepoFolders := []string{"apps", "packages", "workspaces"}

	for _, folder := range monorepoFolders {
		folderPath := filepath.Join(projectPath, folder)
		if _, err := os.Stat(folderPath); os.IsNotExist(err) {
			continue
		}

		entries, err := os.ReadDir(folderPath)
		if err != nil {
			continue
		}

		for _, entry := range entries {
			if !entry.IsDir() {
				continue
			}

			appPath := filepath.Join(folderPath, entry.Name(), "package.json")
			appDeps, err := m.readPackageJson(appPath)
			if err != nil || len(appDeps) == 0 {
				continue
			}

			allDeps = append(allDeps, AppDependencies{
				AppName: entry.Name(),
				Deps:    appDeps,
			})
		}
	}

	return allDeps, nil
}

// readPackageJson reads and parses a package.json file
func (m *ToolsManager) readPackageJson(path string) (map[string]string, error) {
	deps := make(map[string]string)

	content, err := os.ReadFile(path)
	if err != nil {
		return deps, err
	}

	var pkg map[string]interface{}
	if err := json.Unmarshal(content, &pkg); err != nil {
		return deps, err
	}

	// Merge dependencies and devDependencies
	for _, key := range []string{"dependencies", "devDependencies"} {
		if depsMap, ok := pkg[key].(map[string]interface{}); ok {
			for name, version := range depsMap {
				if v, ok := version.(string); ok {
					deps[name] = v
				}
			}
		}
	}

	return deps, nil
}

// CheckLibraryStatus checks which libraries from a list are installed (across all apps)
func (m *ToolsManager) CheckLibraryStatus(projectPath string, libs []string) ([]LibStatus, error) {
	allDeps, err := m.GetAllProjectDependencies(projectPath)
	if err != nil {
		return nil, err
	}

	// Build a map of lib -> apps where it's installed
	libApps := make(map[string][]string)
	libVersions := make(map[string]string)

	for _, appDeps := range allDeps {
		for libName, version := range appDeps.Deps {
			if libApps[libName] == nil {
				libApps[libName] = []string{}
			}
			libApps[libName] = append(libApps[libName], appDeps.AppName)
			// Store the first version found
			if libVersions[libName] == "" {
				libVersions[libName] = version
			}
		}
	}

	// Build status for requested libs
	statuses := make([]LibStatus, len(libs))
	for i, lib := range libs {
		apps := libApps[lib]
		installed := len(apps) > 0
		statuses[i] = LibStatus{
			Name:      lib,
			Installed: installed,
			Version:   libVersions[lib],
			Apps:      apps,
		}
	}

	return statuses, nil
}
