import './style.css';
import './app.css';
import 'highlight.js/styles/github-dark.css';

// Module imports
import { state } from './modules/state.js';
import { escapeHtml, textToBase64 } from './modules/utils.js';
import {
  setupGitSection,
  refreshGitStatus,
  renderGitFileList,
  updateGitDisplay,
  setGitCallbacks,
  initGitHandler
} from './modules/git.js';
import {
  showGitDiff,
  clearDiffSelection,
  setDiffCallbacks
} from './modules/diff.js';
import {
  updateClaudeStatusUI
} from './modules/claude-status.js';
import {
  setupToolsPanel,
  renderToolsPanel,
  refreshToolsPanel,
  initToolsPanelHandler,
  toolsState
} from './modules/tools-panel.js';

// New module imports
import {
  initModules,
  initModuleHostHandler
} from './modules/module-host.js';
import {
  selectProject,
  updateWorkspaceInfo,
  setupEditProjectModal
} from './modules/projects.js';
import {
  renderColorPicker,
  renderIconPicker
} from './modules/ui-pickers.js';
import {
  loadClaudeAccounts,
  buildAccountOptions,
  attachAccountSelect
} from './modules/claude-accounts.js';
import {
  renderGroupModals,
  setupGroupModals,
  openAddChoiceModal
} from './modules/project-groups.js';

// Notes module
import {
  renderNotesSection,
  setNotesCallbacks,
  renderNotesModal,
  setupNotesModal,
  initNotesHandler
} from './modules/notes.js';

// Pomodoro module
import {
  initPomodoro,
  setPomodoroCallbacks,
  renderPomodoro
} from './modules/pomodoro.js';

// Terminal dashboard module (center panel)
import {
  initTerminalDashboard,
  initTerminalDashboardHandler,
  renderTerminalDashboard
} from './modules/terminal-dashboard.js';

// Structure panel module
import {
  initStructurePanel,
  initStructureHandler
} from './modules/structure-panel.jsx';

// Health dashboard module (main panel tab)
import {
  initHealthDashboard
} from './modules/health-dashboard.js';
import { initAutoModule } from './modules/auto-module.js';
import { initWidgets } from './modules/widgets.js';
import { initDashModule } from './modules/dash-module.js';
import { initAddons } from './modules/addon-host.js';

// iTerm2 integration module (managed in sidebar)
import {
  initITermPanel
} from './modules/iterm-panel.js';

// Keyboard shortcuts module
import { initKeyboardShortcuts } from './modules/keyboard-shortcuts.js';
import { initShell } from './modules/shell.js';
import { initNotifications } from './modules/notifications.js';
import { initProjectsModule } from './modules/projects-module.js';
import { initTasks } from './modules/tasks.js';

// NOTE: xterm.js terminal removed - using iTerm2 integration instead

// Backend imports
import {
  Log,
  GetState,
  GetProject,
  CreateProject,
  DeleteProject,
  UpdateProject,
  SetActiveProject,
  SelectDirectory,
  GetDefaultColors,
  GetDefaultIcons,
  SaveNotes,
  GetNotes,
  GetPomodoroSettings,
  SavePomodoroSettings
} from '../wailsjs/go/main/App';
import { EventsOn, WindowToggleMaximise, WindowIsFullscreen } from '../wailsjs/runtime/runtime';

// Module callbacks will be set up in init()

// Helper to insert text to terminal (no-op: xterm.js removed, using iTerm2)
function insertToTerminal(text) {
  // TODO: Could implement iTerm2 paste via AppleScript in the future
  console.log('insertToTerminal: iTerm2 integration - text not inserted:', text.substring(0, 50));
}

// Frontend crashes used to vanish into a devtools console nobody has open;
// route them into the same rotating log the backend writes
function installErrorReporting() {
  const report = (kind, err) => {
    const detail = err?.stack || err?.message || String(err);
    console.error(`[${kind}]`, err);
    Log('error', 'Frontend', `${kind}: ${detail}`, {}).catch(() => {});
  };
  window.addEventListener('error', (e) => report('uncaught', e.error || e.message));
  window.addEventListener('unhandledrejection', (e) => report('unhandled rejection', e.reason));
}

