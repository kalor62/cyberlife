package health

import (
	"bufio"
	"encoding/json"
	"github.com/kalor62/cyberlife/internal/logging"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/kalor62/cyberlife/internal/claude"
	"github.com/kalor62/cyberlife/internal/paths"
)

func packageJSONScripts(projectPath string) map[string]string {
	data, err := os.ReadFile(filepath.Join(projectPath, "package.json"))
	if err != nil {
		return nil
	}
	var pkg struct {
		Scripts map[string]string `json:"scripts"`
	}
	if err := json.Unmarshal(data, &pkg); err != nil {
		return nil
	}
	return pkg.Scripts
}

// HealthCheckItem represents a single check within a category
type HealthCheckItem struct {
	Name        string `json:"name"`
	Passed      bool   `json:"passed"`
	Status      string `json:"status,omitempty"` // "passed", "warning", "failed" — overrides Passed if set
	Detail      string `json:"detail,omitempty"`
	Description string `json:"description,omitempty"` // info popup text
	Manual      bool   `json:"manual,omitempty"`      // true = manual checkbox item
	ManualID    string `json:"manualId,omitempty"`    // unique ID for persistence
}

// ManualCheckState stores the state of a manual check per project
type ManualCheckState struct {
	Checked   bool   `json:"checked"`
	Comment   string `json:"comment,omitempty"`
	Timestamp string `json:"timestamp,omitempty"` // ISO 8601
}

// HealthCategory represents one health card
type HealthCategory struct {
	Name   string            `json:"name"`
	Icon   string            `json:"icon"`
	Items  []HealthCheckItem `json:"items"`
	Passed int               `json:"passed"`
	Total  int               `json:"total"`
}

// ProjectHealthReport is the full health report for a project
type ProjectHealthReport struct {
	ProjectName string           `json:"projectName"`
	ProjectPath string           `json:"projectPath"`
	Categories  []HealthCategory `json:"categories"`
}

// LibTier defines a library with its requirement tier
type LibTier struct {
	Name      string
	Tier      string // "required", "recommended", "optional"
	Category  string
	ShortDesc string // Short inline description
	Desc      string // Full description for popup
}

