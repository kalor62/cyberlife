package health

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/kalor62/cyberlife/internal/claude"
	"github.com/kalor62/cyberlife/internal/logging"
)

// CheckDef is one entry in the health check library. Built-in defs cover
// common stacks; custom (user-defined) checks are always manual. A project
// tracks a subset of the library (its selection) and the report evaluates
// only that subset.
type CheckDef struct {
	ID          string `json:"id"`
	Title       string `json:"title"`
	Description string `json:"description"`
	Stack       string `json:"stack"`    // generic | node | nextjs | express | go | java | ...
	Category    string `json:"category"` // grouping inside the report
	Kind        string `json:"kind"`     // auto | manual
	Custom      bool   `json:"custom,omitempty"`
}

func autoDef(id, stack, category, title, desc string) CheckDef {
	return CheckDef{ID: id, Title: title, Description: desc, Stack: stack, Category: category, Kind: "auto"}
}

func manualDef(id, stack, category, title, desc string) CheckDef {
	return CheckDef{ID: id, Title: title, Description: desc, Stack: stack, Category: category, Kind: "manual"}
}

// BuiltinLibrary returns every predefined check, grouped by stack in the UI.
// The former hardcoded categories (Testing, CI/CD, Structure, Logging, Libs)
// live on as entries here.
func BuiltinLibrary() []CheckDef {
	defs := []CheckDef{
		// ---- generic: structure & docs ----
		autoDef("file:CLAUDE.md", "generic", "Structure", "CLAUDE.md exists", "CLAUDE.md provides project-specific instructions to AI agents. Defines conventions, build commands, and project context."),
		autoDef("file:README", "generic", "Structure", "README exists", "README is the first file people see. Should explain what the project does, how to set it up, and how to contribute."),
		autoDef("file:.env.example", "generic", "Structure", ".env.example exists", "Documents required environment variables without exposing secrets."),
		autoDef("file:.gitignore", "generic", "Structure", ".gitignore exists", "Prevents committing build artifacts, dependencies and secrets."),
		autoDef("gitignore:.env", "generic", "Structure", ".env in .gitignore", "Ensures .env files with secrets are excluded from git."),
		autoDef("package-manifest", "generic", "Structure", "Dependency manifest exists", "Checks for package.json, go.mod, requirements.txt, Cargo.toml or pom.xml."),
		autoDef("tests-dir", "generic", "Testing", "Tests directory exists", "Checks if test files are organized in a dedicated directory (tests/, test/, __tests__/, spec/)."),
		autoDef("secretlint-config", "generic", "Security", "secretlint configured", "Checks if secretlint scans for hardcoded credentials in pre-commit hooks."),

		// ---- generic: CI/CD ----
		autoDef("ci:workflow", "generic", "CI/CD", "Has CI workflow", "GitHub Actions workflow files exist in .github/workflows/."),
		autoDef("ci:lint", "generic", "CI/CD", "CI runs lint", "CI runs a linter to catch code quality issues before merge."),
		autoDef("ci:test", "generic", "CI/CD", "CI runs tests", "CI runs automated tests to prevent regressions."),
		autoDef("ci:coverage", "generic", "CI/CD", "CI tracks coverage", "CI tracks code coverage (Codecov, Coveralls)."),
		autoDef("ci:deploy", "generic", "CI/CD", "CI deploys", "CI has an automated deploy step for continuous delivery."),
		autoDef("ci:last-run", "generic", "CI/CD", "Last CI run passed", "Checks the last GitHub Actions run status via the gh CLI."),

		// ---- node ----
		autoDef("node:test-framework", "node", "Testing", "Unit test framework", "vitest, jest or mocha installed."),
		autoDef("node:e2e-framework", "node", "Testing", "E2E test framework", "Playwright or Cypress installed."),
		autoDef("node:coverage-thresholds", "node", "Testing", "Coverage thresholds set", "Coverage thresholds configured in vitest/jest config."),
		autoDef("node:test-script", "node", "Testing", "Test script in package.json", "package.json has a test script for npm test and CI."),
		autoDef("node:version", "node", "Runtime", "Node.js 24 LTS", "Node version pinned (.nvmrc / engines) and at least 24."),
		autoDef("node:logger", "node", "Logging", "Structured logger configured", "pino, winston or another structured logger installed."),
		autoDef("log:levels", "node", "Logging", "All log levels used", "debug/info/warn/error all appear in the codebase."),
		autoDef("log:coverage", "node", "Logging", "Log coverage ≥90%", "Share of source files containing at least one log call."),
		autoDef("log:structured", "node", "Logging", "Structured log calls", "Log calls pass key-value data instead of concatenated strings."),
		autoDef("log:error-handlers", "node", "Logging", "Error handlers log", "Share of catch blocks that log, re-throw or propagate."),

		// ---- go ----
		autoDef("go:tests", "go", "Testing", "Go test files exist", "*_test.go files present in the module."),
		autoDef("go:logger", "go", "Logging", "Structured logger configured", "slog, zap, zerolog or logrus in go.mod."),

		// ---- express ----
		autoDef("lib:express", "express", "Framework", "express installed", "Express web framework present in dependencies."),
		autoDef("lib:helmet", "express", "Security", "helmet installed", "Security headers middleware for Express."),
		autoDef("lib:cors", "express", "Security", "cors installed", "Cross-origin resource sharing middleware configured."),
		autoDef("lib:pino-http", "express", "Logging", "pino-http installed", "Request logging middleware producing structured logs."),
		autoDef("lib:express-rate-limit", "express", "Security", "rate limiting installed", "Basic protection against brute force and abuse."),

		// ---- java ----
		autoDef("java:build-file", "java", "Structure", "Build file exists", "pom.xml or build.gradle present."),
		autoDef("java:tests-dir", "java", "Testing", "src/test exists", "Standard Maven/Gradle test directory present."),
		manualDef("java:checkstyle", "java", "Code Quality", "Checkstyle/Spotless configured", "A formatter or style checker runs in the build."),

		// ---- nextjs extras ----
		autoDef("nextjs:tailwind", "nextjs", "Framework", "Tailwind CSS configured", "Tailwind config file or CSS imports present."),

		// ---- manual (generic) ----
		manualDef("manual:ai-board-audit", "generic", "Process", "AI task board audit", "Manual review of the AI task board hygiene."),
		manualDef("manual:error-monitoring", "generic", "Monitoring", "Error monitoring wired to alerts", "Production errors page someone (Sentry/alerts verified)."),
		manualDef("manual:backup-tested", "generic", "Ops", "Backups exist and were restored once", "A backup that has never been restored is not a backup."),
		manualDef("manual:security-review", "generic", "Security", "Security review done", "Auth, input validation and secrets handling reviewed."),
	}

	// Library tiers become per-lib auto checks under node/nextjs
	for _, lib := range healthLibs {
		stack := "node"
		switch lib.Name {
		case "@sentry/nextjs", "next-auth", "@testing-library/react", "zustand",
			"@tanstack/react-query", "react-hook-form", "@hookform/resolvers", "react-i18next":
			stack = "nextjs"
		}
		defs = append(defs, autoDef("lib:"+lib.Name, stack, lib.Category,
			lib.Name+" installed", lib.ShortDesc+". "+lib.Desc))
	}
	return defs
}

