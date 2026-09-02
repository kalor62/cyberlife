package logging

import (
	"strings"
	"testing"
)

func TestIsLogFile(t *testing.T) {
	tests := []struct {
		name     string
		filename string
		prefix   string
		want     bool
	}{
		{
			name:     "valid dated log file",
			filename: "app.2024-01-23.log",
			prefix:   "app",
			want:     true,
		},
		{
			name:     "symlink file (just prefix.log)",
			filename: "app.log",
			prefix:   "app",
			want:     false,
		},
		{
			name:     "wrong prefix",
			filename: "other.2024-01-23.log",
			prefix:   "app",
			want:     false,
		},
		{
			name:     "not a log file",
			filename: "app.2024-01-23.txt",
			prefix:   "app",
			want:     false,
		},
		{
			name:     "too short filename",
			filename: "app.log",
			prefix:   "app",
			want:     false,
		},
		{
			name:     "different prefix length",
			filename: "myapp.2024-01-23.log",
			prefix:   "myapp",
			want:     true,
		},
		{
			name:     "empty filename",
			filename: "",
			prefix:   "app",
			want:     false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := isLogFile(tt.filename, tt.prefix)
			if got != tt.want {
				t.Errorf("isLogFile(%q, %q) = %v, want %v", tt.filename, tt.prefix, got, tt.want)
			}
		})
	}
}

func TestSanitizeData(t *testing.T) {
	tests := []struct {
		name string
		data map[string]interface{}
		want map[string]interface{}
	}{
		{
			name: "nil data",
			data: nil,
			want: nil,
		},
		{
			name: "empty data",
			data: map[string]interface{}{},
			want: map[string]interface{}{},
		},
		{
			name: "normal data",
			data: map[string]interface{}{
				"name":  "test",
				"count": 42,
			},
			want: map[string]interface{}{
				"name":  "test",
				"count": 42,
			},
		},
		{
			name: "password field",
			data: map[string]interface{}{
				"username": "admin",
				"password": "secret123",
			},
			want: map[string]interface{}{
				"username": "admin",
				"password": "[REDACTED]",
			},
		},
		{
			name: "token field",
			data: map[string]interface{}{
				"access_token": "abc123xyz",
				"user_id":      "123",
			},
			want: map[string]interface{}{
				"access_token": "[REDACTED]",
				"user_id":      "123",
			},
		},
		{
			name: "api_key field",
			data: map[string]interface{}{
				"api_key": "secret-key",
				"name":    "test",
			},
			want: map[string]interface{}{
				"api_key": "[REDACTED]",
				"name":    "test",
			},
		},
		{
			name: "apiKey camelCase",
			data: map[string]interface{}{
				"apiKey": "secret-key",
			},
			want: map[string]interface{}{
				"apiKey": "[REDACTED]",
			},
		},
		{
			name: "mixed case password",
			data: map[string]interface{}{
				"Password":     "secret",
				"userPassword": "secret",
			},
			want: map[string]interface{}{
				"Password":     "[REDACTED]",
				"userPassword": "[REDACTED]",
			},
		},
		{
			name: "authorization header",
			data: map[string]interface{}{
				"authorization": "Bearer token123",
				"content-type":  "application/json",
			},
			want: map[string]interface{}{
				"authorization": "[REDACTED]",
				"content-type":  "application/json",
			},
		},
		{
			name: "session and cookie",
			data: map[string]interface{}{
				"sessionId": "abc123",
				"cookies":   "session=xyz",
			},
			want: map[string]interface{}{
				"sessionId": "[REDACTED]",
				"cookies":   "[REDACTED]",
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := sanitizeData(tt.data)

			if tt.want == nil {
				if got != nil {
					t.Errorf("sanitizeData() = %v, want nil", got)
				}
				return
			}

			if len(got) != len(tt.want) {
				t.Errorf("sanitizeData() length = %d, want %d", len(got), len(tt.want))
				return
			}

			for key, wantVal := range tt.want {
				gotVal, ok := got[key]
				if !ok {
					t.Errorf("sanitizeData() missing key %q", key)
					continue
				}
				if gotVal != wantVal {
					t.Errorf("sanitizeData()[%q] = %v, want %v", key, gotVal, wantVal)
				}
			}
		})
	}
}

func TestSanitizeDataTruncatesLongValues(t *testing.T) {
	// Create a string longer than MaxDataValueLength
	longString := strings.Repeat("a", MaxDataValueLength+100)

	data := map[string]interface{}{
		"longValue": longString,
	}

	got := sanitizeData(data)

	gotValue, ok := got["longValue"].(string)
	if !ok {
		t.Fatal("sanitizeData() did not return string for longValue")
	}

	if len(gotValue) > MaxDataValueLength+20 { // +20 for truncation suffix
		t.Errorf("sanitizeData() did not truncate long value, got length %d", len(gotValue))
	}

	if !strings.HasSuffix(gotValue, "...[truncated]") {
		t.Errorf("sanitizeData() truncated value should end with ...[truncated], got %q", gotValue[len(gotValue)-20:])
	}
}

