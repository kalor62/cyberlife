// Keyboard shortcuts: mode-aware routing (NORMAL / INSERT / TERM) plus the
// legacy Cmd-shortcuts that work from any mode.

import { state } from './state.js';
import { getMode, setMode, cycleModule, switchToVisibleModuleByIndex, getModules, activeModuleIndex, hasOpenModal, openModuleOrderModal } from './shell.js';
import { isHintMode, enterHintMode, handleHintKey } from './hint-mode.js';
import { isProjectSwitcherOpen, openProjectSwitcher, handleProjectSwitcherKey } from './quick-switcher.js';
import { SHORTCUT_SECTIONS, renderSingleSection, sectionForModule, generalSections, moduleSections } from './shortcuts-data.js';
import { togglePomodoro } from './pomodoro.js';
import { toggleWidgetSidebar } from './widgets.js';
import { openCommandPalette, closeCommandPalette, isCommandPaletteOpen } from './command-palette.js';
import { isTermMenuOpen, toggleTermMenu, handleTermMenuKey } from './term-menu.js';
import { isNotificationsOpen, toggleNotifications, handleNotificationsKey } from './notifications.js';

// g-chord: `g` followed by a module mnemonic within the window
const G_CHORD_TARGETS = {
  d: 'tab-dashboard',
  p: 'projects-tab',
  b: 'board-tab',
  h: 'health-tab',
  s: 'tab-structure',
  a: 'auto-tab',
  w: 'dash-tab',
  e: 'email-tab',
  n: 'notes-tab',
  o: 'settings-tab',
};
let gChordUntil = 0;

const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

function isEditableElement(el) {
  if (!el) return false;
  const tag = el.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  return !!el.isContentEditable;
}

const TERM_KEY_MAP = {
  Enter: 'enter',
  Backspace: 'backspace',
  Escape: 'esc',
  ArrowUp: 'up',
  ArrowDown: 'down',
  ArrowLeft: 'left',
  ArrowRight: 'right',
};

// Ctrl+U is the detach key, so it cannot also reach the session — everything
// else a shell needs is forwarded.
// 'v' included so Ctrl+V reaches Claude Code, which reads image pastes
// from the OS clipboard itself
const TERM_CTRL_KEYS = new Set(['c', 'd', 'z', 'l', 'a', 'e', 'k', 'r', 'v']);

function handleKeydown(e) {
  // Non-mac platforms use Ctrl+K for the palette (Cmd is a mac key);
  // TERM mode keeps Ctrl combos for the session
  if (!IS_MAC && e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey
      && e.key === 'k' && getMode() !== 'term') {
    e.preventDefault();
    if (isCommandPaletteOpen()) closeCommandPalette();
    else openCommandPalette();
    return;
  }
  // A focused field removed by a re-render fires no focusout, stranding the
  // shell in INSERT with nothing focused — self-heal before dispatching
  if (getMode() === 'insert' && !isEditableElement(document.activeElement)) {
    setMode('normal');
  }

  if (isHintMode()) {
    handleHintKey(e);
    return;
  }
  if (isTermMenuOpen()) {
    handleTermMenuKey(e);
    return;
  }
  if (isNotificationsOpen()) {
    handleNotificationsKey(e);
    return;
  }
  if (isProjectSwitcherOpen()) {
    handleProjectSwitcherKey(e);
    return;
  }
  if (isShortcutsModalOpen()) {
    handleShortcutsModalKey(e);
    return;
  }
  if (handleCmdShortcuts(e)) return;

  const mode = getMode();
  if (mode === 'insert') {
    handleInsertKey(e);
    return;
  }
  if (mode === 'term') {
    handleTermKey(e);
    return;
  }
  handleNormalKey(e);
}

