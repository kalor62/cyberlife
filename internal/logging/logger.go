package logging

import (
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// Constants for configuration
const (
	// DefaultMaxAge is the default retention period for log files (3 days)
	DefaultMaxAge = 3 * 24 * time.Hour

	// DirPermissions for log directory (rwxr-xr-x)
	DirPermissions = 0755

	// FilePermissions for log files (rw-r--r--)
	FilePermissions = 0644

	// MaxMessageLength is the maximum allowed length for log messages
	MaxMessageLength = 10000

	// MaxDataSize is the maximum allowed size for data map (number of keys)
	MaxDataSize = 50

	// MaxDataValueLength is the maximum length for individual data values
	MaxDataValueLength = 1000
)

// SensitiveKeys that should be redacted from logs
var SensitiveKeys = []string{
	"password", "passwd", "pwd",
	"token", "access_token", "refresh_token", "auth_token",
	"secret", "client_secret",
	"api_key", "apikey", "api-key",
	"authorization", "auth",
	"credential", "credentials",
	"private_key", "privatekey",
	"session", "sessionid", "session_id",
	"cookie", "cookies",
}

// ValidLogLevels defines accepted log levels
var ValidLogLevels = map[string]bool{
	"debug": true,
	"info":  true,
	"warn":  true,
	"error": true,
}

var (
	defaultLogger *slog.Logger
	loggerMu      sync.RWMutex
	currentConfig Config
	configMu      sync.RWMutex
)

// Config holds logger configuration
type Config struct {
	LogDir     string        // Directory for log files
	MaxAge     time.Duration // Maximum age of log files before cleanup
	JSONOutput bool          // Use JSON output format
	DevMode    bool          // Enable console output for development
}

// DefaultConfig returns the default configuration
func DefaultConfig() Config {
	homeDir, _ := os.UserHomeDir()
	return Config{
		LogDir:     filepath.Join(homeDir, ".cyberlife", "logs"),
		MaxAge:     DefaultMaxAge,
		JSONOutput: true,
		DevMode:    false,
	}
}

// GetConfig returns the current logger configuration
func GetConfig() Config {
	configMu.RLock()
	defer configMu.RUnlock()
	return currentConfig
}

// IsDevMode returns whether the logger is in development mode
func IsDevMode() bool {
	configMu.RLock()
	defer configMu.RUnlock()
	return currentConfig.DevMode
}

// RotatingFileHandler handles log rotation by date
type RotatingFileHandler struct {
	dir            string
	prefix         string
	maxAge         time.Duration
	currentFile    *os.File
	currentDate    string
	mu             sync.Mutex
	cleanupRunning atomic.Bool // Prevents concurrent cleanup runs
}

// NewRotatingFileHandler creates a new rotating file handler
func NewRotatingFileHandler(dir, prefix string, maxAge time.Duration) (*RotatingFileHandler, error) {
	if err := os.MkdirAll(dir, DirPermissions); err != nil {
		return nil, err
	}

	h := &RotatingFileHandler{
		dir:    dir,
		prefix: prefix,
		maxAge: maxAge,
	}

	if err := h.rotate(); err != nil {
		return nil, err
	}

	return h, nil
}

// Write implements io.Writer
func (h *RotatingFileHandler) Write(p []byte) (n int, err error) {
	h.mu.Lock()
	defer h.mu.Unlock()

	today := time.Now().Format("2006-01-02")
	if today != h.currentDate {
		if err := h.rotate(); err != nil {
			return 0, err
		}
		// Run cleanup asynchronously with debounce (only if not already running)
		if h.cleanupRunning.CompareAndSwap(false, true) {
			go func() {
				defer h.cleanupRunning.Store(false)
				h.cleanup()
			}()
		}
	}

	return h.currentFile.Write(p)
}

// rotate closes current file and opens new one for today
func (h *RotatingFileHandler) rotate() error {
	if h.currentFile != nil {
		if err := h.currentFile.Close(); err != nil {
			// the logger itself cannot log here; stderr is the only channel left
			fmt.Fprintf(os.Stderr, "logging: closing rotated file failed: %v\n", err)
		}
	}

	today := time.Now().Format("2006-01-02")
	filename := filepath.Join(h.dir, h.prefix+"."+today+".log")

	file, err := os.OpenFile(filename, os.O_CREATE|os.O_APPEND|os.O_WRONLY, FilePermissions)
	if err != nil {
		return err
	}

	h.currentFile = file
	h.currentDate = today

	// Also create/update a symlink to current log
	h.updateSymlink(filename)

	return nil
}

// updateSymlink creates or updates symlink to current log file
func (h *RotatingFileHandler) updateSymlink(targetFile string) {
	symlinkPath := filepath.Join(h.dir, h.prefix+".log")

	// Remove old symlink if exists
	if err := os.Remove(symlinkPath); err != nil && !os.IsNotExist(err) {
		// Log warning but don't fail - symlink is convenience feature
		slog.Warn("Failed to remove old symlink", "path", symlinkPath, "error", err)
	}

	// Create new symlink
	if err := os.Symlink(targetFile, symlinkPath); err != nil {
		slog.Warn("Failed to create symlink", "path", symlinkPath, "target", targetFile, "error", err)
	}
}

// cleanup removes log files older than maxAge
func (h *RotatingFileHandler) cleanup() {
	entries, err := os.ReadDir(h.dir)
	if err != nil {
		slog.Warn("Failed to read log directory for cleanup", "dir", h.dir, "error", err)
		return
	}

	cutoff := time.Now().Add(-h.maxAge)
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}

		// Skip symlinks and non-log files
		name := entry.Name()
		if !isLogFile(name, h.prefix) {
			continue
		}

		info, err := entry.Info()
		if err != nil {
			continue
		}

		if info.ModTime().Before(cutoff) {
			filePath := filepath.Join(h.dir, name)
			if err := os.Remove(filePath); err != nil {
				slog.Warn("Failed to remove old log file", "path", filePath, "error", err)
			}
		}
	}
}

