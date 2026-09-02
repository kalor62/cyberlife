// Term menu: keyboard-driven overlay replacing the old command input bar.
// Opened with ⌘M from any mode (or m in NORMAL on the Term module); collects
// voice input, saved prompts and voice configuration in one list.

import { escapeHtml } from './utils.js';
import { state } from './state.js';
import { listTermMenuItems } from './term-menu-registry.js';
import { GetProjectPrompts, GetGlobalPrompts, IncrementPromptUsage, GetVoiceLang, GetVoiceAutoSubmit, GetTranscriptionEngine, GetElevenLabsAPIKey } from '../../wailsjs/go/main/App.js';

let menuState = null; // null = closed; { cursor, items }

export function isTermMenuOpen() {
  return !!menuState;
}

export function toggleTermMenu() {
  if (menuState) closeTermMenu();
  else openTermMenu();
}

export function closeTermMenu() {
  menuState = null;
  document.getElementById('termMenuModal')?.remove();
}

async function loadMenuData() {
  const projectId = state.activeProject?.id;
  const [projectPrompts, globalPrompts, voiceLang, autoSubmit, engine, elevenKey] = await Promise.all([
    projectId ? GetProjectPrompts(projectId).catch(() => []) : Promise.resolve([]),
    GetGlobalPrompts().catch(() => []),
    GetVoiceLang().catch(() => 'en-US'),
    GetVoiceAutoSubmit().catch(() => true),
    GetTranscriptionEngine().catch(() => 'native'),
    GetElevenLabsAPIKey().catch(() => ''),
  ]);
  const prompts = [
    ...(projectPrompts || []).map(p => ({ ...p, isGlobal: false })),
    ...(globalPrompts || []).map(p => ({ ...p, isGlobal: true })),
  ].sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0));
  return { prompts, voiceLang, autoSubmit, engine, scribeAvailable: !!(elevenKey && elevenKey.trim()) };
}

function sendPrompt(p) {
  closeTermMenu();
  window.itermSendText?.(p.content);
  window.termNoteLastPrompt?.(p);
  IncrementPromptUsage(state.activeProject?.id || '', p.id, p.isGlobal)
    .catch((err) => console.warn('prompt usage increment failed:', err));
}

function buildItems(data) {
  const items = [];

  items.push({
    label: '🎤 Voice input',
    hint: '⌘R',
    run: () => {
      closeTermMenu();
      window.itermVoiceStart?.();
    },
  });
  items.push({
    label: `🌐 Language: ${data.voiceLang === 'pl-PL' ? 'Polski' : 'English'}`,
    run: () => {
      data.voiceLang = data.voiceLang === 'pl-PL' ? 'en-US' : 'pl-PL';
      window.itermSetVoiceLang?.(data.voiceLang);
      rerenderTermMenu(data);
    },
  });
  items.push({
    label: `${data.autoSubmit ? '☑' : '☐'} Auto submit voice text`,
    run: () => {
      data.autoSubmit = !data.autoSubmit;
      window.itermSetVoiceAutoSubmit?.(data.autoSubmit);
      rerenderTermMenu(data);
    },
  });
  if (data.scribeAvailable) {
    items.push({
      label: `🎛 Engine: ${data.engine === 'scribe' ? 'ElevenLabs Scribe' : 'Native macOS'}`,
      run: () => {
        data.engine = data.engine === 'scribe' ? 'native' : 'scribe';
        window.itermSetVoiceEngine?.(data.engine);
        rerenderTermMenu(data);
      },
    });
  }
  const wrappersOn = window.isPromptWrappersEnabled ? window.isPromptWrappersEnabled() : true;
  items.push({
    label: `${wrappersOn ? '☑' : '☐'} Prompt wrappers`,
    run: () => {
      window.itermToggleWrappers?.();
      rerenderTermMenu(data);
    },
  });

  const hasSession = window.itermIsViewingSession?.();
  listTermMenuItems().forEach((it, i) => {
    items.push({
      section: i === 0 ? 'Addons' : null,
      label: it.label,
      hint: it.hint,
      run: () => {
        closeTermMenu();
        const ctx = {
          session: window.itermViewingSession?.() || null,
          project: state.activeProject || null,
          lastPrompt: window.termGetLastPrompt?.() || null,
        };
        Promise.resolve(it.run(ctx)).catch((err) => console.warn(`term menu item ${it.addonId}:${it.id} failed:`, err));
      },
    });
  });

  data.prompts.forEach((p, i) => {
    items.push({
      section: i === 0 ? 'Prompts' : null,
      label: `${p.pinned ? '📌' : '📝'} ${p.title}`,
      title: p.content,
      hint: i < 9 ? String(i + 1) : '',
      disabled: !hasSession,
      run: () => sendPrompt(p),
      promptIndex: i,
    });
  });

  return items;
}

