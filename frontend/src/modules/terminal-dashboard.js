// Terminal Dashboard - iTerm2 monitoring with inline output viewer

import { escapeHtml, escapeAttr } from './utils.js';
import * as bus from './bus.js';
import { state } from './state.js';
import { registerStateHandler, switchProject } from './project-switcher.js';
import { updateWorkspaceInfo, openEditProjectModal, selectProject, getAccountBadge } from './projects.js';
import { TERMINAL_THEMES, getThemeByName } from './terminal-themes.js';
import { loadClaudeAccounts, buildAccountOptions, attachAccountSelect } from './claude-accounts.js';
import { buildGroupOptions, toggleGroupCollapsed, deleteGroup, openGroupModal } from './project-groups.js';
import { refreshGitStatus } from './git.js';
import { renderTabbedIconPicker } from './icon-catalog.js';
import { GetITermSessionInfo, GetITermStatus, SwitchITermTabBySessionID, OpenTmuxInITerm, CreateITermTab, RenameITermTabBySessionID, CloseITermTabBySessionID, WatchITermSession, UnwatchITermSession, WriteITermTextBySessionID, SendITermSpecialKey, GetTerminalTheme, SetTerminalTheme, GetTerminalFontSize, SetTerminalFontSize, GetITermSessionContentsByID, PasteClipboardToSession, StartVoiceRecognition, StopVoiceRecognition, ResetVoiceRecognition, FocusITerm, RequestStyledHistory, GetVoiceLang, SetVoiceLang, GetVoiceAutoSubmit, SetVoiceAutoSubmit, GetTranscriptionEngine, SetTranscriptionEngine, GetElevenLabsAPIKey, GetDashboardFullscreen, SetDashboardFullscreen, SaveScreenshot, GetProjectPrompts, GetGlobalPrompts, IncrementPromptUsage, DeleteProject, UpdateProject, GetPinnedTerminals, SetPinnedTerminal, GetTerminalNameOverrides, SetTerminalNameOverride, GetTerminalAccounts, SetTerminalAccount, ClearTerminalAccount, GetRunners, GetDefaultRunner, GetTerminalRunners, SetTerminalRunner, CreateITermTabWithRunner, CheckDependencies, SetTermViewSize, GetClaudeSessions } from '../../wailsjs/go/main/App';
import { EventsOn } from '../../wailsjs/runtime/runtime';
import { getMode, setMode } from './shell.js';
import { toggleTermMenu } from './term-menu.js';
import { getClaudeStatusTitle } from './claude-status.js';

// Dashboard state
let dashboardState = {
  itermStatus: null,
  lastUpdate: null,
  selectedProjectName: null, // project selected on the left
  viewingSessionId: null,    // terminal being viewed on the right
  sessionContents: '',       // output text (plain fallback)
  styledLines: null,         // styled line data (array of arrays of runs)
  cursorPos: null,           // {x, y}
  termSize: null,            // {cols, rows}
  profileColors: null,       // {fg, bg, cursor, ansi: [...]}
  useStyledMode: false,      // whether styled content is active
  currentTheme: 'dracula',   // active theme name
  fontSize: 12,              // active font size
  themeMenuOpen: false,       // dropdown visibility
  historyLines: null,          // plain text history lines (from scrollback)
  historyLoading: false,       // loading indicator
  historySizeAtLoad: 0,        // tmux history_size when historyLines was captured
  voiceState: 'idle',
  voiceBuffer: '',
  voiceLang: 'en-US',
  voiceAutoSubmit: true,
  voiceConfigOpen: false,
  transcriptionEngine: 'native',
  elevenLabsConfigured: false,
  fullscreen: false,           // fullscreen mode (hide sidebars/tools)
  pastedImagePath: null,       // absolute path of pasted screenshot on disk
  pastedImageBase64: null,     // base64 data URI for thumbnail preview
  queueMode: false,            // when true, prompts go to queue instead of terminal
  promptQueue: [],             // queued prompts [{id, text}]
  pinnedPrompts: [],            // cached pinned prompts for the prompts popup
  promptsPopupOpen: false,
  pinnedTerminals: {},           // projectName -> terminal tab name (per-project pins)
  nameOverrides: {},             // sessionId -> custom name (fallback B)
  terminalAccounts: {},          // sessionId -> CLAUDE_CONFIG_DIR (which Claude account the terminal uses)
  terminalRunners: {},           // sessionId -> runner ID (absent = claude)
  runners: [],                   // available runners (claude built-in first)
  defaultRunner: '',             // global default runner id (empty = claude)
  deps: null,                    // dependency check results (tmux, claude, ...)
  flatProjectList: localStorage.getItem('flatProjectList') === '1', // show projects without group accordions
  jiraEnabled: false,            // Jira integration on — shows the tasks/tickets badge on project tiles
};

// ============================================
// Helpers
// ============================================

// Stores sessionId → projectName for tabs WE created
const tabProjectMap = {};

// Get pinned terminal name for the currently selected project
function getPinnedNameForCurrentProject() {
  const proj = dashboardState.selectedProjectName;
  return proj ? dashboardState.pinnedTerminals[proj] || null : null;
}

// Set pinned terminal name for the currently selected project
function setPinForCurrentProject(tabName) {
  const proj = dashboardState.selectedProjectName;
  if (!proj) return;
  if (tabName) {
    dashboardState.pinnedTerminals[proj] = tabName;
  } else {
    delete dashboardState.pinnedTerminals[proj];
  }
  SetPinnedTerminal(proj, tabName || '').catch(() => {});
}

// Apply local name overrides to tabs from iTerm2 status
// Detects out-of-sync: if iTerm2 reverted a renamed tab, local override wins
// Only tmux-backed sessions can be streamed, so plain iTerm2 tabs never enter
// the session list — listing them would offer sessions that cannot be watched.
// Every consumer (Term tabs, Projects badges, quick switcher, task reuse) reads
// the list through here, so the filter lives at this one door.
function adoptITermStatus(status) {
  const tabs = (status?.tabs || []).filter(t => t.sessionId?.startsWith('tmux:'));
  applyNameOverrides(tabs);
  const adopted = { ...(status || {}), tabs };
  dashboardState.itermStatus = adopted;
  return adopted;
}

function applyNameOverrides(tabs) {
  if (!tabs) return;
  const overrides = dashboardState.nameOverrides;
  for (const tab of tabs) {
    const override = overrides[tab.sessionId];
    if (override && tab.name !== override) {
      // Out of sync — iTerm2 reverted the name, use local override
      tab.name = override;
    }
  }
}

// Get tabs matching a project name
function getTabsForProject(allTabs, projectName, projectPath, taskPaths) {
  if (!projectName) return [];
  return allTabs.filter(tab => {
    // Match by our own mapping (most reliable - tabs we created)
    if (tabProjectMap[tab.sessionId] === projectName) return true;
    // Match by name
    if (tab.name === projectName || tab.name.startsWith(projectName + ' ')) return true;
    // Match by tmux-sanitized name (tmux sessions replace unsafe chars with '-')
    const dashed = projectName.replace(/[^A-Za-z0-9_-]/g, '-');
    if (tab.name === dashed || tab.name.startsWith(dashed + '-')) return true;
    // Match by exact working directory path
    if (projectPath && tab.path && tab.path === projectPath) return true;
    // Match by task worktree path (survives app restart)
    if (taskPaths && tab.path && taskPaths.has(tab.path)) return true;
    return false;
  });
}

// Build project groups from all iTerm tabs + Cyber Life projects
function buildProjectGroups(allTabs) {
  const groups = []; // { name, path, tabs[], icon, color }
  const matched = new Set();

  // Show ALL Cyber Life projects (same order as top tabs)
  const projects = state.projects || [];
  for (const proj of projects) {
    const taskPaths = new Set((proj.tasks || []).flatMap(t => [t.worktreePath, ...(t.repos || []).map(r => r.worktreePath)]).filter(Boolean));
    const tabs = getTabsForProject(allTabs.filter(t => !matched.has(t.sessionId)), proj.name, proj.path, taskPaths);
    tabs.forEach(t => matched.add(t.sessionId));
    groups.push({
      name: proj.name,
      path: proj.path,
      icon: proj.icon || '',
      color: proj.color || '',
      tabs,
    });
  }

  // Collect unmatched tabs under "Other"
  const otherTabs = allTabs.filter(t => !matched.has(t.sessionId));
  if (otherTabs.length > 0) {
    groups.push({
      name: 'Other',
      path: '',
      icon: '',
      color: '',
      tabs: otherTabs,
    });
  }

  return groups;
}

// Worst-first: a session waiting for the user outranks one still working,
// which outranks idle — the project dot shows what most needs attention
// Heartbeat files are the authoritative source (~/.claude/sessions, matched
// by working dir); the output-analysis detector only fills in when a tab has
// no heartbeat — e.g. a claude started before the heartbeat feature.
function aggregateClaudeStatus(tabs) {
  const rank = { needs_action: 0, working: 1, idle: 2, none: 3 };
  let best = 'none';
  for (const t of tabs) {
    const hb = claudeDotByCwd.get(t.path);
    const s = hb === 'waiting' ? 'needs_action' : (hb || state.claudeStatus?.get?.(t.sessionId) || 'none');
    if (rank[s] < rank[best]) best = s;
  }
  return best;
}

// projectName -> { count, status, firstSessionId } for projects with live sessions
export function getProjectSessionInfo() {
  const info = new Map();
  for (const g of buildProjectGroups(getAllTerminalTabs())) {
    if (g.name === 'Other' || g.tabs.length === 0) continue;
    info.set(g.name, {
      count: g.tabs.length,
      status: aggregateClaudeStatus(g.tabs),
      firstSessionId: g.tabs[0].sessionId,
    });
  }
  return info;
}

// Get next tab number for a project
function getNextTabNumber(allTabs, projectName) {
  if (!projectName) return 1;
  const projectTabs = allTabs.filter(tab => tab.name.startsWith(projectName + ' ') || tab.name.startsWith(projectName + '-'));
  let maxNum = 0;
  projectTabs.forEach(tab => {
    const match = tab.name.match(new RegExp(`^${escapeRegex(projectName)}[ -](\\d+)$`));
    if (match) {
      const num = parseInt(match[1], 10);
      if (num > maxNum) maxNum = num;
    }
  });
  return maxNum + 1;
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}


// Show context menu for project items (Edit / Delete)
function showProjectContextMenu(e, projectName) {
  // Remove any existing context menu
  const existing = document.querySelector('.project-context-menu');
  if (existing) existing.remove();

  const project = (state.projects || []).find(p => p.name === projectName);
  if (!project) return;

  const safeName = escapeAttr(project.name);

  const isPinned = project.pinned;

  const menu = document.createElement('div');
  menu.className = 'prompt-context-menu project-context-menu';
  menu.innerHTML = `
    <button class="context-menu-item" data-act="_projectCtxPin" data-arg="${safeName}">${isPinned ? 'Unpin' : 'Pin'}</button>
    <button class="context-menu-item" data-act="_projectCtxEdit" data-arg="${safeName}">Edit</button>
    <button class="context-menu-item danger" data-act="_projectCtxDelete" data-arg="${safeName}">Delete</button>
  `;

  menu.style.position = 'fixed';
  menu.style.left = `${e.clientX}px`;
  menu.style.top = `${e.clientY}px`;

  document.body.appendChild(menu);

  // Close on click outside
  const closeMenu = (ev) => {
    if (!menu.contains(ev.target)) {
      menu.remove();
      document.removeEventListener('mousedown', closeMenu);
    }
  };
  setTimeout(() => document.addEventListener('mousedown', closeMenu), 0);
}

function dismissProjectContextMenu() {
  const menu = document.querySelector('.project-context-menu');
  if (menu) menu.remove();
}

window._projectCtxPin = async function(projectName) {
  dismissProjectContextMenu();
  const project = (state.projects || []).find(p => p.name === projectName);
  if (!project) return;
  try {
    project.pinned = !project.pinned;
    await UpdateProject(project);
    renderTerminalDashboard();
  } catch (err) {
    console.error('Failed to pin/unpin project:', err);
  }
};

window._projectCtxEdit = async function(projectName) {
  dismissProjectContextMenu();
  const project = (state.projects || []).find(p => p.name === projectName);
  if (!project) return;
  if (state.activeProject?.id !== project.id) {
    await selectProject(project.id);
  }
  openEditProjectModal();
};

window._projectCtxDelete = async function(projectName) {
  dismissProjectContextMenu();
  const project = (state.projects || []).find(p => p.name === projectName);
  if (!project) {
    alert('Project not found: ' + projectName);
    return;
  }
  try {
    await DeleteProject(project.id);
    const idx = state.projects.findIndex(p => p.id === project.id);
    if (idx >= 0) state.projects.splice(idx, 1);
    if (state.activeProject?.id === project.id) {
      if (state.projects.length > 0) {
        await selectProject(state.projects[0].id);
      } else {
        state.activeProject = null;
      }
      updateWorkspaceInfo();
    }
    renderTerminalDashboard();
  } catch (err) {
    alert('Error deleting project: ' + err);
  }
};

// Show context menu for group headers (Edit / Delete)
function showGroupContextMenu(e, groupId) {
  const existing = document.querySelector('.project-context-menu');
  if (existing) existing.remove();

  const group = (state.projectGroups || []).find(g => g.id === groupId);
  if (!group) return;

  const menu = document.createElement('div');
  menu.className = 'prompt-context-menu project-context-menu';
  menu.innerHTML = `
    <button class="context-menu-item" data-act="_groupCtxEdit" data-arg="${groupId}">Edit</button>
    <button class="context-menu-item danger" data-act="_groupCtxDelete" data-arg="${groupId}">Delete</button>
  `;

  menu.style.position = 'fixed';
  menu.style.left = `${e.clientX}px`;
  menu.style.top = `${e.clientY}px`;

  document.body.appendChild(menu);

  const closeMenu = (ev) => {
    if (!menu.contains(ev.target)) {
      menu.remove();
      document.removeEventListener('mousedown', closeMenu);
    }
  };
  setTimeout(() => document.addEventListener('mousedown', closeMenu), 0);
}

