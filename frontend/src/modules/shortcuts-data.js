// Canonical keyboard shortcut registry — the single source both the quick
// `?` modal and the Help module render from. Add rows here when adding keys.

export const SHORTCUT_SECTIONS = [
  {
    title: 'Modes',
    moduleId: null,
    general: true,
    rows: [
      { keys: ['i'], desc: 'INSERT — write a prompt' },
      { keys: ['a'], desc: 'TERM — attach, keys go to the session' },
      { keys: ['⌃', 'U'], desc: 'Detach from the session' },
      { keys: ['⌘', 'M'], desc: 'Terminal menu — voice, prompts, settings' },
      { keys: ['⌘', 'N'], desc: 'Notifications — j/k, r read, a archive, d delete' },
      { keys: ['Esc'], desc: 'Close layer / interrupt Claude' },
    ],
  },
  {
    title: 'Modules',
    moduleId: null,
    general: true,
    rows: [
      { keys: ['1', '…', '9'], desc: 'Switch module' },
      { keys: ['⇧', '1', '…', '9'], desc: 'Switch page inside an addon module' },
      { keys: ['←', '→'], desc: 'Prev / next module' },
      { keys: ['⇧', 'T'], desc: 'Reorder tabs' },
      { keys: ['g', '+key'], desc: 'Go to: d/p/b/h/s/a/w/e/n/o' },
      { keys: ['p'], desc: 'Project switcher — labels pick like Vimium' },
      { keys: ['j', 'k', '↵'], desc: 'Move in lists / open' },
      { keys: ['⇧', 'F'], desc: 'Hints — click anything by letters' },
    ],
  },
  {
    title: 'Term',
    moduleId: 'tab-dashboard',
    rows: [
      { keys: ['j', 'k'], desc: 'Prev / next session' },
      { keys: ['↵', 'i'], desc: 'Focus the command input' },
      { keys: ['a'], desc: 'Attach — keys go to the session' },
      { keys: ['⌃', 'U'], desc: 'Detach' },
      { keys: ['n'], desc: 'New terminal' },
      { keys: ['q'], desc: 'Toggle queue mode' },
      { keys: ['m'], desc: 'Terminal menu — voice, prompts, settings' },
      { keys: ['o'], desc: 'Open in iTerm' },
    ],
  },
  {
    title: 'Board',
    moduleId: 'board-tab',
    rows: [
      { keys: ['j', 'k', 'h', 'l'], desc: 'Move between cards / columns' },
      { keys: ['⇧', 'H', 'L'], desc: 'Move card to prev / next column' },
      { keys: ['⇧', 'J', 'K'], desc: 'Reorder card in column' },
      { keys: ['↵', 'n'], desc: 'Edit / new task' },
      { keys: ['s', 'b', 'x'], desc: 'Next column / blocked / archive' },
      { keys: ['v', '/', 'C'], desc: 'Board ⇄ list / filter / columns' },
      { keys: ['r'], desc: 'Sync with Jira (when mapped)' },
    ],
  },
  {
    title: 'Dash',
    moduleId: 'dash-tab',
    rows: [
      { keys: ['h', 'l'], desc: 'Prev / next dashboard' },
      { keys: ['n'], desc: 'New dashboard' },
      { keys: ['↵', 'e'], desc: 'Edit current dashboard' },
      { keys: ['r'], desc: 'Refresh widgets' },
    ],
  },
  {
    title: 'Auto',
    moduleId: 'auto-tab',
    rows: [
      { keys: ['j', 'k'], desc: 'Move between rules' },
      { keys: ['↵', 'e'], desc: 'Edit rule' },
      { keys: ['n'], desc: 'New rule' },
      { keys: ['t'], desc: 'Enable / disable' },
      { keys: ['r'], desc: 'Run now' },
      { keys: ['d'], desc: 'Delete' },
    ],
  },
  {
    title: 'Mail',
    moduleId: 'email-tab',
    rows: [
      { keys: ['↵', 'o'], desc: 'Open thread' },
      { keys: ['e'], desc: 'Archive' },
      { keys: ['#'], desc: 'Trash' },
      { keys: ['z'], desc: 'Undo' },
      { keys: ['a'], desc: 'Reply all' },
      { keys: ['⇧', 'R'], desc: 'Reply to sender' },
      { keys: ['f'], desc: 'Forward' },
      { keys: ['u', 's'], desc: 'Read / star' },
      { keys: ['x'], desc: 'Select this thread' },
      { keys: ['*'], desc: 'Select all / none on the page' },
      { keys: ['c', 'r', '/'], desc: 'Compose / refresh / search' },
    ],
  },
  {
    title: 'Files',
    moduleId: 'tab-structure',
    rows: [
      { keys: ['j', 'k'], desc: 'Move in the file tree' },
      { keys: ['↵', 'l'], desc: 'Open file / toggle folder' },
    ],
  },
  {
    title: 'Health',
    moduleId: 'health-tab',
    rows: [
      { keys: ['c'], desc: 'Configure tracked checks' },
      { keys: ['r'], desc: 'Re-scan' },
      { keys: ['/'], desc: 'Filter the library' },
    ],
  },
  {
    title: 'Projects',
    moduleId: 'projects-tab',
    rows: [
      { keys: ['j', 'k', 'h', 'l'], desc: 'Move between project cards' },
      { keys: ['↵', 'o'], desc: 'Open project (↵ goes to Term)' },
      { keys: ['s', 'b', 'e'], desc: 'New session / board / edit' },
      { keys: ['⇧', 'H'], desc: 'Health of the focused project' },
      { keys: ['⇧', 'G'], desc: 'Manage groups' },
      { keys: ['⇧', 'P'], desc: 'Pin / unpin' },
      { keys: ['n', 'v', '/'], desc: 'Add / grid⇄list / filter' },
      { keys: ['f'], desc: 'Cycle group filter' },
      { keys: ['⌘', '1', '…', '9'], desc: 'Switch project directly' },
    ],
  },
  {
    title: 'Session & Tools',
    moduleId: null,
    general: true,
    rows: [
      { keys: ['⌘', '↑', '↓', '←', '→'], desc: 'Arrow to session' },
      { keys: ['⌘', '↵'], desc: 'Enter to session' },
      { keys: ['⌘', 'R'], desc: 'Voice input' },
      { keys: ['⌘', 'M'], desc: 'Terminal menu' },
      { keys: ['⌘', 'P'], desc: 'Pomodoro' },
      { keys: ['w'], desc: 'Collapse / expand widget sidebar' },
      { keys: ['⌘', 'K'], desc: 'Command palette (Ctrl+K on Windows/Linux)' },
      { keys: ['?'], desc: 'Shortcuts — this dialog' },
    ],
  },
];

export function generalSections() {
  return SHORTCUT_SECTIONS.filter(s => s.general);
}

export function moduleSections() {
  return SHORTCUT_SECTIONS.filter(s => !s.general);
}

export function renderShortcutSections() {
  return SHORTCUT_SECTIONS.map(section => `
    <div class="shortcuts-section">
      <h3>${section.title}</h3>
      ${section.rows.map(row => `
        <div class="shortcut-row">
          ${row.keys.map(k => k === '…' ? '…' : `<kbd>${k}</kbd>`).join('')}
          <span>${row.desc}</span>
        </div>
      `).join('')}
    </div>
  `).join('');
}

export function renderSingleSection(section) {
  return `
    <div class="shortcuts-section">
      <h3>${section.title}</h3>
      ${section.rows.map(row => `
        <div class="shortcut-row">
          ${row.keys.map(k => k === '…' ? '…' : `<kbd>${k}</kbd>`).join('')}
          <span>${row.desc}</span>
        </div>
      `).join('')}
    </div>
  `;
}

// Best section for the current context: the active module's own, else Modes
export function sectionForModule(moduleId) {
  const hit = SHORTCUT_SECTIONS.find(s => s.moduleId && s.moduleId === moduleId);
  return hit ? hit.title : 'Modes';
}