// Initialize app
async function init() {
  installErrorReporting();
  wireDiffNav();
  // Setup module callbacks
  setGitCallbacks({
    showGitDiff
  });
  setDiffCallbacks({
    switchTab
  });

  // Initialize project switcher handlers
  initModuleHostHandler({ switchTab });
  initNotesHandler();
  initTerminalDashboardHandler();
  initGitHandler();
  initToolsPanelHandler();
  initStructureHandler();
  initITermPanel();

  // Setup notes callbacks
  setNotesCallbacks({
    saveNotes: SaveNotes,
    getNotes: GetNotes,
    insertToTerminal
  });

  // Setup pomodoro callbacks (init called after render)
  setPomodoroCallbacks({
    saveSettings: SavePomodoroSettings,
    loadSettings: GetPomodoroSettings
  });

  // Load initial data
  state.colors = await GetDefaultColors();
  state.icons = await GetDefaultIcons();

  // Load full state from backend
  const appState = await GetState();
  state.projects = Object.values(appState.projects || {});
  state.projectGroups = appState.projectGroups || [];

  await loadClaudeAccounts();

  // NOTE: Terminal theme and xterm.js event handlers removed - using iTerm2 integration

  EventsOn('active-project-changed', (data) => {
    const { projectId, state: projectState } = data;
    // Handle external project change (e.g., from another window)
    if (state.activeProject?.id !== projectId) {
      const project = state.projects.find(p => p.id === projectId);
      if (project) {
        state.activeProject = project;
        updateWorkspaceInfo();
      }
    }
  });

  // Agents mutate workspace data through the local API — refresh live
  EventsOn('projects-changed', async () => {
    try {
      const fresh = await GetState();
      state.projects = Object.values(fresh.projects || {});
      state.projectGroups = fresh.projectGroups || [];
      window.itermRefreshDashboard?.();
    } catch (err) {
      console.warn('projects refresh failed:', err);
    }
  });
  EventsOn('notes-changed', () => {
    import('./modules/notes.js').then(({ renderNotesPanel }) => {
      if (document.getElementById('notesPanel')?.style.display !== 'none') renderNotesPanel();
    }).catch((err) => { console.warn('notes refresh failed:', err); });
  });
  EventsOn('prompts-changed', () => {
    // Prompts live in Settings now — refresh the panel when it is open
    import('./modules/settings-dashboard.js').then(({ renderSettingsPanel }) => {
      if (document.getElementById('settingsPanel')?.style.display !== 'none') renderSettingsPanel();
    }).catch((err) => { console.warn('prompts refresh failed:', err); });
  });

  // Claude CLI status detection with project context
  EventsOn('state:claude:status', (data) => {
    const { projectId, terminalId, status } = data;
    const oldStatus = state.claudeStatus.get(terminalId);

    if (status === 'none') {
      state.claudeStatus.delete(terminalId);
    } else {
      state.claudeStatus.set(terminalId, status);
    }

    if (oldStatus !== status) {
      updateClaudeStatusUI(terminalId);
    }
  });

  // Render UI
  // Tab order/visibility must be known before initBrowserTabs picks the
  // startup module (position 1 = default view)
  try {
    const { loadModuleOrder } = await import('./modules/shell.js');
    await loadModuleOrder();
  } catch (err) {
    console.warn('module order load failed:', err);
  }

  render();

  // Initialize pomodoro (after render, NOT project specific)
  initPomodoro();

  // Initialize terminal dashboard (center panel)
  initTerminalDashboard();

  // Initialize structure panel
  initStructurePanel();

  // Initialize health dashboard (main panel)
  initHealthDashboard();
  initAutoModule();

  // Initialize shell (module bar, status bar, keyboard modes) and shortcuts
  initShell();
  initNotifications();
  initKeyboardShortcuts();
  initProjectsModule();

  // Widget area (right sidebar) — after legacy sections have initialized
  initWidgets();
  initDashModule();
  initAddons();

  // Initialize tasks (worktree + resumable Claude session per work item)
  initTasks();

  // Detect fullscreen and toggle titlebar visibility
  async function updateFullscreenClass() {
    const isFs = await WindowIsFullscreen();
    document.body.classList.toggle('wails-fullscreen', isFs);
  }
  updateFullscreenClass();
  window.addEventListener('resize', updateFullscreenClass);

  // If we have projects, select the first one or the previously active one
  if (state.projects.length > 0) {
    const activeId = appState.activeProjectId || state.projects[0].id;
    selectProject(activeId);
  }
}