window._groupToggle = async function(groupId) {
  await toggleGroupCollapsed(groupId);
  renderTerminalDashboard();
};

window._groupCtxEdit = function(groupId) {
  dismissProjectContextMenu();
  openGroupModal(groupId);
};

window._groupCtxDelete = async function(groupId) {
  dismissProjectContextMenu();
  try {
    await deleteGroup(groupId);
    renderTerminalDashboard();
  } catch (err) {
    alert('Error deleting group: ' + err);
  }
};

function accountConfigDirForSession(sessionId) {
  if (sessionId && sessionId in dashboardState.terminalAccounts) {
    return dashboardState.terminalAccounts[sessionId];
  }
  const projectName = sessionId ? tabProjectMap[sessionId] : null;
  const proj = (state.projects || []).find(p => p.name === (projectName || state.activeProject?.name));
  return proj?.claudeConfigDir || '';
}

function accountBadgeHtml(sessionId) {
  const account = getAccountBadge(accountConfigDirForSession(sessionId));
  const title = escapeHtml(account.title).replace(/"/g, '&quot;');
  return `<span class="account-badge account-${account.kind} term-account-badge" title="${title}">${escapeHtml(account.label)}</span>`;
}

function resolvedDefaultRunner(proj) {
  const candidates = [proj?.defaultRunner, dashboardState.defaultRunner, 'claude'];
  const runners = dashboardState.runners || [];
  for (const id of candidates) {
    if (id && runners.some(r => r.id === id)) return id;
  }
  return 'claude';
}

function runnerBadgeHtml(sessionId) {
  const runnerId = dashboardState.terminalRunners[sessionId];
  if (!runnerId || runnerId === 'claude') return '';
  const runner = (dashboardState.runners || []).find(r => r.id === runnerId);
  if (!runner) return '';
  const title = escapeHtml(runner.name).replace(/"/g, '&quot;');
  return `<span class="term-runner-badge" style="--runner-color:${runner.color || '#8b5cf6'}" title="${title}">${runner.icon || '▶'}</span> `;
}

function renderDependencyGuide(canCreate) {
  const deps = dashboardState.deps || [];
  const missingRequired = deps.some(d => d.required && !d.ok);
  return `
    <div class="deps-guide">
      <div class="setup-guide-title">${missingRequired ? 'Missing dependencies' : 'Getting started'}</div>
      <p class="setup-guide-desc">${missingRequired
        ? 'Cyber Life needs these tools on this Mac. Install the missing ones, then re-check.'
        : 'All dependencies are in place — create a terminal to start a session.'}</p>
      <div class="deps-list">
        ${deps.map(d => `
          <div class="dep-row ${d.ok ? 'dep-ok' : d.required ? 'dep-missing' : 'dep-optional-missing'}">
            <span class="dep-status">${d.ok ? '✓' : d.required ? '✗' : '—'}</span>
            <div class="dep-info">
              <span class="dep-name">${d.name} ${d.required ? '' : '<em class="dep-optional">optional</em>'}</span>
              <span class="dep-purpose">${d.purpose}</span>
            </div>
            ${d.ok ? '' : `<code class="dep-hint">${d.hint}</code>`}
          </div>
        `).join('')}
      </div>
      <div class="deps-actions">
        ${canCreate && !missingRequired
          ? '<button class="fc-btn fc-btn-primary" data-act="itermCreateTab" title="New terminal (n)">Create terminal (n)</button>'
          : ''}
        <button class="fc-btn fc-btn-secondary" data-act="itermRecheckDeps" title="Re-check dependencies">↻ Re-check</button>
      </div>
    </div>
  `;
}

window.itermRecheckDeps = async function() {
  try {
    dashboardState.deps = await CheckDependencies() || [];
  } catch (err) {
    console.error('Dependency check failed:', err);
  }
  renderTerminalDashboard();
};

function termHintBarContent() {
  const chip = (act, key, label) => act
    ? `<button class="term-hint-chip" data-act="${act}"><kbd>${key}</kbd>${label}</button>`
    : `<span class="term-hint-chip"><kbd>${key}</kbd>${label}</span>`;
  if (getMode() === 'term') {
    return `
      <span class="term-hint-state term-hint-attached">ATTACHED</span>
      ${chip(null, 'A…Z', 'keys go to the session')}
      ${chip('termAttachToggle', '⌃U', 'detach')}
      ${chip('termMenuToggle', '⌘M', 'menu')}
      ${chip('itermToggleVoice', '⌘R', 'voice')}
      ${chip(null, '⌘V', 'paste')}
      ${chip(null, 'Esc', 'interrupt Claude')}
    `;
  }
  return `
    <span class="term-hint-state">NORMAL</span>
    ${chip(null, 'Enter/i', 'write in prompt')}
    ${chip('termAttachToggle', 'a', 'attach — type into session')}
    ${chip(null, 'j k', 'prev/next terminal')}
    ${chip('openProjectSwitcher', 'p', 'pick project')}
    ${chip('termMenuToggle', 'm', 'menu — voice & prompts')}
    ${chip('itermToggleVoice', '⌘R', 'voice')}
    ${chip(null, 'Esc', 'interrupt Claude')}
  `;
}

function renderWrappersToggleButton() {
  const enabled = window.isPromptWrappersEnabled ? window.isPromptWrappersEnabled() : true;
  const title = window.wrappersToggleTitle ? window.wrappersToggleTitle() : 'Toggle prompt wrappers';
  return `
    <button class="input-action-btn wrappers-toggle-btn ${enabled ? 'active' : ''}" id="wrappersToggleBtn" data-act="itermToggleWrappers" title="${title}">
      <span class="wrappers-toggle-label">P/A</span>
    </button>
  `;
}

function renderProjectBarButtons() {
  const info = getProjectSessionInfo();
  return (state.projects || [])
    .filter(p => info.has(p.name) && p.name !== state.activeProject?.name)
    .map(p => {
      const s = info.get(p.name);
      return `
      <button class="key-btn term-proj-btn"
              data-act="itermJumpProject" data-arg="${escapeAttr(p.name)}"
              style="--project-color: ${p.color || '#3b82f6'}"
              title="${escapeAttr(p.name)} — ${s.count} session${s.count > 1 ? 's' : ''} (${getClaudeStatusTitle(s.status) || 'no Claude'})">
        <span class="term-proj-dot claude-dot-${s.status}"></span>${p.icon ? `${p.icon} ` : ''}${escapeHtml(p.name)}${s.count > 1 ? `<span class="term-proj-count">${s.count}</span>` : ''}
      </button>`;
    }).join('');
}

function renderInputPanel(opts = {}) {
  const disabled = opts.disabled || false;
  const placeholder = opts.placeholder || 'Type command and press Enter...';
  const sessionId = opts.sessionId || dashboardState.viewingSessionId;
  const projectBar = renderProjectBarButtons();
  return `
              <div class="term-hint-bar" id="termHintBar">${termHintBarContent()}</div>
              <div class="keyboard-helper">
                ${state.activeProject ? `${accountBadgeHtml(sessionId)}<span class="current-project-label current-project-clickable" data-act="openProjectSwitcher" title="Switch project (p)" style="--project-color: ${state.activeProject.color || '#3b82f6'}">${state.activeProject.icon || ''} ${escapeHtml(state.activeProject.name)} <span class="project-label-caret">▾</span></span>` : ''}
                <button class="key-btn" data-act="termMenuToggle" title="Voice, prompts &amp; settings (⌘M)">☰ Menu</button>
                <button class="key-btn" data-act="itermSendKey" data-arg="enter">Enter</button>
                <button class="key-btn" data-act="itermSendKey" data-arg="tab">Tab</button>
                <button class="key-btn" data-act="itermSendKey" data-arg="left">←</button>
                <button class="key-btn" data-act="itermSendKey" data-arg="right">→</button>
                <button class="key-btn" data-act="itermSendKey" data-arg="up">↑</button>
                <button class="key-btn" data-act="itermSendKey" data-arg="down">↓</button>
                ${(() => {
                  const last = getLastUsedPrompt();
                  return last ? `<button class="key-btn term-last-prompt-btn" data-act="itermSendLastPrompt"
                    title="${escapeAttr(`Ostatni prompt — kliknij aby wysłać ponownie:\n${last.content}`)}">${escapeHtml(last.title || last.content)}</button>` : '';
                })()}
                ${dashboardState.pinnedPrompts.length > 0 ? `
                  <span class="prompts-popup-wrapper">
                    <button class="key-btn prompts-popup-btn ${dashboardState.promptsPopupOpen ? 'active' : ''}" data-act="itermTogglePromptsPopup" title="Saved prompts">💬</button>
                    <div id="promptsPopup" class="prompts-popup" style="display:${dashboardState.promptsPopupOpen ? 'flex' : 'none'}">
                      ${dashboardState.pinnedPrompts.map(p => `
                        <button class="prompts-popup-item"
                                data-act="itermSendPinnedPrompt" data-arg="${escapeAttr(p.id)}" data-global="${p.isGlobal ? '1' : ''}"
                                title="${escapeAttr(p.content)}">
                          ${escapeHtml(p.title)}
                        </button>
                      `).join('')}
                    </div>
                  </span>
                ` : ''}
                ${projectBar ? '<span class="pinned-prompt-separator"></span>' : ''}
                <div class="term-project-bar" id="termProjectBar">${projectBar}</div>
                <span class="bridge-indicator ${dashboardState.useStyledMode ? 'active' : ''}" title="${dashboardState.useStyledMode ? 'Styled stream active' : 'Not connected'}"></span>
                <div class="voice-controls">
                  <button id="voiceMicBtn" class="voice-mic-btn voice-${dashboardState.voiceState}" data-act="itermToggleVoice" title="${dashboardState.voiceState === 'listening' ? 'Stop & send (⌘R)' : 'Start voice (⌘R)'}">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                      <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/>
                      <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
                      <line x1="12" y1="19" x2="12" y2="23"/>
                      <line x1="8" y1="23" x2="16" y2="23"/>
                    </svg>
                  </button>
                  <div class="voice-config-wrapper">
                    <button class="voice-config-btn" data-act="itermToggleVoiceConfig" title="Voice settings (engine & language in Settings → Voice)">
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
                      </svg>
                    </button>
                    <div id="voiceConfigPanel" class="voice-config-panel" style="display:none">
                      <div class="voice-config-section">
                        <div class="voice-config-label">Language</div>
                        <label class="voice-config-option">
                          <input type="radio" name="voiceLang" class="voice-lang-radio" value="en-US" ${dashboardState.voiceLang === 'en-US' ? 'checked' : ''} data-act="itermSetVoiceLang" data-arg="en-US"> English
                        </label>
                        <label class="voice-config-option">
                          <input type="radio" name="voiceLang" class="voice-lang-radio" value="pl-PL" ${dashboardState.voiceLang === 'pl-PL' ? 'checked' : ''} data-act="itermSetVoiceLang" data-arg="pl-PL"> Polski
                        </label>
                      </div>
                      <div class="voice-config-section">
                        <label class="voice-config-option">
                          <input type="checkbox" ${dashboardState.voiceAutoSubmit ? 'checked' : ''} data-act="itermSetVoiceAutoSubmit" data-checkbox="1"> Auto submit
                        </label>
                      </div>
                      ${dashboardState.elevenLabsConfigured ? `
                      <div class="voice-config-section">
                        <div class="voice-config-label">Engine</div>
                        <label class="voice-config-option">
                          <input type="radio" name="voiceEngine" class="voice-engine-radio" value="native" ${dashboardState.transcriptionEngine !== 'scribe' ? 'checked' : ''} data-act="itermSetVoiceEngine" data-arg="native"> Native macOS
                        </label>
                        <label class="voice-config-option">
                          <input type="radio" name="voiceEngine" class="voice-engine-radio" value="scribe" ${dashboardState.transcriptionEngine === 'scribe' ? 'checked' : ''} data-act="itermSetVoiceEngine" data-arg="scribe"> ElevenLabs Scribe
                        </label>
                      </div>` : ''}
                    </div>
                  </div>
                </div>
              </div>
              <div id="voicePreview" class="voice-modal-overlay" style="display:${dashboardState.voiceState === 'listening' ? 'flex' : 'none'}" data-act="itermVoicePreviewBackdrop">
                <div class="voice-modal">
                  <div class="voice-modal-header">
                    <span class="voice-modal-title">🎤 Voice input</span>
                    <span class="voice-modal-status"><span class="voice-modal-dot"></span><span id="voiceStatusText">Listening…</span></span>
                  </div>
                  <textarea id="voicePreviewText" class="voice-preview-textarea" rows="10"
                    placeholder="Listening… you can also type or fix text here."
                    >${escapeHtml(dashboardState.voiceBuffer || '')}</textarea>
                  <div class="voice-modal-hint">Enter to send · Shift+Enter for newline · Esc to cancel</div>
                  <div class="voice-preview-actions">
                    <button class="voice-action-btn voice-cancel-btn" data-act="itermCancelVoice">Cancel</button>
                    <button id="voiceStopBtn" class="voice-action-btn voice-stop-btn" data-act="itermVoiceStop" ${dashboardState.voiceState !== 'listening' ? 'disabled' : ''}>Stop & Send</button>
                  </div>
                </div>
              </div>
              <div id="pastedImagePreview" class="pasted-image-preview" style="display:${dashboardState.pastedImagePath ? 'flex' : 'none'}">
                ${dashboardState.pastedImagePath ? `
                  <img src="${dashboardState.pastedImageBase64 || ''}" class="pasted-image-thumb" alt="Screenshot" />
                  <span class="pasted-image-name">${(dashboardState.pastedImagePath || '').split('/').pop()}</span>
                  <button class="pasted-image-remove" data-act="itermRemovePastedImage" title="Remove image">&times;</button>
                ` : ''}
              </div>
              <div class="command-input-bar" id="commandInputBar">
                <div class="input-left-actions">
                  <button class="input-action-btn queue-mode-btn ${dashboardState.queueMode ? 'active' : ''}" id="queueModeBtn" data-act="itermToggleQueueMode" title="${dashboardState.queueMode ? 'Queue mode ON (q)' : 'Queue mode OFF (q)'}">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                      <line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/>
                      <line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/>
                    </svg>
                  </button>
                  <button class="input-action-btn expand-input-btn" id="expandInputBtn" data-act="itermToggleExpandInput" title="Expand input">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                      <polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/>
                    </svg>
                  </button>
                  ${renderWrappersToggleButton()}
                </div>
                <textarea id="itermCommandInput" class="command-input" rows="3"
                       placeholder="${placeholder}" autocomplete="off" spellcheck="false"
                       ${disabled ? 'disabled' : ''}></textarea>
              </div>
`;
}

// ============================================
// Window handlers
// ============================================

// Select a project on the left (does full global project switch)
window.itermSelectProject = async function(projectName) {
  if (dashboardState.selectedProjectName === projectName) return;

  // Exit ALL view if active

  // Find the project and do a full global switch
  const project = state.projects.find(p => p.name === projectName);
  if (project && state.activeProject?.id !== project.id) {
    await switchProject(project.id);
    // onAfterSwitch handler handles stopViewing + auto-select terminal + workspace info
    return;
  }

  // For "Other" group or non-project entries, just change terminal view
  stopViewing();
  dashboardState.selectedProjectName = projectName;

  const allTabs = dashboardState.itermStatus?.tabs || [];
  const groups = buildProjectGroups(allTabs);
  const group = groups.find(g => g.name === projectName);
  if (group?.tabs?.length > 0) {
    window.itermSelectTerminal(group.tabs[0].sessionId);
    return;
  }
  renderTerminalDashboard();
};

// Unpin the pinned terminal for current project
window.itermUnpin = function() {
  setPinForCurrentProject(null);
  renderTerminalDashboard();
};

// Open add project modal from dashboard
window.openAddProjectModal = async function() {
  const modal = document.getElementById('addProjectModal');
  if (!modal) return;
  await loadClaudeAccounts();
  const accountSelect = document.getElementById('projectClaudeAccount');
  if (accountSelect) {
    accountSelect.innerHTML = buildAccountOptions('');
    attachAccountSelect(accountSelect);
  }
  const groupSelect = document.getElementById('projectGroup');
  if (groupSelect) {
    groupSelect.innerHTML = buildGroupOptions('');
  }
  renderTabbedIconPicker(document.getElementById('iconPicker'), '');
  modal.classList.remove('hidden');
};

// Select a terminal tab on the right (starts viewing)
// Automatically pins the selected terminal
window.itermSelectTerminal = async function(sessionId) {
  if (dashboardState.viewingSessionId === sessionId) return;
  stopViewing();

  dashboardState.viewingSessionId = sessionId;
  dashboardState.sessionContents = '';
  dashboardState.useStyledMode = true;

  // Auto-pin: pin follows whichever tab is selected (per-project)
  const tab = dashboardState.itermStatus?.tabs?.find(t => t.sessionId === sessionId);
  if (tab) {
    setPinForCurrentProject(tab.name);
  }

  // Git/diff context follows the task worktree when a task terminal is viewed
  let taskPath = null;
  let taskRepos = null;
  if (tab?.path) {
    for (const p of state.projects || []) {
      for (const t of p.tasks || []) {
        const repos = t.repos || [];
        const repoHit = repos.find(r => r.worktreePath === tab.path);
        if (repoHit) {
          taskPath = repoHit.worktreePath;
        } else if (t.worktreePath === tab.path) {
          // Session opened at the task root — default the git panel to the first repo worktree
          taskPath = repos.length > 0 ? repos[0].worktreePath : t.worktreePath;
        } else {
          continue;
        }
        taskRepos = repos.length > 1 ? repos : null;
        break;
      }
      if (taskPath) break;
    }
  }
  if (state.activeTaskPath !== taskPath || state.activeTaskRepos !== taskRepos) {
    state.activeTaskPath = taskPath;
    state.activeTaskRepos = taskRepos;
    refreshGitStatus().catch((err) => { console.error('Failed to refresh git status for task context:', err); });
  }

  renderTerminalDashboard();

  // tmux content streams directly (control mode); if an iTerm host happens to
  // be attached, keep it in sync with what the dashboard views
  if (sessionId && sessionId.startsWith('tmux:')) {
    SwitchITermTabBySessionID(sessionId).catch((err) => {
      console.warn('tmux host follow failed:', err);
    });
  }

  try {
    const result = await WatchITermSession(sessionId);
    if (result && result.startsWith('ERROR:')) {
      dashboardState.sessionContents = result;
      dashboardState.useStyledMode = false;
      renderTerminalDashboard();
      return;
    }
    // tmux scrollback is one cheap capture away — load it upfront so
    // scrolling up just works instead of hiding behind the ⇡ button
    if (sessionId && sessionId.startsWith('tmux:')) {
      dashboardState.lastHistoryLoadTs = Date.now();
      loadHistory();
    }
  } catch (err) {
    dashboardState.sessionContents = 'ERROR: ' + (err.message || err);
    dashboardState.useStyledMode = false;
    renderTerminalDashboard();
  }
};

// Close a terminal tab in iTerm2
window.itermCloseTab = async function(sessionId) {
  try {
    if (dashboardState.viewingSessionId === sessionId) {
      stopViewing();
    }
    await CloseITermTabBySessionID(sessionId);
    // Clean up name override for closed tab
    if (dashboardState.nameOverrides[sessionId]) {
      delete dashboardState.nameOverrides[sessionId];
      SetTerminalNameOverride(sessionId, '').catch(() => {});
    }
    if (sessionId in dashboardState.terminalAccounts) {
      delete dashboardState.terminalAccounts[sessionId];
      ClearTerminalAccount(sessionId).catch((err) => { console.error('Failed to clear terminal account:', err); });
    }
    // Remove tab from local state immediately so UI updates
    if (dashboardState.itermStatus?.tabs) {
      dashboardState.itermStatus.tabs = dashboardState.itermStatus.tabs.filter(t => t.sessionId !== sessionId);
    }
    renderTerminalDashboard();
  } catch (err) {
    console.error('Failed to close tab:', err);
  }
};

// Send text to the active terminal session (with Enter)
window.itermSendText = async function(text) {
  const targetSession = dashboardState.viewingSessionId;
  if (!targetSession) return;
  try {
    const wrapped = window.applyPromptWrappers ? window.applyPromptWrappers(text) : text;
    await WriteITermTextBySessionID(targetSession, wrapped, true);
  } catch (err) {
    console.error('Failed to send text:', err);
  }
};

// Called from settings when Jira integration is toggled — shows/hides tasks badges live
window.itermSetJiraEnabled = function(enabled) {
  dashboardState.jiraEnabled = !!enabled;
  renderTerminalDashboard();
};

// Toggle flat project list (no group accordions) in the sidebar
window.itermToggleFlatProjects = function() {
  dashboardState.flatProjectList = !dashboardState.flatProjectList;
  localStorage.setItem('flatProjectList', dashboardState.flatProjectList ? '1' : '0');
  renderTerminalDashboard();
};

// Toggle fullscreen mode - hide everything except projects, terminal, and right sidebar
window.itermToggleFullscreen = function() {
  dashboardState.fullscreen = !dashboardState.fullscreen;
  SetDashboardFullscreen(dashboardState.fullscreen);
  const cls = document.querySelector('.app-container')?.classList;
  if (!cls) return;
  cls.toggle('dashboard-fullscreen', dashboardState.fullscreen);
  const btn = document.querySelector('.fullscreen-toggle-btn');
  if (btn) btn.textContent = dashboardState.fullscreen ? '⊗' : '⤢';
};

// Focus iTerm2 on a specific session; for tmux sessions this creates the
// host tab (and an iTerm window) when none is open
window.itermFocusSession = async function(sessionId) {
  try {
    if (sessionId && sessionId.startsWith('tmux:')) {
      await OpenTmuxInITerm(sessionId);
    } else {
      await SwitchITermTabBySessionID(sessionId);
    }
    await FocusITerm();
  } catch (err) {
    console.error('Failed to focus session:', err);
  }
};


// Load scrollback history; the response arrives via 'iterm-session-history'
async function loadHistory() {
  if (!dashboardState.viewingSessionId || dashboardState.historyLoading) return;

  dashboardState.historyLoading = true;
  try {
    await RequestStyledHistory(dashboardState.viewingSessionId);
  } catch (err) {
    console.error('Failed to load history:', err);
    dashboardState.historyLoading = false;
  }
}

// Lines that scroll off the live screen enter tmux scrollback, so a history
// snapshot goes stale as soon as the session keeps printing — without a
// reload the viewer shows a gap between the history block and the live area
let historyRefreshTimer = null;

function maybeRefreshHistory(historySize) {
  if (typeof historySize !== 'number' || !dashboardState.historyLines) return;
  if (historySize === dashboardState.historySizeAtLoad) return;
  // At the bottom the scrollback is off-screen, and a streaming session
  // grows history on every frame — re-capturing the entire styled history
  // each second froze the whole app once the scrollback got long. Scrolling
  // up reloads it on demand (hookViewerScroll), so only a viewer that is
  // actually showing history keeps it fresh here.
  const viewer = document.getElementById('itermOutputViewer');
  if (!viewer || viewer.scrollHeight - viewer.scrollTop - viewer.clientHeight < 30) return;
  if (historyRefreshTimer) return;
  historyRefreshTimer = setTimeout(() => {
    historyRefreshTimer = null;
    loadHistory();
  }, 3000);
}

function cancelHistoryRefresh() {
  if (historyRefreshTimer) {
    clearTimeout(historyRefreshTimer);
    historyRefreshTimer = null;
  }
}

// Inline rename - replaces tab button text with input
function startInlineRename(tabBtn, sessionId, currentName) {
  if (tabBtn.querySelector('.tab-rename-input')) return; // already editing

  const focusSpan = tabBtn.querySelector('.term-tab-focus');
  const originalText = currentName;

  // Replace button content with input
  tabBtn.textContent = '';
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'tab-rename-input';
  input.value = originalText;
  input.spellcheck = false;
  input.autocomplete = 'off';
  tabBtn.appendChild(input);
  if (focusSpan) tabBtn.appendChild(focusSpan);

  input.focus();
  input.select();

  let done = false;
  const finish = async (save) => {
    if (done) return;
    done = true;
    const newName = input.value.trim();
    // Restore button text
    input.remove();
    tabBtn.insertBefore(document.createTextNode(escapeHtml(save && newName ? newName : originalText) + ' '), focusSpan || null);

    if (save && newName && newName !== originalText) {
      try {
        // A: Try to rename in iTerm2 via AppleScript + OSC sequences
        await RenameITermTabBySessionID(sessionId, newName);
        // B: Store local override as fallback in case iTerm2 reverts
        dashboardState.nameOverrides[sessionId] = newName;
        await SetTerminalNameOverride(sessionId, newName);
        const tab = dashboardState.itermStatus?.tabs?.find(t => t.sessionId === sessionId);
        if (tab) tab.name = newName;
      } catch (err) {
        console.error('Failed to rename tab:', err);
      }
    }
  };

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); finish(true); }
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false); }
  });
  input.addEventListener('blur', () => finish(true));
  // Prevent click on input from triggering tab switch
  input.addEventListener('click', (e) => e.stopPropagation());
}