// All libraries for health checks (matching RECOMMENDED_LIBS in tools-panel.js)
var healthLibs = []LibTier{
	// Required
	{Name: "eslint", Tier: "required", Category: "Code Quality", ShortDesc: "JS/TS linter", Desc: "Pluggable JavaScript/TypeScript linter for identifying problematic patterns. Enforces coding standards, catches bugs early, and supports custom rules via plugins. Essential for any JS/TS project to maintain code quality and consistency across the team."},
	{Name: "prettier", Tier: "required", Category: "Code Quality", ShortDesc: "Code formatter", Desc: "Opinionated code formatter supporting multiple languages. Automatically formats code on save or commit, eliminating style debates. Works with JS, TS, CSS, HTML, JSON, YAML, and more. Pairs with ESLint via eslint-config-prettier."},
	{Name: "husky", Tier: "required", Category: "Code Quality", ShortDesc: "Git hooks manager", Desc: "Modern native Git hooks manager for running scripts on commits. Installs pre-commit, pre-push, and other hooks automatically. Ensures linting and tests run before code reaches the repo. Zero-config with lint-staged."},
	{Name: "lint-staged", Tier: "required", Category: "Code Quality", ShortDesc: "Staged file linter", Desc: "Run linters and formatters only on staged files before commits. Dramatically faster than running on the entire codebase. Pairs with husky to create a pre-commit quality gate that doesn't slow developers down."},
	{Name: "secretlint", Tier: "required", Category: "Security", ShortDesc: "Secret detector", Desc: "Secret detection and prevention tool for finding hardcoded credentials. Scans for API keys, tokens, passwords, private keys, and other sensitive data in your codebase. Prevents accidental secret commits via pre-commit hooks."},
	{Name: "@secretlint/secretlint-rule-preset-recommend", Tier: "required", Category: "Security", ShortDesc: "Secretlint rules", Desc: "Recommended secretlint rules covering common secret patterns: AWS keys, GitHub tokens, Slack webhooks, private SSH keys, database connection strings, and more. Drop-in preset that covers 90% of secret detection needs."},
	// Recommended
	{Name: "vitest", Tier: "recommended", Category: "Testing", ShortDesc: "Unit test framework", Desc: "Fast Vite-native unit test framework with smart watch mode and native coverage. Compatible with Jest API but significantly faster. Supports TypeScript, ESM, JSX out of the box. Built-in coverage via c8/istanbul."},
	{Name: "@playwright/test", Tier: "recommended", Category: "Testing", ShortDesc: "E2E testing", Desc: "End-to-end testing framework for web applications with cross-browser support. Tests run in real Chromium, Firefox, and WebKit browsers. Auto-waiting, screenshots, video recording, and trace viewer included. Reliable and fast."},
	{Name: "@testing-library/react", Tier: "recommended", Category: "Testing", ShortDesc: "React test utils", Desc: "Simple and complete React component testing utilities that encourage good testing practices. Tests components the way users interact with them rather than implementation details. Works with any test runner."},
	{Name: "zod", Tier: "recommended", Category: "Validation", ShortDesc: "Schema validation", Desc: "TypeScript-first schema validation with static type inference. Define schemas once, get runtime validation and TypeScript types. Perfect for API input validation, form data, env vars, and config files. Tree-shakeable and zero dependencies."},
	{Name: "jscpd", Tier: "recommended", Category: "Duplication", ShortDesc: "Copy-paste detector", Desc: "Copy-paste detector for finding duplicated code across files. Supports 150+ languages. Outputs reports in multiple formats. Helps identify refactoring opportunities and reduces maintenance burden from duplicated logic."},
	// Optional
	{Name: "@sentry/nextjs", Tier: "optional", Category: "Monitoring", ShortDesc: "Error tracking", Desc: "Error tracking and performance monitoring for Next.js applications. Captures exceptions, performance traces, and user sessions. Provides stack traces, breadcrumbs, and release tracking. Essential for production observability."},
	{Name: "zustand", Tier: "optional", Category: "State", ShortDesc: "State management", Desc: "Small, fast and scalable state management for React. No boilerplate, no providers, no context. Just create a store and use it anywhere. Supports middleware, devtools, persistence, and immer integration. 1KB gzipped."},
	{Name: "@tanstack/react-query", Tier: "optional", Category: "State", ShortDesc: "Server state cache", Desc: "Powerful data synchronization and caching for server state. Handles fetching, caching, background updates, and stale data. Eliminates manual loading/error states. Built-in devtools, infinite queries, and optimistic updates."},
	{Name: "react-hook-form", Tier: "optional", Category: "Forms", ShortDesc: "Form handling", Desc: "Performant, flexible forms with easy validation and minimal re-renders. Uncontrolled components by default for best performance. Supports complex validation with Zod/Yup resolvers. Tiny bundle size with zero dependencies."},
	{Name: "@hookform/resolvers", Tier: "optional", Category: "Forms", ShortDesc: "Form validators", Desc: "Validation resolvers for react-hook-form supporting Zod, Yup, Joi, Superstruct, and more. Bridge between your schema validation library and react-hook-form. Enables type-safe form validation with any schema library."},
	{Name: "i18next", Tier: "optional", Category: "i18n", ShortDesc: "Internationalization", Desc: "Internationalization framework for browser, Node.js, and more. Supports plurals, context, nesting, interpolation, and formatting. Language detection, lazy loading of translations, and namespace separation. Industry standard for i18n."},
	{Name: "react-i18next", Tier: "optional", Category: "i18n", ShortDesc: "React i18n bindings", Desc: "React bindings for i18next with hooks, HOCs, and render props. useTranslation hook for functional components, Trans component for JSX interpolation. Supports SSR, suspense, and automatic re-rendering on language change."},
	{Name: "next-auth", Tier: "optional", Category: "Auth", ShortDesc: "Authentication", Desc: "Complete authentication solution for Next.js applications. Supports OAuth (Google, GitHub, etc.), credentials, email/magic links. Built-in session management, CSRF protection, and database adapters. Secure by default."},
	{Name: "prisma", Tier: "optional", Category: "Database", ShortDesc: "Database ORM", Desc: "Next-generation ORM with type-safe database client and migrations. Auto-generated TypeScript types from your schema. Supports PostgreSQL, MySQL, SQLite, MongoDB, and more. Visual database browser with Prisma Studio."},
	{Name: "pino", Tier: "optional", Category: "Observability", ShortDesc: "JSON logger", Desc: "Ultra-fast, low-overhead structured JSON logger for Node.js. 5x faster than alternatives. Supports log levels, child loggers, redaction, and serializers. JSON output makes logs queryable in production. Async by default."},
	{Name: "pino-pretty", Tier: "optional", Category: "Observability", ShortDesc: "Log prettifier", Desc: "Prettifier for pino logs with colorized, human-readable output in development. Transforms JSON log lines into formatted, colored terminal output. Use only in development; pino JSON output is better for production log aggregators."},
}