// Render main UI
function render() {
  document.querySelector('#app').innerHTML = `
    <div class="app-container">
      <!-- Titlebar Drag Region -->
      <div class="titlebar-drag-region"></div>

      <!-- Main Content -->
      <div class="main-content">
        <!-- Main Panel -->
        <div class="main-panel">
          <!-- Tab Bar (for special tabs like diff) -->
          <div class="panel-tabs">
            <button class="panel-tab diff-tab hidden" data-tab="diff" id="diffTab">
              <span class="diff-tab-name">file.js</span>
              <span class="diff-tab-close" id="closeDiffTab">×</span>
            </button>
            <div class="panel-tabs-spacer"></div>
          </div>

          <!-- Tab Content -->
          <div class="panel-content">
            <!-- Browser/Dashboard Panel (main content area) -->
            <div id="browserPanel" class="tab-panel active">
              <div class="browser-content">
                <div class="browser-tabs-bar" id="browserTabsBar">
                  <!-- Module tabs rendered by shell.js -->
                </div>

                <!-- Term panel (sessions) -->
                <div class="dashboard-panel" id="dashboardPanel" style="display: flex;"></div>

                <!-- Board Panel (kanban) -->
                <div class="board-panel" id="boardPanel" style="display: none;">
                  <!-- Rendered by board-module.js -->
                </div>

                <!-- Help Panel -->
                <div class="help-panel" id="helpPanel" style="display: none;">
                  <!-- Rendered by help-module.js -->
                </div>

                <!-- Projects Panel (mission control, rendered by projects-module.js) -->
                <div class="projects-panel" id="projectsPanel" style="display: none;"></div>

                <!-- Health Panel -->
                <div class="health-panel" id="healthPanel" style="display: none;">
                  <!-- Content rendered by health-dashboard.js -->
                </div>

                <!-- Structure Panel -->
                <div class="structure-panel" id="structurePanel" style="display: none;">
                  <!-- Content rendered by structure-panel.js -->
                </div>

                <!-- Auto Panel (automation rules) -->
                <div class="auto-panel" id="autoPanel" style="display: none;">
                  <!-- Rendered by auto-module.js -->
                </div>

                <!-- Dash Panel (custom widget dashboards) -->
                <div class="dash-panel" id="dashPanel" style="display: none;">
                  <!-- Rendered by dash-module.js -->
                </div>

                <!-- Prompts Panel -->
                <div class="prompts-panel" id="promptsPanel" style="display: none;">
                  <div class="prompts-container" id="promptsContainer"></div>
                </div>

                <!-- Notes Panel -->
                <div class="notes-panel" id="notesPanel" style="display: none;">
                  <!-- Content rendered by notes.js -->
                </div>

                <!-- Settings Panel -->
                <div class="settings-panel" id="settingsPanel" style="display: none;">
                  <!-- Content rendered by settings-dashboard.js -->
                </div>

                <!-- Email Panel -->
                <div class="email-panel" id="emailPanel" style="display: none;">
                  <!-- Content rendered by email-dashboard.js -->
                </div>

              </div>
            </div>

            <div id="diffPanel" class="tab-panel">
              <div class="diff-panel-content">
                <div class="diff-toolbar">
                  <span class="diff-filename" id="diffFilename">No file selected</span>
                  <div class="diff-nav">
                    <button class="diff-nav-btn" data-diff-nav="prev" title="Previous change">&#x25B2;</button>
                    <span class="diff-change-counter" id="diffChangeCounter"></span>
                    <button class="diff-nav-btn" data-diff-nav="next" title="Next change">&#x25BC;</button>
                  </div>
                  <button id="refreshDiff" class="small-btn" title="Refresh">🔄</button>
                </div>
                <div class="diff-viewer" id="diffViewer">
                  <div class="diff-empty-state">
                    <p>Select a file from Git Diff to view changes</p>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <!-- Tools Panel (Bottom) -->
        </div>

        <!-- Right Sidebar Resizer -->
        <div class="sidebar-resizer right-sidebar-resizer" id="rightSidebarResizer"></div>

        <!-- Right Sidebar: widget area (composed by widgets.js) -->
        <div class="sidebar right-sidebar" id="rightSidebar">
          <div class="widget-sidebar-header">
            <span class="widget-sidebar-title">Widgets</span>
            <button class="widget-collapse-btn" id="widgetCollapseBtn" title="Collapse sidebar (w)">⟩</button>
          </div>
          <div class="widget-strip" id="widgetStrip"></div>
          <div class="widget-area" id="widgetArea"></div>
          <!-- Legacy widget sections wait here until widgets.js places them -->
          <div id="widgetStash" style="display: none;">
            <div class="sidebar-section git-section" id="gitSection">
              <div class="git-section-resizer" id="gitSectionResizer"></div>
              <div class="git-header" id="gitHeader">
                <span class="git-toggle">▼</span>
                <h3>Git</h3>
                <div class="git-stats" id="gitStats"></div>
                <button id="refreshGit" class="small-btn git-refresh" title="Refresh">🔄</button>
              </div>
              <div id="gitContent" class="git-content">
                <div class="git-branch-bar" id="gitBranchBar"></div>
                <div id="gitFileList" class="git-file-list"></div>
              </div>
            </div>
            <div class="sidebar-section pomodoro-section" id="pomodoroSection">
              <!-- Pomodoro timer rendered by pomodoro.js - NOT project specific -->
            </div>
            <div class="sidebar-section notes-section" id="notesSection">
              <!-- Notes section rendered by notes.js -->
            </div>
          </div>
        </div>
      </div>

      <!-- Shell Status Bar -->
      <div class="shell-status-bar" id="shellStatusBar"></div>
    </div>

    <!-- Add Project Modal -->
    <div id="addProjectModal" class="modal hidden">
      <div class="modal-content">
        <h2>Add Project</h2>
        <form id="addProjectForm">
          <div class="form-group">
            <label>Name</label>
            <input type="text" id="projectName" required placeholder="My Project">
          </div>
          <div class="form-group">
            <label>Path</label>
            <div class="path-input">
              <input type="text" id="projectPath" required placeholder="/path/to/project">
              <button type="button" id="browseBtn" class="small-btn">Browse</button>
            </div>
          </div>
          <div class="form-group">
            <label>Group</label>
            <select id="projectGroup" class="account-select"></select>
          </div>
          <div class="form-group">
            <label>Icon</label>
            <div id="iconPicker" class="icon-picker"></div>
          </div>
          <div class="form-actions">
            <button type="button" id="cancelAddProject" class="secondary-btn">Cancel</button>
            <button type="submit" class="primary-btn">Add Project</button>
          </div>
        </form>
      </div>
    </div>

    <!-- Edit Project Modal -->
    <div id="editProjectModal" class="modal hidden">
      <div class="modal-content">
        <h2>Edit Project</h2>
        <form id="editProjectForm">
          <div class="form-group">
            <label>Name</label>
            <input type="text" id="editProjectName" required placeholder="My Project">
          </div>
          <div class="form-group">
            <label>Path</label>
            <div class="path-input">
              <input type="text" id="editProjectPath" required placeholder="/path/to/project">
              <button type="button" id="editBrowseBtn" class="small-btn">Browse</button>
            </div>
          </div>
          <div class="form-group">
            <label>Default runner</label>
            <select id="editDefaultRunner" class="account-select"></select>
            <span class="form-hint">New Term sessions in this project. Empty inherits the global default (Settings → Runners).</span>
          </div>
          <div class="form-group">
            <label>Claude account</label>
            <select id="editClaudeConfigDir" class="account-select"></select>
            <span class="form-hint">Default account used for terminals in this project</span>
          </div>
          <div class="form-group">
            <label>Group</label>
            <select id="editProjectGroup" class="account-select"></select>
          </div>
          <div class="form-group">
            <label>Icon</label>
            <div id="editIconPicker" class="icon-picker"></div>
          </div>
          <div class="form-actions">
            <button type="button" id="cancelEditProject" class="secondary-btn">Cancel</button>
            <button type="submit" class="primary-btn">Save</button>
          </div>
        </form>
      </div>
    </div>

    <!-- Tools Modal for Agents/Hooks editing and Library info -->
    <div id="toolsModal" class="tools-modal hidden">
      <div class="tools-modal-content">
        <div class="tools-modal-header">
          <h3 id="toolsModalTitle">Edit Agent</h3>
          <div class="tools-modal-header-actions">
            <button id="fullscreenToolsModal" class="tools-modal-fullscreen" title="Toggle fullscreen">⛶</button>
            <button id="closeToolsModal" class="tools-modal-close">×</button>
          </div>
        </div>
        <div class="tools-modal-body" id="toolsModalBody">
          <!-- Content dynamically inserted -->
        </div>
        <div class="tools-modal-footer" id="toolsModalFooter">
          <button id="cancelToolsModal" class="secondary-btn">Cancel</button>
          <button id="saveToolsModal" class="primary-btn">Save</button>
        </div>
      </div>
    </div>

    ${renderGroupModals()}

    <!-- Notes Modal -->
    ${renderNotesModal()}

    <!-- Keyboard Shortcuts Modal (content rendered by keyboard-shortcuts.js) -->
    <div id="shortcutsModal" class="modal hidden">
      <div class="modal-content shortcuts-modal-content" id="shortcutsModalContent"></div>
    </div>
  `;

  // Setup event listeners
  setupEventListeners();
  setupGitSection();
  setupToolsPanel();
  setupEditProjectModal();
  setupGroupModals(renderTerminalDashboard);
  window.openAddChoiceModal = openAddChoiceModal;
  setupNotesModal();

  // Initialize shell modules (tab at position 1 is the startup view)
  initModules();

  // Render dynamic parts
  renderNotesSection();
  renderColorPicker();
  renderIconPicker();
}