// Stacks returns the display order of stacks in the configuration UI
func Stacks() []string {
	return []string{"generic", "node", "nextjs", "express", "go", "java"}
}

// RunCheck evaluates one auto check; manual checks are resolved from the
// per-project manual state by the caller.
func RunCheck(def CheckDef, projectPath string, toolsManager *claude.ToolsManager) HealthCheckItem {
	item := HealthCheckItem{Name: def.Title, Description: def.Description}

	deps := func() map[string]string {
		all, _ := toolsManager.GetAllProjectDependencies(projectPath)
		return flattenDeps(all)
	}

	switch {
	case def.ID == "file:CLAUDE.md":
		return withMeta(checkFileExists(projectPath, "CLAUDE.md", def.Title), def)
	case def.ID == "file:.env.example":
		return withMeta(checkFileExists(projectPath, ".env.example", def.Title), def)
	case def.ID == "file:.gitignore":
		return withMeta(checkFileExists(projectPath, ".gitignore", def.Title), def)
	case def.ID == "file:README":
		for _, name := range []string{"README.md", "README", "README.txt"} {
			if fileExists(filepath.Join(projectPath, name)) {
				item.Passed = true
				item.Detail = name
				break
			}
		}
	case def.ID == "gitignore:.env":
		item.Passed = checkGitignoreContains(projectPath, ".env")
	case def.ID == "package-manifest":
		for _, name := range []string{"package.json", "go.mod", "requirements.txt", "Cargo.toml", "pom.xml", "build.gradle"} {
			if fileExists(filepath.Join(projectPath, name)) {
				item.Passed = true
				item.Detail = name
				break
			}
		}
	case def.ID == "tests-dir":
		dir := findTestsDir(projectPath)
		item.Passed = dir != ""
		item.Detail = dir
	case def.ID == "secretlint-config":
		for _, name := range []string{".secretlintrc.json", ".secretlintrc.yml", ".secretlintrc.yaml", ".secretlintrc"} {
			if fileExists(filepath.Join(projectPath, name)) {
				item.Passed = true
				break
			}
		}

	case strings.HasPrefix(def.ID, "ci:"):
		return ciCheck(def, projectPath)

	case def.ID == "node:test-framework":
		depMap := deps()
		for _, fw := range []string{"vitest", "jest", "mocha"} {
			if _, ok := depMap[fw]; ok {
				item.Passed = true
				item.Detail = fw
				break
			}
		}
	case def.ID == "node:e2e-framework":
		depMap := deps()
		for _, fw := range []string{"@playwright/test", "cypress"} {
			if _, ok := depMap[fw]; ok {
				item.Passed = true
				item.Detail = fw
				break
			}
		}
	case def.ID == "node:coverage-thresholds":
		item.Passed = hasCoverageConfig(projectPath)
	case def.ID == "node:test-script":
		for name := range packageJSONScripts(projectPath) {
			if strings.Contains(strings.ToLower(name), "test") {
				item.Passed = true
				item.Detail = name
				break
			}
		}
	case def.ID == "node:version":
		version, source := detectNodeVersion(projectPath)
		if version == "" {
			item.Status = "warning"
			item.Detail = "version not specified"
		} else {
			item.Passed = parseNodeMajor(version) >= 24
			item.Detail = "v" + version + " (" + source + ")"
			if !item.Passed {
				item.Status = "failed"
			}
		}
	case def.ID == "node:logger":
		depMap := deps()
		for _, name := range []string{"pino", "winston", "bunyan", "log4js", "loglevel", "consola"} {
			if _, ok := depMap[name]; ok {
				item.Passed = true
				item.Detail = name
				break
			}
		}
	case strings.HasPrefix(def.ID, "log:"):
		return loggingCheck(def, projectPath)

	case def.ID == "go:tests":
		item.Passed = hasGoTestFiles(projectPath)
	case def.ID == "go:logger":
		if data, err := os.ReadFile(filepath.Join(projectPath, "go.mod")); err == nil {
			content := string(data)
			for _, mod := range []string{"log/slog", "go.uber.org/zap", "github.com/sirupsen/logrus", "github.com/rs/zerolog", "github.com/kalor62/cyberlife/internal/logging"} {
				if strings.Contains(content, mod) {
					item.Passed = true
					item.Detail = filepath.Base(mod)
					break
				}
			}
		}
		// slog is stdlib — grep sources when go.mod says nothing
		if !item.Passed && grepSourceContains(projectPath, "log/slog") {
			item.Passed = true
			item.Detail = "slog"
		}

	case def.ID == "java:build-file":
		for _, name := range []string{"pom.xml", "build.gradle", "build.gradle.kts"} {
			if fileExists(filepath.Join(projectPath, name)) {
				item.Passed = true
				item.Detail = name
				break
			}
		}
	case def.ID == "java:tests-dir":
		item.Passed = fileExists(filepath.Join(projectPath, "src", "test"))

	case def.ID == "nextjs:tailwind":
		item.Passed, item.Detail = checkTailwindCSS(projectPath)

	case strings.HasPrefix(def.ID, "lib:"):
		name := strings.TrimPrefix(def.ID, "lib:")
		depMap := deps()
		version, ok := depMap[name]
		item.Passed = ok
		item.Detail = version
	}
	return item
}

