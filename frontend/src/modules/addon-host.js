// Addon host: imports the frontend entry of every enabled addon from the
// local API server and hands each a scoped context (events, storage, api,
// widget registration). Reacts to "addons-changed" by deactivating and
// re-importing, so agents can hot-reload addons they are building.

import * as bus from './bus.js';
import { registerAddonWidget, removeAddonWidgets, rerenderSidebarWidgets } from './widgets.js';
import { registerAddonModule, unregisterAddonModules, switchToModuleId, switchAddonPage } from './module-host.js';
import { registerAddonSettingsSection, removeAddonSettingsSections, refreshSettingsIfOpen } from './settings-dashboard.js';
import { registerTermMenuItem, removeAddonTermMenuItems } from './term-menu-registry.js';
import { setBuiltinStates } from './addon-state.js';
import { renderModuleBar, getModules, getVisibleModules } from './shell.js';
import { AddonsList, AddonStorageAll, AddonStorageSet, AddonStorageDelete, AddonSendEmail, GetGmailConfig } from '../../wailsjs/go/main/App.js';
import { BrowserOpenURL } from '../../wailsjs/runtime/runtime.js';
import { API_BASE } from './utils.js';

const active = new Map(); // addon id -> { addon, dispose, cleanups }
const agentToolHandlers = new Map(); // "addonId:tool" -> async handler
let reloadNonce = 0;
let syncing = false;
let resyncQueued = false;
let pendingSync = false;

export async function initAddons() {
  bus.on('addons-changed', () => {
    reloadNonce++;
    syncAddons(true);
  });
  bus.on('addon-agent-tool', handleAgentToolCall);
  await syncAddons(false);
}

// An MCP call bridged from the Go server (addonbridge.go): run the addon's
// registered handler and post the outcome back so the agent gets a response
async function handleAgentToolCall(payload) {
  const { callId, addon: addonId, tool, args } = payload || {};
  if (!callId) return;
  const respond = async (body) => {
    try {
      const res = await fetch(`${API_BASE}/api/addons/tool-result`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ callId, addon: addonId, ...body }),
      });
      if (!res.ok) {
        console.warn(`addon ${addonId}: tool result rejected (${res.status}) — the agent call likely timed out`);
      }
    } catch (err) {
      console.warn(`addon ${addonId}: tool result post failed:`, err);
    }
  };
  const handler = agentToolHandlers.get(`${addonId}:${tool}`);
  if (!handler) {
    await respond({ error: `addon ${addonId} has no handler for tool "${tool}" (is it enabled and loaded?)` });
    return;
  }
  try {
    const result = await handler(args ?? {});
    await respond({ result: result ?? null });
  } catch (err) {
    console.warn(`addon ${addonId}: agent tool "${tool}" failed:`, err);
    await respond({ error: String(err?.message || err) });
  }
}

export function activeAddonIds() {
  return [...active.keys()];
}

async function syncAddons(reloadActive) {
  // A reload arriving mid-sync must not be dropped, or an addon enabled
  // right after a reload never activates until the next unrelated change
  if (syncing) {
    pendingSync = pendingSync || reloadActive;
    resyncQueued = true;
    return;
  }
  syncing = true;
  try {
    const info = await AddonsList();
    setBuiltinStates(info.addons);
    const enabled = (info.addons || []).filter(a => a.enabled && a.entry && !a.error);
    const wanted = new Set(enabled.map(a => a.id));
    for (const id of [...active.keys()]) {
      if (!wanted.has(id) || reloadActive) deactivate(id);
    }
    for (const addon of enabled) {
      if (!active.has(addon.id)) await activate(addon);
    }
    renderModuleBar();
    rerenderSidebarWidgets();
    refreshSettingsIfOpen();
    const activeMod = getModules().find(m => m.isActive?.());
    if (activeMod && typeof activeMod.hidden === 'function' && activeMod.hidden()) {
      getVisibleModules()[0]?.switchTo();
    }
  } catch (err) {
    console.warn('addon sync failed:', err);
  } finally {
    syncing = false;
  }
  if (resyncQueued) {
    const forceReload = pendingSync;
    resyncQueued = false;
    pendingSync = false;
    await syncAddons(forceReload);
  }
}