// Create new terminal for the selected project
window.itermCreateTab = async function() {
  const projectName = dashboardState.selectedProjectName;
  if (!projectName || projectName === 'Other') return;

  const proj = (state.projects || []).find(p => p.name === projectName);
  if (!proj) return;

  await loadClaudeAccounts();
  try {
    dashboardState.runners = await GetRunners() || [];
  } catch (err) {
    console.warn('Failed to load runners:', err);
  }
  try {
    dashboardState.defaultRunner = await GetDefaultRunner() || '';
  } catch (err) {
    console.warn('Failed to load default runner:', err);
  }

  const allTabs = dashboardState.itermStatus?.tabs || [];
  const tabNumber = getNextTabNumber(allTabs, projectName);
  const defaultName = `${projectName} ${tabNumber}`;

  showNewTabPopup(defaultName, proj.claudeConfigDir || '', resolvedDefaultRunner(proj), async (tabName, claudeConfigDir, runnerId) => {
    try {
      const previousSessionIds = new Set((dashboardState.itermStatus?.tabs || []).map(t => t.sessionId));
      await CreateITermTabWithRunner(proj.path, tabName, claudeConfigDir || '', runnerId || '');
      await adoptNewTab(previousSessionIds, projectName, tabName, claudeConfigDir || '', runnerId || '');
    } catch (err) {
      console.error('Failed to create terminal:', err);
    }
  });
};

// Poll iTerm status until the freshly created tab appears, then register and select it.
// Exposed on window so tasks.js can reuse it without an import cycle.
async function adoptNewTab(previousSessionIds, projectName, tabName, claudeConfigDir, runnerId = '') {
  for (let attempt = 0; attempt < 10; attempt++) {
    await new Promise(r => setTimeout(r, 500));
    const status = adoptITermStatus(await GetITermStatus());
    const newTab = status.tabs.find(t => !previousSessionIds.has(t.sessionId));
    if (newTab) {
      // Force custom name — iTerm2 may have overridden it with profile settings
      newTab.name = tabName;
      dashboardState.nameOverrides[newTab.sessionId] = tabName;
      SetTerminalNameOverride(newTab.sessionId, tabName).catch(() => {});
      dashboardState.terminalAccounts[newTab.sessionId] = claudeConfigDir || '';
      SetTerminalAccount(newTab.sessionId, claudeConfigDir || '').catch((err) => { console.error('Failed to save terminal account:', err); });
      if (runnerId && runnerId !== 'claude') {
        dashboardState.terminalRunners[newTab.sessionId] = runnerId;
        SetTerminalRunner(newTab.sessionId, runnerId).catch((err) => { console.error('Failed to save terminal runner:', err); });
      }
      tabProjectMap[newTab.sessionId] = projectName;
      renderTerminalDashboard();
      window.itermSelectTerminal(newTab.sessionId);
      return newTab;
    }
  }
  renderTerminalDashboard();
  return null;
}
window.itermAdoptNewTab = adoptNewTab;