// Cmd-shortcuts work in every mode (legacy muscle memory kept intact)
function handleCmdShortcuts(e) {
  if (!e.metaKey || e.altKey) return false;
  const key = e.key;

  if (key === 'ArrowDown' || key === 'ArrowUp' || key === 'ArrowLeft' || key === 'ArrowRight') {
    e.preventDefault();
    window.itermSendKey?.(key.replace('Arrow', '').toLowerCase());
    return true;
  }
  if (e.shiftKey && key === 'Tab') {
    e.preventDefault();
    window.itermSendKey?.('shift-tab');
    return true;
  }
  // ⌘⇧J / ⌘⇧K cycle modules from ANY mode — the escape hatch when ⇧J/⇧K
  // would type into the Term input or the attached session
  if (e.shiftKey && (key === 'J' || key === 'K')) {
    e.preventDefault();
    cycleModule(key === 'J' ? -1 : 1);
    return true;
  }
  if (key === 'Enter') {
    e.preventDefault();
    window.itermSendKey?.('enter');
    return true;
  }
  if (!e.shiftKey && key === 'r') {
    e.preventDefault();
    window.itermToggleVoice?.();
    return true;
  }
  if (!e.shiftKey && key === 'm') {
    e.preventDefault();
    toggleTermMenu();
    return true;
  }
  if (!e.shiftKey && key === 'n') {
    e.preventDefault();
    toggleNotifications();
    return true;
  }
  // ⌘V outside INSERT has no focused field to paste into — route the
  // clipboard to the viewed session; INSERT keeps the native paste
  if (!e.shiftKey && key === 'v' && getMode() !== 'insert' && window.itermIsViewingSession?.()) {
    e.preventDefault();
    window.itermPasteClipboard?.();
    return true;
  }
  if (!e.shiftKey && key === 'p') {
    e.preventDefault();
    togglePomodoro();
    return true;
  }
  if (!e.shiftKey && key === 'k') {
    e.preventDefault();
    if (isCommandPaletteOpen()) closeCommandPalette();
    else openCommandPalette();
    return true;
  }
  if (!e.shiftKey && key >= '1' && key <= '9') {
    const idx = parseInt(key) - 1;
    const order = window._projectDisplayOrder;
    if (order && idx < order.length) {
      e.preventDefault();
      window.itermSelectProject?.(order[idx]);
    }
    return true;
  }
  return true; // unhandled Cmd combos stay out of mode handling
}

// Static modals (declared in main.js HTML) have no Esc handling of their
// own; dynamic ones only catch Esc while focus sits inside them. The global
// fallback closes the topmost visible modal either way.
function closeTopVisibleModal() {
  const candidates = [...document.querySelectorAll('.modal, .modal-overlay, [id$="Modal"]')]
    .filter(el => !el.classList.contains('hidden') && el.offsetParent !== null);
  const top = candidates[candidates.length - 1];
  if (!top) return false;
  const cancel = top.querySelector('[id^="cancel"], .modal-close, [data-modal-close]');
  if (cancel) cancel.click();
  else top.classList.add('hidden');
  return true;
}

function closeShortcutsModalIfOpen() {
  const modal = document.getElementById('shortcutsModal');
  if (modal && !modal.classList.contains('hidden')) {
    modal.classList.add('hidden');
    return true;
  }
  return false;
}

function handleInsertKey(e) {
  if (e.key === 'Escape' && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
    if (window.itermCancelVoice?.()) {
      e.preventDefault();
      return;
    }
    e.preventDefault();
    // The modal sits above the focused field — close it first
    if (closeShortcutsModalIfOpen()) return;
    document.activeElement?.blur();
  }
  // Every other key belongs to the focused field
}

// TERM: full pass-through to the viewed session
function handleTermKey(e) {
  if (e.ctrlKey && !e.metaKey && e.key === 'u') {
    e.preventDefault();
    setMode('normal');
    return;
  }
  if (e.metaKey) return;

  // Option-composed characters (macOS Polish diacritics: ⌥a → ą) arrive with
  // altKey set but a printable e.key — they must reach the session
  if (e.altKey) {
    if (!e.ctrlKey && e.key.length === 1) {
      e.preventDefault();
      window.itermTypeText?.(e.key);
    }
    return;
  }

  if (e.ctrlKey) {
    const k = e.key.toLowerCase();
    // Ctrl+Shift+V — the terminal paste convention on Linux
    if (e.shiftKey && k === 'v') {
      e.preventDefault();
      window.itermPasteClipboard?.();
      return;
    }
    if (TERM_CTRL_KEYS.has(k)) {
      e.preventDefault();
      window.itermSendKey?.('ctrl-' + k);
    }
    return;
  }

  if (e.key === 'Tab') {
    e.preventDefault();
    window.itermSendKey?.(e.shiftKey ? 'shift-tab' : 'tab');
    return;
  }
  const mapped = TERM_KEY_MAP[e.key];
  if (mapped) {
    e.preventDefault();
    window.itermSendKey?.(mapped);
    return;
  }
  if (e.key.length === 1) {
    e.preventDefault();
    window.itermTypeText?.(e.key);
  }
}