function rerenderTermMenu(data) {
  if (!menuState) return;
  menuState.items = buildItems(data);
  menuState.data = data;
  if (menuState.cursor >= menuState.items.length) menuState.cursor = menuState.items.length - 1;
  renderTermMenu();
}

export async function openTermMenu() {
  if (menuState) return;
  document.activeElement?.blur();
  menuState = { cursor: 0, items: [], data: null };

  const modal = document.createElement('div');
  modal.id = 'termMenuModal';
  modal.className = 'modal';
  modal.addEventListener('click', (e) => { if (e.target === modal) closeTermMenu(); });
  document.body.appendChild(modal);
  renderTermMenu();

  const data = await loadMenuData();
  if (!menuState) return; // closed while loading
  rerenderTermMenu(data);
}

function renderTermMenu() {
  const modal = document.getElementById('termMenuModal');
  if (!modal || !menuState) return;
  const { items, cursor } = menuState;

  modal.innerHTML = `
    <div class="modal-content module-order-modal">
      <h2>Terminal menu</h2>
      <div class="settings-widget-list">
        ${items.length === 0 ? '<div class="settings-widget-row">Loading…</div>' : ''}
        ${items.map((item, i) => `
          ${item.section ? `<div class="shortcuts-nav-group">${item.section}</div>` : ''}
          <div class="settings-widget-row ${i === cursor ? 'kb-selected' : ''}" data-index="${i}"
               ${item.title ? `title="${escapeHtml(item.title).replace(/"/g, '&quot;')}"` : ''}
               ${item.disabled ? 'style="opacity:0.4"' : ''}>
            <span class="settings-widget-name">${escapeHtml(item.label)}</span>
            <span class="fc-spacer"></span>
            ${item.hint ? `<kbd>${item.hint}</kbd>` : ''}
          </div>
        `).join('')}
      </div>
      <div class="shortcuts-context-hint">j/k move · ↵ select · 1-9 send prompt · Esc close</div>
    </div>
  `;

  modal.querySelectorAll('.settings-widget-row[data-index]').forEach(row => {
    row.addEventListener('click', () => runItem(parseInt(row.dataset.index)));
  });
  modal.querySelector('.kb-selected')?.scrollIntoView({ block: 'nearest' });
}

function runItem(index) {
  const item = menuState?.items[index];
  if (!item || item.disabled) return;
  menuState.cursor = index;
  item.run();
}

export function handleTermMenuKey(e) {
  if (!menuState) return;
  if (e.key === 'Escape' || (e.metaKey && !e.shiftKey && e.key === 'm')) {
    e.preventDefault();
    closeTermMenu();
    return;
  }
  if (e.metaKey || e.ctrlKey || e.altKey) return;

  switch (e.key) {
    case 'j': case 'ArrowDown':
      e.preventDefault();
      menuState.cursor = Math.min(menuState.items.length - 1, menuState.cursor + 1);
      renderTermMenu();
      return;
    case 'k': case 'ArrowUp':
      e.preventDefault();
      menuState.cursor = Math.max(0, menuState.cursor - 1);
      renderTermMenu();
      return;
    case 'Enter': case ' ':
      e.preventDefault();
      runItem(menuState.cursor);
      return;
  }
  if (e.key >= '1' && e.key <= '9') {
    const idx = menuState.items.findIndex(it => it.promptIndex === parseInt(e.key) - 1);
    if (idx !== -1) {
      e.preventDefault();
      runItem(idx);
    }
  }
}