// isLogFile checks if a filename matches the log pattern
func isLogFile(name, prefix string) bool {
	// Pattern: prefix.YYYY-MM-DD.log (e.g., "app.2024-01-23.log")
	// Minimum length: prefix + "." + "YYYY-MM-DD" + ".log" = prefix + 15 chars
	expectedLen := len(prefix) + 15
	if len(name) < expectedLen {
		return false
	}

	// Check prefix
	if !strings.HasPrefix(name, prefix+".") {
		return false
	}

	// Check suffix
	if !strings.HasSuffix(name, ".log") {
		return false
	}

	// Check that it's a dated log (not the symlink which is just "prefix.log")
	return len(name) > len(prefix)+5 // More than "prefix.log"
}

// Close closes the file handler
func (h *RotatingFileHandler) Close() error {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.currentFile != nil {
		return h.currentFile.Close()
	}
	return nil
}

// MultiWriter writes to multiple io.Writers
type MultiWriter struct {
	writers []io.Writer
}

// NewMultiWriter creates a new multi-writer
func NewMultiWriter(writers ...io.Writer) *MultiWriter {
	return &MultiWriter{writers: writers}
}

func (mw *MultiWriter) Write(p []byte) (n int, err error) {
	for _, w := range mw.writers {
		n, err = w.Write(p)
		if err != nil {
			return
		}
	}
	return len(p), nil
}

// Init initializes the global logger with the given configuration
func Init(cfg Config) error {
	loggerMu.Lock()
	defer loggerMu.Unlock()

	// Store config for later access
	configMu.Lock()
	currentConfig = cfg
	configMu.Unlock()

	var writers []io.Writer

	// Add file output
	fileHandler, err := NewRotatingFileHandler(cfg.LogDir, "app", cfg.MaxAge)
	if err != nil {
		return err
	}
	writers = append(writers, fileHandler)

	// Add stdout in dev mode
	if cfg.DevMode {
		writers = append(writers, os.Stdout)
	}

	// Create multi-writer
	multiWriter := NewMultiWriter(writers...)

	// Create handler based on output format
	var handler slog.Handler
	opts := &slog.HandlerOptions{
		Level: slog.LevelDebug,
		ReplaceAttr: func(groups []string, a slog.Attr) slog.Attr {
			// Format time as ISO8601
			if a.Key == slog.TimeKey {
				if t, ok := a.Value.Any().(time.Time); ok {
					a.Value = slog.StringValue(t.Format(time.RFC3339Nano))
				}
			}
			return a
		},
	}

	if cfg.JSONOutput {
		handler = slog.NewJSONHandler(multiWriter, opts)
	} else {
		handler = slog.NewTextHandler(multiWriter, opts)
	}

	defaultLogger = slog.New(handler)
	slog.SetDefault(defaultLogger)

	return nil
}