// Snapshot of current session IDs, for adoptNewTab's "what's new" diff
window.itermCurrentSessionIds = () => new Set((dashboardState.itermStatus?.tabs || []).map(t => t.sessionId));

window.itermRenderDashboard = () => renderTerminalDashboard();

// Find an open tab by its working directory (used to jump to an already-open task)
window.itermFindTabByPath = (path) => (dashboardState.itermStatus?.tabs || []).find(t => t.path === path) || null;

function showNewTabPopup(defaultName, defaultConfigDir, defaultRunnerId, onCreate) {
  document.querySelector('.newtab-popup-overlay')?.remove();

  const overlay = document.createElement('div');
  overlay.className = 'newtab-popup-overlay';
  overlay.innerHTML = `
    <div class="newtab-popup">
      <div class="newtab-popup-header">
        <span class="newtab-popup-title">New Terminal</span>
      </div>
      <div class="newtab-popup-body">
        <input type="text" class="newtab-popup-input" value="${escapeHtml(defaultName)}" spellcheck="false" autocomplete="off">
        <label class="account-popup-label">Runner</label>
        <select class="account-select newtab-popup-runner">
          ${(dashboardState.runners || []).map(r => `<option value="${r.id}" ${r.id === defaultRunnerId ? 'selected' : ''}>${r.icon || ''} ${escapeHtml(r.name)}</option>`).join('') || '<option value="claude">✳️ Claude</option>'}
        </select>
        <label class="account-popup-label newtab-account-label">Claude account</label>
        <select class="account-select newtab-popup-account">${buildAccountOptions(defaultConfigDir)}</select>
      </div>
      <div class="newtab-popup-actions">
        <button class="newtab-popup-cancel">Cancel</button>
        <button class="newtab-popup-create">Create</button>
      </div>
    </div>
  `;

  const input = overlay.querySelector('.newtab-popup-input');
  const accountSelect = overlay.querySelector('.newtab-popup-account');
  const runnerSelect = overlay.querySelector('.newtab-popup-runner');
  attachAccountSelect(accountSelect);
  // Claude account only applies to the built-in runner
  const syncAccountVisibility = () => {
    const isClaude = !runnerSelect.value || runnerSelect.value === 'claude';
    overlay.querySelector('.newtab-account-label').style.display = isClaude ? '' : 'none';
    accountSelect.style.display = isClaude ? '' : 'none';
  };
  runnerSelect.addEventListener('change', syncAccountVisibility);
  syncAccountVisibility();
  const close = () => overlay.remove();

  const submit = () => {
    const name = input.value.trim();
    if (name) {
      const isClaude = !runnerSelect.value || runnerSelect.value === 'claude';
      close();
      onCreate(name, isClaude ? accountSelect.value : '', runnerSelect.value);
    }
  };

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); submit(); }
    if (e.key === 'Escape') { e.preventDefault(); close(); }
  });
  // Select all on first keypress so typing replaces the default
  input.addEventListener('focus', () => input.select());

  overlay.querySelector('.newtab-popup-cancel').addEventListener('click', close);
  overlay.querySelector('.newtab-popup-create').addEventListener('click', submit);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

  document.body.appendChild(overlay);
  input.focus();
}

window.itermRefreshDashboard = function() {
  refreshDashboardData();
};

// Send command to viewed session
window.itermSendCommand = async function() {
  const input = document.getElementById('itermCommandInput');
  const targetSession = dashboardState.viewingSessionId;
  if (!input || !targetSession) return;

  let text = input.value.trim();
  const imagePath = dashboardState.pastedImagePath;

  if (!text && !imagePath) return;

  // Append image path if attached
  if (imagePath) {
    text = text ? text + '\n\n[Image: ' + imagePath + ']' : 'Look at this image: ' + imagePath;
  }

  // Queue mode: add to queue instead of sending
  if (dashboardState.queueMode) {
    dashboardState.promptQueue.push({
      id: 'q-' + Date.now() + '-' + Math.random().toString(36).substr(2, 5),
      text: text
    });
    input.value = '';
    dashboardState.pastedImagePath = null;
    dashboardState.pastedImageBase64 = null;
    updatePastedImagePreview();
    renderPromptQueue();
    return;
  }

  try {
    const wrapped = window.applyPromptWrappers ? window.applyPromptWrappers(text) : text;
    await WriteITermTextBySessionID(targetSession, wrapped, true);
    input.value = '';
    // Clear attached image
    dashboardState.pastedImagePath = null;
    dashboardState.pastedImageBase64 = null;
    updatePastedImagePreview();
  } catch (err) {
    console.error('Failed to send command:', err);
  }
};

// Toggle queue mode
window.itermToggleQueueMode = function() {
  dashboardState.queueMode = !dashboardState.queueMode;
  const btn = document.getElementById('queueModeBtn');
  if (btn) btn.classList.toggle('active', dashboardState.queueMode);
  renderPromptQueue();
};

// Send a queued prompt
window.itermSendQueued = async function(id) {
  const targetSession = dashboardState.viewingSessionId;
  const idx = dashboardState.promptQueue.findIndex(q => q.id === id);
  if (idx === -1 || !targetSession) return;

  const item = dashboardState.promptQueue[idx];
  try {
    const wrapped = window.applyPromptWrappers ? window.applyPromptWrappers(item.text) : item.text;
    await WriteITermTextBySessionID(targetSession, wrapped, true);
    dashboardState.promptQueue.splice(idx, 1);
    renderPromptQueue();
  } catch (err) {
    console.error('Failed to send queued command:', err);
  }
};

// Remove a queued prompt
window.itermRemoveQueued = function(id) {
  dashboardState.promptQueue = dashboardState.promptQueue.filter(q => q.id !== id);
  renderPromptQueue();
};

// Render prompt queue bar
function renderPromptQueue() {
  let bar = document.getElementById('promptQueueBar');
  const container = document.getElementById('commandInputBar');
  if (!container) return;

  if (dashboardState.promptQueue.length === 0) {
    if (bar) bar.remove();
    return;
  }

  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'promptQueueBar';
    bar.className = 'prompt-queue-bar';
    container.parentNode.insertBefore(bar, container);
  }

  const escHtml = (s) => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

  bar.innerHTML = dashboardState.promptQueue.map(q =>
    `<div class="prompt-queue-item" data-id="${q.id}">
      <button class="prompt-queue-send" data-act="itermSendQueued" data-arg="${q.id}" title="Send now">▶</button>
      <span class="prompt-queue-text">${escHtml(q.text)}</span>
      <button class="prompt-queue-remove" data-act="itermRemoveQueued" data-arg="${q.id}" title="Remove">&times;</button>
    </div>`
  ).join('');
}

// Handle clipboard paste with image detection
async function handleClipboardPaste(e) {
  const items = e.clipboardData?.items;
  if (!items) return;

  for (const item of items) {
    if (item.type === 'image/png' || item.type === 'image/jpeg') {
      e.preventDefault();

      const blob = item.getAsFile();
      if (!blob) return;

      const reader = new FileReader();
      reader.onload = async () => {
        const base64Full = reader.result; // data:image/png;base64,xxxxx
        const base64Data = base64Full.split(',')[1];

        const projectID = state.activeProject?.id;
        if (!projectID) return;

        const filename = `clipboard_${Date.now()}.png`;
        try {
          const savedPath = await SaveScreenshot(projectID, base64Data, filename);
          dashboardState.pastedImagePath = savedPath;
          dashboardState.pastedImageBase64 = base64Full;
          updatePastedImagePreview();
        } catch (err) {
          console.error('Failed to save pasted image:', err);
        }
      };
      reader.readAsDataURL(blob);
      return;
    }
  }
}

// Update pasted image preview without full re-render
function updatePastedImagePreview() {
  let preview = document.getElementById('pastedImagePreview');

  if (!dashboardState.pastedImagePath) {
    if (preview) preview.style.display = 'none';
    return;
  }

  if (!preview) {
    const inputBar = document.querySelector('.command-input-bar');
    if (!inputBar) return;
    preview = document.createElement('div');
    preview.id = 'pastedImagePreview';
    preview.className = 'pasted-image-preview';
    inputBar.parentNode.insertBefore(preview, inputBar);
  }

  const filename = dashboardState.pastedImagePath.split('/').pop();
  preview.style.display = 'flex';
  preview.innerHTML = `
    <img src="${dashboardState.pastedImageBase64}" class="pasted-image-thumb" alt="Screenshot" />
    <span class="pasted-image-name">${filename}</span>
    <button class="pasted-image-remove" data-act="itermRemovePastedImage" title="Remove image">&times;</button>
  `;
}

window.itermRemovePastedImage = function() {
  dashboardState.pastedImagePath = null;
  dashboardState.pastedImageBase64 = null;
  updatePastedImagePreview();
};

window.itermToggleExpandInput = function() {
  const bar = document.getElementById('commandInputBar');
  const btn = document.getElementById('expandInputBtn');
  const textarea = document.getElementById('itermCommandInput');
  if (!bar || !btn) return;

  const isExpanded = bar.classList.toggle('command-input-expanded');

  if (isExpanded) {
    btn.title = 'Collapse input (Esc)';
    btn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 14 10 14 10 20"/><polyline points="20 10 14 10 14 4"/><line x1="14" y1="10" x2="21" y2="3"/><line x1="3" y1="21" x2="10" y2="14"/></svg>';
    if (textarea) {
      textarea.focus();
      textarea._expandEscHandler = function(e) {
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          window.itermToggleExpandInput();
        }
      };
      textarea.addEventListener('keydown', textarea._expandEscHandler);
    }
  } else {
    btn.title = 'Expand input';
    btn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>';
    if (textarea) {
      if (textarea._expandEscHandler) {
        textarea.removeEventListener('keydown', textarea._expandEscHandler);
        textarea._expandEscHandler = null;
      }
      textarea.focus();
    }
  }
};

window.itermSendKey = async function(key) {
  const targetSession = dashboardState.viewingSessionId;
  if (!targetSession) return;
  try {
    await SendITermSpecialKey(targetSession, key);
  } catch (err) {
    console.error('Failed to send key:', err);
  }
};

window.itermPasteClipboard = async function() {
  const targetSession = dashboardState.viewingSessionId;
  if (!targetSession) return;
  try {
    await PasteClipboardToSession(targetSession);
  } catch (err) {
    console.error('Failed to paste clipboard:', err);
  }
};

// TERM mode pass-through, leading edge first: the first keystroke is sent
// immediately so its echo isn't delayed, and only keystrokes arriving while
// a send is pending get batched into one follow-up flush
let typeBuffer = '';
let typeFlushPending = false;

function flushTypeBuffer() {
  const targetSession = dashboardState.viewingSessionId;
  const chunk = typeBuffer;
  typeBuffer = '';
  if (!chunk || !targetSession) {
    typeFlushPending = false;
    return;
  }
  WriteITermTextBySessionID(targetSession, chunk, false)
    .catch((err) => { console.error('Failed to type text:', err); })
    .finally(flushTypeBuffer);
}

window.itermTypeText = function(text) {
  if (!dashboardState.viewingSessionId || !text) return;
  typeBuffer += text;
  if (typeFlushPending) return;
  typeFlushPending = true;
  flushTypeBuffer();
};

window.itermViewingSession = function() {
  return dashboardState.viewingSessionId || null;
};
window.itermIsViewingSession = function() {
  return !!dashboardState.viewingSessionId;
};

// Redraw on NORMAL<->TERM switches so the attach cursor, outline and hint
// bar follow
document.addEventListener('shell-mode-change', () => {
  const hintBar = document.getElementById('termHintBar');
  if (hintBar) hintBar.innerHTML = termHintBarContent();
  const viewer = document.getElementById('itermOutputViewer');
  if (!viewer || !dashboardState.styledLines) return;
  viewer._forceRender = true;
  updateStyledOutputViewer();
  viewer._forceRender = false;
});

export function getAllTerminalTabs() {
  return dashboardState.itermStatus?.tabs || [];
}

// Shell NORMAL-mode hook for the Term module: j/k switches the viewed
// session directly (no cursor), n opens a terminal, o jumps to iTerm
export function termModuleOnKey(e) {
  switch (e.key) {
    case 'Enter': {
      // Enter drops you into the command input (INSERT)
      const input = document.getElementById('itermCommandInput');
      if (input && !input.disabled) {
        e.preventDefault();
        input.focus();
        return true;
      }
      return false;
    }
    case 'm':
      e.preventDefault();
      toggleTermMenu();
      return true;
    case 'q':
      e.preventDefault();
      window.itermToggleQueueMode?.();
      return true;
    case 'j':
    case 'k': {
      const btns = [...document.querySelectorAll('#dashboardPanel .term-tab-btn[data-session]')];
      if (btns.length === 0) return false;
      const current = btns.findIndex(b => b.dataset.session === dashboardState.viewingSessionId);
      const next = current === -1
        ? 0
        : (current + (e.key === 'j' ? 1 : -1) + btns.length) % btns.length;
      e.preventDefault();
      window.itermSelectTerminal(btns[next].dataset.session);
      return true;
    }
    case 'n':
      e.preventDefault();
      window.itermCreateTab?.();
      return true;
    case 'o':
      if (dashboardState.viewingSessionId) {
        e.preventDefault();
        window.itermFocusSession?.(dashboardState.viewingSessionId);
        return true;
      }
      return false;
  }
  return false;
}

