package git

import (
	"context"
	"fmt"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// ChangedFile represents a file with changes
type ChangedFile struct {
	Path   string `json:"path"`
	Status string `json:"status"` // M = modified, A = added, D = deleted, ? = untracked
	Staged bool   `json:"staged"`
}

// FileDiff represents the diff content for a file
type FileDiff struct {
	Path        string `json:"path"`
	OldContent  string `json:"oldContent"`
	NewContent  string `json:"newContent"`
	DiffContent string `json:"diffContent"`
}

// Manager handles git operations
type Manager struct{}

// NewManager creates a new git manager
func NewManager() *Manager {
	return &Manager{}
}

// IsGitRepo checks if the path is a git repository
func (m *Manager) IsGitRepo(path string) bool {
	gitDir := filepath.Join(path, ".git")
	cmd := exec.CommandContext(gitCtx(), "git", "-C", path, "rev-parse", "--git-dir")
	err := cmd.Run()
	if err != nil {
		// Check if .git directory exists
		cmd = exec.Command("test", "-d", gitDir)
		return cmd.Run() == nil
	}
	return true
}

// GetChangedFiles returns list of changed files
func (m *Manager) GetChangedFiles(path string) ([]ChangedFile, error) {
	var files []ChangedFile

	// Get staged files
	stagedCmd := exec.CommandContext(gitCtx(), "git", "-C", path, "diff", "--cached", "--name-status")
	stagedOutput, _ := stagedCmd.Output()
	for _, line := range strings.Split(string(stagedOutput), "\n") {
		if line == "" {
			continue
		}
		parts := strings.Fields(line)
		if len(parts) >= 2 {
			files = append(files, ChangedFile{
				Path:   parts[1],
				Status: parts[0],
				Staged: true,
			})
		}
	}

	// Get unstaged modified files
	unstagedCmd := exec.CommandContext(gitCtx(), "git", "-C", path, "diff", "--name-status")
	unstagedOutput, _ := unstagedCmd.Output()
	for _, line := range strings.Split(string(unstagedOutput), "\n") {
		if line == "" {
			continue
		}
		parts := strings.Fields(line)
		if len(parts) >= 2 {
			// Check if already in staged
			found := false
			for _, f := range files {
				if f.Path == parts[1] {
					found = true
					break
				}
			}
			if !found {
				files = append(files, ChangedFile{
					Path:   parts[1],
					Status: parts[0],
					Staged: false,
				})
			}
		}
	}

	// Get untracked files
	untrackedCmd := exec.CommandContext(gitCtx(), "git", "-C", path, "ls-files", "--others", "--exclude-standard")
	untrackedOutput, _ := untrackedCmd.Output()
	for _, line := range strings.Split(string(untrackedOutput), "\n") {
		if line == "" {
			continue
		}
		files = append(files, ChangedFile{
			Path:   line,
			Status: "?",
			Staged: false,
		})
	}

	return files, nil
}

// GetFileDiff returns the diff for a specific file
func (m *Manager) GetFileDiff(repoPath, filePath string) (*FileDiff, error) {
	diff := &FileDiff{
		Path: filePath,
	}

	// Get the diff content
	diffCmd := exec.CommandContext(gitCtx(), "git", "-C", repoPath, "diff", "--", filePath)
	diffOutput, _ := diffCmd.Output()

	// If no unstaged diff, check staged
	if len(diffOutput) == 0 {
		diffCmd = exec.CommandContext(gitCtx(), "git", "-C", repoPath, "diff", "--cached", "--", filePath)
		diffOutput, _ = diffCmd.Output()
	}

	diff.DiffContent = string(diffOutput)

	// Get old content (HEAD version)
	oldCmd := exec.CommandContext(gitCtx(), "git", "-C", repoPath, "show", "HEAD:"+filePath)
	oldOutput, _ := oldCmd.Output()
	diff.OldContent = string(oldOutput)

	// Get new content (working directory)
	fullPath := filepath.Join(repoPath, filePath)
	newCmd := exec.CommandContext(gitCtx(), "cat", "--", fullPath)
	newOutput, _ := newCmd.Output()
	diff.NewContent = string(newOutput)

	return diff, nil
}

// GetCurrentBranch returns the current branch name
func (m *Manager) GetCurrentBranch(path string) string {
	cmd := exec.CommandContext(gitCtx(), "git", "-C", path, "branch", "--show-current")
	output, err := cmd.Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(output))
}