async function activate(addon) {
  const url = `${API_BASE}/addons/${addon.id}/${addon.entry}?v=${encodeURIComponent(addon.version || '0')}-${reloadNonce}`;
  const inst = { addon, dispose: null, cleanups: [] };
  try {
    const mod = await import(/* @vite-ignore */ url);
    if (typeof mod.default !== 'function') {
      console.warn(`addon ${addon.id}: entry has no default export function`);
      return;
    }
    active.set(addon.id, inst);
    inst.dispose = await mod.default(makeContext(addon, inst));
  } catch (err) {
    console.warn(`addon ${addon.id}: activation failed:`, err);
    active.delete(addon.id);
  }
}

function deactivate(id) {
  const inst = active.get(id);
  if (!inst) return;
  try {
    inst.dispose?.();
  } catch (err) {
    console.warn(`addon ${id}: dispose failed:`, err);
  }
  for (const cleanup of inst.cleanups) {
    try {
      cleanup();
    } catch (err) {
      console.warn(`addon ${id}: cleanup failed:`, err);
    }
  }
  removeAddonWidgets(id);
  unregisterAddonModules(id);
  removeAddonSettingsSections(id);
  removeAddonTermMenuItems(id);
  active.delete(id);
}

const PATH_GROUPS = [
  ['/api/board', 'board'], ['/api/health', 'health'], ['/api/auto', 'auto'],
  ['/api/widgets', 'widgets'], ['/api/term', 'term'], ['/api/projects', 'projects'],
  ['/api/tasks', 'tasks'], ['/api/notes', 'notes'], ['/api/prompts', 'prompts'],
  ['/api/system', 'system'], ['/api/addons', 'addons'],
  ['/api/calendar', 'calendar'],
];

function requiredGroup(path) {
  return PATH_GROUPS.find(([prefix]) => path.startsWith(prefix))?.[1] || null;
}