// ============================================
// Manual check persistence
// ============================================

func manualChecksPath() string {
	path, err := paths.File("health-manual-checks.json")
	if err != nil {
		return ""
	}
	return path
}

// manualChecksMap is projectPath -> checkID -> ManualCheckState
type manualChecksMap map[string]map[string]ManualCheckState

func loadManualChecks() manualChecksMap {
	data, err := os.ReadFile(manualChecksPath())
	if err != nil {
		return make(manualChecksMap)
	}
	var m manualChecksMap
	if err := json.Unmarshal(data, &m); err != nil {
		return make(manualChecksMap)
	}
	return m
}

func saveManualChecks(m manualChecksMap) error {
	dir := filepath.Dir(manualChecksPath())
	if err := os.MkdirAll(dir, 0755); err != nil {
		return err
	}
	data, err := json.MarshalIndent(m, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(manualChecksPath(), data, 0644)
}

// GetManualChecks returns all manual check states for a project
func GetManualChecks(projectPath string) map[string]ManualCheckState {
	m := loadManualChecks()
	if checks, ok := m[projectPath]; ok {
		return checks
	}
	return make(map[string]ManualCheckState)
}

// SetManualCheck sets the state of a manual check for a project
func SetManualCheck(projectPath, checkID string, checked bool, comment string) error {
	m := loadManualChecks()
	if m[projectPath] == nil {
		m[projectPath] = make(map[string]ManualCheckState)
	}
	if checked {
		m[projectPath][checkID] = ManualCheckState{
			Checked:   true,
			Comment:   comment,
			Timestamp: time.Now().Format(time.RFC3339),
		}
	} else {
		delete(m[projectPath], checkID)
		if len(m[projectPath]) == 0 {
			delete(m, projectPath)
		}
	}
	return saveManualChecks(m)
}

// detectNodeVersion reads the Node.js version from .nvmrc, .node-version, or package.json engines
func detectNodeVersion(projectPath string) (version string, source string) {
	// Check .nvmrc
	if data, err := os.ReadFile(filepath.Join(projectPath, ".nvmrc")); err == nil {
		v := strings.TrimSpace(string(data))
		v = strings.TrimPrefix(v, "v")
		if v != "" {
			return v, ".nvmrc"
		}
	}

	// Check .node-version
	if data, err := os.ReadFile(filepath.Join(projectPath, ".node-version")); err == nil {
		v := strings.TrimSpace(string(data))
		v = strings.TrimPrefix(v, "v")
		if v != "" {
			return v, ".node-version"
		}
	}

	// Check package.json engines.node
	pkgPath := filepath.Join(projectPath, "package.json")
	if data, err := os.ReadFile(pkgPath); err == nil {
		var pkg struct {
			Engines struct {
				Node string `json:"node"`
			} `json:"engines"`
		}
		if err := json.Unmarshal(data, &pkg); err == nil && pkg.Engines.Node != "" {
			// Extract version number from constraint like ">=18.0.0" or "^20.0.0"
			v := pkg.Engines.Node
			v = strings.TrimLeft(v, ">=^~<! ")
			if v != "" {
				return v, "package.json engines"
			}
		}
	}

	return "", ""
}

// parseNodeMajor extracts major version number from a version string like "20.11.0"
func parseNodeMajor(version string) int {
	parts := strings.Split(version, ".")
	if len(parts) == 0 {
		return 0
	}
	major, err := strconv.Atoi(parts[0])
	if err != nil {
		return 0
	}
	return major
}

// loggingStats holds scanning results
type loggingStats struct {
	totalFiles      int
	filesWithLogs   int
	levelCounts     map[string]int
	structuredCount int
	catchBlocks     int
	catchWithLog    int
}

// scanLoggingPatterns walks source files and counts logging patterns
func scanLoggingPatterns(projectPath string, isJS, isGo bool) loggingStats {
	stats := loggingStats{
		levelCounts: map[string]int{"debug": 0, "info": 0, "warn": 0, "error": 0},
	}

	// Source directories to scan
	srcDirs := []string{"src", "lib", "app", "pages", "components", "internal", "cmd", "pkg", "server", "api"}
	// Also scan root-level source files
	rootExts := map[string]bool{".js": true, ".ts": true, ".jsx": true, ".tsx": true, ".go": true, ".mjs": true}

	var allFiles []string

	// Collect files from source directories
	for _, dir := range srcDirs {
		fullDir := filepath.Join(projectPath, dir)
		if !fileExists(fullDir) {
			continue
		}
		walkErr := filepath.Walk(fullDir, func(path string, info os.FileInfo, err error) error {
			if err != nil || info.IsDir() {
				return nil
			}
			if isSourceFile(info.Name(), isJS, isGo) {
				allFiles = append(allFiles, path)
			}
			return nil
		})
		if walkErr != nil {
			logging.Debug("health: logging scan walk failed", "dir", fullDir, "error", walkErr)
		}
	}

	// Collect root-level source files
	entries, _ := os.ReadDir(projectPath)
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		ext := strings.ToLower(filepath.Ext(entry.Name()))
		if rootExts[ext] {
			allFiles = append(allFiles, filepath.Join(projectPath, entry.Name()))
		}
	}

	stats.totalFiles = len(allFiles)

	for _, file := range allFiles {
		content, err := os.ReadFile(file)
		if err != nil {
			continue
		}
		text := string(content)
		hasLog := analyzeFileLogging(text, isJS, isGo, &stats)
		if hasLog {
			stats.filesWithLogs++
		}
	}

	return stats
}