func withMeta(item HealthCheckItem, def CheckDef) HealthCheckItem {
	item.Name = def.Title
	item.Description = def.Description
	return item
}

func ciCheck(def CheckDef, projectPath string) HealthCheckItem {
	item := HealthCheckItem{Name: def.Title, Description: def.Description}
	workflowFiles := findYAMLFiles(filepath.Join(projectPath, ".github", "workflows"))

	switch def.ID {
	case "ci:workflow":
		item.Passed = len(workflowFiles) > 0
		item.Detail = fmt.Sprintf("%d workflow(s)", len(workflowFiles))
		return item
	case "ci:last-run":
		item.Passed, item.Detail = getLastGHRunStatus(projectPath)
		return item
	}

	if len(workflowFiles) == 0 {
		return item
	}
	lower := strings.ToLower(readWorkflowContents(workflowFiles))
	switch def.ID {
	case "ci:lint":
		item.Passed = strings.Contains(lower, "eslint") || strings.Contains(lower, "npm run lint") ||
			strings.Contains(lower, "npx lint") || containsStepName(lower, "lint") ||
			strings.Contains(lower, "go vet") || strings.Contains(lower, "golangci")
	case "ci:test":
		item.Passed = strings.Contains(lower, "npm run test") || strings.Contains(lower, "npm test") ||
			strings.Contains(lower, "npx vitest") || strings.Contains(lower, "npx jest") ||
			strings.Contains(lower, "go test") || strings.Contains(lower, "pytest") ||
			strings.Contains(lower, "mvn test") || strings.Contains(lower, "gradle test") ||
			containsStepName(lower, "test")
	case "ci:coverage":
		item.Passed = strings.Contains(lower, "coverage") || strings.Contains(lower, "codecov") ||
			strings.Contains(lower, "coveralls")
	case "ci:deploy":
		item.Passed = strings.Contains(lower, "deploy") || strings.Contains(lower, "vercel") ||
			strings.Contains(lower, "netlify") || strings.Contains(lower, "coolify") ||
			strings.Contains(lower, "aws") || containsStepName(lower, "deploy")
	}
	return item
}