window.itermStopViewing = function() {
  stopViewing();
  renderTerminalDashboard();
};

window.itermTogglePromptsPopup = function() {
  setPromptsPopupOpen(!dashboardState.promptsPopupOpen);
};

function setPromptsPopupOpen(open) {
  dashboardState.promptsPopupOpen = open;
  const popup = document.getElementById('promptsPopup');
  if (popup) popup.style.display = open ? 'flex' : 'none';
  document.querySelector('.prompts-popup-btn')?.classList.toggle('active', open);
}

document.addEventListener('click', (e) => {
  if (dashboardState.promptsPopupOpen && !e.target.closest('.prompts-popup-wrapper')) {
    setPromptsPopupOpen(false);
  }
});

// The clicked button glides into the current-project label on the left,
// selling the "this becomes the active project" hand-off before the bar
// re-renders without it
function animateProjectJump(btn) {
  const label = document.querySelector('.keyboard-helper .current-project-label');
  if (!label) return Promise.resolve();
  const from = btn.getBoundingClientRect();
  const to = label.getBoundingClientRect();
  btn.classList.add('jumping');
  void btn.offsetWidth; // flush styles so the transition picks up the transform
  btn.style.transform = `translate(${to.left - from.left}px, ${to.top - from.top}px) scale(0.85)`;
  return new Promise(resolve => setTimeout(resolve, 280));
}

// Switch to a project from the input-bar button: full project switch, then
// always land on its first session (no picker in between)
window.itermJumpProject = async function(projectName, e) {
  const group = buildProjectGroups(getAllTerminalTabs()).find(g => g.name === projectName);
  const firstSessionId = group?.tabs?.[0]?.sessionId || null;
  const project = (state.projects || []).find(p => p.name === projectName);
  if (project && state.activeProject?.id !== project.id) {
    const btn = e?.target?.closest?.('.term-proj-btn');
    if (btn) await animateProjectJump(btn);
    await switchProject(project.id);
  }
  dashboardState.selectedProjectName = projectName;
  if (firstSessionId) window.itermSelectTerminal(firstSessionId);
  else renderTerminalDashboard();
};

// Targeted repaint for claude-status.js: status dots change often and a full
// dashboard re-render would tear down the popup and input focus
window.itermRefreshProjectBar = function() {
  const bar = document.getElementById('termProjectBar');
  if (bar) bar.innerHTML = renderProjectBarButtons();
};

window.itermSendPinnedPrompt = async function(promptId, isGlobal) {
  setPromptsPopupOpen(false);
  const targetSession = dashboardState.viewingSessionId;
  if (!targetSession) return;
  const prompt = dashboardState.pinnedPrompts.find(p => p.id === promptId);
  if (!prompt) return;
  try {
    const wrapped = window.applyPromptWrappers ? window.applyPromptWrappers(prompt.content) : prompt.content;
    await WriteITermTextBySessionID(targetSession, wrapped, true);
    await IncrementPromptUsage(state.activeProject?.id, promptId, isGlobal);
    noteLastUsedPrompt(prompt);
  } catch (err) {
    console.error('Failed to send pinned prompt:', err);
  }
};

// The most recently used prompt (popup or ☰ menu) sits as a one-click
// button next to the prompts icon; persisted so it survives restarts
function getLastUsedPrompt() {
  try {
    const p = JSON.parse(localStorage.getItem('termLastPrompt') || 'null');
    return p && p.content ? p : null;
  } catch (err) {
    console.warn('last prompt parse failed:', err);
    return null;
  }
}

function noteLastUsedPrompt(p) {
  try {
    localStorage.setItem('termLastPrompt', JSON.stringify({
      id: p.id, isGlobal: !!p.isGlobal, title: p.title, content: p.content,
    }));
  } catch (err) {
    console.warn('last prompt save failed:', err);
  }
  if (isDashboardVisible()) renderTerminalDashboard();
}
window.termNoteLastPrompt = noteLastUsedPrompt;
window.termGetLastPrompt = getLastUsedPrompt;

window.itermSendLastPrompt = async function() {
  const last = getLastUsedPrompt();
  const targetSession = dashboardState.viewingSessionId;
  if (!last || !targetSession) return;
  try {
    const wrapped = window.applyPromptWrappers ? window.applyPromptWrappers(last.content) : last.content;
    await WriteITermTextBySessionID(targetSession, wrapped, true);
    IncrementPromptUsage(state.activeProject?.id || '', last.id, last.isGlobal)
      .catch((err) => console.warn('prompt usage increment failed:', err));
  } catch (err) {
    console.error('Failed to send last prompt:', err);
  }
};

async function loadPinnedPrompts() {
  try {
    const projectId = state.activeProject?.id;
    const [projectPrompts, globalPrompts] = await Promise.all([
      projectId ? GetProjectPrompts(projectId) : Promise.resolve([]),
      GetGlobalPrompts()
    ]);
    const all = [
      ...(projectPrompts || []).filter(p => p.pinned).map(p => ({ ...p, isGlobal: false })),
      ...(globalPrompts || []).filter(p => p.pinned).map(p => ({ ...p, isGlobal: true }))
    ];
    dashboardState.pinnedPrompts = all;
  } catch (err) {
    // Ignore - prompts just won't show
  }
}

// ============================================
// Voice Input
// ============================================

function getVoicePreviewTextarea() {
  return document.getElementById('voicePreviewText');
}

let voicePartialAppended = '';
let voiceIgnoreEventsUntil = 0;

function trimPartialFromTail() {
  if (!voicePartialAppended) return;
  const ta = getVoicePreviewTextarea();
  if (!ta) return;
  if (ta.value.endsWith(voicePartialAppended)) {
    ta.value = ta.value.slice(0, ta.value.length - voicePartialAppended.length);
  }
}

function liveAppendVoiceText(text, commit) {
  if (!text) {
    if (commit) voicePartialAppended = '';
    return;
  }
  const ta = getVoicePreviewTextarea();
  if (!ta) {
    dashboardState.voiceBuffer = (dashboardState.voiceBuffer || '') + text;
    return;
  }
  const prevSel = { start: ta.selectionStart, end: ta.selectionEnd };
  const wasAtEnd = prevSel.start === ta.value.length;
  trimPartialFromTail();
  const cur = ta.value;
  const needsSeparator = cur.length > 0 && !/\s$/.test(cur);
  const piece = (needsSeparator ? ' ' : '') + text;
  ta.value = cur + piece;
  if (wasAtEnd) {
    ta.selectionStart = ta.selectionEnd = ta.value.length;
    ta.scrollTop = ta.scrollHeight;
  } else {
    ta.selectionStart = Math.min(prevSel.start, ta.value.length);
    ta.selectionEnd = Math.min(prevSel.end, ta.value.length);
  }
  dashboardState.voiceBuffer = ta.value;
  voicePartialAppended = commit ? '' : piece;
}

function isInPostResetIgnoreWindow() {
  return Date.now() < voiceIgnoreEventsUntil;
}

function resetVoiceTracking() {
  voiceFinalTranscript = '';
  voicePartialAppended = '';
  voiceIgnoreEventsUntil = 0;
}

function updateVoiceUI() {
  const btn = document.getElementById('voiceMicBtn');
  const preview = document.getElementById('voicePreview');
  if (!btn) return;

  btn.classList.remove('voice-idle', 'voice-listening');
  btn.classList.add('voice-' + dashboardState.voiceState);

  if (dashboardState.voiceState === 'idle') {
    btn.title = 'Voice input';
    if (preview) preview.style.display = 'none';
  } else if (dashboardState.voiceState === 'listening') {
    btn.title = 'Listening...';
    if (preview) preview.style.display = 'flex';
  }

  const startBtn = document.getElementById('voiceStartBtn');
  const stopBtn = document.getElementById('voiceStopBtn');
  if (startBtn) startBtn.disabled = dashboardState.voiceState === 'listening';
  if (stopBtn) stopBtn.disabled = dashboardState.voiceState === 'idle';
}

function readVoicePreviewValue() {
  const ta = getVoicePreviewTextarea();
  return (ta ? ta.value : dashboardState.voiceBuffer || '').trim();
}

window.itermVoicePreviewInput = function(e) {
  dashboardState.voiceBuffer = e.target.value;
};

window.itermVoicePreviewKeydown = function(e) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    stopVoiceAndSubmit();
    return;
  }
  if (e.key === 'Escape') {
    e.preventDefault();
    window.itermCancelVoice();
  }
};

window.itermVoicePreviewBackdrop = function(e) {
  if (e.target && e.target.id === 'voicePreview') {
    window.itermCancelVoice();
  }
};

function voiceSubmitText(text) {
  if (!text) return;
  const targetSession = dashboardState.viewingSessionId;
  if (dashboardState.voiceAutoSubmit) {
    if (targetSession) {
      const wrapped = window.applyPromptWrappers ? window.applyPromptWrappers(text) : text;
      WriteITermTextBySessionID(targetSession, wrapped, true);
    }
  } else {
    const input = document.getElementById('itermCommandInput');
    if (input) {
      input.value = (input.value ? input.value + ' ' : '') + text;
      input.focus();
    } else if (targetSession) {
      WriteITermTextBySessionID(targetSession, text, false);
    }
  }
}

function stopVoiceAndSubmit() {
  const text = readVoicePreviewValue();
  StopVoiceRecognition();
  if (text) voiceSubmitText(text);
  dashboardState.voiceState = 'idle';
  dashboardState.voiceBuffer = '';
  resetVoiceTracking();
  updateVoiceUI();
}

function stopVoiceRecognition() {
  StopVoiceRecognition();
  dashboardState.voiceState = 'idle';
  dashboardState.voiceBuffer = '';
  resetVoiceTracking();
  updateVoiceUI();
}

// Cancel voice - stop without submitting, clear buffer
window.itermCancelVoice = function() {
  if (dashboardState.voiceState !== 'listening') return false;
  stopVoiceRecognition();
  return true;
};

function showVoiceError(msg) {
  const preview = document.getElementById('voicePreview');
  const ta = getVoicePreviewTextarea();
  if (preview) preview.style.display = 'flex';
  if (ta) {
    ta.value = msg;
    ta.classList.add('voice-preview-error');
  }
  setTimeout(() => {
    if (dashboardState.voiceState === 'idle' && preview) {
      preview.style.display = 'none';
      if (ta) ta.classList.remove('voice-preview-error');
    }
  }, 4000);
}

// Start voice recognition
window.itermVoiceStart = async function() {
  if (dashboardState.voiceState === 'listening') return;

  dashboardState.voiceState = 'listening';
  dashboardState.voiceBuffer = '';
  resetVoiceTracking();
  updateVoiceUI();
  const ta = getVoicePreviewTextarea();
  if (ta) {
    ta.value = '';
    ta.focus();
  }

  const result = await StartVoiceRecognition(dashboardState.voiceLang);
  if (result.startsWith('ERROR:')) {
    showVoiceError(result.replace('ERROR: ', ''));
    dashboardState.voiceState = 'idle';
    updateVoiceUI();
  }
};

// Stop voice recognition and submit
window.itermVoiceStop = function() {
  if (dashboardState.voiceState !== 'listening') return;
  stopVoiceAndSubmit();
};

// Toggle mic (start/stop shortcut)
window.itermToggleVoice = async function() {
  if (dashboardState.voiceState === 'listening') {
    stopVoiceAndSubmit();
  } else {
    window.itermVoiceStart();
  }
};

// Config panel toggle
window.itermToggleVoiceConfig = async function(e) {
  e && e.stopPropagation();
  const opening = !dashboardState.voiceConfigOpen;

  // Refresh the Scribe availability so the engine option reflects a key saved in Settings
  // since the dashboard was last rendered.
  if (opening) {
    try {
      const key = await GetElevenLabsAPIKey();
      const configured = !!(key && key.trim());
      if (configured !== dashboardState.elevenLabsConfigured) {
        dashboardState.elevenLabsConfigured = configured;
        renderTerminalDashboard();
      }
    } catch (err) {
      console.warn('Failed to refresh ElevenLabs config state:', err);
    }
  }

  dashboardState.voiceConfigOpen = opening;
  const panel = document.getElementById('voiceConfigPanel');
  if (panel) panel.style.display = dashboardState.voiceConfigOpen ? 'block' : 'none';
};

window.itermSetVoiceLang = function(lang) {
  dashboardState.voiceLang = lang;
  SetVoiceLang(lang);
  document.querySelectorAll('.voice-lang-radio').forEach(r => r.checked = r.value === lang);
};

window.itermSetVoiceAutoSubmit = function(checked) {
  dashboardState.voiceAutoSubmit = checked;
  SetVoiceAutoSubmit(checked);
};

window.itermSetVoiceEngine = function(engine) {
  dashboardState.transcriptionEngine = engine;
  SetTranscriptionEngine(engine);
  document.querySelectorAll('.voice-engine-radio').forEach(r => r.checked = r.value === engine);
};

// Close config panel on outside click
document.addEventListener('click', (e) => {
  if (dashboardState.voiceConfigOpen && !e.target.closest('.voice-config-wrapper')) {
    dashboardState.voiceConfigOpen = false;
    const panel = document.getElementById('voiceConfigPanel');
    if (panel) panel.style.display = 'none';
  }
});

// Handle voice transcript events from native macOS speech recognition
let voiceFinalTranscript = '';