// GetStatus returns a short status summary
func (m *Manager) GetStatus(path string) (staged, unstaged, untracked int) {
	files, err := m.GetChangedFiles(path)
	if err != nil {
		return 0, 0, 0
	}

	for _, f := range files {
		switch {
		case f.Staged:
			staged++
		case f.Status == "?":
			untracked++
		default:
			unstaged++
		}
	}

	return staged, unstaged, untracked
}

// CommitInfo represents detailed information about a commit
type CommitInfo struct {
	Hash         string       `json:"hash"`
	ShortHash    string       `json:"shortHash"`
	Subject      string       `json:"subject"` // First line of commit message
	Body         string       `json:"body"`    // Rest of commit message
	Author       string       `json:"author"`
	AuthorEmail  string       `json:"authorEmail"`
	Date         string       `json:"date"`         // ISO format
	RelativeDate string       `json:"relativeDate"` // "2 hours ago"
	Files        []CommitFile `json:"files"`
	Stats        CommitStats  `json:"stats"`
}

// CommitFile represents a file changed in a commit
type CommitFile struct {
	Path   string `json:"path"`
	Status string `json:"status"` // A, M, D, R
}

// CommitStats represents statistics for a commit
type CommitStats struct {
	FilesChanged int `json:"filesChanged"`
	Insertions   int `json:"insertions"`
	Deletions    int `json:"deletions"`
}

// GetCommitHistory returns the commit history for a repository
func (m *Manager) GetCommitHistory(repoPath string, limit int) ([]CommitInfo, error) {
	if limit <= 0 {
		limit = 50
	}

	// Format: hash|shortHash|subject|author|email|date|relativeDate
	// Use ASCII 0x1E (record separator) to handle subjects with pipes
	format := "%H%x1E%h%x1E%s%x1E%an%x1E%ae%x1E%aI%x1E%ar%x1E%b%x00"

	cmd := exec.CommandContext(gitCtx(), "git", "-C", repoPath, "log",
		"--format="+format,
		"-n", fmt.Sprintf("%d", limit),
		"--no-merges")

	output, err := cmd.Output()
	if err != nil {
		return nil, err
	}

	commits := []CommitInfo{}
	entries := strings.Split(string(output), "\x00")

	for _, entry := range entries {
		entry = strings.TrimSpace(entry)
		if entry == "" {
			continue
		}

		parts := strings.Split(entry, "\x1E")
		if len(parts) < 7 {
			continue
		}

		commit := CommitInfo{
			Hash:         parts[0],
			ShortHash:    parts[1],
			Subject:      parts[2],
			Author:       parts[3],
			AuthorEmail:  parts[4],
			Date:         parts[5],
			RelativeDate: parts[6],
		}

		if len(parts) > 7 {
			commit.Body = strings.TrimSpace(parts[7])
		}

		// Get files and stats for this commit
		commit.Files, commit.Stats = m.getCommitDetails(repoPath, commit.Hash)

		commits = append(commits, commit)
	}

	return commits, nil
}

// getCommitDetails returns files and stats for a specific commit
func (m *Manager) getCommitDetails(repoPath, hash string) ([]CommitFile, CommitStats) {
	files := []CommitFile{}
	stats := CommitStats{}

	// Get file list with status
	cmd := exec.CommandContext(gitCtx(), "git", "-C", repoPath, "show", "--name-status", "--format=", hash)
	output, err := cmd.Output()
	if err != nil {
		return files, stats
	}

	for _, line := range strings.Split(string(output), "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}

		parts := strings.Fields(line)
		if len(parts) >= 2 {
			files = append(files, CommitFile{
				Status: parts[0],
				Path:   parts[1],
			})
		}
	}

	stats.FilesChanged = len(files)

	// Get insertions/deletions
	cmd = exec.CommandContext(gitCtx(), "git", "-C", repoPath, "show", "--numstat", "--format=", hash)
	output, err = cmd.Output()
	if err != nil {
		return files, stats
	}

	for _, line := range strings.Split(string(output), "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}

		parts := strings.Fields(line)
		if len(parts) >= 2 {
			if ins, err := strconv.Atoi(parts[0]); err == nil {
				stats.Insertions += ins
			}
			if del, err := strconv.Atoi(parts[1]); err == nil {
				stats.Deletions += del
			}
		}
	}

	return files, stats
}

// gitCtx bounds every git invocation; a hung network remote or a lock file
// must not freeze the UI thread that called us
func gitCtx() context.Context {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	go func() {
		<-ctx.Done()
		cancel()
	}()
	return ctx
}