function handleNormalKey(e) {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const key = e.key;

  if (key === 'Escape') {
    if (window.itermCancelVoice?.()) {
      e.preventDefault();
      return;
    }
    if (closeShortcutsModalIfOpen()) {
      e.preventDefault();
      return;
    }
    if (closeTopVisibleModal()) {
      e.preventDefault();
      return;
    }
    // Module layers (reading pane etc.) close first
    const mod = getModules()[activeModuleIndex()];
    if (mod?.onKey && mod.onKey(e)) return;
    // No layer open: Esc goes to the Claude session (interrupt)
    e.preventDefault();
    window.itermSendKey?.('esc');
    return;
  }

  if (hasOpenModal()) return;

  // The active module gets first pick (list selection, module actions).
  // A handled key must also be default-prevented, or WKWebView forwards it
  // to the native responder chain and macOS beeps on every press
  if (gChordUntil <= Date.now()) {
    const mod = getModules()[activeModuleIndex()];
    if (mod?.onKey && mod.onKey(e)) {
      e.preventDefault();
      return;
    }
  }

  // g-chord completion
  if (gChordUntil > Date.now()) {
    gChordUntil = 0;
    const targetId = G_CHORD_TARGETS[key];
    if (targetId) {
      e.preventDefault();
      getModules().find(m => m.id === targetId)?.switchTo();
      return;
    }
  }

  if (key >= '1' && key <= '9' && !e.shiftKey) {
    e.preventDefault();
    switchToVisibleModuleByIndex(parseInt(key) - 1);
    return;
  }

  switch (key) {
    case 'ArrowLeft':
      e.preventDefault();
      cycleModule(-1);
      return;
    case 'ArrowRight':
      e.preventDefault();
      cycleModule(1);
      return;
    case 'ArrowUp':
    case 'ArrowDown':
      if (e.shiftKey) {
        e.preventDefault();
        switchProject(key === 'ArrowUp' ? -1 : 1);
      }
      return;
    case 'J':
      e.preventDefault();
      cycleModule(-1);
      return;
    case 'K':
      e.preventDefault();
      cycleModule(1);
      return;
    case 'i': {
      const input = document.getElementById('itermCommandInput');
      if (input && !input.disabled) {
        e.preventDefault();
        input.focus();
      }
      return;
    }
    case 'a':
      if (window.itermIsViewingSession?.()) {
        e.preventDefault();
        setMode('term');
      }
      return;
    case 'p':
      e.preventDefault();
      openProjectSwitcher();
      return;
    case 'w':
      e.preventDefault();
      toggleWidgetSidebar();
      return;
    case 'T':
      e.preventDefault();
      openModuleOrderModal();
      return;
    case 'F':
      e.preventDefault();
      enterHintMode();
      return;
    case 'g':
      e.preventDefault();
      gChordUntil = Date.now() + 600;
      return;
    case '?':
      e.preventDefault();
      window.showShortcutsModal?.();
      return;
  }
}

function switchProject(direction) {
  const projects = state.projects;
  if (!projects || projects.length === 0) return;

  const currentName = state.activeProject?.name;
  let currentIndex = projects.findIndex(p => p.name === currentName);
  if (currentIndex === -1) currentIndex = 0;

  let nextIndex = currentIndex + direction;
  if (nextIndex < 0) nextIndex = projects.length - 1;
  if (nextIndex >= projects.length) nextIndex = 0;

  const nextProject = projects[nextIndex];
  if (nextProject && window.itermSelectProject) {
    window.itermSelectProject(nextProject.name);
  }
}