// InitDefault initializes the logger with default configuration
func InitDefault() error {
	return Init(DefaultConfig())
}

// Logger returns the default logger
func Logger() *slog.Logger {
	loggerMu.RLock()
	defer loggerMu.RUnlock()
	if defaultLogger == nil {
		return slog.Default()
	}
	return defaultLogger
}

// Debug logs at debug level
func Debug(msg string, args ...any) {
	Logger().Debug(msg, args...)
}

// Info logs at info level
func Info(msg string, args ...any) {
	Logger().Info(msg, args...)
}

// Warn logs at warn level
func Warn(msg string, args ...any) {
	Logger().Warn(msg, args...)
}

// Error logs at error level
func Error(msg string, args ...any) {
	Logger().Error(msg, args...)
}

// With returns a logger with additional attributes
func With(args ...any) *slog.Logger {
	return Logger().With(args...)
}

// LogEntry represents a frontend log entry
type LogEntry struct {
	Level   string                 `json:"level"`
	Module  string                 `json:"module"`
	Message string                 `json:"message"`
	Data    map[string]interface{} `json:"data,omitempty"`
}

// sanitizeData removes or redacts sensitive information from log data
func sanitizeData(data map[string]interface{}) map[string]interface{} {
	if data == nil {
		return nil
	}

	// Limit number of keys
	if len(data) > MaxDataSize {
		sanitized := make(map[string]interface{})
		count := 0
		for k, v := range data {
			if count >= MaxDataSize {
				sanitized["_truncated"] = true
				break
			}
			sanitized[k] = v
			count++
		}
		data = sanitized
	}

	result := make(map[string]interface{}, len(data))

	for key, value := range data {
		lowerKey := strings.ToLower(key)

		// Check if key contains sensitive pattern
		isSensitive := false
		for _, sensitiveKey := range SensitiveKeys {
			if strings.Contains(lowerKey, sensitiveKey) {
				isSensitive = true
				break
			}
		}

		if isSensitive {
			result[key] = "[REDACTED]"
			continue
		}

		// Truncate long string values
		if strVal, ok := value.(string); ok {
			if len(strVal) > MaxDataValueLength {
				result[key] = strVal[:MaxDataValueLength] + "...[truncated]"
				continue
			}
		}

		result[key] = value
	}

	return result
}

// truncateMessage truncates message if it exceeds maximum length
func truncateMessage(msg string) string {
	if len(msg) > MaxMessageLength {
		return msg[:MaxMessageLength] + "...[truncated]"
	}
	return msg
}

// validateLogLevel validates and normalizes log level
func validateLogLevel(level string) string {
	normalizedLevel := strings.ToLower(strings.TrimSpace(level))
	if ValidLogLevels[normalizedLevel] {
		return normalizedLevel
	}
	// Log warning for invalid level and default to info
	Logger().Warn("Invalid log level from frontend, defaulting to info",
		"providedLevel", level,
		"validLevels", []string{"debug", "info", "warn", "error"})
	return "info"
}

// MaskPath masks sensitive parts of file paths for logging
func MaskPath(path string) string {
	homeDir, err := os.UserHomeDir()
	if err != nil {
		return path
	}

	// Replace home directory with ~
	if strings.HasPrefix(path, homeDir) {
		return "~" + path[len(homeDir):]
	}

	return path
}

// LogFromFrontend logs a message from the frontend with sanitization
func LogFromFrontend(entry LogEntry) {
	// Validate and normalize log level
	level := validateLogLevel(entry.Level)

	// Truncate message if too long
	message := truncateMessage(entry.Message)

	// Sanitize data
	sanitizedData := sanitizeData(entry.Data)

	logger := Logger().With(
		"source", "frontend",
		"module", entry.Module,
	)

	// Add data fields if present
	if len(sanitizedData) > 0 {
		logger = logger.With("data", sanitizedData)
	}

	switch level {
	case "debug":
		logger.Debug(message)
	case "info":
		logger.Info(message)
	case "warn":
		logger.Warn(message)
	case "error":
		logger.Error(message)
	}
}
