// Shell: module registry, module bar, status bar and keyboard modes.
// Modules are full-screen views registered by module-host.js; the shell renders
// the top bar with digit shortcuts and the bottom status bar with the
// NORMAL / INSERT / TERM mode indicator.

import { escapeHtml } from './utils.js';
import { bellHtml, wireBell } from './notifications.js';
import { state } from './state.js';
import { GetModuleOrder, SetModuleOrder, GetHiddenModules, SetHiddenModules, GetAppVersion } from '../../wailsjs/go/main/App.js';

const modules = [];
let appVersion = '';
let moduleOrder = []; // user-chosen tab order (module ids); empty = registration order
let userHidden = new Set(); // tabs the user hid from the bar
let mode = 'normal';

// ============================================
// Registry
// ============================================

export function registerModule(mod) {
  if (modules.some(m => m.id === mod.id)) return;
  modules.push(mod);
}

export function unregisterModule(id) {
  const i = modules.findIndex(m => m.id === id);
  if (i >= 0) modules.splice(i, 1);
}

export function getModules() {
  return modules;
}

function orderedModules() {
  if (!moduleOrder.length) return modules;
  const byId = new Map(modules.map(m => [m.id, m]));
  const out = moduleOrder.map(id => byId.get(id)).filter(Boolean);
  for (const m of modules) {
    if (!out.includes(m)) out.push(m);
  }
  return out;
}

function moduleHidden(m) {
  return typeof m.hidden === 'function' ? m.hidden() : !!m.hidden;
}

// Hidden modules (built-in like Health, disabled-addon tabs, or user-hidden
// tabs) keep full keyboard behavior but take no tab and no digit
export function getVisibleModules() {
  return orderedModules().filter(m => !moduleHidden(m) && !userHidden.has(m.id));
}

export async function loadModuleOrder() {
  try {
    moduleOrder = await GetModuleOrder() || [];
    userHidden = new Set(await GetHiddenModules() || []);
  } catch (err) {
    console.warn('Module order load failed:', err);
  }
  renderModuleBar();
}

export function activeModuleIndex() {
  return modules.findIndex(m => m.isActive());
}

export function switchToVisibleModuleByIndex(idx) {
  const visible = getVisibleModules();
  if (idx < 0 || idx >= visible.length) return;
  visible[idx].switchTo();
}

export function cycleModule(direction) {
  const visible = getVisibleModules();
  if (visible.length === 0) return;
  const active = modules[activeModuleIndex()];
  let idx = visible.indexOf(active);
  if (idx === -1) idx = 0;
  const next = (idx + direction + visible.length) % visible.length;
  visible[next].switchTo();
}

// ============================================
// Modes: normal | insert | term
// ============================================

export function getMode() {
  return mode;
}

export function setMode(next) {
  if (mode === next) return;
  mode = next;
  renderStatusBar();
  document.dispatchEvent(new CustomEvent('shell-mode-change', { detail: mode }));
}

window.shellGetMode = getMode;

function isEditable(el) {
  if (!el) return false;
  const tag = el.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  return !!el.isContentEditable;
}

// Some modal may be open without a focused field; NORMAL commands must not
// fire underneath it
export function hasOpenModal() {
  const candidates = document.querySelectorAll('.modal, .modal-overlay, [id$="Modal"]');
  for (const el of candidates) {
    if (el.classList.contains('hidden')) continue;
    if (el.offsetParent !== null) return true;
  }
  return false;
}

// ============================================
// Module bar (top)
// ============================================

export function renderModuleBar() {
  const bar = document.getElementById('browserTabsBar');
  if (!bar) return;

  bar.innerHTML = `
    <div class="browser-tabs-container">
      ${getVisibleModules().map((m, i) => `
        <div class="browser-tab shell-tab ${m.isActive() ? 'active' : ''}" data-module-id="${m.id}">
          ${i < 9 ? `<span class="shell-tab-digit">${i + 1}</span>` : ''}
          <span class="tab-icon">${m.icon}</span>
          <span class="tab-title">${m.label}</span>
          <span class="shell-tab-badge" id="shellBadge-${m.id}" style="display:none;"></span>
        </div>
      `).join('')}
      <button class="shell-tab-sort" id="shellTabSort" title="Reorder tabs (⇧T)">⇅</button>
    </div>
  `;

  bar.querySelectorAll('.shell-tab').forEach(tabEl => {
    tabEl.addEventListener('click', () => {
      const mod = modules.find(m => m.id === tabEl.dataset.moduleId);
      if (mod) mod.switchTo();
    });
  });
  bar.querySelector('#shellTabSort')?.addEventListener('click', openModuleOrderModal);

  refreshBadges();
  renderStatusBar();
  document.dispatchEvent(new CustomEvent('shell-module-change', {
    detail: modules[activeModuleIndex()]?.id || null,
  }));
}

export function refreshBadges() {
  for (const m of modules) {
    if (!m.badge) continue;
    const el = document.getElementById(`shellBadge-${m.id}`);
    if (!el) continue;
    const value = m.badge();
    if (value) {
      el.textContent = value > 99 ? '99+' : String(value);
      el.style.display = 'inline-flex';
    } else {
      el.style.display = 'none';
    }
  }
}

// ============================================
// Tab order modal: j/k select, J/K move, Esc closes; saved to app state
// ============================================