func loggingCheck(def CheckDef, projectPath string) HealthCheckItem {
	item := HealthCheckItem{Name: def.Title, Description: def.Description}
	isJS := fileExists(filepath.Join(projectPath, "package.json"))
	isGo := fileExists(filepath.Join(projectPath, "go.mod"))
	stats := scanLoggingPatterns(projectPath, isJS, isGo)

	switch def.ID {
	case "log:levels":
		levelsFound := []string{}
		for _, lvl := range []string{"debug", "info", "warn", "error"} {
			if stats.levelCounts[lvl] > 0 {
				levelsFound = append(levelsFound, fmt.Sprintf("%s(%d)", lvl, stats.levelCounts[lvl]))
			}
		}
		item.Passed = len(levelsFound) == 4
		item.Detail = strings.Join(levelsFound, ", ")
	case "log:coverage":
		pct := 0
		if stats.totalFiles > 0 {
			pct = (stats.filesWithLogs * 100) / stats.totalFiles
		}
		item.Passed = pct >= 90
		item.Detail = fmt.Sprintf("%d%% (%d/%d files)", pct, stats.filesWithLogs, stats.totalFiles)
		if pct >= 100 {
			item.Status = "passed"
		} else if pct >= 90 {
			item.Status = "warning"
		} else {
			item.Status = "failed"
		}
	case "log:structured":
		item.Passed = stats.structuredCount > 0
		item.Detail = fmt.Sprintf("%d structured calls", stats.structuredCount)
	case "log:error-handlers":
		pct := 0
		if stats.catchBlocks > 0 {
			pct = (stats.catchWithLog * 100) / stats.catchBlocks
		}
		item.Passed = stats.catchBlocks == 0 || pct >= 90
		item.Detail = fmt.Sprintf("%d%% (%d/%d error handlers)", pct, stats.catchWithLog, stats.catchBlocks)
		if stats.catchBlocks == 0 || pct >= 100 {
			item.Status = "passed"
		} else if pct >= 90 {
			item.Status = "warning"
		} else {
			item.Status = "failed"
		}
	}
	return item
}