// JS error helper patterns — functions that handle+log errors internally
var jsErrorHelpers = []string{
	"handleerror", "handleapierror", "handleerr",
	"reporterror", "reporterr",
	"onerror", "onerrorhandler",
	"errorhandler", "errhandler",
	"senderror", "senderrorresponse",
	"notifyerror", "captureerror", "captureexception",
	"sentry.captureexception", "sentry.capturemessage",
	"bugsnag.notify", "rollbar.error",
	"next(err", "next(error", "next(new",
}

// JS intentional silent return values inside catch — not a missing log
var jsSilentReturns = []string{
	"return null", "return false", "return undefined",
	"return {}", "return ({})", "return []",
}

// Go error-propagation patterns — return err without logging is fine
var goErrorPropagation = []string{
	"return err", "return nil, err", "return fmt.errorf",
	"return errors.wrap", "return errors.new",
	"return nil, fmt.errorf",
}

// analyzeFileLogging scans a single file for logging patterns
func analyzeFileLogging(content string, isJS, isGo bool, stats *loggingStats) bool {
	lines := strings.Split(content, "\n")
	hasAnyLog := false
	inCatchBlock := false
	catchBraceDepth := 0
	catchHandled := false        // has log, error helper, re-throw, or propagation
	catchIsSilentReturn := false // only contains a silent return (return null/false/{})
	catchLineCount := 0          // non-empty lines inside catch body

	// Detect if this file IS an error middleware/handler
	isErrorMiddleware := false
	if isJS {
		lowerAll := strings.ToLower(content)
		if strings.Contains(lowerAll, "err, req, res, next") ||
			strings.Contains(lowerAll, "errorboundary") ||
			strings.Contains(lowerAll, "error-handler") ||
			strings.Contains(lowerAll, "errorhandler") {
			isErrorMiddleware = true
		}
	}

	for _, line := range lines {
		trimmed := strings.TrimSpace(line)
		lower := strings.ToLower(trimmed)

		// Track catch/error blocks
		if isJS {
			if strings.Contains(trimmed, "catch") && (strings.Contains(trimmed, "(") || strings.Contains(trimmed, "{")) {
				// Skip inline trivial: .catch(() => {}) .catch(() => null)
				if isInlineTrivialCatch(trimmed) {
					continue
				}
				stats.catchBlocks++
				inCatchBlock = true
				catchBraceDepth = 0
				catchHandled = false
				catchIsSilentReturn = false
				catchLineCount = 0
				if isErrorMiddleware {
					catchHandled = true
				}
			}
		}
		if isGo {
			if strings.Contains(trimmed, "if err != nil") || strings.Contains(trimmed, "if err :=") {
				stats.catchBlocks++
				inCatchBlock = true
				catchBraceDepth = 0
				catchHandled = false
				catchIsSilentReturn = false
				catchLineCount = 0
			}
		}

		// Track braces in catch blocks
		if inCatchBlock {
			catchBraceDepth += strings.Count(trimmed, "{") - strings.Count(trimmed, "}")

			// Count non-trivial lines in body (skip braces-only and empty lines)
			stripped := strings.Trim(trimmed, "{} \t")
			if stripped != "" && !strings.HasPrefix(stripped, "catch") && !strings.HasPrefix(stripped, "//") {
				catchLineCount++
			}

			// Check for error handling patterns inside catch
			if !catchHandled {
				if isJS {
					if strings.Contains(lower, "throw") {
						catchHandled = true
					}
					for _, helper := range jsErrorHelpers {
						if strings.Contains(lower, helper) {
							catchHandled = true
							break
						}
					}
					// Detect intentional silent returns (graceful fallbacks)
					for _, silent := range jsSilentReturns {
						if strings.Contains(lower, silent) {
							catchIsSilentReturn = true
							break
						}
					}
				}
				if isGo {
					for _, prop := range goErrorPropagation {
						if strings.Contains(lower, prop) {
							catchHandled = true
							break
						}
					}
				}
			}

			if catchBraceDepth <= 0 && strings.Contains(trimmed, "}") {
				if catchHandled {
					stats.catchWithLog++
				} else if catchIsSilentReturn && catchLineCount <= 1 {
					// Graceful fallback (only a return null/false/{}) — not a real error handler
					// Remove from total count
					stats.catchBlocks--
				}
				inCatchBlock = false
			}
		}

		// Detect log calls and levels
		logDetected := false

		if isJS {
			for _, lvl := range []string{"debug", "info", "warn", "error"} {
				if matchesJSLogCall(lower, lvl) {
					stats.levelCounts[lvl]++
					logDetected = true
				}
			}
			if logDetected && (strings.Contains(trimmed, ",") || strings.Contains(trimmed, "{")) {
				for _, pattern := range []string{", {", "({", ", \"", ", '"} {
					if strings.Contains(trimmed, pattern) {
						stats.structuredCount++
						break
					}
				}
			}
		}

		if isGo {
			for _, lvl := range []string{"debug", "info", "warn", "error"} {
				if matchesGoLogCall(lower, lvl) {
					stats.levelCounts[lvl]++
					logDetected = true
				}
			}
			if logDetected {
				commaCount := strings.Count(trimmed, ",")
				if commaCount >= 1 {
					stats.structuredCount++
				}
			}
		}

		if logDetected {
			hasAnyLog = true
			if inCatchBlock {
				catchHandled = true
			}
		}
	}

	return hasAnyLog
}