// acorn-style pick & place: Space (or click) picks a tab up, navigating and
// pressing Space again (or clicking another row) drops it there
export function openModuleOrderModal() {
  document.getElementById('moduleOrderModal')?.remove();
  // All user-manageable modules, in current order — including hidden tabs
  const ids = orderedModules().filter(m => !moduleHidden(m)).map(m => m.id);
  let cursor = 0;
  let picked = -1;

  const persistHidden = () => {
    SetHiddenModules([...userHidden])?.catch?.((err) => console.error('Hidden modules save failed:', err));
    renderModuleBar();
  };

  const toggleVisibility = (i) => {
    const id = ids[i];
    if (userHidden.has(id)) {
      userHidden.delete(id);
    } else {
      if (ids.filter(x => !userHidden.has(x)).length <= 1) return; // keep at least one tab
      userHidden.add(id);
    }
    persistHidden();
    rerender();
  };

  const modal = document.createElement('div');
  modal.id = 'moduleOrderModal';
  modal.className = 'modal';
  modal.tabIndex = -1;
  document.body.appendChild(modal);

  const persist = () => {
    moduleOrder = [...ids];
    SetModuleOrder(ids)?.catch?.((err) => console.error('Module order save failed:', err));
    renderModuleBar();
  };

  const placeAt = (target) => {
    const [id] = ids.splice(picked, 1);
    ids.splice(target, 0, id);
    cursor = target;
    picked = -1;
    persist();
    rerender();
  };

  const toggleAt = (i) => {
    if (picked === -1) {
      picked = i;
      cursor = i;
      rerender();
    } else if (picked === i) {
      picked = -1;
      rerender();
    } else {
      placeAt(i);
    }
  };

  const rerender = () => {
    const byId = new Map(modules.map(m => [m.id, m]));
    let digit = 0;
    modal.innerHTML = `
      <div class="modal-content module-order-modal">
        <h2>Tab order</h2>
        <div class="settings-widget-list">
          ${ids.map((id, i) => {
            const m = byId.get(id);
            const hidden = userHidden.has(id);
            const n = hidden ? 0 : ++digit;
            return `
            <div class="settings-widget-row ${i === cursor ? 'kb-selected' : ''} ${i === picked ? 'mo-picked' : ''} ${hidden ? 'mo-hidden' : ''}" data-index="${i}">
              <span class="settings-widget-name">${n && n <= 9 ? `<span class="shell-tab-digit">${n}</span> ` : ''}${m.icon} ${m.label}</span>
              <span class="fc-spacer"></span>
              ${i === picked ? '<span class="board-chip mo-picked-chip">picked — drop with Space</span>' : ''}
              <button class="mo-eye" data-eye="${i}" title="${hidden ? 'Show tab (v)' : 'Hide tab (v)'}">${hidden ? '🚫' : '👁'}</button>
            </div>
          `;}).join('')}
        </div>
        <div class="shortcuts-context-hint">j/k move · Space pick up / drop · v or 👁 toggle visibility · Esc ${picked !== -1 ? 'cancel pick' : 'close'}</div>
      </div>
    `;
    modal.querySelectorAll('.settings-widget-row').forEach(row => {
      row.addEventListener('click', () => toggleAt(parseInt(row.dataset.index)));
    });
    modal.querySelectorAll('.mo-eye').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        cursor = parseInt(btn.dataset.eye);
        toggleVisibility(cursor);
      });
    });
  };

  const close = () => modal.remove();
  modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
  modal.addEventListener('keydown', (e) => {
    e.stopPropagation();
    switch (e.key) {
      case 'Escape':
        if (picked !== -1) {
          picked = -1;
          rerender();
        } else {
          close();
        }
        break;
      case 'j': case 'ArrowDown':
        e.preventDefault();
        cursor = Math.min(ids.length - 1, cursor + 1);
        rerender();
        break;
      case 'k': case 'ArrowUp':
        e.preventDefault();
        cursor = Math.max(0, cursor - 1);
        rerender();
        break;
      case ' ':
        e.preventDefault();
        toggleAt(cursor);
        break;
      case 'v':
        e.preventDefault();
        toggleVisibility(cursor);
        break;
      case 'Enter':
        e.preventDefault();
        if (picked !== -1) toggleAt(cursor);
        else close();
        break;
    }
  });

  rerender();
  modal.focus();
}

// ============================================
// Status bar (bottom)
// ============================================

const MODE_LABELS = { normal: 'NORMAL', insert: 'INSERT', term: 'TERM' };
const MODE_HINTS = {
  normal: '1-9 modules · Enter/i prompt · a attach · ⌘M menu · ? shortcuts',
  insert: 'Esc back to NORMAL',
  term: 'keys go to the session · ⌘M menu · Ctrl+U to leave',
};

export function renderStatusBar() {
  const el = document.getElementById('shellStatusBar');
  if (!el) return;

  const project = state.activeProject;
  const mod = modules[activeModuleIndex()];

  el.innerHTML = `
    <span class="shell-brand" title="Cyber Life v${appVersion}">⚡ Cyber&nbsp;Life<span class="shell-brand-ver">${appVersion ? 'v' + appVersion : ''}</span></span>
    <span class="shell-mode shell-mode-${mode}">${MODE_LABELS[mode] || mode}</span>
    ${project ? `<span class="shell-status-item">${project.icon || '📁'} ${escapeHtml(project.name)}</span>` : ''}
    ${mod ? `<span class="shell-status-item">${mod.icon} ${mod.label}</span>` : ''}
    <span class="shell-status-spacer"></span>
    <span class="shell-status-hint">${MODE_HINTS[mode] || ''}</span>
    ${bellHtml()}
  `;
  wireBell();
}


// ============================================
// Init
// ============================================

export function initShell() {
  GetAppVersion().then(v => {
    appVersion = v || '';
    renderStatusBar();
  }).catch((err) => console.warn('app version load failed:', err));
  document.addEventListener('focusin', (e) => {
    if (isEditable(e.target)) setMode('insert');
  });
  document.addEventListener('focusout', () => {
    if (mode === 'insert') setMode('normal');
  });
  renderStatusBar();
}