// grepSourceContains does a shallow scan of .go files for a substring
func grepSourceContains(projectPath, needle string) bool {
	found := false
	walkErr := filepath.Walk(projectPath, func(path string, info os.FileInfo, err error) error {
		if err != nil || found {
			return filepath.SkipDir
		}
		if info.IsDir() {
			base := info.Name()
			if base == "node_modules" || base == ".git" || base == "vendor" {
				return filepath.SkipDir
			}
			return nil
		}
		if strings.HasSuffix(path, ".go") {
			if data, err := os.ReadFile(path); err == nil && strings.Contains(string(data), needle) {
				found = true
			}
		}
		return nil
	})
	if walkErr != nil {
		logging.Debug("health: source grep walk failed", "path", projectPath, "error", walkErr)
	}
	return found
}

// SelectedReport evaluates only the project's selected checks, grouped by
// "Stack · Category". Manual checks resolve from the per-project manual state.
func SelectedReport(projectPath string, defs []CheckDef, selected []string, toolsManager *claude.ToolsManager) *ProjectHealthReport {
	report := &ProjectHealthReport{
		ProjectPath: projectPath,
		ProjectName: filepath.Base(projectPath),
	}
	byID := map[string]CheckDef{}
	for _, d := range defs {
		byID[d.ID] = d
	}
	manual := GetManualChecks(projectPath)

	groups := map[string]*HealthCategory{}
	order := []string{}

	for _, id := range selected {
		def, ok := byID[id]
		if !ok {
			continue
		}
		var item HealthCheckItem
		if def.Kind == "manual" {
			state := manual[def.ID]
			item = HealthCheckItem{
				Name:        def.Title,
				Description: def.Description,
				Passed:      state.Checked,
				Manual:      true,
				ManualID:    def.ID,
				Detail:      state.Comment,
			}
		} else {
			item = RunCheck(def, projectPath, toolsManager)
			item.Name = def.Title
			if item.Description == "" {
				item.Description = def.Description
			}
		}

		key := def.Category
		cat, ok := groups[key]
		if !ok {
			cat = &HealthCategory{Name: def.Category, Icon: categoryIcon(def.Category)}
			groups[key] = cat
			order = append(order, key)
		}
		cat.Items = append(cat.Items, item)
		cat.Total++
		if item.Passed {
			cat.Passed++
		}
	}

	for _, key := range order {
		report.Categories = append(report.Categories, *groups[key])
	}
	return report
}

func categoryIcon(category string) string {
	switch strings.ToLower(category) {
	case "testing":
		return "🧪"
	case "ci/cd":
		return "🚀"
	case "structure":
		return "🏗️"
	case "logging", "observability":
		return "📋"
	case "security":
		return "🔒"
	case "framework":
		return "🧩"
	case "runtime":
		return "⚙️"
	case "monitoring":
		return "📡"
	case "process":
		return "📋"
	case "ops":
		return "🛟"
	case "code quality":
		return "✨"
	case "database":
		return "🗄️"
	case "state":
		return "🧠"
	case "forms":
		return "📝"
	case "i18n":
		return "🌍"
	case "validation":
		return "✅"
	case "auth":
		return "🔑"
	case "duplication":
		return "👯"
	}
	return "📌"
}