function makeContext(addon, inst) {
  const namespaced = (id) => id.startsWith(`${addon.id}.`) ? id : `${addon.id}.${id}`;
  return {
    id: addon.id,
    manifest: addon,

    events: {
      on(name, fn) {
        const offFn = bus.on(name, fn);
        inst.cleanups.push(offFn);
        return offFn;
      },
      off: bus.off,
      emit: bus.emit,
    },

    storage: {
      async all() {
        const raw = await AddonStorageAll(addon.id);
        const out = {};
        for (const [k, v] of Object.entries(raw || {})) {
          try {
            out[k] = JSON.parse(v);
          } catch (err) {
            console.warn(`addon ${addon.id}: bad stored JSON for key ${k}:`, err);
          }
        }
        return out;
      },
      async get(key) {
        const all = await this.all();
        return all[key];
      },
      async set(key, value) {
        await AddonStorageSet(addon.id, key, JSON.stringify(value ?? null));
      },
      async remove(key) {
        await AddonStorageDelete(addon.id, key);
      },
    },

    registerWidget(desc) {
      if (!desc?.id || typeof desc.render !== 'function') {
        throw new Error('registerWidget needs {id, title, render(el)}');
      }
      registerAddonWidget({ ...desc, id: namespaced(desc.id), addonId: addon.id, addonName: addon.name || addon.id });
    },

    registerModule(desc) {
      const paged = Array.isArray(desc?.pages) && desc.pages.length > 0;
      if (!desc?.id || !desc.label || (!paged && typeof desc.render !== 'function')) {
        throw new Error('registerModule needs {id, label, render(el)} or {id, label, pages: [...]}');
      }
      if (paged) {
        for (const p of desc.pages) {
          if (!p?.id || !p.label || typeof p.render !== 'function') {
            throw new Error('registerModule: each page needs {id, label, render(el)}');
          }
        }
      }
      registerAddonModule(addon.id, { ...desc, id: namespaced(desc.id) });
    },

    // Entry in the Term menu (⌘M) under an "Addons" section. run(ctx) gets
    // { session, project, lastPrompt } for the session being viewed.
    registerTermMenuItem(desc) {
      const off = registerTermMenuItem(addon.id, desc);
      inst.cleanups.push(off);
    },

    openModule(id, pageId) {
      switchToModuleId(namespaced(id));
      if (pageId) switchAddonPage(namespaced(id), pageId);
    },

    registerSettingsSection(desc) {
      if (!desc?.label || typeof desc.render !== 'function') {
        throw new Error('registerSettingsSection needs {label, render(el)}');
      }
      const id = namespaced(desc.id || 'settings');
      registerAddonSettingsSection(addon.id, { ...desc, id, icon: desc.icon || addon.icon || '🧩' });
    },

    // Outbound HTTP through the app's proxy — the webview blocks direct
    // cross-origin calls to APIs without CORS (KSeF). Hosts must be
    // allowlisted in addon.json "hosts".
    async http(request) {
      if (typeof request === 'string') request = { url: request };
      const res = await fetch(`${API_BASE}/api/addons/http`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...request, addon: addon.id }),
      });
      if (!res.ok) {
        throw new Error(`http proxy ${request.url}: ${res.status} ${await res.text()}`);
      }
      return res.json();
    },

    // Layout-preserving text extraction from a PDF (base64), via the app's
    // pdftotext bridge — the webview itself cannot read PDF content
    async pdfText(dataBase64) {
      const res = await fetch(`${API_BASE}/api/addons/pdftext`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ addon: addon.id, dataBase64 }),
      });
      if (!res.ok) {
        throw new Error(`pdftext: ${res.status} ${await res.text()}`);
      }
      return (await res.json()).text;
    },

    // Opens a self-contained HTML document in the default browser — the
    // print/PDF path, since WKWebView does not implement window.print()
    async openPreview(html, title) {
      const res = await fetch(`${API_BASE}/api/addons/preview`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ addon: addon.id, html, title }),
      });
      if (!res.ok) {
        throw new Error(`preview: ${res.status} ${await res.text()}`);
      }
    },

    // Per-addon blob store (binary artifacts too big for cl.storage).
    // putDataFile writes (toPdf converts PNG/JPEG to PDF on the host),
    // dataFileUrl is what an <embed>/<a> can load, deleteDataFile removes.
    async putDataFile(path, dataBase64, { toPdf = false } = {}) {
      const res = await fetch(`${API_BASE}/api/addons/datafile`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ addon: addon.id, path, dataBase64, toPdf }),
      });
      if (!res.ok) {
        throw new Error(`datafile ${path}: ${res.status} ${await res.text()}`);
      }
      return res.json();
    },

    async deleteDataFile(path) {
      const res = await fetch(`${API_BASE}/api/addons/datafile`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ addon: addon.id, path, delete: true }),
      });
      if (!res.ok) {
        throw new Error(`datafile delete ${path}: ${res.status} ${await res.text()}`);
      }
    },

    // Concatenate stored PDFs into a new blob-store file (poppler
    // pdfunite); open: true also opens the result in the system viewer
    async mergePdfs(keys, outPath, { open = false } = {}) {
      const res = await fetch(`${API_BASE}/api/addons/pdfmerge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ addon: addon.id, keys, outPath, open }),
      });
      if (!res.ok) {
        throw new Error(`pdfmerge: ${res.status} ${await res.text()}`);
      }
      return res.json();
    },

    // Render HTML to a PDF stored in the addon blob store (headless
    // Chrome) — for email attachments, where a printable page is not enough
    async htmlToPdf(html, outPath) {
      const res = await fetch(`${API_BASE}/api/addons/htmltopdf`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ addon: addon.id, html, outPath }),
      });
      if (!res.ok) {
        throw new Error(`htmltopdf: ${res.status} ${await res.text()}`);
      }
      return res.json();
    },

    // Mirror this addon's blob store into an S3-compatible bucket (R2).
    // action: 'start' kicks off a background job, 'status' polls it (the
    // final status carries an objects manifest), 'test' verifies the
    // credentials by listing the bucket. Credentials are the addon's to
    // store — the host keeps them only for the running job. `job` keeps
    // concurrent backups apart (one per company), `keys` limits the upload
    // to those blob-store paths instead of the whole store.
    async backup(action, config, { job = '', keys = undefined } = {}) {
      const res = await fetch(`${API_BASE}/api/addons/backup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ addon: addon.id, action, config, job, keys }),
      });
      if (!res.ok) {
        throw new Error(`backup ${action}: ${res.status} ${await res.text()}`);
      }
      return res.json();
    },

    // Configured Gmail account addresses — for "send as" pickers
    async listEmailAccounts() {
      const cfg = await GetGmailConfig();
      return (cfg?.accounts || []).map((a) => a.email);
    },

    // Send an email through the app's Gmail integration; attachments are
    // blob-store KEYS (the host confines them to this addon's storage)
    async sendEmail({ account = '', to, cc = '', subject, body, attachmentKeys = [] }) {
      if (!to) throw new Error('sendEmail needs a recipient');
      await AddonSendEmail(addon.id, account, to, cc, subject, body, attachmentKeys);
    },

    // Open an http(s) URL in the system browser — in-webview navigation
    // would replace the whole app
    openUrl(url) {
      if (!/^https?:/i.test(String(url))) throw new Error(`openUrl: not an http(s) URL: ${url}`);
      BrowserOpenURL(url);
    },

    dataFileUrl(path) {
      return `${API_BASE}/addons-data/${addon.id}/${String(path).split('/').map(encodeURIComponent).join('/')}`;
    },

    registerAgentTool(name, handler) {
      if (typeof handler !== 'function') {
        throw new Error('registerAgentTool needs (name, async handler(args))');
      }
      if (!(addon.agentTools || []).some((t) => t.name === name)) {
        console.warn(`addon ${addon.id}: tool "${name}" is not declared in addon.json agentTools — agents will not see it`);
      }
      const key = `${addon.id}:${name}`;
      agentToolHandlers.set(key, handler);
      inst.cleanups.push(() => {
        if (agentToolHandlers.get(key) === handler) agentToolHandlers.delete(key);
      });
    },

    async api(path, body) {
      const group = requiredGroup(path);
      if (!group) throw new Error(`api(): unsupported path ${path}`);
      if (!(addon.permissions || []).includes(group)) {
        throw new Error(`api(): addon.json does not declare the "${group}" permission for ${path}`);
      }
      const opts = body === undefined
        ? undefined
        : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
      const res = await fetch(`${API_BASE}${path}`, opts);
      if (!res.ok) {
        throw new Error(`${path}: ${res.status} ${await res.text()}`);
      }
      return res.json();
    },

    // System notification. Unlike api() this is not an API group, so the
    // manifest permission is checked here rather than derived from a path.
    async notify(title, message) {
      if (!(addon.permissions || []).includes('notify')) {
        throw new Error('notify(): addon.json does not declare the "notify" permission');
      }
      if (!String(title || '').trim()) throw new Error('notify(): title is required');
      const res = await fetch(`${API_BASE}/api/notify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: String(title), message: String(message ?? '') }),
      });
      if (!res.ok) throw new Error(`notify(): ${res.status} ${await res.text()}`);
      return res.json();
    },

    log(...args) {
      console.log(`[addon:${addon.id}]`, ...args);
    },
  };
}