EventsOn('voice-transcript', (data) => {
  if (!data) return;

  if (data.type === 'error') {
    showVoiceError(data.message);
    dashboardState.voiceState = 'idle';
    updateVoiceUI();
    return;
  }

  if (data.type === 'started') {
    voiceIgnoreEventsUntil = 0;
    return;
  }

  if (data.type === 'stopped') return;

  if (dashboardState.voiceState !== 'listening') return;
  if (isInPostResetIgnoreWindow()) return;

  const text = data.text || '';
  const isFinal = data.type === 'final';

  if (isFinal) voiceFinalTranscript += text + ' ';
  liveAppendVoiceText(text, isFinal);
});

EventsOn('voice-stopped', () => {
  dashboardState.voiceState = 'idle';
  dashboardState.voiceBuffer = '';
  resetVoiceTracking();
  updateVoiceUI();
});

// Toggle theme dropdown menu
window.itermToggleThemeMenu = function() {
  dashboardState.themeMenuOpen = !dashboardState.themeMenuOpen;
  const menu = document.getElementById('themeMenu');
  if (!menu) return;
  if (dashboardState.themeMenuOpen) {
    const dot = document.querySelector('.theme-dot');
    if (dot) {
      const rect = dot.getBoundingClientRect();
      menu.style.top = (rect.bottom + 6) + 'px';
      menu.style.left = Math.max(8, rect.right - 140) + 'px';
    }
    menu.classList.add('visible');
  } else {
    menu.classList.remove('visible');
  }
};

// Set terminal color theme
window.itermSetTheme = function(themeName) {
  dashboardState.currentTheme = themeName;
  dashboardState.themeMenuOpen = false;
  SetTerminalTheme(themeName);
  applyCurrentTheme();
  if (dashboardState.styledLines) updateStyledOutputViewer();
  renderTerminalDashboard();
};

// Change font size by delta
window.itermFontSize = function(delta) {
  const newSize = Math.min(24, Math.max(10, dashboardState.fontSize + delta));
  if (newSize === dashboardState.fontSize) return;
  dashboardState.fontSize = newSize;
  SetTerminalFontSize(newSize);
  applyFontSize();
  const display = document.querySelector('.font-size-value');
  if (display) display.textContent = newSize;
};

// Allowlist backing data-act: only these names are reachable from markup,
// and the numeric/boolean arguments are converted here rather than in HTML
const DASHBOARD_ACTIONS = {
  _projectCtxPin: (n) => window._projectCtxPin(n),
  _projectCtxEdit: (n) => window._projectCtxEdit(n),
  _projectCtxDelete: (n) => window._projectCtxDelete(n),
  _groupCtxEdit: (id) => window._groupCtxEdit(id),
  _groupCtxDelete: (id) => window._groupCtxDelete(id),
  _groupToggle: (id) => window._groupToggle(id),
  openProjectSwitcher: () => window.openProjectSwitcher(),
  tasksOpenPopup: (id) => window.tasksOpenPopup(id),
  itermSelectProject: (n) => window.itermSelectProject(n),
  itermSendKey: (k) => window.itermSendKey(k),
  itermSendPinnedPrompt: (id, isGlobal) => window.itermSendPinnedPrompt(id, isGlobal),
  itermSendLastPrompt: () => window.itermSendLastPrompt(),
  itermTogglePromptsPopup: () => window.itermTogglePromptsPopup(),
  itermJumpProject: (n, e) => window.itermJumpProject(n, e),
  itermSendQueued: (id) => window.itermSendQueued(id),
  itermRemoveQueued: (id) => window.itermRemoveQueued(id),
  itermToggleQueueMode: () => window.itermToggleQueueMode(),
  itermToggleExpandInput: () => window.itermToggleExpandInput(),
  itermRemovePastedImage: () => window.itermRemovePastedImage(),
  itermToggleWrappers: () => window.itermToggleWrappers(),
  itermRecheckDeps: () => window.itermRecheckDeps(),
  termMenuToggle: () => toggleTermMenu(),
  termAttachToggle: () => {
    if (!dashboardState.viewingSessionId) return;
    document.activeElement?.blur();
    setMode(getMode() === 'term' ? 'normal' : 'term');
  },
  itermToggleVoice: () => window.itermToggleVoice(),
  itermToggleVoiceConfig: (e) => window.itermToggleVoiceConfig(e),
  itermVoicePreviewBackdrop: (e) => window.itermVoicePreviewBackdrop(e),
  itermCancelVoice: () => window.itermCancelVoice(),
  itermVoiceStop: () => window.itermVoiceStop(),
  itermSetVoiceLang: (lang) => window.itermSetVoiceLang(lang),
  itermSetVoiceEngine: (engine) => window.itermSetVoiceEngine(engine),
  itermSetVoiceAutoSubmit: (checked) => window.itermSetVoiceAutoSubmit(checked),
  itermCreateTab: () => window.itermCreateTab(),
  itermCloseTab: (id) => window.itermCloseTab(id),
  itermFocusSession: (id) => window.itermFocusSession(id),
  itermUnpin: () => window.itermUnpin(),
  itermToggleThemeMenu: () => window.itermToggleThemeMenu(),
  itermSetTheme: (name) => window.itermSetTheme(name),
  itermFontSize: (delta) => window.itermFontSize(Number(delta)),
};

// ============================================
// Core logic
// ============================================

export function stopViewing() {
  if (!dashboardState.viewingSessionId) return;
  if (getMode() === 'term') setMode('normal');
  dashboardState.viewingSessionId = null;
  dashboardState.sessionContents = '';
  dashboardState.styledLines = null;
  dashboardState.cursorPos = null;
  dashboardState.termSize = null;
  dashboardState.profileColors = null;
  dashboardState.useStyledMode = false;
  dashboardState.historyLines = null;
  dashboardState.historyLoading = false;
  dashboardState.historySizeAtLoad = 0;
  cancelHistoryRefresh();
  try {
    UnwatchITermSession();
  } catch (err) {
    // Ignore
  }
}

// Markup declares actions as data-act/data-arg instead of inline handlers:
// interpolating values into onclick= means escaping for two nested contexts
// at once (HTML attribute, then JS string), which is where XSS creeps in.
function dispatchAction(e) {
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const fn = DASHBOARD_ACTIONS[el.dataset.act];
  if (!fn) return;
  if (el.dataset.stop) e.stopPropagation();
  try {
    if (el.dataset.checkbox) fn(e.target.checked, e);
    else if (el.dataset.global !== undefined) fn(el.dataset.arg, el.dataset.global === '1');
    else if (el.dataset.arg !== undefined) fn(el.dataset.arg, e);
    else fn(e);
  } catch (err) {
    console.error(`dashboard action ${el.dataset.act} failed:`, err);
  }
}

export const DASHBOARD_TAB_ID = 'tab-dashboard';

export function showDashboardPanel(show) {
  const panel = document.getElementById('dashboardPanel');
  if (panel) panel.style.display = show ? 'flex' : 'none';
}

// The voice preview lives inside markup that is rebuilt on every render, so
// its handlers are delegated rather than re-attached (and inline on*= is
// blocked by the CSP).
function dispatchInputKeys(e) {
  const el = e.target;
  if (el?.id === 'itermCommandInput') {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (el.value.trim() === '' && !dashboardState.pastedImagePath) window.itermSendKey('enter');
      else window.itermSendCommand();
    }
    return;
  }
  if (el?.id === 'voicePreviewText') window.itermVoicePreviewKeydown(e);
}

function dispatchInputChanges(e) {
  if (e.target?.id === 'voicePreviewText') window.itermVoicePreviewInput(e);
}

export function initTerminalDashboard() {
  document.addEventListener('keydown', dispatchInputKeys);
  document.addEventListener('input', dispatchInputChanges);

  document.addEventListener('click', dispatchAction);
  document.addEventListener('change', dispatchAction);

  setInterval(pollClaudeSessionDots, 5000);
  pollClaudeSessionDots();

  GetTerminalAccounts().then(m => { dashboardState.terminalAccounts = m || {}; })
    .catch(err => console.warn('terminal accounts unavailable:', err));
  GetTerminalRunners().then(m => { dashboardState.terminalRunners = m || {}; })
    .catch(err => console.warn('terminal runners unavailable:', err));
  GetRunners().then(r => { dashboardState.runners = r || []; })
    .catch(err => console.warn('runners unavailable:', err));
  GetDefaultRunner().then(id => { dashboardState.defaultRunner = id || ''; })
    .catch(err => console.warn('default runner unavailable:', err));
  try {
    const saved = JSON.parse(localStorage.getItem('termViewSize') || 'null');
    if (saved?.cols && saved?.rows) {
      lastSentViewSize = { cols: saved.cols, rows: saved.rows };
      SetTermViewSize(saved.cols, saved.rows).catch(err => console.warn('term view size restore failed:', err));
    }
  } catch (err) {
    console.warn('term view size restore failed:', err);
  }
  CheckDependencies().then(d => {
    dashboardState.deps = d || [];
    if (isDashboardVisible()) renderTerminalDashboard();
  }).catch(err => console.warn('dependency check failed:', err));

  bus.on('session-status-changed', (status) => {
    const { tabs } = adoptITermStatus(status);
    if (dashboardState.viewingSessionId && !tabs.some(t => t.sessionId === dashboardState.viewingSessionId)) {
      stopViewing();
    }
    if (isDashboardVisible()) {
      renderTerminalDashboard();
    }
  });

  EventsOn('iterm-session-styled-content', (data) => {
    if (!data) return;
    if (data.sessionId !== dashboardState.viewingSessionId) return;
    try {
      dashboardState.styledLines = typeof data.lines === 'string' ? JSON.parse(data.lines) : data.lines;
      dashboardState.cursorPos = data.cursor;
      dashboardState.termSize = { cols: data.cols, rows: data.rows };
      dashboardState.useStyledMode = true;
      updateStyledOutputViewer();
      maybeRefreshHistory(data.historySize);
    } catch (e) {
      console.error('Failed to parse styled content:', e);
    }
  });

  EventsOn('iterm-session-history', (data) => {
    if (!data || data.sessionId !== dashboardState.viewingSessionId) return;
    try {
      dashboardState.historyLines = typeof data.lines === 'string' ? JSON.parse(data.lines) : data.lines;
      dashboardState.historyLoading = false;
      if (typeof data.historySize === 'number') {
        dashboardState.historySizeAtLoad = data.historySize;
      }

      // Force the render and keep the reading position: everything that got
      // prepended above the fold moves scrollTop down by its own height
      const viewer = document.getElementById('itermOutputViewer');
      const prevHeight = viewer ? viewer.scrollHeight : 0;
      const prevTop = viewer ? viewer.scrollTop : 0;
      const stickToBottom = viewer
        ? prevHeight - prevTop - viewer.clientHeight < 30
        : true;
      if (viewer) viewer._forceRender = true;
      updateStyledOutputViewer();
      if (viewer) {
        viewer._forceRender = false;
        if (!stickToBottom) {
          viewer.scrollTop = viewer.scrollHeight - prevHeight + prevTop;
        }
      }
    } catch (e) {
      console.error('Failed to parse history:', e);
      dashboardState.historyLoading = false;
    }
  });

  EventsOn('iterm-session-profile', (data) => {
    if (!data || data.sessionId !== dashboardState.viewingSessionId) return;
    dashboardState.profileColors = data.colors;
    applyProfileColors();
    if (dashboardState.styledLines) {
      updateStyledOutputViewer();
    }
  });

  // Load persisted theme, font size, and voice settings
  GetTerminalTheme().then(theme => {
    dashboardState.currentTheme = theme || 'dracula';
  }).catch(() => {});
  GetTerminalFontSize().then(size => {
    dashboardState.fontSize = size || 12;
  }).catch(() => {});

  setTimeout(() => refreshDashboardData(), 500);
}

function isDashboardVisible() {
  const panel = document.getElementById('dashboardPanel');
  return panel && panel.style.display !== 'none';
}

// Claude heartbeat status (working/waiting/idle) mapped onto session-tab
// buttons as a colored dot. Sessions are matched to tabs by working
// directory; when several sessions share one, the most active state wins.
let claudeDotByCwd = new Map();

async function pollClaudeSessionDots() {
  try {
    const sessions = (await GetClaudeSessions()) || [];
    const rank = { working: 0, waiting: 1, idle: 2 };
    const next = new Map();
    for (const s of sessions) {
      const prev = next.get(s.cwd);
      if (!prev || rank[s.status] < rank[prev]) next.set(s.cwd, s.status);
    }
    const changed = next.size !== claudeDotByCwd.size
      || [...next].some(([k, v]) => claudeDotByCwd.get(k) !== v);
    claudeDotByCwd = next;
    if (!changed) return;
  } catch (err) {
    console.warn('claude session dots unavailable:', err);
    return;
  }
  patchClaudeSessionDots();
  window.itermRefreshProjectBar?.();
}

function patchClaudeSessionDots() {
  const byId = new Map((dashboardState.itermStatus?.tabs || []).map(t => [t.sessionId, t]));
  for (const btn of document.querySelectorAll('#dashboardPanel .term-tab-btn[data-session]')) {
    const tab = byId.get(btn.dataset.session);
    const status = tab ? claudeDotByCwd.get(tab.path) || '' : '';
    let dot = btn.querySelector('.term-tab-claude-dot');
    if (!status) {
      dot?.remove();
      continue;
    }
    if (!dot) {
      dot = document.createElement('span');
      btn.insertBefore(dot, btn.firstChild);
    }
    dot.className = `term-tab-claude-dot claude-dot-${status === 'waiting' ? 'needs_action' : status}`;
    dot.title = `Claude: ${status}`;
  }
}

async function refreshDashboardData() {
  try {
    const [status] = await Promise.all([
      GetITermStatus(),
      loadPinnedPrompts()
    ]);
    // Session status has no backend event; this poll is the only source, so
    // it is re-broadcast for the other views that show sessions (Projects)
    bus.emit('session-status-changed', adoptITermStatus(status));
  } catch (err) {
    console.warn('dashboard refresh failed:', err);
  }

  dashboardState.lastUpdate = new Date();
  renderTerminalDashboard();
}