function setupEventListeners() {
  // Double-click on titlebar to toggle maximize/restore
  document.querySelector('.titlebar-drag-region')?.addEventListener('dblclick', () => {
    WindowToggleMaximise();
  });

  // Cancel add project
  document.getElementById('cancelAddProject').addEventListener('click', () => {
    document.getElementById('addProjectModal').classList.add('hidden');
  });

  // Add project form
  document.getElementById('addProjectForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = document.getElementById('projectName').value;
    const path = document.getElementById('projectPath').value;
    const claudeConfigDir = document.getElementById('projectClaudeAccount')?.value || '';
    const groupId = document.getElementById('projectGroup')?.value || '';
    const icon = document.getElementById('iconPicker')?.dataset.selectedIcon || '';
    const color = document.querySelector('#colorPicker .color-option.selected')?.dataset.color || '';

    try {
      const project = await CreateProject(name, path);
      if (claudeConfigDir || groupId || icon || color) {
        project.claudeConfigDir = claudeConfigDir;
        project.groupId = groupId;
        if (icon) project.icon = icon;
        if (color) project.color = color;
        await UpdateProject(project);
      }
      state.projects.push(project);
      selectProject(project.id);
      document.getElementById('addProjectModal').classList.add('hidden');
      document.getElementById('addProjectForm').reset();
    } catch (err) {
      alert('Error creating project: ' + err);
    }
  });

  // Browse button
  document.getElementById('browseBtn').addEventListener('click', async () => {
    const path = await SelectDirectory();
    if (path) {
      document.getElementById('projectPath').value = path;
    }
  });


  // Panel tabs
  document.querySelectorAll('.panel-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      const tabName = tab.dataset.tab;
      switchTab(tabName);
    });
  });


  // Load Gmail account config (module bar badge + Mail view)
  import('./modules/email-dashboard.js').then(({ updateEmailButton }) => updateEmailButton());

  // Close modal on outside click
  document.getElementById('addProjectModal').addEventListener('click', (e) => {
    if (e.target.id === 'addProjectModal') {
      document.getElementById('addProjectModal').classList.add('hidden');
    }
  });

  // Split view no longer used - main panel is full width now
  // initSplitView();

  // Close diff tab
  document.getElementById('closeDiffTab')?.addEventListener('click', (e) => {
    e.stopPropagation();
    closeDiffTab();
  });

  // Sidebar resizers
  setupSidebarResizer();
  setupRightSidebarResizer();

  // Git section resizer
  setupGitSectionResizer();
}