// isInlineTrivialCatch detects one-liner trivial catch like .catch(() => {}) or .catch(() => null)
func isInlineTrivialCatch(line string) bool {
	trimmed := strings.TrimSpace(line)
	// .catch(() => {}) .catch(() => null) .catch(() => undefined) .catch(noop)
	catchIdx := strings.Index(trimmed, "catch")
	if catchIdx < 0 {
		return false
	}
	after := strings.TrimSpace(trimmed[catchIdx:])
	// Must open and close on same line with trivial body
	openBraces := strings.Count(after, "{")
	closeBraces := strings.Count(after, "}")
	if openBraces > 0 && openBraces == closeBraces {
		// Check body is empty or trivial: only whitespace between { and }
		braceStart := strings.Index(after, "{")
		braceEnd := strings.LastIndex(after, "}")
		if braceStart >= 0 && braceEnd > braceStart {
			body := strings.TrimSpace(after[braceStart+1 : braceEnd])
			if body == "" || body == "}" {
				return true
			}
		}
	}
	// .catch(() => null) .catch(() => false) .catch(() => ({})) .catch(noop)
	if !strings.Contains(after, "{") || strings.Contains(after, "({})") {
		lowerAfter := strings.ToLower(after)
		if strings.Contains(lowerAfter, "=> null") || strings.Contains(lowerAfter, "=> undefined") ||
			strings.Contains(lowerAfter, "=> false") || strings.Contains(lowerAfter, "=> ({})") ||
			strings.Contains(lowerAfter, "=> []") ||
			strings.Contains(lowerAfter, "noop") || strings.Contains(lowerAfter, "() => )") {
			return true
		}
	}
	return false
}