function updateStyledOutputViewer() {
  const viewer = document.getElementById('itermOutputViewer');
  if (!viewer) return;

  // Update bridge indicator to green
  const indicator = document.querySelector('.bridge-indicator');
  if (indicator && !indicator.classList.contains('active')) {
    indicator.classList.add('active');
    indicator.title = 'Styled stream active';
  }

  // Pause updates while user has an active text selection inside the viewer
  // Prevents selection from jumping when content re-renders
  const sel = window.getSelection();
  if (sel && sel.toString().length > 0 && sel.anchorNode && viewer.contains(sel.anchorNode)) {
    // Schedule a retry soon - will apply once selection is cleared
    clearTimeout(viewer._pendingUpdate);
    viewer._pendingUpdate = setTimeout(() => updateStyledOutputViewer(), 500);
    return;
  }

  const allLines = dashboardState.styledLines;
  if (!allLines) {
    viewer.textContent = '';
    return;
  }

  hookViewerScroll(viewer);

  // Trim trailing empty lines so the viewer doesn't scroll past actual content
  let lastNonEmpty = allLines.length - 1;
  while (lastNonEmpty >= 0 && (!allLines[lastNonEmpty] || allLines[lastNonEmpty].length === 0)) {
    lastNonEmpty--;
  }
  const lines = allLines.slice(0, lastNonEmpty + 1);

  const wasAtBottom = viewer.scrollHeight - viewer.scrollTop - viewer.clientHeight < 30;

  // While the user reads scrollback, hold the frame steady; the scroll
  // handler re-renders the pending content once they return to the bottom
  if (!wasAtBottom && viewer.childNodes.length > 0 && !viewer._forceRender) {
    viewer._dirtyWhileScrolled = true;
    return;
  }
  viewer._dirtyWhileScrolled = false;
  const defaultFg = dashboardState.profileColors?.fg || '#c7c7c7';
  const defaultBg = dashboardState.profileColors?.bg || '#000000';

  const fragment = document.createDocumentFragment();

  // Helper: render a single line of styled runs into a div
  function renderStyledLine(lineRuns, className) {
    const lineDiv = document.createElement('div');
    lineDiv.className = className;

    if (!lineRuns || lineRuns.length === 0) {
      lineDiv.textContent = '\u00A0';
      return lineDiv;
    }

    for (const run of lineRuns) {
      const span = document.createElement('span');
      let style = '';

      const fgIsDefault = !run.fg || colorsMatch(run.fg, defaultFg);
      const bgIsDefault = !run.bg || colorsMatch(run.bg, defaultBg);

      if (run.inv) {
        const theme = viewerPalette();
        if (fgIsDefault && bgIsDefault) {
          style += `color:${theme.background};background-color:${theme.foreground};`;
        } else {
          const fg = fgIsDefault ? theme.foreground : run.fg;
          const bg = bgIsDefault ? theme.background : run.bg;
          style += `color:${bg};background-color:${fg};`;
        }
      } else {
        if (!fgIsDefault) style += `color:${run.fg};`;
        if (!bgIsDefault) style += `background-color:${run.bg};`;
      }

      if (run.b) style += 'font-weight:bold;';
      if (run.i) style += 'font-style:italic;';
      if (run.u && run.s) {
        style += 'text-decoration:underline line-through;';
      } else if (run.u) {
        style += 'text-decoration:underline;';
      } else if (run.s) {
        style += 'text-decoration:line-through;';
      }
      if (run.f) style += 'opacity:0.5;';

      if (style) span.setAttribute('style', style);
      if (run.cursorCell) span.classList.add('term-cursor');
      span.textContent = run.t;
      lineDiv.appendChild(span);
    }

    return lineDiv;
  }

  // The viewer holds two persistent boxes so the (potentially huge)
  // scrollback DOM survives live-screen updates: rebuilding thousands of
  // history lines on every 25ms frame is what used to freeze the app
  let histBox = viewer.querySelector(':scope > .term-hist-box');
  let liveBox = viewer.querySelector(':scope > .term-live-box');
  if (!histBox || !liveBox) {
    viewer.innerHTML = '';
    histBox = document.createElement('div');
    histBox.className = 'term-hist-box';
    liveBox = document.createElement('div');
    liveBox.className = 'term-live-box';
    viewer.appendChild(histBox);
    viewer.appendChild(liveBox);
    viewer._renderedHistory = undefined;
  }

  // History colors depend on the profile, so a theme change invalidates too
  const histTheme = `${defaultFg}|${defaultBg}|${dashboardState.currentTheme || ''}`;
  if (viewer._renderedHistory !== dashboardState.historyLines || viewer._renderedHistTheme !== histTheme) {
    const hist = document.createDocumentFragment();
    if (dashboardState.historyLines && dashboardState.historyLines.length > 0) {
      for (const histLineRuns of dashboardState.historyLines) {
        hist.appendChild(renderStyledLine(histLineRuns, 'term-line'));
      }
    }
    histBox.innerHTML = '';
    histBox.appendChild(hist);
    viewer._renderedHistory = dashboardState.historyLines;
    viewer._renderedHistTheme = histTheme;
  }

  // Attached (TERM mode): draw a block cursor where the session's cursor is
  const cursor = window.shellGetMode?.() === 'term' ? dashboardState.cursorPos : null;
  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const runs = cursor && lineIdx === cursor.y ? withCursor(lines[lineIdx], cursor.x) : lines[lineIdx];
    fragment.appendChild(renderStyledLine(runs, 'term-line'));
  }
  if (cursor && cursor.y >= lines.length) {
    fragment.appendChild(renderStyledLine(withCursor([], cursor.x), 'term-line'));
  }

  liveBox.innerHTML = '';
  liveBox.appendChild(fragment);

  if (wasAtBottom) {
    viewer.scrollTop = viewer.scrollHeight;
  }
}

// Natural terminal scrolling: reaching the top (re)loads scrollback, and
// returning to the bottom flushes a frame held while the user was reading
function hookViewerScroll(viewer) {
  if (viewer._scrollHooked) return;
  viewer._scrollHooked = true;
  viewer.addEventListener('scroll', () => {
    const atBottom = viewer.scrollHeight - viewer.scrollTop - viewer.clientHeight < 30;
    if (atBottom && viewer._dirtyWhileScrolled) {
      viewer._dirtyWhileScrolled = false;
      updateStyledOutputViewer();
    }
    const now = Date.now();
    if (viewer.scrollTop < 40 && !dashboardState.historyLoading &&
        now - (dashboardState.lastHistoryLoadTs || 0) > 2000) {
      dashboardState.lastHistoryLoadTs = now;
      loadHistory();
    }
  });
}

// Split the run containing column x so that single cell renders as the cursor
function withCursor(lineRuns, x) {
  const runs = [];
  let col = 0;
  let placed = false;
  for (const run of (lineRuns || [])) {
    const t = run.t || '';
    if (placed || x >= col + t.length) {
      runs.push(run);
      col += t.length;
      continue;
    }
    const off = x - col;
    if (off > 0) runs.push({ ...run, t: t.slice(0, off) });
    runs.push({ ...run, t: t.slice(off, off + 1) || ' ', cursorCell: true });
    if (off + 1 < t.length) runs.push({ ...run, t: t.slice(off + 1) });
    placed = true;
    col += t.length;
  }
  if (!placed) runs.push({ t: ' ', cursorCell: true });
  return runs;
}

function colorsMatch(a, b) {
  if (!a || !b) return false;
  return a.toLowerCase() === b.toLowerCase();
}

function viewingUsesAppTheme() {
  const sid = dashboardState.viewingSessionId;
  if (!sid) return true;
  const runnerId = dashboardState.terminalRunners[sid];
  return !runnerId || runnerId === 'claude';
}

function viewerPalette() {
  if (viewingUsesAppTheme()) {
    const theme = getThemeByName(dashboardState.currentTheme);
    return { background: theme.background, foreground: theme.foreground };
  }
  return {
    background: dashboardState.profileColors?.bg || '#000000',
    foreground: dashboardState.profileColors?.fg || '#c7c7c7',
  };
}

function applyCurrentTheme() {
  const viewer = document.getElementById('itermOutputViewer');
  if (!viewer) return;
  const palette = viewerPalette();
  viewer.style.backgroundColor = palette.background;
  viewer.style.color = palette.foreground;
}

function applyFontSize() {
  const viewer = document.getElementById('itermOutputViewer');
  if (!viewer) return;
  viewer.style.fontSize = dashboardState.fontSize + 'px';
  syncTermViewSize();
}

let lastSentViewSize = null;
let viewSizeTimer = null;

function syncTermViewSize() {
  if (viewSizeTimer) clearTimeout(viewSizeTimer);
  viewSizeTimer = setTimeout(sendTermViewSize, 200);
}

function sendTermViewSize() {
  const viewer = document.getElementById('itermOutputViewer');
  if (!viewer) return;
  if (!viewer.clientWidth || !viewer.clientHeight) return;
  const cs = getComputedStyle(viewer);
  const probe = document.createElement('span');
  probe.style.cssText = 'position:absolute;visibility:hidden;white-space:pre;';
  viewer.appendChild(probe);
  probe.textContent = 'M'.repeat(100);
  const asciiW = probe.getBoundingClientRect().width / 100;
  probe.textContent = '─'.repeat(100);
  const boxW = probe.getBoundingClientRect().width / 100;
  probe.remove();
  const charW = Math.max(asciiW, boxW);
  const lineH = parseFloat(cs.lineHeight) || dashboardState.fontSize * 1.35;
  if (!charW || !lineH) return;
  const innerW = viewer.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
  const innerH = viewer.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
  // -1: subpixel rounding + the scrollbar appearing after first paint used
  // to make a fullscreen TUI wrap its full-width box-drawing lines.
  const cols = Math.min(400, Math.max(40, Math.floor(innerW / charW) - 1));
  const rows = Math.min(200, Math.max(10, Math.floor(innerH / lineH)));
  if (lastSentViewSize && lastSentViewSize.cols === cols && lastSentViewSize.rows === rows) return;
  lastSentViewSize = { cols, rows };
  try { localStorage.setItem('termViewSize', JSON.stringify(lastSentViewSize)); } catch (err) {
    console.warn('term view size persist failed:', err);
  }
  SetTermViewSize(cols, rows).catch(err => console.warn('term view size sync failed:', err));
}

function applyProfileColors() {
  applyCurrentTheme();
}

// ============================================
// Render
// ============================================