// Setup sidebar horizontal resizer
function setupSidebarResizer() {
  const resizer = document.getElementById('sidebarResizer');
  const sidebar = document.querySelector('.sidebar');
  if (!resizer || !sidebar) return;

  let isResizing = false;
  let startX = 0;
  let startWidth = 0;

  resizer.addEventListener('mousedown', (e) => {
    isResizing = true;
    startX = e.clientX;
    startWidth = sidebar.offsetWidth;
    resizer.classList.add('active');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  });

  document.addEventListener('mousemove', (e) => {
    if (!isResizing) return;
    const deltaX = e.clientX - startX;
    const maxWidth = window.innerWidth * 0.8;
    const newWidth = Math.min(maxWidth, Math.max(180, startWidth + deltaX));
    sidebar.style.width = `${newWidth}px`;
  });

  document.addEventListener('mouseup', () => {
    if (isResizing) {
      isResizing = false;
      resizer.classList.remove('active');
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    }
  });
}

// Setup right sidebar horizontal resizer
function setupRightSidebarResizer() {
  const resizer = document.getElementById('rightSidebarResizer');
  const sidebar = document.getElementById('rightSidebar');
  if (!resizer || !sidebar) return;

  let isResizing = false;
  let startX = 0;
  let startWidth = 0;

  resizer.addEventListener('mousedown', (e) => {
    isResizing = true;
    startX = e.clientX;
    startWidth = sidebar.offsetWidth;
    resizer.classList.add('active');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  });

  document.addEventListener('mousemove', (e) => {
    if (!isResizing) return;
    // For right sidebar, dragging left increases width
    const deltaX = startX - e.clientX;
    const maxWidth = window.innerWidth * 0.8;
    const newWidth = Math.min(maxWidth, Math.max(200, startWidth + deltaX));
    sidebar.style.width = `${newWidth}px`;
  });

  document.addEventListener('mouseup', () => {
    if (isResizing) {
      isResizing = false;
      resizer.classList.remove('active');
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      import('./modules/widgets.js').then(({ saveSidebarWidthFromDrag }) => {
        saveSidebarWidthFromDrag(sidebar.offsetWidth);
      }).catch((err) => { console.warn('sidebar width save failed:', err); });
    }
  });
}