// matchesJSLogCall checks if a line contains a JS log call at the given level
func matchesJSLogCall(lower, level string) bool {
	patterns := []string{
		"logger." + level + "(",
		"log." + level + "(",
		"console." + level + "(",
		".log('" + level,
		".log(\"" + level,
	}
	if level == "warn" {
		patterns = append(patterns, "console.warn(", "logger.warning(")
	}
	for _, p := range patterns {
		if strings.Contains(lower, p) {
			return true
		}
	}
	return false
}

// matchesGoLogCall checks if a line contains a Go log call at the given level
func matchesGoLogCall(lower, level string) bool {
	goLevel := capitalize(level)
	patterns := []string{
		"slog." + goLevel + "(",
		"log." + goLevel + "(",
		"logger." + goLevel + "(",
		"logging." + goLevel + "(",
		strings.ToLower("." + goLevel + "("),
	}
	if level == "warn" {
		patterns = append(patterns, "slog.warn(", "logger.warn(", "log.warn(", "logging.warn(")
	}
	for _, p := range patterns {
		if strings.Contains(lower, p) {
			return true
		}
	}
	return false
}

// isSourceFile checks if a filename is a source file to scan
func isSourceFile(name string, isJS, isGo bool) bool {
	// Skip test files, configs, generated files
	lower := strings.ToLower(name)
	if strings.Contains(lower, ".test.") || strings.Contains(lower, ".spec.") ||
		strings.Contains(lower, "_test.go") || strings.HasPrefix(lower, ".") {
		return false
	}

	ext := strings.ToLower(filepath.Ext(name))
	if isJS && (ext == ".js" || ext == ".ts" || ext == ".jsx" || ext == ".tsx" || ext == ".mjs") {
		return true
	}
	if isGo && ext == ".go" {
		return true
	}
	return false
}

// fileExists checks if a path exists
func fileExists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

// ============================================
// Helper functions
// ============================================

func flattenDeps(allDeps []claude.AppDependencies) map[string]string {
	result := make(map[string]string)
	for _, app := range allDeps {
		for name, version := range app.Deps {
			result[name] = version
		}
	}
	return result
}

func hasGoTestFiles(projectPath string) bool {
	found := false
	walkErr := filepath.Walk(projectPath, func(path string, info os.FileInfo, err error) error {
		if err != nil || found {
			return filepath.SkipDir
		}
		if info.IsDir() {
			switch info.Name() {
			case "node_modules", ".git", "vendor", "build", "dist":
				return filepath.SkipDir
			}
			return nil
		}
		if strings.HasSuffix(path, "_test.go") {
			found = true
		}
		return nil
	})
	if walkErr != nil {
		logging.Debug("health: go test scan walk failed", "path", projectPath, "error", walkErr)
	}
	return found
}

// capitalize upper-cases the first letter (ASCII) — what the Go log level
// method names need; strings.Title is deprecated and overkill here.
func capitalize(s string) string {
	if s == "" {
		return s
	}
	return strings.ToUpper(s[:1]) + s[1:]
}

func hasCoverageConfig(projectPath string) bool {
	configFiles := []string{
		"vitest.config.ts", "vitest.config.js", "vitest.config.mts",
		"jest.config.ts", "jest.config.js", "jest.config.mjs",
	}
	for _, cf := range configFiles {
		content, err := os.ReadFile(filepath.Join(projectPath, cf))
		if err != nil {
			continue
		}
		lower := strings.ToLower(string(content))
		if strings.Contains(lower, "coverage") && (strings.Contains(lower, "threshold") || strings.Contains(lower, "lines") || strings.Contains(lower, "branches")) {
			return true
		}
	}
	return false
}