export function renderTerminalDashboard() {
  const panel = document.getElementById('dashboardPanel');
  if (!panel) return;

  const allTabs = dashboardState.itermStatus?.tabs || [];
  const groups = buildProjectGroups(allTabs);

  // Auto-select first project if nothing selected yet
  if (!dashboardState.selectedProjectName && groups.length > 0) {
    dashboardState.selectedProjectName = groups[0].name;
  }

  const selectedGroup = groups.find(g => g.name === dashboardState.selectedProjectName);
  const selectedTabs = selectedGroup?.tabs || [];
  const isRealProject = selectedGroup && selectedGroup.name !== 'Other';

  // Stop viewing only if the session no longer exists at all (tab closed in iTerm2)
  if (dashboardState.viewingSessionId && !allTabs.some(t => t.sessionId === dashboardState.viewingSessionId)) {
    stopViewing();
  }

  // Auto-select pinned terminal, or first terminal if none is being viewed (auto-pins it)
  if (isDashboardVisible() && !dashboardState.viewingSessionId && selectedTabs.length > 0) {
    const pinnedName = getPinnedNameForCurrentProject();
    const pinnedTab = pinnedName
      ? selectedTabs.find(t => t.name === pinnedName)
      : null;
    window.itermSelectTerminal(pinnedTab ? pinnedTab.sessionId : selectedTabs[0].sessionId);
    return; // itermSelectTerminal will re-render
  }

  const viewingTab = allTabs.find(t => t.sessionId === dashboardState.viewingSessionId);
  const currentThemeObj = getThemeByName(dashboardState.currentTheme);

  // Render projects list in left sidebar
  const projectsList = document.getElementById('projectsList');
  if (projectsList) {
    const findProj = g => (state.projects || []).find(p => p.name === g.name);

    // Pinned always at the top, grouped projects under their group accordion, ungrouped at the bottom
    const pinned = groups.filter(g => findProj(g)?.pinned);
    const rest = groups.filter(g => !findProj(g)?.pinned);

    const projectGroups = dashboardState.flatProjectList ? [] : (state.projectGroups || []);
    const groupMembers = new Map(projectGroups.map(grp => [grp.id, []]));
    const ungrouped = [];
    for (const g of rest) {
      const groupId = findProj(g)?.groupId;
      if (groupId && groupMembers.has(groupId)) {
        groupMembers.get(groupId).push(g);
      } else {
        ungrouped.push(g);
      }
    }
    const ungroupedWithTerminals = ungrouped.filter(g => g.tabs.length > 0);
    const ungroupedWithout = ungrouped.filter(g => g.tabs.length === 0);
    const ungroupedSorted = [...ungroupedWithTerminals, ...ungroupedWithout];

    const sorted = [
      ...pinned,
      ...ungroupedSorted,
      ...projectGroups.flatMap(grp => groupMembers.get(grp.id))
    ];
    window._projectDisplayOrder = sorted.map(g => g.name);
    const numberOf = new Map(sorted.map((g, i) => [g.name, i + 1]));
    const hasPinnedProjects = pinned.length > 0;

    const renderItem = (g) => {
      const proj = findProj(g);
      const isPinned = proj?.pinned;
      const openTasks = (proj?.tasks || []).filter(t => t.status !== 'done');
      return `
      <div class="terminal-list-item ${g.name === dashboardState.selectedProjectName ? 'viewing' : ''} ${isPinned ? 'pinned' : ''} ${g.tabs.length === 0 ? 'inactive' : ''}"
           data-project-name="${escapeAttr(g.name)}"
           data-act="itermSelectProject" data-arg="${escapeAttr(g.name)}">
        <div class="project-number-badge" ${g.color ? `style="background:${g.color}22;color:${g.color}"` : ''}>
          <span class="project-number">${isPinned ? '📌' : numberOf.get(g.name)}</span>
        </div>
        <div class="project-info">
          <span class="terminal-list-name">${escapeHtml(g.name)}</span>
          ${g.tabs.length > 0 ? `<span class="card-count">${g.tabs.length} terminal${g.tabs.length > 1 ? 's' : ''}</span>` : ''}
        </div>
        ${proj && dashboardState.jiraEnabled ? `<span class="project-tasks-badge ${openTasks.length > 0 ? '' : 'empty'}" title="Tasks"
          data-act="tasksOpenPopup" data-arg="${proj.id}" data-stop="1">◫${openTasks.length > 0 ? ` ${openTasks.length}` : ''}</span>` : ''}
        ${g.icon ? `<span class="project-icon-right">${g.icon}</span>` : ''}
      </div>`;
    };

    const renderGroup = (grp) => {
      const members = groupMembers.get(grp.id);
      return `
      <div class="project-group ${grp.collapsed ? 'collapsed' : ''}">
        <div class="project-group-header" data-group-id="${grp.id}" data-act="_groupToggle" data-arg="${grp.id}">
          <span class="project-group-icon">${grp.icon || '🗂️'}</span>
          <span class="project-group-name">${escapeHtml(grp.name)}</span>
          ${members.length > 0 ? `<span class="project-group-count">${members.length}</span>` : ''}
          <span class="project-group-chevron">${grp.collapsed ? '▸' : '▾'}</span>
        </div>
        ${grp.collapsed || members.length === 0 ? '' : `
        <div class="project-group-items">
          ${members.map(renderItem).join('')}
        </div>`}
      </div>`;
    };

    projectsList.innerHTML = groups.length > 0 || projectGroups.length > 0 ? `
      <div class="terminal-list">
        ${pinned.map(renderItem).join('')}
        ${hasPinnedProjects && (projectGroups.length > 0 || ungroupedSorted.length > 0) ? '<div class="project-separator"></div>' : ''}
        ${ungroupedSorted.map((g, i) => `
          ${renderItem(g)}
          ${i === ungroupedWithTerminals.length - 1 && ungroupedWithout.length > 0 ? '<div class="project-separator"></div>' : ''}
        `).join('')}
        ${projectGroups.length > 0 && ungroupedSorted.length > 0 ? '<div class="project-separator"></div>' : ''}
        ${projectGroups.map(renderGroup).join('')}
      </div>
    ` : `<div class="no-terminals">No terminals open in iTerm2</div>`;

    // Attach context menu to project items
    projectsList.querySelectorAll('.terminal-list-item[data-project-name]').forEach(item => {
      item.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        const projectName = item.dataset.projectName;
        if (projectName === 'Other') return;
        showProjectContextMenu(e, projectName);
      });
    });

    // Attach context menu to group headers
    projectsList.querySelectorAll('.project-group-header[data-group-id]').forEach(header => {
      header.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        showGroupContextMenu(e, header.dataset.groupId);
      });
    });
  }

  // Update fullscreen button state
  const fsBtn = document.querySelector('.fullscreen-toggle-btn');
  if (fsBtn) fsBtn.textContent = dashboardState.fullscreen ? '⊗' : '⤢';

  // Update flat-list toggle button state
  const flatBtn = document.querySelector('.flat-list-toggle-btn');
  if (flatBtn) {
    flatBtn.classList.toggle('active', dashboardState.flatProjectList);
    flatBtn.title = dashboardState.flatProjectList ? 'Show projects grouped' : 'Show projects as flat list (no groups)';
  }

  captureVoiceTextareaSelection();
  captureCmdInputState();

  panel.innerHTML = `
    <div class="terminal-dashboard">
      <div class="dashboard-card output-card">
        ${selectedGroup ? `
          <!-- Terminal tabs bar -->
          <div class="terminal-tabs-bar">
            <div class="terminal-tabs-scroll">
              ${selectedTabs.map(tab => {
                const isPinned = getPinnedNameForCurrentProject() === tab.name;
                return `
                <button class="term-tab-btn ${tab.sessionId === dashboardState.viewingSessionId ? 'active' : ''} ${isPinned ? 'pinned' : ''}"
                        data-session="${tab.sessionId}" data-name="${escapeHtml(tab.name)}"
                        title="Double-click to rename">
                  ${isPinned ? '<span class="term-tab-pin-indicator"></span>' : ''}
                  ${runnerBadgeHtml(tab.sessionId)}${escapeHtml(tab.name)}
                  ${isPinned ? `<span class="term-tab-pin active" data-act="itermUnpin" data-stop="1" title="Unpin terminal">&#x1F4CC;</span>` : ''}
                  <span class="term-tab-focus" data-act="itermFocusSession" data-arg="${tab.sessionId}" data-stop="1" title="Focus in iTerm2 (o)">⤴</span>
                  <span class="term-tab-close" data-act="itermCloseTab" data-arg="${tab.sessionId}" data-stop="1" title="Close terminal">×</span>
                </button>`;
              }).join('')}
              ${isRealProject ? `<button class="term-tab-btn term-add-tab" data-act="itermCreateTab" title="New Terminal (n)">+</button>` : ''}
            </div>
            <div class="terminal-controls">
              ${dashboardState.viewingSessionId ? `
              ` : ''}
              <div class="terminal-font-controls">
                <button class="font-size-btn" data-act="itermFontSize" data-arg="-1">-</button>
                <span class="font-size-value">${dashboardState.fontSize}</span>
                <button class="font-size-btn" data-act="itermFontSize" data-arg="1">+</button>
              </div>
              <div class="terminal-theme-selector">
                <button class="theme-dot" style="background:${currentThemeObj.color}" data-act="itermToggleThemeMenu" title="Color theme"></button>
                <div class="theme-menu ${dashboardState.themeMenuOpen ? 'visible' : ''}" id="themeMenu">
                  ${TERMINAL_THEMES.map(t => `
                    <button class="theme-option ${t.name === dashboardState.currentTheme ? 'active' : ''}" data-act="itermSetTheme" data-arg="${t.name}">
                      <span class="theme-color" style="background:${t.color}"></span>
                      <span class="theme-name">${t.displayName}</span>
                    </button>
                  `).join('')}
                </div>
              </div>
            </div>
          </div>

          <!-- Output viewer -->
          ${dashboardState.viewingSessionId ? (
            dashboardState.sessionContents?.startsWith('ERROR:') ? `
            <div class="output-viewer-container">
              <div class="bridge-error">
                <div class="bridge-error-title">Cannot watch this session</div>
                <div class="bridge-error-msg">${escapeHtml(dashboardState.sessionContents.slice(7))}</div>
              </div>
            </div>
          ` : `
            <div class="output-viewer-container">
              <div class="iterm-output-viewer" id="itermOutputViewer"></div>
              ${renderInputPanel()}
            </div>
          `) : `
            <div class="output-placeholder ${allTabs.length === 0 ? 'setup-guide' : ''}">
              ${allTabs.length === 0 ? `
                ${renderDependencyGuide(isRealProject)}
              ` : selectedTabs.length === 0 && isRealProject ? `
                <span>No terminals for this project</span>
                <button class="fc-btn fc-btn-primary" data-act="itermCreateTab" title="New terminal (n)">Create terminal (n)</button>
              ` : `
                <span>Select a terminal tab to view its output</span>
              `}
            </div>
            ${allTabs.length > 0 || isRealProject
              ? renderInputPanel({ disabled: true, placeholder: 'Create a terminal to start typing…' })
              : ''}
          `}
        ` : `
          <div class="output-placeholder setup-guide">
            ${groups.length === 0 ? `
              ${renderDependencyGuide()}
            ` : `
              <span>Select a project</span>
            `}
          </div>
        `}
      </div>
    </div>
  `;

  // Always apply theme and font size when viewer exists
  if (dashboardState.viewingSessionId) {
    applyCurrentTheme();
    applyFontSize();

    if (dashboardState.useStyledMode && dashboardState.styledLines) {
      updateStyledOutputViewer();
    } else if (dashboardState.sessionContents) {
      const viewer = document.getElementById('itermOutputViewer');
      if (viewer) {
        viewer.textContent = dashboardState.sessionContents;
        viewer.scrollTop = viewer.scrollHeight;
      }
    }

    // Attach smart click handler: only focus the input if the user didn't
    // select text
    const viewer = document.getElementById('itermOutputViewer');
    if (viewer && !viewer._focusHandlerAttached) {
      let mouseDownPos = null;
      viewer.addEventListener('mousedown', (e) => {
        mouseDownPos = { x: e.clientX, y: e.clientY };
      });
      viewer.addEventListener('mouseup', (e) => {
        if (!mouseDownPos) return;
        const dx = Math.abs(e.clientX - mouseDownPos.x);
        const dy = Math.abs(e.clientY - mouseDownPos.y);
        const sel = window.getSelection();
        const hasSelection = sel && sel.toString().length > 0;
        if (dx < 3 && dy < 3 && !hasSelection) {
          document.getElementById('itermCommandInput')?.focus();
        }
        mouseDownPos = null;
      });
      viewer._focusHandlerAttached = true;
    }

    if (viewer && !viewer._viewSizeObserved) {
      new ResizeObserver(() => syncTermViewSize()).observe(viewer);
      viewer._viewSizeObserved = true;
    }
  }

  // Attach click + dblclick to tab buttons via event delegation
  const tabsScroll = panel.querySelector('.terminal-tabs-scroll');
  if (tabsScroll) {
    tabsScroll.addEventListener('click', (e) => {
      const btn = e.target.closest('.term-tab-btn');
      if (!btn || btn.querySelector('.tab-rename-input')) return;
      const sid = btn.dataset.session;
      if (sid) window.itermSelectTerminal(sid);
    });
    tabsScroll.addEventListener('dblclick', (e) => {
      const btn = e.target.closest('.term-tab-btn');
      if (!btn) return;
      const sid = btn.dataset.session;
      const name = btn.dataset.name;
      if (sid && name) startInlineRename(btn, sid, name);
    });
  }

  restoreCmdInputState();
  patchClaudeSessionDots();

  if (dashboardState.voiceState === 'listening') {
    restoreVoiceTextareaFocus();
  }
  document.getElementById('itermCommandInput')?.addEventListener('paste', handleClipboardPaste);
  renderPromptQueue();
}

let _voiceSelectionBeforeRender = null;
let _cmdInputStateBeforeRender = null;

function captureCmdInputState() {
  const input = document.getElementById('itermCommandInput');
  if (!input) {
    _cmdInputStateBeforeRender = null;
    return;
  }
  _cmdInputStateBeforeRender = {
    value: input.value,
    start: input.selectionStart,
    end: input.selectionEnd,
    wasFocused: document.activeElement === input
  };
}

function restoreCmdInputState() {
  const snap = _cmdInputStateBeforeRender;
  _cmdInputStateBeforeRender = null;
  if (!snap) return;
  const input = document.getElementById('itermCommandInput');
  if (!input) return;
  if (snap.value) input.value = snap.value;
  const max = input.value.length;
  input.setSelectionRange(Math.min(snap.start, max), Math.min(snap.end, max));
  if (snap.wasFocused && document.activeElement !== input) {
    input.focus();
  }
}

function captureVoiceTextareaSelection() {
  if (dashboardState.voiceState !== 'listening') {
    _voiceSelectionBeforeRender = null;
    return;
  }
  const ta = document.getElementById('voicePreviewText');
  if (!ta) return;
  _voiceSelectionBeforeRender = { start: ta.selectionStart, end: ta.selectionEnd };
}

function restoreVoiceTextareaSelection(ta) {
  const sel = _voiceSelectionBeforeRender;
  _voiceSelectionBeforeRender = null;
  if (sel) {
    const max = ta.value.length;
    ta.setSelectionRange(Math.min(sel.start, max), Math.min(sel.end, max));
  } else {
    const len = ta.value.length;
    ta.setSelectionRange(len, len);
  }
}

function restoreVoiceTextareaFocus() {
  const ta = document.getElementById('voicePreviewText');
  if (!ta) return;
  if (document.activeElement !== ta) ta.focus();
  restoreVoiceTextareaSelection(ta);
}

export function showTerminalDashboard() {
  refreshDashboardData();
}

// ============================================
// Styles
// ============================================



// ============================================
// Project switcher handler
// ============================================

export function initTerminalDashboardHandler() {
  registerStateHandler('terminalDashboard', {
    priority: 80,

    onLoad: (ctx) => {
      // Auto-select active project only if nothing is selected yet
      if (!dashboardState.selectedProjectName && state.activeProject?.name) {
        dashboardState.selectedProjectName = state.activeProject.name;
      }
    },

    onAfterSwitch: async (ctx) => {
      const projectName = state.activeProject?.name;
      if (!projectName) return;

      // Update workspace info in sidebar
      updateWorkspaceInfo();

      // Switch terminal dashboard to the new project
      stopViewing();
      dashboardState.selectedProjectName = projectName;

      // Auto-select pinned terminal if it exists in this project, otherwise first tab (and pin it)
      const allTabs = dashboardState.itermStatus?.tabs || [];
      const groups = buildProjectGroups(allTabs);
      const group = groups.find(g => g.name === projectName);
      const projectTabs = group?.tabs || [];
      const pinnedName = getPinnedNameForCurrentProject();
      const pinnedTab = pinnedName
        ? projectTabs.find(t => t.name === pinnedName)
        : null;
      if (pinnedTab) {
        window.itermSelectTerminal(pinnedTab.sessionId);
      } else if (projectTabs.length > 0) {
        // No pinned tab in this project — open first tab and it gets auto-pinned
        window.itermSelectTerminal(projectTabs[0].sessionId);
      }
    },
  });
}
