package main

import (
	"bufio"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"

	"github.com/kalor62/cyberlife/internal/logging"
	"github.com/kalor62/cyberlife/internal/platform"
	"github.com/wailsapp/wails/v2/pkg/runtime"
)

// GetVoiceLang returns the saved voice input language
func (a *App) GetVoiceLang() string {
	if a.stateManager == nil {
		return "en-US"
	}
	return a.stateManager.GetVoiceLang()
}

// SetVoiceLang saves the voice input language
func (a *App) SetVoiceLang(lang string) {
	if a.stateManager != nil {
		a.stateManager.SetVoiceLang(lang)
	}
}

// GetVoiceAutoSubmit returns the saved voice auto-submit setting
func (a *App) GetVoiceAutoSubmit() bool {
	if a.stateManager == nil {
		return true
	}
	return a.stateManager.GetVoiceAutoSubmit()
}

// SetVoiceAutoSubmit saves the voice auto-submit setting
func (a *App) SetVoiceAutoSubmit(enabled bool) {
	if a.stateManager != nil {
		a.stateManager.SetVoiceAutoSubmit(enabled)
	}
}

// StartVoiceRecognition starts native macOS speech recognition.
// Returns "OK" on success or "ERROR: ..." on failure.
func (a *App) StartVoiceRecognition(lang string) string {
	// The helper is Swift against Speech.framework, so there is nothing to
	// compile or run elsewhere — say so instead of failing on a missing swiftc.
	if !platform.IsMac() {
		return "ERROR: dictation needs macOS (Speech.framework); use the ElevenLabs engine instead"
	}

	a.voiceMu.Lock()
	defer a.voiceMu.Unlock()

	// Stop any existing voice process
	if a.voiceProcess != nil {
		a.stopVoiceProcessLocked()
	}

	// Find the voice_input binary using same candidate pattern as Python bridge
	execPath, _ := os.Executable()
	baseDir := filepath.Dir(execPath)
	candidates := []string{
		filepath.Join(baseDir, "..", "..", "..", "..", "..", "scripts", "voice_input"),
		filepath.Join(baseDir, "..", "..", "scripts", "voice_input"),
		filepath.Join(baseDir, "scripts", "voice_input"),
	}

	var binaryPath string
	for _, p := range candidates {
		if _, err := os.Stat(p); err == nil {
			binaryPath = p
			break
		}
	}

	if binaryPath == "" {
		// Try to compile it
		sourceCandidates := []string{
			filepath.Join(baseDir, "..", "..", "..", "..", "..", "scripts", "voice_input.swift"),
			filepath.Join(baseDir, "..", "..", "scripts", "voice_input.swift"),
			filepath.Join(baseDir, "scripts", "voice_input.swift"),
		}
		var sourcePath string
		for _, p := range sourceCandidates {
			if _, err := os.Stat(p); err == nil {
				sourcePath = p
				break
			}
		}
		if sourcePath == "" {
			return "ERROR: voice_input.swift not found"
		}

		targetPath := sourcePath[:len(sourcePath)-6] // strip .swift
		logging.Info("Compiling voice_input", "source", sourcePath, "target", targetPath)
		cmd := exec.Command("swiftc", "-O", "-o", targetPath, sourcePath, "-framework", "Speech", "-framework", "AVFoundation")
		if out, err := cmd.CombinedOutput(); err != nil {
			return "ERROR: compile failed: " + string(out)
		}
		binaryPath = targetPath
	}

	if lang == "" {
		lang = "en-US"
	}

	engine := "native"
	apiKey := ""
	if a.stateManager != nil {
		engine = a.stateManager.GetTranscriptionEngine()
		apiKey = a.stateManager.GetElevenLabsAPIKey()
	}
	if engine == "scribe" && !a.addonOn("elevenlabs") {
		return "ERROR: Voice Dictation (ElevenLabs) addon is disabled. Enable it in Settings → Addons."
	}
	if engine == "scribe" && apiKey == "" {
		return "ERROR: ElevenLabs API key not configured. Add it in Settings → ElevenLabs."
	}

	args := []string{lang}
	if engine == "scribe" {
		args = append(args, "--engine=scribe", "--key="+apiKey)
	}

	logging.Info("Starting voice recognition", "binary", binaryPath, "lang", lang, "engine", engine)
	cmd := exec.Command(binaryPath, args...)
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return "ERROR: " + err.Error()
	}
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return "ERROR: " + err.Error()
	}

	if err := cmd.Start(); err != nil {
		return "ERROR: " + err.Error()
	}

	a.voiceProcess = cmd
	a.voiceStdin = stdin

	// Read stdout in goroutine, emit events to frontend
	go func() {
		scanner := bufio.NewScanner(stdout)
		for scanner.Scan() {
			line := scanner.Text()
			var msg map[string]interface{}
			if err := json.Unmarshal([]byte(line), &msg); err == nil {
				runtime.EventsEmit(a.ctx, "voice-transcript", msg)
			}
		}
		runtime.EventsEmit(a.ctx, "voice-stopped", nil)
	}()

	return "OK"
}

// StopVoiceRecognition stops the voice recognition process
func (a *App) StopVoiceRecognition() {
	a.voiceMu.Lock()
	defer a.voiceMu.Unlock()

	if a.voiceProcess != nil {
		a.stopVoiceProcessLocked()
	}
}

// stopVoiceProcessLocked asks the helper to stop and reaps it. Write/Wait
// errors only mean the process is already gone, which is the state we want.
// Caller holds voiceMu.
func (a *App) stopVoiceProcessLocked() {
	if a.voiceStdin != nil {
		if _, err := a.voiceStdin.Write([]byte("stop\n")); err != nil {
			logging.Debug("voice: stop command not delivered", "error", err)
		}
		if err := a.voiceStdin.Close(); err != nil {
			logging.Debug("voice: stdin close failed", "error", err)
		}
		a.voiceStdin = nil
	}
	if err := a.voiceProcess.Wait(); err != nil {
		logging.Debug("voice: process exited with error", "error", err)
	}
	a.voiceProcess = nil
}

// ResetVoiceRecognition tells the voice process to restart its recognition
// task, dropping any in-flight partial transcript so the next stream starts fresh.
func (a *App) ResetVoiceRecognition() {
	a.voiceMu.Lock()
	defer a.voiceMu.Unlock()
	if a.voiceStdin != nil {
		if _, err := a.voiceStdin.Write([]byte("reset\n")); err != nil {
			logging.Warn("voice: reset command not delivered", "error", err)
		}
	}
}