func findTestsDir(projectPath string) string {
	for _, dir := range []string{"tests", "test", "__tests__", "spec"} {
		if info, err := os.Stat(filepath.Join(projectPath, dir)); err == nil && info.IsDir() {
			return dir + "/"
		}
	}
	return ""
}

func checkFileExists(projectPath, filename, label string) HealthCheckItem {
	_, err := os.Stat(filepath.Join(projectPath, filename))
	return HealthCheckItem{Name: label, Passed: err == nil}
}

func findYAMLFiles(dir string) []string {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}
	var files []string
	for _, entry := range entries {
		name := entry.Name()
		if strings.HasSuffix(name, ".yml") || strings.HasSuffix(name, ".yaml") {
			files = append(files, filepath.Join(dir, name))
		}
	}
	return files
}

func readWorkflowContents(files []string) string {
	var sb strings.Builder
	for _, f := range files {
		content, err := os.ReadFile(f)
		if err != nil {
			continue
		}
		sb.Write(content)
		sb.WriteByte('\n')
	}
	return sb.String()
}

func containsStepName(content, keyword string) bool {
	return strings.Contains(content, "name: "+keyword) ||
		strings.Contains(content, "name: \""+keyword) ||
		strings.Contains(content, "name: '"+keyword)
}

func checkGitignoreContains(projectPath, pattern string) bool {
	f, err := os.Open(filepath.Join(projectPath, ".gitignore"))
	if err != nil {
		return false
	}
	defer func() { _ = f.Close() }() // read-only
	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == pattern || line == pattern+"/" || strings.HasPrefix(line, pattern) {
			return true
		}
	}
	return false
}

func checkTailwindCSS(projectPath string) (bool, string) {
	// Check for Tailwind config files (v3 and v4)
	configFiles := []string{
		"tailwind.config.js", "tailwind.config.ts", "tailwind.config.mjs", "tailwind.config.cjs",
	}
	for _, cf := range configFiles {
		if _, err := os.Stat(filepath.Join(projectPath, cf)); err == nil {
			return true, cf
		}
	}

	// Tailwind v4 uses CSS-based config (@config directive or @import "tailwindcss")
	cssFiles := []string{
		"app/globals.css", "src/app/globals.css",
		"styles/globals.css", "src/styles/globals.css",
		"app/global.css", "src/global.css",
	}
	for _, cf := range cssFiles {
		content, err := os.ReadFile(filepath.Join(projectPath, cf))
		if err != nil {
			continue
		}
		lower := strings.ToLower(string(content))
		if strings.Contains(lower, "@import \"tailwindcss\"") || strings.Contains(lower, "@import 'tailwindcss'") ||
			strings.Contains(lower, "@tailwind base") || strings.Contains(lower, "@config") {
			return true, cf + " (CSS config)"
		}
	}

	// Check if tailwindcss is in dependencies
	pkgData, err := os.ReadFile(filepath.Join(projectPath, "package.json"))
	if err == nil {
		if strings.Contains(string(pkgData), "\"tailwindcss\"") {
			return true, "in package.json (no config file)"
		}
	}

	return false, ""
}

func getLastGHRunStatus(projectPath string) (bool, string) {
	if _, err := exec.LookPath("gh"); err != nil {
		return false, "gh CLI not installed"
	}
	cmd := exec.Command("gh", "run", "list", "--limit", "1", "--json", "conclusion,status,name")
	cmd.Dir = projectPath
	output, err := cmd.Output()
	if err != nil {
		return false, "unable to fetch"
	}
	var runs []struct {
		Conclusion string `json:"conclusion"`
		Status     string `json:"status"`
		Name       string `json:"name"`
	}
	if err := json.Unmarshal(output, &runs); err != nil || len(runs) == 0 {
		return false, "no runs found"
	}
	run := runs[0]
	if run.Status == "in_progress" || run.Status == "queued" {
		return true, "in progress"
	}
	passed := run.Conclusion == "success"
	detail := run.Conclusion
	if run.Name != "" {
		detail = run.Name + ": " + detail
	}
	return passed, detail
}
