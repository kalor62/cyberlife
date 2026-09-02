// Notification center: the bell in the status bar and its popup. Entries are
// produced in Go (automations, addons via cl.notify, agents via the notify
// tool); this module only reads, marks, archives and deletes them.

import { escapeHtml } from './utils.js';
import * as bus from './bus.js';
import {
  GetNotifications,
  GetUnreadNotificationCount,
  MarkNotificationRead,
  ArchiveNotification,
  DeleteNotification,
} from '../../wailsjs/go/main/App.js';
import { BrowserOpenURL } from '../../wailsjs/runtime/runtime.js';

let unread = 0;
let popup = null; // null = closed; { cursor, items, archived }

export function isNotificationsOpen() {
  return !!popup;
}

export function bellHtml() {
  return `<button class="shell-bell ${unread ? 'has-unread' : ''}" id="shellBell" title="Notifications (⌘N)">🔔${unread ? `<span class="shell-bell-count">${unread > 99 ? '99+' : unread}</span>` : ''}</button>`;
}

function paintBell() {
  const bell = document.getElementById('shellBell');
  if (!bell) return;
  bell.outerHTML = bellHtml();
  wireBell();
}

function wireBell() {
  document.getElementById('shellBell')?.addEventListener('click', toggleNotifications);
}

async function refreshUnread() {
  try {
    unread = await GetUnreadNotificationCount();
  } catch (err) {
    console.warn('unread notification count failed:', err);
  }
  paintBell();
}

export function initNotifications() {
  bus.on('notifications-changed', async () => {
    await refreshUnread();
    if (popup) await loadItems();
  });
  refreshUnread();
}

export function toggleNotifications() {
  if (popup) closeNotifications();
  else openNotifications();
}

export function closeNotifications() {
  popup = null;
  document.getElementById('notificationsModal')?.remove();
}

export async function openNotifications() {
  if (popup) return;
  document.activeElement?.blur();
  popup = { cursor: 0, items: [], archived: false };
  const modal = document.createElement('div');
  modal.id = 'notificationsModal';
  modal.className = 'modal';
  modal.addEventListener('click', (e) => { if (e.target === modal) closeNotifications(); });
  document.body.appendChild(modal);
  render();
  await loadItems();
}

async function loadItems() {
  if (!popup) return;
  try {
    const all = await GetNotifications(popup.archived);
    popup.items = popup.archived ? all.filter((n) => n.archivedAt) : all;
  } catch (err) {
    console.warn('notifications load failed:', err);
    popup.items = [];
  }
  if (popup.cursor >= popup.items.length) popup.cursor = Math.max(0, popup.items.length - 1);
  render();
}