// ============================================
// Shortcuts modal: one section at a time, sidebar to peek at the others
// ============================================

let shortcutsSection = 'Modes';

function renderShortcutsModal() {
  const content = document.getElementById('shortcutsModalContent');
  if (!content) return;
  const active = SHORTCUT_SECTIONS.find(s => s.title === shortcutsSection) || SHORTCUT_SECTIONS[0];
  const navItem = (s) => `
    <button class="help-nav-item ${s.title === active.title ? 'active' : ''}" data-section="${s.title}">${s.title}</button>
  `;
  content.innerHTML = `
    <div class="shortcuts-context-layout">
      <div class="shortcuts-context-nav">
        <div class="shortcuts-nav-group">General</div>
        ${generalSections().map(navItem).join('')}
        <div class="shortcuts-nav-group">Modules</div>
        ${moduleSections().map(navItem).join('')}
      </div>
      <div class="shortcuts-context-body">
        ${renderSingleSection(active)}
        <div class="shortcuts-context-hint">j/k switch section · Esc close</div>
      </div>
    </div>
  `;
  content.querySelectorAll('[data-section]').forEach(btn => {
    btn.addEventListener('click', () => {
      shortcutsSection = btn.dataset.section;
      renderShortcutsModal();
    });
  });
}

function isShortcutsModalOpen() {
  const modal = document.getElementById('shortcutsModal');
  return modal && !modal.classList.contains('hidden');
}

function handleShortcutsModalKey(e) {
  if (e.metaKey && !e.shiftKey && e.key === 'k') {
    e.preventDefault();
    closeShortcutsModalIfOpen();
    return;
  }
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const idx = SHORTCUT_SECTIONS.findIndex(s => s.title === shortcutsSection);
  switch (e.key) {
    case 'Escape':
    case '?':
      e.preventDefault();
      closeShortcutsModalIfOpen();
      return;
    case 'j':
    case 'ArrowDown':
      e.preventDefault();
      shortcutsSection = SHORTCUT_SECTIONS[Math.min(SHORTCUT_SECTIONS.length - 1, idx + 1)].title;
      renderShortcutsModal();
      return;
    case 'k':
    case 'ArrowUp':
      e.preventDefault();
      shortcutsSection = SHORTCUT_SECTIONS[Math.max(0, idx - 1)].title;
      renderShortcutsModal();
      return;
  }
}

window.showShortcutsModal = function() {
  const modal = document.getElementById('shortcutsModal');
  if (!modal) return;
  if (modal.classList.contains('hidden')) {
    // Open focused on the active module's own section
    const mod = getModules()[activeModuleIndex()];
    shortcutsSection = sectionForModule(mod?.id);
    renderShortcutsModal();
    modal.classList.remove('hidden');
    document.activeElement?.blur();
  } else {
    modal.classList.add('hidden');
  }
};

// Module ids are repeated as literals in the shortcut sections and the g-chord
// map. A typo there fails silently — ? falls back to the first section, g+key
// does nothing — so the mismatch is reported instead of shrugged off.
function warnOnUnknownModuleIds() {
  const known = new Set(getModules().map(m => m.id));
  if (known.size === 0) return;
  const unknown = [
    ...SHORTCUT_SECTIONS.filter(s => s.moduleId && !known.has(s.moduleId)).map(s => `section ${s.title} -> ${s.moduleId}`),
    ...Object.entries(G_CHORD_TARGETS).filter(([, id]) => !known.has(id)).map(([k, id]) => `g+${k} -> ${id}`),
  ];
  if (unknown.length) console.warn('shortcuts point at modules that do not exist:', unknown);
}

export function initKeyboardShortcuts() {
  warnOnUnknownModuleIds();

  // Consume Escape's default action app-wide (capture phase, before any
  // handler) — otherwise macOS treats an unconsumed Esc as "exit fullscreen"
  // even when it only closed a popup
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') e.preventDefault();
  }, true);

  document.addEventListener('keydown', handleKeydown);

  // Close shortcuts modal on outside click
  document.addEventListener('click', (e) => {
    const modal = document.getElementById('shortcutsModal');
    if (modal && e.target === modal) {
      modal.classList.add('hidden');
    }
  });
}