// Setup git section vertical resizer
function setupGitSectionResizer() {
  const resizer = document.getElementById('gitSectionResizer');
  const gitSection = document.querySelector('.git-section');
  const sidebar = document.querySelector('.sidebar');
  if (!resizer || !gitSection || !sidebar) return;

  let isResizing = false;
  let startY = 0;
  let startHeight = 0;

  resizer.addEventListener('mousedown', (e) => {
    isResizing = true;
    startY = e.clientY;
    startHeight = gitSection.offsetHeight;
    resizer.classList.add('active');
    document.body.style.cursor = 'row-resize';
    document.body.style.userSelect = 'none';
  });

  document.addEventListener('mousemove', (e) => {
    if (!isResizing) return;
    const deltaY = startY - e.clientY;
    const sidebarHeight = sidebar.offsetHeight;
    const maxHeight = sidebarHeight * 0.6;
    const newHeight = Math.min(maxHeight, Math.max(100, startHeight + deltaY));
    gitSection.style.height = `${newHeight}px`;
    gitSection.style.maxHeight = `${newHeight}px`;
  });

  document.addEventListener('mouseup', () => {
    if (isResizing) {
      isResizing = false;
      resizer.classList.remove('active');
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    }
  });
}


function closeDiffTab() {
  const diffTab = document.getElementById('diffTab');
  const viewer = document.getElementById('diffViewer');

  if (diffTab) diffTab.classList.add('hidden');
  if (viewer) {
    viewer.innerHTML = `
      <div class="diff-empty-state">
        <p>Select a file from Git Diff to view changes</p>
      </div>
    `;
  }

  state.git.currentDiffFile = null;

  if (state.activeTab === 'diff') {
    switchTab('terminal');
  }
}

function wireDiffNav() {
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-diff-nav]');
    if (!btn) return;
    if (btn.dataset.diffNav === 'prev') window.diffGoToPrev?.();
    else window.diffGoToNext?.();
  });
}

function switchTab(tabName) {
  state.activeTab = tabName;

  const browserPanel = document.getElementById('browserPanel');
  const diffPanel = document.getElementById('diffPanel');

  // Update active state on special tabs (diff)
  document.querySelectorAll('.panel-tab').forEach(tab => {
    tab.classList.toggle('active', tab.dataset.tab === tabName);
  });

  // Handle special tabs (diff) vs main browser panel
  if (tabName === 'diff') {
    browserPanel.classList.remove('active');
    diffPanel.classList.add('active');
  } else {
    // Show browser panel (full width)
    browserPanel.classList.add('active');
    diffPanel.classList.remove('active');
  }

}

// Terminal Search Bar (Cmd+F / Ctrl+F)
// NOTE: Terminal search removed - using iTerm2's native search

// Start the app
init();