function fmtWhen(iso) {
  const d = new Date(iso);
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay
    ? d.toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleString('pl-PL', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function render() {
  const modal = document.getElementById('notificationsModal');
  if (!modal || !popup) return;
  const { items, cursor, archived } = popup;
  modal.innerHTML = `
    <div class="modal-content notifications-modal">
      <div class="notifications-head">
        <h2>🔔 Notifications</h2>
        <div class="notifications-tabs">
          <button class="notif-tab ${archived ? '' : 'active'}" data-tab="inbox">Inbox${unread ? ` (${unread})` : ''}</button>
          <button class="notif-tab ${archived ? 'active' : ''}" data-tab="archive">Archive</button>
        </div>
        <span class="fc-spacer"></span>
        ${!archived && items.length ? '<button class="notif-action-btn" data-act="read-all" title="Mark all read (⇧R)">✓ all read</button>' : ''}
        <button class="notif-action-btn" data-modal-close title="Close (Esc)">✕</button>
      </div>
      <div class="notifications-list">
        ${items.length === 0 ? `<div class="notifications-empty">${archived ? 'Archive is empty.' : 'No notifications.'}</div>` : ''}
        ${items.map((n, i) => `
          <div class="notif-row ${i === cursor ? 'kb-selected' : ''} ${n.readAt ? '' : 'unread'}" data-index="${i}">
            <div class="notif-main">
              <div class="notif-title">${n.readAt ? '' : '<span class="notif-dot">●</span>'}${escapeHtml(n.title)}</div>
              ${n.message ? `<div class="notif-message">${escapeHtml(n.message)}</div>` : ''}
              <div class="notif-meta">${n.source ? `<span class="notif-source">${escapeHtml(n.source)}</span> · ` : ''}${fmtWhen(n.createdAt)}${n.link ? ` · <a class="notif-link" data-href="${escapeHtml(n.link)}">open ↗</a>` : ''}</div>
            </div>
            <div class="notif-actions">
              ${n.readAt ? '' : '<button data-act="read" title="Mark read (r)">✓</button>'}
              ${n.archivedAt ? '' : '<button data-act="archive" title="Archive (a)">🗄</button>'}
              <button data-act="delete" title="Delete (d)">🗑</button>
            </div>
          </div>
        `).join('')}
      </div>
      <div class="shortcuts-context-hint">j/k move · r read · a archive · d delete · ⇧R all read · Tab archive/inbox · ↵ open link · Esc close</div>
    </div>
  `;

  modal.querySelectorAll('.notif-tab').forEach((b) => b.addEventListener('click', () => setArchived(b.dataset.tab === 'archive')));
  modal.querySelector('[data-act="read-all"]')?.addEventListener('click', markAllRead);
  modal.querySelector('[data-modal-close]')?.addEventListener('click', closeNotifications);
  modal.querySelectorAll('.notif-row').forEach((row) => {
    const idx = parseInt(row.dataset.index);
    row.addEventListener('click', (e) => {
      popup.cursor = idx;
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (act) {
        e.stopPropagation();
        runAction(act, idx);
        return;
      }
      const link = e.target.closest('.notif-link');
      if (link) {
        e.preventDefault();
        openLink(items[idx]);
        return;
      }
      if (!items[idx].readAt) runAction('read', idx);
      else render();
    });
  });
  modal.querySelector('.kb-selected')?.scrollIntoView({ block: 'nearest' });
}

async function setArchived(on) {
  if (!popup) return;
  popup.archived = on;
  popup.cursor = 0;
  await loadItems();
}

function openLink(n) {
  if (!n?.link) return;
  if (/^https?:\/\//.test(n.link)) BrowserOpenURL(n.link);
  else bus.emit('notification-open-link', n);
  if (!n.readAt) runAction('read', popup.items.indexOf(n));
}

async function runAction(act, idx) {
  const n = popup?.items[idx];
  if (!n) return;
  try {
    if (act === 'read') await MarkNotificationRead(n.id);
    else if (act === 'archive') await ArchiveNotification(n.id);
    else if (act === 'delete') await DeleteNotification(n.id);
  } catch (err) {
    console.warn(`notification ${act} failed:`, err);
  }
  // the changed event reloads; nothing else to do here
}

async function markAllRead() {
  try {
    await MarkNotificationRead('');
  } catch (err) {
    console.warn('mark all notifications read failed:', err);
  }
}

export function handleNotificationsKey(e) {
  if (!popup) return;
  if (e.key === 'Escape' || (e.metaKey && !e.shiftKey && e.key === 'n')) {
    e.preventDefault();
    closeNotifications();
    return;
  }
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const { items } = popup;
  switch (e.key) {
    case 'j': case 'ArrowDown':
      e.preventDefault();
      popup.cursor = Math.min(items.length - 1, popup.cursor + 1);
      render();
      return;
    case 'k': case 'ArrowUp':
      e.preventDefault();
      popup.cursor = Math.max(0, popup.cursor - 1);
      render();
      return;
    case 'Tab':
      e.preventDefault();
      setArchived(!popup.archived);
      return;
    case 'r':
      e.preventDefault();
      runAction('read', popup.cursor);
      return;
    case 'R':
      e.preventDefault();
      markAllRead();
      return;
    case 'a':
      e.preventDefault();
      runAction('archive', popup.cursor);
      return;
    case 'd':
      e.preventDefault();
      runAction('delete', popup.cursor);
      return;
    case 'Enter':
      e.preventDefault();
      openLink(items[popup.cursor]);
      return;
  }
}

export { wireBell };