func TestSanitizeDataLimitsKeys(t *testing.T) {
	// Create data with more than MaxDataSize keys
	data := make(map[string]interface{})
	for i := 0; i < MaxDataSize+10; i++ {
		data[string(rune('a'+i%26))+string(rune('0'+i/26))] = i
	}

	got := sanitizeData(data)

	if len(got) > MaxDataSize+1 { // +1 for _truncated flag
		t.Errorf("sanitizeData() did not limit keys, got %d keys, want max %d", len(got), MaxDataSize+1)
	}

	if _, ok := got["_truncated"]; !ok {
		t.Error("sanitizeData() did not set _truncated flag")
	}
}

func TestTruncateMessage(t *testing.T) {
	tests := []struct {
		name    string
		message string
		wantLen int
	}{
		{
			name:    "short message",
			message: "Hello world",
			wantLen: 11,
		},
		{
			name:    "exactly max length",
			message: strings.Repeat("a", MaxMessageLength),
			wantLen: MaxMessageLength,
		},
		{
			name:    "longer than max",
			message: strings.Repeat("a", MaxMessageLength+100),
			wantLen: MaxMessageLength + len("...[truncated]"),
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := truncateMessage(tt.message)
			if len(got) != tt.wantLen {
				t.Errorf("truncateMessage() length = %d, want %d", len(got), tt.wantLen)
			}

			if len(tt.message) > MaxMessageLength {
				if !strings.HasSuffix(got, "...[truncated]") {
					t.Error("truncateMessage() should end with ...[truncated]")
				}
			}
		})
	}
}

func TestValidateLogLevel(t *testing.T) {
	tests := []struct {
		name  string
		level string
		want  string
	}{
		{"debug", "debug", "debug"},
		{"info", "info", "info"},
		{"warn", "warn", "warn"},
		{"error", "error", "error"},
		{"uppercase DEBUG", "DEBUG", "debug"},
		{"mixed case Info", "Info", "info"},
		{"with spaces", "  warn  ", "warn"},
		{"invalid level", "invalid", "info"},
		{"empty string", "", "info"},
		{"trace (invalid)", "trace", "info"},
		{"fatal (invalid)", "fatal", "info"},
	}

	// Initialize a basic logger first to avoid nil pointer
	if err := Init(Config{
		LogDir:     "/tmp/test-logs",
		MaxAge:     DefaultMaxAge,
		JSONOutput: false,
		DevMode:    false,
	}); err != nil {
		t.Fatalf("Init failed: %v", err)
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := validateLogLevel(tt.level)
			if got != tt.want {
				t.Errorf("validateLogLevel(%q) = %q, want %q", tt.level, got, tt.want)
			}
		})
	}
}

func TestMaskPath(t *testing.T) {
	tests := []struct {
		name string
		path string
		want string
	}{
		{
			name: "absolute path without home",
			path: "/usr/local/bin",
			want: "/usr/local/bin",
		},
		{
			name: "relative path",
			path: "./config/app.yaml",
			want: "./config/app.yaml",
		},
		{
			name: "empty path",
			path: "",
			want: "",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := MaskPath(tt.path)
			// For paths not starting with home dir, should be unchanged
			if !strings.HasPrefix(got, "~") && got != tt.want {
				t.Errorf("MaskPath(%q) = %q, want %q", tt.path, got, tt.want)
			}
		})
	}
}

func TestValidLogLevels(t *testing.T) {
	expectedLevels := []string{"debug", "info", "warn", "error"}

	for _, level := range expectedLevels {
		if !ValidLogLevels[level] {
			t.Errorf("ValidLogLevels missing expected level: %s", level)
		}
	}

	if len(ValidLogLevels) != len(expectedLevels) {
		t.Errorf("ValidLogLevels has %d levels, want %d", len(ValidLogLevels), len(expectedLevels))
	}
}

func TestSensitiveKeysCompleteness(t *testing.T) {
	// Verify common sensitive patterns are covered
	requiredPatterns := []string{
		"password", "token", "secret", "api_key", "authorization", "credential", "session", "cookie",
	}

	for _, pattern := range requiredPatterns {
		found := false
		for _, key := range SensitiveKeys {
			if strings.Contains(key, pattern) || strings.Contains(pattern, key) {
				found = true
				break
			}
		}
		if !found {
			t.Errorf("SensitiveKeys missing pattern for: %s", pattern)
		}
	}
}
