// UI: the Invoices module page (list, filters, create form, detail, print
// view styled after Fakturownia's classic template), the two widgets and the
// Settings section. All rendering is plain DOM into the container the host
// hands us.

import {
  importFromFakturownia, fetchFakturowniaInfo, fetchFakturowniaClients, fakturowniaMode,
  fvUpdateClientBankAccount,
} from './fakturownia.js';
import {
  syncCompany, createInvoice, sendToKsef, checkSendStatus, setPaid, setApproval, clearTokenCache, today,
  runR2Backup, r2Configured,
} from './service.js';
import { lineNet, lineVat } from './fa3.js';
import { normalizeNip } from './store.js';

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const zl = (n, cur = 'PLN') => `${(Number(n) || 0).toFixed(2)} ${cur}`;

// VAT can be 'zw'/'np' on imported positions — money math then yields 0
function safeLineVat(l) {
  return Number.isFinite(Number(l.vatRate)) ? lineVat(l) : 0;
}

// One-line "what was this issued for", from the document's positions
export function invDesc(inv, max = 70) {
  if (!inv?.lines?.length) return '';
  const first = inv.lines[0].name || '';
  const extra = inv.lines.length > 1 ? ` (+${inv.lines.length - 1})` : '';
  return (first.length > max ? `${first.slice(0, max)}…` : first) + extra;
}

function ksefMark(inv) {
  if (inv.ksefNumber) return `<span class="ksefad-ok" title="${esc(inv.ksefNumber)}">✓</span>`;
  if (inv.kind === 'proforma') return '<span class="ksefad-muted">—</span>';
  if (inv.sendState === 'error') return `<span class="ksefad-warn" title="${esc(inv.sendError || 'błąd wysyłki')}">⚠</span>`;
  return '<span class="ksefad-no" title="brak w KSeF">✗</span>';
}

const APPROVALS = [
  ['received', 'Otrzymana', 'var(--warning, #fab387)'],
  ['accepted', 'Zatwierdzona', 'var(--success, #a6e3a1)'],
  ['rejected', 'Odrzucona', 'var(--error, #f38ba8)'],
];

// Fakturownia's expense acceptance flow — editable inline, pushed to
// Fakturownia on change (dual mode, cost documents only)
function approvalCell(inv) {
  if (inv.dir !== 'cost' || !inv.fvId) return '<span class="ksefad-muted">—</span>';
  const color = APPROVALS.find(([v]) => v === inv.fvApproval)?.[2] || 'var(--text-muted, #6c7086)';
  return `<select data-approval="${esc(inv.id)}" style="color:${color}; font-weight:600">
    ${inv.fvApproval ? '' : '<option value="" selected>—</option>'}
    ${APPROVALS.map(([v, label, c]) => `<option value="${v}" style="color:${c}" ${inv.fvApproval === v ? 'selected' : ''}>${label}</option>`).join('')}
  </select>`;
}

function fvMark(inv) {
  if (inv.fvId) return `<span class="ksefad-ok" title="Fakturownia #${esc(inv.fvId)}">✓</span>`;
  return '<span class="ksefad-no" title="brak w Fakturowni">✗</span>';
}

function payBadge(inv) {
  if (inv.kind === 'proforma') return '<span class="ksefad-muted">proforma</span>';
  if (inv.paid) return '<span class="ksefad-badge paid">opłacona</span>';
  if (Number(inv.paidAmount) > 0) {
    return `<span class="ksefad-badge partial" title="opłacono ${zl(inv.paidAmount, inv.currency)} z ${zl(inv.gross, inv.currency)}">◐ częściowo</span>`;
  }
  return '<span class="ksefad-badge unpaid">nieopłacona</span>';
}

const STYLE_ID = 'ksefad-style';

// Keyed by element id, not a module flag: a hot reload re-imports the module
// and would otherwise append a duplicate stylesheet each time
export function injectStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    .ksefad { display:flex; flex-direction:column; gap:10px; height:100%; font-size: 14px; position:relative; }
    .ksefad-sync-overlay { position:absolute; inset:0; z-index:20; display:flex; flex-direction:column;
      align-items:center; justify-content:center; gap:14px; border-radius:10px;
      background: rgba(17,17,27,.62); backdrop-filter: blur(3px); }
    .ksefad-sync-overlay svg { color: var(--accent, #89b4fa); animation: ksefad-rot 1.1s linear infinite; }
    .ksefad-sync-overlay .ksefad-sync-title { font-size:17px; font-weight:600; }
    .ksefad-sync-overlay .ksefad-sync-sub { color: var(--text-muted, #6c7086); font-size:13.5px; }
    @keyframes ksefad-rot { to { transform: rotate(360deg); } }
    @keyframes ksefad-dots { 0%, 20% { content:''; } 40% { content:'.'; } 60% { content:'..'; } 80%, 100% { content:'...'; } }
    .ksefad-sync-title::after { display:inline-block; width:1.2em; text-align:left; content:''; animation: ksefad-dots 1.6s steps(1) infinite; }
    .ksefad-bar { display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
    .ksefad-tabs { display:flex; gap:2px; }
    .ksefad-mnav { display:flex; gap:6px; align-items:center; }
    .ksefad-tab { background:transparent; border:1px solid var(--border, #45475a); color:inherit;
      border-radius:6px 6px 0 0; border-bottom:none; padding:6px 16px; cursor:pointer; font:inherit; opacity:.6; }
    .ksefad-tab.active { opacity:1; border-color:var(--accent, #89b4fa); color:var(--accent, #89b4fa); font-weight:600; }
    .ksefad-bar select, .ksefad-bar input, .ksefad select, .ksefad input, .ksefad textarea {
      background: var(--bg-surface, #313244); color: inherit; border: 1px solid var(--border, #45475a);
      border-radius: 6px; padding: 5px 8px; font: inherit; }
    .ksefad-btn { background: var(--bg-surface, #313244); border: 1px solid var(--border, #45475a);
      color: inherit; border-radius: 6px; padding: 5px 10px; cursor: pointer; font: inherit; }
    .ksefad-btn:hover { border-color: var(--accent, #89b4fa); color: var(--accent, #89b4fa); }
    .ksefad-btn.primary { border-color: var(--accent, #89b4fa); }
    .ksefad-table { width:100%; border-collapse: collapse; }
    .ksefad-table th { text-align:left; opacity:.6; font-weight:600; padding:4px 8px; border-bottom:1px solid var(--border, #45475a); }
    .ksefad-table td { padding:5px 8px; border-bottom:1px solid rgba(128,128,128,.15); }
    .ksefad-row-ok td { background: rgba(166,227,161,.06); }
    .ksefad-row-ok td:first-child { box-shadow: inset 3px 0 0 rgba(166,227,161,.55); }
    .ksefad-row-warn td { background: rgba(249,226,175,.06); }
    .ksefad-row-warn td:first-child { box-shadow: inset 3px 0 0 rgba(249,226,175,.5); }
    .ksefad-row-bad td { background: rgba(243,139,168,.09); }
    .ksefad-row-bad td:first-child { box-shadow: inset 3px 0 0 rgba(243,139,168,.6); }
    .ksefad-row-in td { background: rgba(148,226,213,.06); }
    .ksefad-row-in td:first-child { box-shadow: inset 3px 0 0 rgba(148,226,213,.55); }
    .ksefad-row-ret td { background: rgba(180,190,254,.07); }
    .ksefad-row-ret td:first-child { box-shadow: inset 3px 0 0 rgba(180,190,254,.6); }
    .ksefad-table tr.sel td, .ksefad-table tbody tr:hover td { background: rgba(137,180,250,.08); cursor:pointer; }
    .ksefad-scroll { overflow:auto; flex:1; min-height:0; }
    .ksefad-badge { font-size:.85em; border:1px solid; border-radius:10px; padding:0 7px; white-space:nowrap; }
    .ksefad-badge.paid { color:var(--success, #a6e3a1); border-color:var(--success, #a6e3a1); }
    .ksefad-badge.unpaid { color:var(--warning, #f9e2af); border-color:var(--warning, #f9e2af); }
    .ksefad-badge.partial { color:var(--success, #a6e3a1); border-color:var(--success, #a6e3a1);
      background:linear-gradient(90deg, rgba(166,227,161,.30) 50%, transparent 50%); }
    .ksefad-badge.cost { color:var(--error, #f38ba8); border-color:var(--error, #f38ba8); }
    .ksefad-badge.sale { color:var(--accent, #89b4fa); border-color:var(--accent, #89b4fa); }
    .ksefad-overlay { position:fixed; inset:0; background:rgba(0,0,0,.55); z-index:900;
      display:flex; align-items:center; justify-content:center; }
    .ksefad-modal { background: var(--bg-secondary, #181825); border:1px solid var(--border, #45475a);
      border-radius:10px; padding:18px; width:min(720px, 92vw); max-height:88vh; overflow:auto; }
    .ksefad-modal.lg { width:min(1060px, 94vw); max-height:92vh; padding:32px 40px; font-size:15px; }
    .ksefad-modal.lg input, .ksefad-modal.lg select { padding:10px 12px; font-size:15px; border-radius:8px; }
    .ksefad-modal.lg .ksefad-btn { padding:10px 18px; font-size:15px; border-radius:8px; }
    .ksefad-modal.lg label { font-weight:600; }
    .ksefad-doc-head { display:flex; justify-content:space-between; align-items:baseline; gap:16px;
      border-bottom:1px solid var(--border, #45475a); padding-bottom:14px; margin-bottom:16px; }
    .ksefad-doc-head h2 { font-size:22px; margin:0; }
    .ksefad-doc-dates { min-width:300px; }
    .ksefad-doc-dates div { display:flex; justify-content:space-between; gap:16px; margin-bottom:4px; }
    .ksefad-doc-parties { display:grid; grid-template-columns:1fr 1fr; gap:24px; margin:18px 0; }
    .ksefad-doc-party .ksefad-party-label { font-size:13px; opacity:.6; margin-bottom:6px; text-transform:uppercase; letter-spacing:.04em; }
    .ksefad-doc-party .ksefad-party-name { font-size:17px; font-weight:700; margin-bottom:4px; }
    .ksefad-doc-table { width:100%; border-collapse:collapse; margin:16px 0; font-size:15px; }
    .ksefad-doc-table th { background:rgba(128,128,128,.12); font-weight:600; text-align:left;
      padding:10px 12px; border:1px solid var(--border, #45475a); }
    .ksefad-doc-table td { padding:10px 12px; border:1px solid var(--border, #45475a); }
    .ksefad-doc-totals { margin-left:auto; min-width:360px; width:max-content; font-size:16px; margin-bottom:16px; }
    .ksefad-doc-totals div { display:flex; justify-content:space-between; gap:32px; padding:3px 0; }
    .ksefad-doc-totals .ksefad-doc-due { font-size:19px; font-weight:700; border-top:1px solid var(--border, #45475a);
      padding-top:8px; margin-top:6px; }
    .ksefad-grid { display:grid; grid-template-columns: 1fr 1fr; gap:8px; }
    .ksefad-modal.lg .ksefad-grid { gap:14px 18px; }
    .ksefad-lines td { padding:2px; }
    .ksefad-modal.lg .ksefad-lines td { padding:4px; }
    .ksefad-modal.lg .ksefad-lines input, .ksefad-modal.lg .ksefad-lines select { padding:9px 10px; }
    .ksefad-muted { opacity:.6; }
    .ksefad-error { color:var(--error, #f38ba8); white-space:pre-wrap; }
    .ksefad-ok { color:var(--success, #a6e3a1); font-weight:700; }
    .ksefad-no { color:var(--error, #f38ba8); font-weight:700; }
    .ksefad-warn { color:var(--warning, #f9e2af); font-weight:700; }
    .ksefad-clients { display:flex; gap:14px; flex:1; min-height:0; }
    .ksefad-clients-list { width:340px; flex-shrink:0; overflow:auto; border:1px solid var(--border, #45475a);
      border-radius:8px; }
    .ksefad-clients-list .row { padding:8px 12px; cursor:pointer; border-bottom:1px solid rgba(128,128,128,.12); }
    .ksefad-clients-list .row.sel, .ksefad-clients-list .row:hover { background: rgba(137,180,250,.10); }
    .ksefad-clients-list .row .nm { font-weight:600; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .ksefad-clients-detail { flex:1; min-width:0; overflow:auto; border:1px solid var(--border, #45475a);
      border-radius:8px; padding:16px 20px; }
    .ksefad-subtabs { display:flex; gap:6px; margin:12px 0; }
    .ksefad-subtab { background:var(--bg-surface, #313244); border:1px solid var(--border, #45475a);
      color:inherit; border-radius:6px; padding:6px 14px; cursor:pointer; font:inherit; opacity:.7; }
    .ksefad-subtab.active { opacity:1; border-color:var(--accent, #89b4fa); color:var(--accent, #89b4fa); font-weight:600; }
    .ksefad-widget { display:flex; flex-direction:column; gap:4px; font-size:.95em; }
    .ksefad-widget-row { display:flex; justify-content:space-between; gap:8px; }
    .ksefad-widget-row span:first-child { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    #ksefad-print { display:none; }
    @media print {
      body > * { display:none !important; }
      #ksefad-print { display:block !important; position:static; color:#000; background:#fff; }
    }
  `;
  document.head.appendChild(style);
}

// ---- month navigation (shared with the bank module) ----

const MONTH_NAMES = ['styczeń', 'luty', 'marzec', 'kwiecień', 'maj', 'czerwiec',
  'lipiec', 'sierpień', 'wrzesień', 'październik', 'listopad', 'grudzień'];

// Shared wrapper for print documents: without print-color-adjust browsers
// strip the row tints when printing or saving to PDF
export function printDocHtml(title, body) {
  return `<!doctype html><html lang="pl"><head><meta charset="utf-8"><title>${esc(title)}</title>
    <style>
      * { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; }
      @page { margin: 10mm; }
      body { margin: 0; }
    </style></head>
    <body onload="window.print()">${body}</body></html>`;
}

export function currentMonth() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

export function monthAdd(month, delta) {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

export function monthLabel(month) {
  const [y, m] = month.split('-').map(Number);
  return `${MONTH_NAMES[m - 1]} ${y}`;
}

export function monthRange(month) {
  const [y, m] = month.split('-').map(Number);
  return { from: `${month}-01`, to: `${month}-${String(new Date(y, m, 0).getDate()).padStart(2, '0')}` };
}

// Month-first period picker with a date-range fallback; the callbacks fire
// after the caller-provided view state was updated
export function periodBarHtml(state) {
  if (state.mode === 'range') {
    return `
      <div class="ksefad-mnav">
        <input type="date" id="ksefadFrom" value="${state.from || ''}">
        <span class="ksefad-muted">—</span>
        <input type="date" id="ksefadTo" value="${state.to || ''}">
        <button class="ksefad-btn" id="ksefadPeriodMode" title="Przełącz na widok miesiąca">Miesiąc</button>
      </div>`;
  }
  return `
    <div class="ksefad-mnav">
      <button class="ksefad-btn" id="ksefadPrevM" title="Poprzedni miesiąc ([)">◀</button>
      <b style="min-width:130px; text-align:center">${monthLabel(state.month)}</b>
      <button class="ksefad-btn" id="ksefadNextM" title="Następny miesiąc (])">▶</button>
      <button class="ksefad-btn" id="ksefadPeriodMode" title="Przełącz na zakres dat">Zakres dat</button>
    </div>`;
}

export function bindPeriodBar(el, state, rerender) {
  el.querySelector('#ksefadPrevM')?.addEventListener('click', () => { state.month = monthAdd(state.month, -1); rerender(); });
  el.querySelector('#ksefadNextM')?.addEventListener('click', () => { state.month = monthAdd(state.month, 1); rerender(); });
  el.querySelector('#ksefadPeriodMode')?.addEventListener('click', () => {
    state.mode = state.mode === 'range' ? 'month' : 'range';
    if (state.mode === 'range' && !state.from) {
      const r = monthRange(state.month);
      state.from = r.from;
      state.to = r.to;
    }
    rerender();
  });
  el.querySelector('#ksefadFrom')?.addEventListener('change', (e) => { state.from = e.target.value; rerender(); });
  el.querySelector('#ksefadTo')?.addEventListener('change', (e) => { state.to = e.target.value; rerender(); });
}

export function periodOf(state) {
  if (state.mode === 'all') return { from: undefined, to: undefined };
  return state.mode === 'range'
    ? { from: state.from || undefined, to: state.to || undefined }
    : monthRange(state.month);
}

const view = {
  companyId: '',
  dir: 'sale',
  unpaid: false,
  noKsef: false,
  noFv: false,
  query: '',
  busy: '',
  error: '',
  selected: 0,
  clientIdx: 0,
  clientTab: 'fv',
  clientQuery: '',
  mode: 'month',
  month: currentMonth(),
  from: '',
  to: '',
};

// One company is always selected for the whole addon (no "all companies"
// mixing); the picker itself is anchored in the module page bar (main.js)
export function activeCompany(store) {
  if (!store.company(view.companyId)) view.companyId = store.companies()[0]?.id || '';
  return store.company(view.companyId) || null;
}

export function setActiveCompany(id) {
  view.companyId = id;
  view.selected = 0;
  view.clientIdx = 0;
}

const TAB_ORDER = ['sale', 'cost'];

function switchTab(el, deps, dir) {
  if (view.dir === dir) return;
  view.dir = dir;
  view.selected = 0;
  view.query = '';
  renderPage(el, deps);
}

function cycleTab(el, deps, step) {
  const i = TAB_ORDER.indexOf(view.dir);
  switchTab(el, deps, TAB_ORDER[(i + step + TAB_ORDER.length) % TAB_ORDER.length]);
}

// ---- module page ----

function tabsHtml() {
  return `<div class="ksefad-tabs">
    ${[['sale', 'Przychody'], ['cost', 'Wydatki']].map(([d, l]) =>
      `<button class="ksefad-tab ${view.dir === d ? 'active' : ''}" data-dir="${d}">${l}</button>`).join('')}
  </div>`;
}

// The detail/create overlays are shared between the Faktury and Klienci
// pages — after an action they refresh whichever page they were opened from
function refresh(el, deps) {
  if (el.dataset.ksefadPage === 'clients') renderClientsPage(el, deps);
  else renderPage(el, deps);
}

function bindShellControls(el, deps) {
  el.querySelectorAll('.ksefad-tab').forEach((btn) => {
    btn.onclick = () => switchTab(el, deps, btn.dataset.dir);
  });
  const query = el.querySelector('#ksefadQuery');
  if (query) {
    // Re-rendering replaces the input the user is typing into, so focus and
    // caret have to be put back or only the first keystroke ever lands
    query.oninput = (e) => {
      view.query = e.target.value;
      const caret = e.target.selectionStart;
      renderPage(el, deps);
      const next = el.querySelector('#ksefadQuery');
      next.focus();
      next.setSelectionRange(caret, caret);
    };
  }
}

export function renderPage(el, deps) {
  injectStyle();
  const { store } = deps;
  const companies = store.companies();
  if (!companies.length) {
    el.innerHTML = `
      <div class="ksefad">
        <h2>🧾 Invoices — KSeF</h2>
        <p>Polish e-invoicing (KSeF). No companies configured yet — add one in
        <b>Settings → Addons → KSeF</b>: name, NIP, KSeF token, optionally the
        Fakturownia account to import history from.</p>
      </div>`;
    return;
  }
  const comp = activeCompany(store);
  const dual = fakturowniaMode(comp) === 'dual';
  const period = periodOf(view);
  let invoices = store.listInvoices({
    companyId: view.companyId,
    dir: view.dir || undefined,
    unpaid: view.unpaid || undefined,
    query: view.query || undefined,
    from: period.from,
    to: period.to,
    limit: 300,
  });
  if (view.noKsef) invoices = invoices.filter((i) => !i.ksefNumber && i.kind !== 'proforma');
  if (view.noFv && dual) invoices = invoices.filter((i) => !i.fvId);
  view.selected = Math.min(view.selected, Math.max(0, invoices.length - 1));
  const fileMap = store.fileByInvoice(view.companyId);

  el.innerHTML = `
    <div class="ksefad">
      <div class="ksefad-bar">
        ${tabsHtml()}
        ${periodBarHtml(view)}
        <label><input type="checkbox" id="ksefadUnpaid" ${view.unpaid ? 'checked' : ''}> unpaid</label>
        <label title="tylko faktury bez numeru KSeF"><input type="checkbox" id="ksefadNoKsef" ${view.noKsef ? 'checked' : ''}> bez KSeF</label>
        ${dual ? `<label title="tylko faktury bez dokumentu w Fakturowni"><input type="checkbox" id="ksefadNoFv" ${view.noFv ? 'checked' : ''}> bez Fakt.</label>` : ''}
        <input id="ksefadQuery" placeholder="search… (/)" value="${esc(view.query)}" style="flex:1; min-width:120px">
        <button class="ksefad-btn" id="ksefadSync" ${view.busy ? 'disabled' : ''}>${view.busy === 'sync' ? 'Syncing…' : '⟳ Sync KSeF (r)'}</button>
        <button class="ksefad-btn primary" id="ksefadNew">+ New invoice (n)</button>
      </div>
      ${view.error ? `<div class="ksefad-error">${esc(view.error)}</div>` : ''}
      <div class="ksefad-scroll">
        <table class="ksefad-table">
          <thead><tr><th>Number</th><th>Date</th><th>Contractor</th><th>Gross</th><th>Status</th><th>KSeF</th>${dual ? '<th>Fakt.</th><th title="status akceptacji w Fakturowni — zmiana zapisuje się też tam">Akcept.</th>' : ''}<th>PDF</th></tr></thead>
          <tbody>
            ${invoices.map((inv, i) => `
              <tr data-id="${esc(inv.id)}" class="${i === view.selected ? 'sel' : ''}">
                <td>${esc(inv.number || '—')}</td>
                <td>${esc(inv.issueDate)}</td>
                <td>${esc(inv.dir === 'sale' ? inv.buyerName : inv.sellerName)}
                  ${inv.lines?.length ? `<div class="ksefad-muted" style="font-size:.9em">${esc(invDesc(inv))}</div>` : ''}</td>
                <td style="text-align:right">${zl(inv.gross, inv.currency)}</td>
                <td>${payBadge(inv)}</td>
                <td style="text-align:center">${ksefMark(inv)}</td>
                ${dual ? `<td style="text-align:center">${fvMark(inv)}</td>
                <td style="text-align:center">${approvalCell(inv)}</td>` : ''}
                <td style="text-align:center">${fileMap.has(inv.id)
                  ? `<button class="ksefad-btn" data-pdf="${esc(inv.id)}" title="Podgląd PDF">📄</button>`
                  : '<span class="ksefad-muted">—</span>'}</td>
              </tr>`).join('')}
          </tbody>
        </table>
        ${invoices.length ? '' : '<p class="ksefad-muted" style="padding:12px">No invoices match. Run the Fakturownia import (Settings) or Sync KSeF.</p>'}
      </div>
      <div class="ksefad-muted">${invoices.length} pozycji · [/]: miesiąc · h/l lub Tab: zakładki · j/k wybór · Enter otwórz · n nowa · r sync</div>
      ${view.busy === 'sync' ? `
        <div class="ksefad-sync-overlay">
          <svg width="76" height="76" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M20 12a8 8 0 0 1-14.5 4.7" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>
            <path d="M4 12a8 8 0 0 1 14.5-4.7" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>
            <path d="M18.9 3.6v3.9H15" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>
            <path d="M5.1 20.4v-3.9H9" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
          <div class="ksefad-sync-title">Synchronizacja</div>
          <div class="ksefad-sync-sub">Pobieram faktury i statusy płatności (KSeF${view.dualSync ? ' + Fakturownia' : ''})</div>
        </div>` : ''}
    </div>`;

  bindShellControls(el, deps);
  bindPeriodBar(el, view, () => renderPage(el, deps));
  el.querySelector('#ksefadUnpaid').onchange = (e) => { view.unpaid = e.target.checked; renderPage(el, deps); };
  el.querySelector('#ksefadNoKsef').onchange = (e) => { view.noKsef = e.target.checked; renderPage(el, deps); };
  const noFv = el.querySelector('#ksefadNoFv');
  if (noFv) noFv.onchange = (e) => { view.noFv = e.target.checked; renderPage(el, deps); };
  el.querySelector('#ksefadSync').onclick = () => runSync(el, deps);
  el.querySelector('#ksefadNew').onclick = () => openCreateForm(el, deps);
  el.querySelectorAll('tbody tr').forEach((tr, i) => {
    tr.onclick = (e) => {
      if (e.target.closest('select')) return;
      view.selected = i;
      openDetail(el, deps, tr.dataset.id);
    };
  });
  el.querySelectorAll('[data-approval]').forEach((sel) => {
    sel.onclick = (e) => e.stopPropagation();
    sel.onchange = async () => {
      if (!sel.value) return;
      sel.disabled = true;
      try {
        await setApproval(deps, comp, sel.dataset.approval, sel.value);
      } catch (err) {
        deps.cl.log('setApproval failed:', err);
        view.error = `Nie udało się zmienić statusu akceptacji: ${err.message || err}`;
      }
      renderPage(el, deps);
    };
  });
  el.querySelectorAll('[data-pdf]').forEach((btn) => {
    btn.onclick = (e) => {
      e.stopPropagation();
      openPdfOverlay(deps, fileMap.get(btn.dataset.pdf));
    };
  });
}

// ---- clients tab ----

function clientsFor(store) {
  const companies = view.companyId
    ? [store.company(view.companyId)].filter(Boolean)
    : store.companies();
  const seen = new Map();
  for (const c of companies) {
    const dual = fakturowniaMode(c) === 'dual';
    const list = dual ? store.fvClients(c.id) : store.contractors(c.id);
    for (const cl of list) {
      if (!cl.name || cl.name === '-') continue;
      const key = normalizeNip(cl.nip) || `n:${cl.name.toLowerCase()}`;
      if (!seen.has(key)) seen.set(key, { ...cl, nip: normalizeNip(cl.nip), companyId: c.id, readonly: dual });
    }
  }
  // People who exist only in the local account register (employees,
  // partners) still deserve a row — the register is their client card
  for (const c of companies) {
    for (const e of store.clientAccounts(c.id)) {
      const key = normalizeNip(e.nip) || `n:${String(e.name || '').toLowerCase()}`;
      if (!seen.has(key)) {
        seen.set(key, { name: e.name, nip: normalizeNip(e.nip), companyId: c.id, readonly: false, note: 'wpis lokalny (konta bankowe)' });
      }
    }
  }
  let out = [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
  if (view.clientQuery) {
    const q = view.clientQuery.toLowerCase();
    out = out.filter((c) => `${c.name} ${c.nip}`.toLowerCase().includes(q));
  }
  return out;
}

function invoicesForClient(store, client, dir) {
  const party = (i) => (dir === 'sale' ? { nip: i.buyerNip, name: i.buyerName } : { nip: i.sellerNip, name: i.sellerName });
  return store.listInvoices({ companyId: view.companyId || undefined, dir }).filter((i) => {
    const p = party(i);
    return client.nip ? p.nip === client.nip : (p.name || '').toLowerCase() === client.name.toLowerCase();
  });
}

function clientInvoiceTableHtml(store, list) {
  if (!list.length) return '<p class="ksefad-muted" style="padding:8px 0">Brak dokumentów.</p>';
  const fileMap = store.fileByInvoice(view.companyId);
  const sums = {};
  for (const i of list) {
    const s = sums[i.currency] || { total: 0, open: 0 };
    s.total += i.gross;
    if (!i.paid && i.kind !== 'proforma') s.open += Math.max(0, i.gross - (Number(i.paidAmount) || 0));
    sums[i.currency] = s;
  }
  return `
    <table class="ksefad-table">
      <thead><tr><th>Numer</th><th>Data</th><th>Brutto</th><th>Status</th><th>KSeF</th><th>PDF</th></tr></thead>
      <tbody>${list.map((i) => `
        <tr data-inv-id="${esc(i.id)}">
          <td>${esc(i.number || '—')}
            ${i.lines?.length ? `<div class="ksefad-muted" style="font-size:.9em">${esc(invDesc(i, 50))}</div>` : ''}</td>
          <td>${esc(i.issueDate)}</td>
          <td style="text-align:right">${zl(i.gross, i.currency)}</td>
          <td>${payBadge(i)}</td>
          <td style="text-align:center">${ksefMark(i)}</td>
          <td style="text-align:center">${fileMap.has(i.id)
            ? `<button class="ksefad-btn" data-pdf="${esc(i.id)}" title="Podgląd PDF">📄</button>`
            : '<span class="ksefad-muted">—</span>'}</td>
        </tr>`).join('')}
      </tbody>
    </table>
    <div class="ksefad-muted" style="margin-top:8px">
      ${Object.entries(sums).map(([cur, s]) =>
        `Suma: <b>${zl(s.total, cur)}</b>${s.open > 0 ? ` · do zapłaty: ${zl(s.open, cur)}` : ''}`).join(' · ')}
    </div>`;
}

export function clientAcctKey(entry) {
  return normalizeNip(entry.nip) || `n:${String(entry.name || '').toLowerCase()}`;
}

function clientAcctEntry(store, client) {
  const key = clientAcctKey(client);
  return store.clientAccounts(view.companyId).find((e) => clientAcctKey(e) === key) || null;
}

function clientDetailHtml(store, client) {
  if (!client) return '<p class="ksefad-muted" style="padding:12px">Wybierz klienta z listy.</p>';
  const sub = view.clientTab;
  const subtab = (id, label, key) =>
    `<button class="ksefad-subtab ${sub === id ? 'active' : ''}" data-subtab="${id}">${label} <span class="ksefad-muted">(${key})</span></button>`;
  let body = '';
  if (sub === 'dane') {
    body = `
      <div class="adk-kv">
        <div><b>NIP:</b> ${esc(client.nip || '—')}</div>
        <div><b>Adres:</b> ${esc([client.address1, client.address2].filter(Boolean).join(', ') || '—')}</div>
        ${client.email ? `<div><b>E-mail:</b> ${esc(client.email)}</div>` : ''}
        ${client.phone ? `<div><b>Telefon:</b> ${esc(client.phone)}</div>` : ''}
        ${client.note ? `<div><b>Notatka:</b> ${esc(client.note)}</div>` : ''}
        <div class="adk-muted">${client.readonly
          ? 'Dane z Fakturowni — tylko do odczytu, edycja w Fakturowni.'
          : 'Klient lokalny.'}</div>
      </div>
      <div class="adk-kv" style="margin-top:10px">
        <div><b>Numery kont bankowych</b> <span class="adk-muted">(lokalne — do rozpoznawania przelewów na wyciągach)</span></div>
        <textarea id="ksefadClientAccts" rows="3" style="width:100%; font-family:monospace"
          placeholder="jeden numer konta na linię">${esc((clientAcctEntry(store, client)?.accounts || []).join('\n'))}</textarea>
        <div class="adk-actions"><button class="adk-btn primary" id="ksefadClientAcctsSave">Zapisz konta</button></div>
      </div>
      ${client.readonly ? '' : '<div class="adk-actions"><button class="adk-btn" id="ksefadClientEdit">Edytuj</button></div>'}`;
  } else {
    body = clientInvoiceTableHtml(store, invoicesForClient(store, client, sub === 'fv' ? 'sale' : 'cost'));
  }
  return `
    <div style="display:flex; align-items:baseline; gap:10px">
      <h3 style="font-size:18px; margin:0">${esc(client.name)}</h3>
      ${client.nip ? `<span class="ksefad-muted">NIP ${esc(client.nip)}</span>` : ''}
    </div>
    <div class="ksefad-subtabs">
      ${subtab('dane', 'Dane', 'd')}
      ${subtab('fv', 'Faktury', 'f')}
      ${subtab('wyd', 'Wydatki', 'w')}
    </div>
    <div id="ksefadClientBody">${body}</div>`;
}

export function renderClientsPage(el, deps) {
  injectStyle();
  el.dataset.ksefadPage = 'clients';
  const { store } = deps;
  const companies = store.companies();
  if (!companies.length) {
    el.innerHTML = `
      <div class="ksefad">
        <h2>👥 Klienci</h2>
        <p>Brak skonfigurowanych firm — dodaj firmę w <b>Settings → Addons → KSeF</b>.</p>
      </div>`;
    return;
  }
  const editableCompany = activeCompany(store);
  const clients = clientsFor(store);
  view.clientIdx = Math.min(view.clientIdx, Math.max(0, clients.length - 1));
  const sel = clients[view.clientIdx] || null;
  const scoped = [editableCompany].filter(Boolean);
  const canRefresh = scoped.some((c) => fakturowniaMode(c) === 'dual');
  const canAdd = editableCompany && fakturowniaMode(editableCompany) !== 'dual';

  el.innerHTML = `
    <div class="ksefad">
      <div class="ksefad-bar">
        <input id="ksefadClientQuery" placeholder="szukaj klienta… (/)" value="${esc(view.clientQuery)}" style="flex:1; min-width:120px">
        ${canRefresh ? `<button class="ksefad-btn" id="ksefadClientsRefresh" ${view.busy ? 'disabled' : ''}>${view.busy === 'clients' ? 'Odświeżam…' : '⟳ Odśwież z Fakturowni'}</button>` : ''}
        ${canAdd ? '<button class="ksefad-btn primary" id="ksefadClientAdd">+ Nowy klient (n)</button>' : ''}
      </div>
      ${view.error ? `<div class="ksefad-error">${esc(view.error)}</div>` : ''}
      <div class="ksefad-clients">
        <div class="ksefad-clients-list">
          ${clients.map((c, i) => `
            <div class="row ${i === view.clientIdx ? 'sel' : ''}" data-idx="${i}">
              <div class="nm">${esc(c.name)}</div>
              <div class="ksefad-muted">${c.nip ? `NIP ${esc(c.nip)}` : '—'}</div>
            </div>`).join('') || '<p class="ksefad-muted" style="padding:12px">Brak klientów. W trybie dual uruchom „Odśwież z Fakturowni".</p>'}
        </div>
        <div class="ksefad-clients-detail">${clientDetailHtml(store, sel)}</div>
      </div>
      <div class="ksefad-muted">${clients.length} klientów · j/k klient · d/f/w: dane/faktury/wydatki</div>
    </div>`;

  const query = el.querySelector('#ksefadClientQuery');
  // Re-rendering replaces the input the user is typing into, so focus and
  // caret have to be put back or only the first keystroke ever lands
  query.oninput = (e) => {
    view.clientQuery = e.target.value;
    view.clientIdx = 0;
    const caret = e.target.selectionStart;
    renderClientsPage(el, deps);
    const next = el.querySelector('#ksefadClientQuery');
    next.focus();
    next.setSelectionRange(caret, caret);
  };
  el.querySelectorAll('.ksefad-clients-list .row').forEach((row) => {
    row.onclick = () => { view.clientIdx = Number(row.dataset.idx); renderClientsPage(el, deps); };
  });
  el.querySelector('.ksefad-clients-list .row.sel')?.scrollIntoView({ block: 'nearest' });
  el.querySelectorAll('.ksefad-subtab').forEach((btn) => {
    btn.onclick = () => { view.clientTab = btn.dataset.subtab; renderClientsPage(el, deps); };
  });
  el.querySelectorAll('[data-inv-id]').forEach((row) => {
    row.onclick = () => openDetail(el, deps, row.dataset.invId);
  });
  el.querySelectorAll('[data-pdf]').forEach((btn) => {
    btn.onclick = (e) => {
      e.stopPropagation();
      openPdfOverlay(deps, store.fileByInvoice(view.companyId).get(btn.dataset.pdf));
    };
  });
  el.querySelector('#ksefadClientsRefresh')?.addEventListener('click', async () => {
    view.busy = 'clients';
    view.error = '';
    renderClientsPage(el, deps);
    for (const c of scoped.filter((x) => fakturowniaMode(x) === 'dual')) {
      try {
        await fetchFakturowniaClients(deps, c);
      } catch (err) {
        deps.cl.log('clients refresh failed:', err);
        view.error = `${c.name}: ${err.message || err}`;
      }
    }
    view.busy = '';
    renderClientsPage(el, deps);
  });
  el.querySelector('#ksefadClientAcctsSave')?.addEventListener('click', async () => {
    if (!sel) return;
    const accounts = el.querySelector('#ksefadClientAccts').value
      .split('\n').map((s) => s.trim()).filter(Boolean);
    const list = store.clientAccounts(view.companyId).slice();
    const key = clientAcctKey(sel);
    const i = list.findIndex((e) => clientAcctKey(e) === key);
    if (i >= 0) list[i] = { ...list[i], name: sel.name, nip: sel.nip, accounts };
    else list.push({ name: sel.name, nip: sel.nip, accounts });
    await store.saveClientAccounts(view.companyId, list.filter((e) => e.accounts.length));
    view.error = '';
    // Fakturownia keeps a single bank_account per client — the first
    // number is the primary one and syncs there in dual mode
    const comp = store.company(view.companyId);
    if (sel.fvId && fakturowniaMode(comp) === 'dual') {
      try {
        await fvUpdateClientBankAccount(deps, comp, sel.fvId, accounts[0] || '');
      } catch (err) {
        deps.cl.log('client bank account push to Fakturownia failed:', err);
        view.error = `Konta zapisane lokalnie, ale Fakturownia odrzuciła aktualizację: ${err.message || err}`;
      }
    }
    renderClientsPage(el, deps);
  });
  el.querySelector('#ksefadClientAdd')?.addEventListener('click', () => openClientForm(el, deps, editableCompany));
  el.querySelector('#ksefadClientEdit')?.addEventListener('click', () => {
    if (sel && !sel.readonly) openClientForm(el, deps, store.company(sel.companyId) || editableCompany, sel);
  });
}

function openClientForm(el, deps, company, client = {}) {
  const { store } = deps;
  const overlay = document.createElement('div');
  // modal-overlay is what the host's Esc handling and hasOpenModal() look for
  overlay.className = 'ksefad-overlay modal-overlay';
  overlay.innerHTML = `
    <div class="ksefad-modal lg" style="width:min(640px, 92vw)">
      <h2 style="margin-bottom:18px">${client.name ? 'Edytuj klienta' : 'Nowy klient'}</h2>
      <div class="adk-form">
        <label class="adk-field"><span>Nazwa</span><input id="kcName" value="${esc(client.name || '')}"></label>
        <label class="adk-field"><span>NIP</span><input id="kcNip" value="${esc(client.nip || '')}"></label>
        <label class="adk-field"><span>Ulica i nr</span><input id="kcAddr1" value="${esc(client.address1 || '')}"></label>
        <label class="adk-field"><span>Kod i miejscowość</span><input id="kcAddr2" value="${esc(client.address2 || '')}"></label>
        <label class="adk-field"><span>E-mail</span><input id="kcEmail" value="${esc(client.email || '')}"></label>
        <label class="adk-field"><span>Telefon</span><input id="kcPhone" value="${esc(client.phone || '')}"></label>
      </div>
      <div class="adk-actions">
        <span class="ksefad-error" id="kcError"></span>
        <span style="flex:1"></span>
        <button class="adk-btn primary" id="kcSave">Zapisz</button>
        <button class="adk-btn" id="kcCancel">Anuluj</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  const close = () => overlay.remove();
  overlay.onclick = (e) => { if (e.target === overlay) close(); };
  overlay.querySelector('#kcCancel').onclick = close;
  overlay.querySelector('#kcSave').onclick = async () => {
    const val = (id) => overlay.querySelector(id).value.trim();
    if (!val('#kcName')) {
      overlay.querySelector('#kcError').textContent = 'Nazwa jest wymagana';
      return;
    }
    await store.upsertContractors(company.id, [{
      name: val('#kcName'),
      nip: val('#kcNip'),
      address1: val('#kcAddr1'),
      address2: val('#kcAddr2'),
      email: val('#kcEmail'),
      phone: val('#kcPhone'),
    }]);
    close();
    renderClientsPage(el, deps);
  };
}

async function runSync(el, deps) {
  const { store } = deps;
  const targets = view.companyId ? [store.company(view.companyId)] : store.companies();
  view.busy = 'sync';
  view.dualSync = targets.filter(Boolean).some((c) => fakturowniaMode(c) === 'dual');
  view.error = '';
  renderPage(el, deps);
  const errors = [];
  for (const company of targets.filter(Boolean)) {
    try {
      await syncCompany(deps, company);
    } catch (err) {
      deps.cl.log('sync failed:', err);
      errors.push(`${company.name}: ${err.message || err}`);
      await store.setSyncState(company.id, { lastError: String(err.message || err) });
    }
  }
  view.busy = '';
  view.error = errors.join('\n');
  renderPage(el, deps);
}

// ---- detail ----

function openDetail(el, deps, id) {
  const { store } = deps;
  const inv = store.getInvoice(id);
  if (!inv) return;
  const company = store.company(inv.companyId);
  const overlay = document.createElement('div');
  // modal-overlay is what the host's Esc handling and hasOpenModal() look
  // for; without it Esc would fall through to the terminal and interrupt
  // whatever session is attached
  overlay.className = 'ksefad-overlay modal-overlay';
  const title = inv.kind === 'proforma' ? 'Proforma' : (inv.dir === 'cost' ? 'Faktura kosztowa' : 'Faktura');
  const party = (label, name, nip, addr1, addr2, bank) => `
    <div class="ksefad-doc-party">
      <div class="ksefad-party-label">${label}</div>
      <div class="ksefad-party-name">${esc(name || '—')}</div>
      ${addr1 ? `<div>${esc(addr1)}</div>` : ''}
      ${addr2 ? `<div>${esc(addr2)}</div>` : ''}
      ${nip ? `<div class="ksefad-muted">${/^\d/.test(String(nip)) ? 'NIP ' : 'VAT '}${esc(nip)}</div>` : ''}
      ${bank ? `<div class="ksefad-muted" style="margin-top:6px">Rachunek: ${esc(bank)}</div>` : ''}
    </div>`;
  const isSale = inv.dir === 'sale';
  overlay.innerHTML = `
    <div class="ksefad-modal lg">
      <div class="ksefad-doc-head">
        <h2>${esc(title)} <b>${esc(inv.number || inv.ksefNumber)}</b></h2>
        <div class="ksefad-doc-dates">
          <div>Data wystawienia: <b>${esc(inv.issueDate)}</b></div>
          ${inv.sellDate && inv.sellDate !== inv.issueDate ? `<div>Data sprzedaży: <b>${esc(inv.sellDate)}</b></div>` : ''}
          <div>Termin płatności: <b>${esc(inv.paymentTo || '—')}</b></div>
        </div>
      </div>
      <div class="ksefad-doc-parties">
        ${party('Sprzedawca', inv.sellerName, inv.sellerNip || inv.sellerVatId, inv.sellerAddress1, inv.sellerAddress2, isSale && inv.src === 'local' ? company?.bankAccount : null)}
        ${party('Nabywca', inv.buyerName, inv.buyerNip, inv.buyerAddress1, inv.buyerAddress2, null)}
      </div>
      ${(inv.lines || []).length ? `
        <table class="ksefad-doc-table">
          <thead><tr><th>LP</th><th>Nazwa towaru / usługi</th><th>Ilość</th><th>Cena netto</th>
            <th>Wartość netto</th><th>VAT %</th><th>Wartość VAT</th><th>Wartość brutto</th></tr></thead>
          <tbody>${inv.lines.map((l, i) => `<tr>
            <td>${i + 1}</td>
            <td>${esc(l.name)}</td>
            <td>${esc(l.quantity)} ${esc(l.unit)}</td>
            <td style="text-align:right">${Number(l.unitNetPrice).toFixed(2)}</td>
            <td style="text-align:right">${lineNet(l).toFixed(2)}</td>
            <td style="text-align:right">${esc(l.vatRate)}</td>
            <td style="text-align:right">${safeLineVat(l).toFixed(2)}</td>
            <td style="text-align:right">${(lineNet(l) + safeLineVat(l)).toFixed(2)}</td>
          </tr>`).join('')}
          </tbody>
        </table>` : ''}
      <div class="ksefad-doc-totals">
        <div><span>Wartość netto</span><span>${zl(inv.net, inv.currency)}</span></div>
        <div><span>Wartość VAT</span><span>${zl(inv.vat, inv.currency)}</span></div>
        <div><span>Wartość brutto</span><span><b>${zl(inv.gross, inv.currency)}</b></span></div>
        ${inv.kind !== 'proforma' ? (() => {
          const paidAmt = inv.paid ? inv.gross : (Number(inv.paidAmount) || 0);
          return `
          <div><span>Kwota opłacona</span><span>${zl(paidAmt, inv.currency)}${inv.paidDate ? ` <span class="ksefad-muted">(${esc(inv.paidDate)})</span>` : ''}</span></div>
          <div class="ksefad-doc-due"><span>Do zapłaty</span><span>${zl(Math.max(0, inv.gross - paidAmt), inv.currency)}</span></div>`;
        })() : ''}
      </div>
      <div class="ksefad-muted" style="margin-bottom:14px">
        ${inv.ksefNumber ? `Numer KSeF: <b>${esc(inv.ksefNumber)}</b>` : `KSeF: ${esc(inv.sendState || '—')}`}
        · źródło: ${esc(inv.src)}
        ${inv.sendError ? `<div class="ksefad-error">${esc(inv.sendError)}</div>` : ''}
      </div>
      <div class="ksefad-bar">
        ${inv.kind !== 'proforma' ? `<button class="ksefad-btn" id="ksefadPaid">${inv.paid ? 'Oznacz jako niezapłaconą' : 'Oznacz jako zapłaconą'}</button>` : ''}
        ${inv.src === 'local' ? `<button class="ksefad-btn" id="ksefadPrint">Drukuj / PDF</button>` : ''}
        ${store.fileByInvoice(inv.companyId).has(inv.id) ? '<button class="ksefad-btn" id="ksefadOrigPdf">📄 Oryginał PDF</button>' : ''}
        ${inv.sendState === 'processing' || (inv.sendState === 'error' && inv.sessionRef)
          ? `<button class="ksefad-btn primary" id="ksefadCheck">Sprawdź status KSeF</button>` : ''}
        ${inv.src === 'local' && !inv.ksefNumber && inv.kind !== 'proforma'
          && inv.sendState !== 'processing' && inv.sendState !== 'sending' && !inv.sessionRef
          ? `<button class="ksefad-btn primary" id="ksefadSend">Wyślij do KSeF</button>` : ''}
        <span style="flex:1"></span>
        <button class="ksefad-btn" id="ksefadClose">Zamknij (Esc)</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  const close = () => overlay.remove();
  overlay.onclick = (e) => { if (e.target === overlay) close(); };
  overlay.querySelector('#ksefadClose').onclick = close;
  overlay.querySelector('#ksefadPaid')?.addEventListener('click', async (e) => {
    e.target.disabled = true;
    try {
      await setPaid(deps, company, inv.id, !inv.paid);
      close();
    } catch (err) {
      e.target.disabled = false;
      alert(`Nie udało się zmienić statusu płatności: ${err.message || err}`);
    }
    refresh(el, deps);
  });
  overlay.querySelector('#ksefadPrint')?.addEventListener('click', () => printInvoice(deps, company, store.getInvoice(id)));
  overlay.querySelector('#ksefadOrigPdf')?.addEventListener('click', () => {
    openPdfOverlay(deps, store.fileByInvoice(inv.companyId).get(inv.id));
  });
  overlay.querySelector('#ksefadCheck')?.addEventListener('click', async (e) => {
    e.target.disabled = true;
    e.target.textContent = 'Sprawdzanie…';
    try {
      const updated = await checkSendStatus(deps, company, inv.id);
      close();
      if (!updated.ksefNumber) {
        alert('KSeF has not assigned a number yet — the invoice is still being processed.');
      }
    } catch (err) {
      e.target.disabled = false;
      e.target.textContent = 'Sprawdź status KSeF';
      alert(`Status check failed: ${err.message || err}`);
    }
    refresh(el, deps);
  });
  overlay.querySelector('#ksefadSend')?.addEventListener('click', async (e) => {
    e.target.disabled = true;
    e.target.textContent = 'Wysyłanie…';
    try {
      await sendToKsef(deps, company, inv.id);
      close();
    } catch (err) {
      e.target.disabled = false;
      e.target.textContent = 'Wyślij do KSeF';
      alert(`KSeF send failed: ${err.message || err}`);
    }
    refresh(el, deps);
  });
}

// ---- create form ----

function linesFromForm(modal) {
  return [...modal.querySelectorAll('.ksefad-line')].map((row) => ({
    name: row.querySelector('.l-name').value.trim(),
    quantity: Number(row.querySelector('.l-qty').value) || 1,
    unit: row.querySelector('.l-unit').value.trim() || 'szt',
    unitNetPrice: Number(row.querySelector('.l-price').value) || 0,
    vatRate: Number(row.querySelector('.l-vat').value),
  })).filter((l) => l.name);
}

function lineRowHtml(l = {}) {
  return `<tr class="ksefad-line">
    <td><input class="l-name" placeholder="Nazwa towaru / usługi" value="${esc(l.name || '')}" style="width:100%"></td>
    <td><input class="l-qty" type="number" step="any" value="${esc(l.quantity ?? 1)}" style="width:80px"></td>
    <td><input class="l-unit" value="${esc(l.unit || 'szt')}" style="width:70px"></td>
    <td><input class="l-price" type="number" step="any" value="${esc(l.unitNetPrice ?? '')}" placeholder="netto" style="width:120px"></td>
    <td><select class="l-vat">${[23, 8, 5, 0].map((r) => `<option ${r === (l.vatRate ?? 23) ? 'selected' : ''}>${r}</option>`).join('')}</select></td>
    <td class="l-net" style="text-align:right; min-width:100px">0,00</td>
    <td class="l-gross" style="text-align:right; min-width:100px">0,00</td>
  </tr>`;
}

function recalcFormTotals(overlay) {
  let net = 0;
  let vat = 0;
  for (const row of overlay.querySelectorAll('.ksefad-line')) {
    const line = {
      quantity: Number(row.querySelector('.l-qty').value) || 0,
      unitNetPrice: Number(row.querySelector('.l-price').value) || 0,
      vatRate: Number(row.querySelector('.l-vat').value) || 0,
    };
    const ln = lineNet(line);
    const lv = lineVat(line);
    row.querySelector('.l-net').textContent = ln.toFixed(2);
    row.querySelector('.l-gross').textContent = (ln + lv).toFixed(2);
    net += ln;
    vat += lv;
  }
  overlay.querySelector('#ksefadSumNet').textContent = net.toFixed(2);
  overlay.querySelector('#ksefadSumVat').textContent = vat.toFixed(2);
  overlay.querySelector('#ksefadSumGross').textContent = (net + vat).toFixed(2);
}

function openCreateForm(el, deps) {
  const { store } = deps;
  const companies = store.companies();
  const companyId = view.companyId || companies[0].id;
  const overlay = document.createElement('div');
  // modal-overlay is what the host's Esc handling and hasOpenModal() look
  // for; without it Esc would fall through to the terminal and interrupt
  // whatever session is attached
  overlay.className = 'ksefad-overlay modal-overlay';
  const contractors = store.contractors(companyId);
  const sellerBoxHtml = (c) => `
    <div class="ksefad-party-label">Sprzedawca</div>
    <div class="ksefad-party-name">${esc(c?.name || '')}</div>
    ${c?.address1 ? `<div>${esc(c.address1)}</div>` : ''}
    ${c?.address2 ? `<div>${esc(c.address2)}</div>` : ''}
    <div class="ksefad-muted">NIP ${esc(c?.nip || '—')}</div>
    ${c?.bankAccount ? `<div class="ksefad-muted" style="margin-top:6px">Rachunek: ${esc(c.bankAccount)}</div>` : ''}`;
  overlay.innerHTML = `
    <div class="ksefad-modal lg">
      <h2 style="margin-bottom:20px">Nowa faktura</h2>
      <div class="ksefad-grid" style="grid-template-columns:repeat(4, 1fr); margin-bottom:18px">
        <label>Firma<br><select id="ksefadFormCompany" style="width:100%">
          ${companies.map((c) => `<option value="${esc(c.id)}" ${c.id === companyId ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}
        </select></label>
        <label>Rodzaj<br><select id="ksefadFormKind" style="width:100%">
          <option value="vat">Faktura VAT</option><option value="proforma">Proforma</option>
        </select></label>
        <label>Data wystawienia<br><input id="ksefadFormDate" type="date" value="${today()}" style="width:100%"></label>
        <label>Termin płatności<br><input id="ksefadFormDue" type="date" style="width:100%"></label>
      </div>
      <div class="ksefad-doc-parties" style="margin-bottom:18px">
        <div class="ksefad-doc-party" id="ksefadFormSeller">${sellerBoxHtml(store.company(companyId))}</div>
        <div class="ksefad-doc-party">
          <div class="ksefad-party-label">Nabywca</div>
          <div class="ksefad-grid" style="grid-template-columns:2fr 1fr">
            <label>Nazwa<br><input id="ksefadFormBuyer" list="ksefadContractors" style="width:100%" placeholder="nazwa firmy / imię i nazwisko">
              <datalist id="ksefadContractors">${contractors.map((c) => `<option value="${esc(c.name)}">`).join('')}</datalist></label>
            <label>NIP<br><input id="ksefadFormNip" style="width:100%"></label>
            <label>Ulica i nr<br><input id="ksefadFormAddr1" style="width:100%"></label>
            <label>Kod i miejscowość<br><input id="ksefadFormAddr2" style="width:100%"></label>
          </div>
        </div>
      </div>
      <div class="ksefad-party-label" style="font-size:13px; opacity:.6; text-transform:uppercase; letter-spacing:.04em; margin-bottom:6px">Pozycje</div>
      <table class="ksefad-table ksefad-lines" style="margin-bottom:10px">
        <thead><tr><th>Nazwa</th><th>Ilość</th><th>Jm</th><th>Cena netto</th><th>VAT %</th>
          <th style="text-align:right">Wartość netto</th><th style="text-align:right">Wartość brutto</th></tr></thead>
        <tbody id="ksefadFormLines">${lineRowHtml()}</tbody>
      </table>
      <div class="ksefad-bar" style="margin-bottom:14px">
        <button class="ksefad-btn" id="ksefadAddLine">+ Nowa pozycja</button>
        <span style="flex:1"></span>
        <div class="ksefad-doc-totals" style="margin:0">
          <div><span>Suma netto</span><span id="ksefadSumNet">0,00</span></div>
          <div><span>Suma VAT</span><span id="ksefadSumVat">0,00</span></div>
          <div class="ksefad-doc-due"><span>Suma brutto</span><span id="ksefadSumGross">0,00</span></div>
        </div>
      </div>
      <div class="ksefad-bar">
        <span id="ksefadFormError" class="ksefad-error"></span>
        <span style="flex:1"></span>
        <button class="ksefad-btn" id="ksefadSave">Zapisz szkic</button>
        <button class="ksefad-btn primary" id="ksefadSaveSend">Zapisz i wyślij do KSeF</button>
        <button class="ksefad-btn" id="ksefadCancel">Anuluj</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  const close = () => overlay.remove();
  overlay.onclick = (e) => { if (e.target === overlay) close(); };
  overlay.querySelector('#ksefadCancel').onclick = close;
  overlay.querySelector('#ksefadAddLine').onclick = () => {
    overlay.querySelector('#ksefadFormLines').insertAdjacentHTML('beforeend', lineRowHtml());
    recalcFormTotals(overlay);
  };
  overlay.querySelector('#ksefadFormLines').addEventListener('input', () => recalcFormTotals(overlay));
  recalcFormTotals(overlay);
  overlay.querySelector('#ksefadFormCompany').addEventListener('change', (e) => {
    overlay.querySelector('#ksefadFormSeller').innerHTML = sellerBoxHtml(store.company(e.target.value));
    overlay.querySelector('#ksefadContractors').innerHTML = store.contractors(e.target.value)
      .map((c) => `<option value="${esc(c.name)}">`).join('');
  });
  overlay.querySelector('#ksefadFormBuyer').addEventListener('change', (e) => {
    const c = store.contractors(overlay.querySelector('#ksefadFormCompany').value)
      .find((x) => x.name === e.target.value);
    if (!c) return;
    overlay.querySelector('#ksefadFormNip').value = c.nip || '';
    if (c.address1) overlay.querySelector('#ksefadFormAddr1').value = c.address1;
    if (c.address2) overlay.querySelector('#ksefadFormAddr2').value = c.address2;
  });

  // Retrying after a failed send must not create the invoice a second time,
  // so a successfully created record is remembered across attempts
  let createdId = null;
  async function save(send) {
    const errEl = overlay.querySelector('#ksefadFormError');
    errEl.textContent = '';
    const company = store.company(overlay.querySelector('#ksefadFormCompany').value);
    try {
      if (!createdId) {
        const record = await createInvoice(deps, company, {
          kind: overlay.querySelector('#ksefadFormKind').value,
          buyerName: overlay.querySelector('#ksefadFormBuyer').value.trim(),
          buyerNip: overlay.querySelector('#ksefadFormNip').value.trim(),
          buyerAddress1: overlay.querySelector('#ksefadFormAddr1').value.trim(),
          buyerAddress2: overlay.querySelector('#ksefadFormAddr2').value.trim(),
          issueDate: overlay.querySelector('#ksefadFormDate').value,
          paymentTo: overlay.querySelector('#ksefadFormDue').value,
          lines: linesFromForm(overlay),
        });
        createdId = record.id;
      }
      if (send) await sendToKsef(deps, company, createdId);
      close();
    } catch (err) {
      errEl.textContent = createdId
        ? `Faktura zapisana jako szkic, ale: ${err.message || err}`
        : String(err.message || err);
    }
    renderPage(el, deps);
  }
  overlay.querySelector('#ksefadSave').onclick = () => save(false);
  overlay.querySelector('#ksefadSaveSend').onclick = () => save(true);
}

// ---- print (Fakturownia-style classic template) ----

export function printInvoice(deps, company, inv) {
  const lines = inv.lines || [];
  const vatGroups = {};
  for (const l of lines) {
    const g = vatGroups[l.vatRate] || { net: 0, vat: 0 };
    g.net += lineNet(l);
    g.vat += lineVat(l);
    vatGroups[l.vatRate] = g;
  }
  const body = `
    <div style="font-family: Arial, Helvetica, sans-serif; font-size:12px; padding:24px; max-width:760px; margin:0 auto;">
      <table style="width:100%; margin-bottom:18px"><tr>
        <td style="vertical-align:top">
          <div style="font-size:11px; color:#555">Sprzedawca</div>
          <b>${esc(company?.name || inv.sellerName)}</b><br>
          ${esc(company?.address1 || '')}<br>${esc(company?.address2 || '')}<br>
          NIP: ${esc(inv.sellerNip)}
        </td>
        <td style="vertical-align:top; text-align:right">
          <div style="font-size:20px; margin-bottom:4px">${inv.kind === 'proforma' ? 'Faktura proforma' : 'Faktura VAT'} <b>${esc(inv.number)}</b></div>
          <div>Data wystawienia: ${esc(inv.issueDate)}</div>
          ${inv.sellDate && inv.sellDate !== inv.issueDate ? `<div>Data sprzedaży: ${esc(inv.sellDate)}</div>` : ''}
          ${inv.ksefNumber ? `<div style="font-size:10px; color:#555">KSeF: ${esc(inv.ksefNumber)}</div>` : ''}
        </td>
      </tr></table>
      <div style="margin-bottom:14px">
        <div style="font-size:11px; color:#555">Nabywca</div>
        <b>${esc(inv.buyerName)}</b><br>
        ${esc(inv.buyerAddress1 || '')}<br>${esc(inv.buyerAddress2 || '')}<br>
        ${inv.buyerNip ? `NIP: ${esc(inv.buyerNip)}` : ''}
      </div>
      <table style="width:100%; border-collapse:collapse; margin-bottom:14px">
        <thead><tr>
          ${['Lp', 'Nazwa', 'Ilość', 'Jm', 'Cena netto', 'VAT', 'Wartość netto', 'Wartość brutto']
            .map((h) => `<th style="border:1px solid #999; padding:4px 6px; background:#f0f0f0; text-align:left">${h}</th>`).join('')}
        </tr></thead>
        <tbody>
          ${lines.map((l, i) => `<tr>
            <td style="border:1px solid #999; padding:4px 6px">${i + 1}</td>
            <td style="border:1px solid #999; padding:4px 6px">${esc(l.name)}</td>
            <td style="border:1px solid #999; padding:4px 6px">${esc(l.quantity)}</td>
            <td style="border:1px solid #999; padding:4px 6px">${esc(l.unit)}</td>
            <td style="border:1px solid #999; padding:4px 6px; text-align:right">${esc(Number(l.unitNetPrice).toFixed(2))}</td>
            <td style="border:1px solid #999; padding:4px 6px">${esc(l.vatRate)}%</td>
            <td style="border:1px solid #999; padding:4px 6px; text-align:right">${lineNet(l).toFixed(2)}</td>
            <td style="border:1px solid #999; padding:4px 6px; text-align:right">${(lineNet(l) + lineVat(l)).toFixed(2)}</td>
          </tr>`).join('')}
        </tbody>
      </table>
      <table style="border-collapse:collapse; margin-left:auto; margin-bottom:16px">
        <thead><tr>${['Stawka', 'Netto', 'VAT', 'Brutto'].map((h) => `<th style="border:1px solid #999; padding:3px 8px; background:#f0f0f0">${h}</th>`).join('')}</tr></thead>
        <tbody>
          ${Object.entries(vatGroups).map(([rate, g]) => `<tr>
            <td style="border:1px solid #999; padding:3px 8px">${esc(rate)}%</td>
            <td style="border:1px solid #999; padding:3px 8px; text-align:right">${g.net.toFixed(2)}</td>
            <td style="border:1px solid #999; padding:3px 8px; text-align:right">${g.vat.toFixed(2)}</td>
            <td style="border:1px solid #999; padding:3px 8px; text-align:right">${(g.net + g.vat).toFixed(2)}</td>
          </tr>`).join('')}
          <tr><td style="border:1px solid #999; padding:3px 8px"><b>Razem</b></td>
            <td style="border:1px solid #999; padding:3px 8px; text-align:right"><b>${(inv.net).toFixed(2)}</b></td>
            <td style="border:1px solid #999; padding:3px 8px; text-align:right"><b>${(inv.vat).toFixed(2)}</b></td>
            <td style="border:1px solid #999; padding:3px 8px; text-align:right"><b>${(inv.gross).toFixed(2)}</b></td></tr>
        </tbody>
      </table>
      <div style="font-size:14px; margin-bottom:6px"><b>Do zapłaty: ${zl(inv.gross, inv.currency)}</b></div>
      ${inv.paymentTo ? `<div>Termin płatności: ${esc(inv.paymentTo)}</div>` : ''}
      ${company?.bankAccount ? `<div>Nr konta: ${esc(company.bankAccount)}</div>` : ''}
    </div>`;
  // WKWebView has no window.print(); the document opens in the default
  // browser, prints itself and can be saved as PDF there
  const title = `${inv.kind === 'proforma' ? 'Proforma' : 'Faktura'} ${inv.number}`;
  deps.cl.openPreview(printDocHtml(title, body), title).catch((err) => {
    deps.cl.log('print preview failed:', err);
    alert(`Nie udało się otworzyć podglądu wydruku: ${err.message || err}`);
  });
}

// ---- PDF preview (blob-store files) ----

export function openPdfOverlay(deps, fileRec) {
  if (!fileRec?.key) return;
  const overlay = document.createElement('div');
  overlay.className = 'ksefad-overlay modal-overlay';
  overlay.innerHTML = `
    <div class="ksefad-modal lg" style="width:min(1100px, 96vw); height:92vh; display:flex; flex-direction:column; gap:10px">
      <div style="display:flex; align-items:baseline; gap:12px">
        <h2 style="margin:0; font-size:16px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap">📄 ${esc(fileRec.name || fileRec.key)}</h2>
        <span class="ksefad-muted">${esc(fileRec.docDate || fileRec.month || '')}${fileRec.gross ? ` · ${zl(fileRec.gross, fileRec.currency || 'PLN')}` : ''}</span>
        <span style="flex:1"></span>
        <button class="ksefad-btn" data-close>Zamknij (Esc)</button>
      </div>
      <embed src="${esc(deps.cl.dataFileUrl(fileRec.key))}" type="application/pdf" style="flex:1; width:100%; border:1px solid var(--border, #45475a); border-radius:8px; background:#fff">
    </div>`;
  document.body.appendChild(overlay);
  const close = () => overlay.remove();
  overlay.onclick = (e) => { if (e.target === overlay) close(); };
  overlay.querySelector('[data-close]').onclick = close;
}

// ---- keyboard ----

export function pageOnKey(e, el, deps) {
  if (e.metaKey || e.ctrlKey || e.altKey) return false;
  const overlay = document.querySelector('.ksefad-overlay');
  if (overlay) {
    if (e.key === 'Escape') {
      overlay.remove();
      return true;
    }
    return false;
  }
  const tag = document.activeElement?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return false;
  if (!deps.store.companies().length) return false;

  switch (e.key) {
    case 'h': cycleTab(el, deps, -1); return true;
    case 'l': cycleTab(el, deps, 1); return true;
    case 'Tab': e.preventDefault(); cycleTab(el, deps, 1); return true;
    case '/': el.querySelector('#ksefadQuery')?.focus(); e.preventDefault(); return true;
    case '[':
    case ']':
      if (view.mode === 'month') {
        view.month = monthAdd(view.month, e.key === '[' ? -1 : 1);
        view.selected = 0;
        renderPage(el, deps);
        return true;
      }
      break;
    default: break;
  }

  activeCompany(deps.store);
  const period = periodOf(view);
  const invoices = deps.store.listInvoices({
    companyId: view.companyId,
    dir: view.dir || undefined,
    unpaid: view.unpaid || undefined,
    query: view.query || undefined,
    from: period.from,
    to: period.to,
    limit: 300,
  });
  switch (e.key) {
    case 'j': view.selected = Math.min(view.selected + 1, invoices.length - 1); renderPage(el, deps); return true;
    case 'k': view.selected = Math.max(view.selected - 1, 0); renderPage(el, deps); return true;
    case 'Enter':
      if (invoices[view.selected]) openDetail(el, deps, invoices[view.selected].id);
      return true;
    case 'n': openCreateForm(el, deps); return true;
    case 'r':
      if (!view.busy) runSync(el, deps);
      return true;
    default: return false;
  }
}

export function clientsOnKey(e, el, deps) {
  if (e.metaKey || e.ctrlKey || e.altKey) return false;
  const overlay = document.querySelector('.ksefad-overlay');
  if (overlay) {
    if (e.key === 'Escape') {
      overlay.remove();
      return true;
    }
    return false;
  }
  const tag = document.activeElement?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return false;
  if (!deps.store.companies().length) return false;

  const clients = clientsFor(deps.store);
  switch (e.key) {
    case '/': el.querySelector('#ksefadClientQuery')?.focus(); e.preventDefault(); return true;
    case 'j': view.clientIdx = Math.min(view.clientIdx + 1, Math.max(0, clients.length - 1)); renderClientsPage(el, deps); return true;
    case 'k': view.clientIdx = Math.max(view.clientIdx - 1, 0); renderClientsPage(el, deps); return true;
    case 'd': view.clientTab = 'dane'; renderClientsPage(el, deps); return true;
    case 'f': view.clientTab = 'fv'; renderClientsPage(el, deps); return true;
    case 'w': view.clientTab = 'wyd'; renderClientsPage(el, deps); return true;
    case 'n': el.querySelector('#ksefadClientAdd')?.click(); return true;
    case 'r': el.querySelector('#ksefadClientsRefresh')?.click(); return true;
    default: return false;
  }
}

// ---- widgets ----

export function renderTodayWidget(el, deps) {
  injectStyle();
  const stamp = today();
  const items = deps.store.listInvoices()
    .filter((i) => i.src === 'ksef' && i.seen === stamp)
    .slice(0, 8);
  el.innerHTML = items.length
    ? `<div class="ksefad-widget">${items.map((i) => `
        <div class="ksefad-widget-row">
          <span title="${esc(i.number)}">${i.dir === 'cost' ? '📥' : '📤'} ${esc((i.dir === 'sale' ? i.buyerName : i.sellerName) || i.number)}</span>
          <span>${zl(i.gross, i.currency)}</span>
        </div>`).join('')}</div>`
    : '<div class="widget-empty">Nothing new from KSeF today</div>';
  el.onclick = () => deps.cl.openModule('main', 'invoices');
}

export function renderUnpaidWidget(el, deps) {
  injectStyle();
  const items = deps.store.listInvoices({ dir: 'sale', unpaid: true }).slice(0, 8);
  const remaining = (i) => Math.max(0, i.gross - (Number(i.paidAmount) || 0));
  const sum = items.reduce((s, i) => s + (i.currency === 'PLN' ? remaining(i) : 0), 0);
  el.innerHTML = items.length
    ? `<div class="ksefad-widget">
        ${items.map((i) => `
          <div class="ksefad-widget-row">
            <span title="${esc(i.number)}">${Number(i.paidAmount) > 0 ? '◐ ' : ''}${esc(i.buyerName || i.number)}</span>
            <span>${zl(remaining(i), i.currency)}</span>
          </div>`).join('')}
        <div class="ksefad-widget-row" style="border-top:1px solid rgba(128,128,128,.3); padding-top:3px">
          <span>total</span><b>${zl(sum)}</b>
        </div>
      </div>`
    : '<div class="widget-empty">No unpaid sales invoices 🎉</div>';
  el.onclick = () => deps.cl.openModule('main', 'invoices');
}

// ---- settings ----

// Gmail accounts configured in the app — loaded once per settings render
// for the "send reports as" combo
let emailAccountsCache = [];

function r2StatusLine(store, companyId) {
  const cfg = store.r2Config(companyId);
  if (!r2Configured(store, companyId)) return 'Backup R2 nie jest skonfigurowany';
  const last = cfg.last;
  if (!last?.at) return `bucket ${cfg.bucket} — jeszcze bez backupu`;
  const when = String(last.at).replace('T', ' ').slice(0, 16);
  return `bucket ${cfg.bucket} · ostatni backup ${when} · ${store.r2Manifest(companyId).length} plików w chmurze`
    + (last.failed ? ` · ⚠ ${last.failed} błędów` : '');
}

// Deep link to the object's page in the Cloudflare dashboard — the bucket
// is private, so a direct https link to the object would only 403
export function r2DashUrl(cfg, key) {
  if (!cfg?.bucket) return '';
  const prefix = String(cfg.prefix || '').replace(/^\/+|\/+$/g, '');
  const fullKey = (prefix ? `${prefix}/` : '') + key;
  return `https://dash.cloudflare.com/?to=/:account/r2/default/buckets/${encodeURIComponent(cfg.bucket)}/objects/${encodeURIComponent(fullKey)}/details`;
}

function openR2Modal(deps, company, onDone) {
  const { store, cl } = deps;
  const cfg = store.r2Config(company.id) || {};
  const overlay = document.createElement('div');
  overlay.className = 'ksefad-overlay modal-overlay';
  overlay.innerHTML = `
    <div class="ksefad-modal lg" style="width:min(640px, 92vw)">
      <h2 style="margin-bottom:6px">☁️ Backup R2 — ${esc(company.name)}</h2>
      <div class="ksefad-muted" style="margin-bottom:14px">Kopia archiwum plików tej firmy (faktury i wyciągi)
        do osobnego bucketa S3/R2. Tylko wysyłka — nic nie jest usuwane z chmury.</div>
      <div class="adk-form">
        <label class="adk-field"><span>Endpoint S3</span><input id="r2Endpoint" value="${esc(cfg.endpoint || '')}" placeholder="https://<account>.r2.cloudflarestorage.com"></label>
        <label class="adk-field"><span>Bucket</span><input id="r2Bucket" value="${esc(cfg.bucket || '')}"></label>
        <label class="adk-field"><span>Access Key ID</span><input id="r2AccessKey" value="${esc(cfg.accessKeyId || '')}"></label>
        <label class="adk-field"><span>Secret Access Key</span><input id="r2Secret" type="password" value="${esc(cfg.secretAccessKey || '')}"></label>
        <label class="adk-field"><span>Prefiks kluczy <small>(opcjonalny podkatalog w buckecie)</small></span><input id="r2Prefix" value="${esc(cfg.prefix || '')}" placeholder="np. cyberlife"></label>
        <label class="adk-field" style="flex-direction:row; align-items:center; gap:8px">
          <input type="checkbox" id="r2Auto" ${cfg.auto ? 'checked' : ''} style="width:auto"><span>Automatyczny backup po każdej synchronizacji</span></label>
      </div>
      <div class="adk-actions" style="margin-top:14px">
        <button class="adk-btn primary" id="r2Save">Zapisz</button>
        <button class="adk-btn" id="r2Test">Test połączenia</button>
        <button class="adk-btn" id="r2Run">Backup teraz</button>
        <span style="flex:1"></span>
        <button class="adk-btn" id="r2Close">Zamknij</button>
      </div>
      <div class="adk-status" id="r2Status">${esc(r2StatusLine(store, company.id))}${cfg.last?.error ? ` · ostatni błąd: ${esc(cfg.last.error)}` : ''}</div>
    </div>`;
  document.body.appendChild(overlay);
  const status = overlay.querySelector('#r2Status');
  const close = () => { overlay.remove(); onDone?.(); };
  overlay.onclick = (e) => { if (e.target === overlay) close(); };
  overlay.querySelector('#r2Close').onclick = close;

  const readConfig = () => ({
    ...(store.r2Config(company.id) || {}),
    endpoint: overlay.querySelector('#r2Endpoint').value.trim().replace(/\/+$/, ''),
    bucket: overlay.querySelector('#r2Bucket').value.trim(),
    accessKeyId: overlay.querySelector('#r2AccessKey').value.trim(),
    secretAccessKey: overlay.querySelector('#r2Secret').value.trim(),
    prefix: overlay.querySelector('#r2Prefix').value.trim(),
    auto: overlay.querySelector('#r2Auto').checked,
  });

  overlay.querySelector('#r2Save').onclick = async () => {
    await store.saveR2Config(company.id, readConfig());
    status.textContent = 'Zapisano konfigurację.';
  };
  overlay.querySelector('#r2Test').onclick = async (e) => {
    e.target.disabled = true;
    status.textContent = 'Sprawdzam połączenie z bucketem…';
    try {
      const next = readConfig();
      await store.saveR2Config(company.id, next);
      const res = await cl.backup('test', next);
      status.textContent = `✓ Połączenie działa — w buckecie ${res.remoteObjects} obiektów.`;
    } catch (err) {
      cl.log('r2 test failed:', err);
      status.textContent = `✗ ${err.message || err}`;
    }
    e.target.disabled = false;
  };
  overlay.querySelector('#r2Run').onclick = async (e) => {
    e.target.disabled = true;
    try {
      await store.saveR2Config(company.id, readConfig());
      const st = await runR2Backup(deps, company, {
        onProgress: (p) => { status.textContent = `Backup… sprawdzono ${p.checked}, wysłano ${p.uploaded}${p.failed ? `, błędów ${p.failed}` : ''}`; },
      });
      status.textContent = `✓ Backup zakończony: wysłano ${st.uploaded}, bez zmian ${st.skipped}${st.failed ? `, błędów ${st.failed} (${st.lastError})` : ''}.`;
    } catch (err) {
      cl.log('r2 backup failed:', err);
      status.textContent = `✗ ${err.message || err}`;
    }
    e.target.disabled = false;
  };
}

function companyFormHtml(c = {}) {
  const fk = c.fakturownia || {};
  return `
    <div class="adk-form">
      <label class="adk-field"><span>Nazwa firmy</span><input data-f="name" value="${esc(c.name || '')}"></label>
      <label class="adk-field"><span>NIP</span><input data-f="nip" value="${esc(c.nip || '')}"></label>
      <label class="adk-field"><span>Adres — linia 1</span><input data-f="address1" value="${esc(c.address1 || '')}" placeholder="ulica i numer"></label>
      <label class="adk-field"><span>Adres — linia 2</span><input data-f="address2" value="${esc(c.address2 || '')}" placeholder="kod i miejscowość"></label>
      <label class="adk-field"><span>Rachunek bankowy</span><input data-f="bankAccount" value="${esc(c.bankAccount || '')}"></label>
      <label class="adk-field"><span>E-mail księgowej</span><input data-f="accountantEmail" type="email" value="${esc(c.accountantEmail || '')}" placeholder="ksiegowa@biuro.pl — cel raportów wysyłanych mailem"></label>
      <label class="adk-field"><span>E-maile CC raportów <small>(po przecinku)</small></span><input data-f="accountantCc" value="${esc(c.accountantCc || '')}" placeholder="ja@firma.pl, wspolnik@firma.pl"></label>
      <label class="adk-field"><span>Wysyłka raportów z konta</span><select data-f="senderEmail">
        <option value="">(pierwsze skonfigurowane konto Gmail)</option>
        ${emailAccountsCache.map((a) => `<option value="${esc(a)}" ${a === c.senderEmail ? 'selected' : ''}>${esc(a)}</option>`).join('')}
      </select></label>
      <label class="adk-field"><span>Wzorzec numeracji <small>(tylko gdy tryb Fakturownia: wyłączony)</small></span>
        <input data-f="numberingPattern" value="${esc(c.numberingPattern || '{nr}/{mm}/{yyyy}')}" title="{nr} kolejny numer, {mm} miesiąc, {yyyy} rok — w trybie dual numeruje Fakturownia wg własnego wzorca"></label>
      <label class="adk-field"><span>Środowisko KSeF</span><select data-f="env">
        ${['prod', 'demo', 'test'].map((e) => `<option ${e === (c.env || 'prod') ? 'selected' : ''}>${e}</option>`).join('')}
      </select></label>
      <label class="adk-field"><span>Token KSeF</span><input data-f="ksefToken" type="password" value="${esc(c.ksefToken || '')}"></label>
      <label class="adk-field"><span>Fakturownia — subdomena</span><input data-f="fk_subdomain" value="${esc(fk.subdomain || '')}" placeholder="mojafirma (.fakturownia.pl)"></label>
      <label class="adk-field"><span>Fakturownia — token API</span><input data-f="fk_token" type="password" value="${esc(fk.token || '')}"></label>
      <label class="adk-field"><span>Tryb Fakturownia</span><select data-f="fk_mode"
        title="Dual: faktury tworzone tutaj powstają też w Fakturowni (jej numeracja), wysyłka do KSeF idzie przez Fakturownię, płatności synchronizują się w obie strony. Wyłączony: aplikacja rozmawia z KSeF bezpośrednio.">
        <option value="dual" ${(fk.mode || 'dual') !== 'off' ? 'selected' : ''}>Dual — synchronizacja dwustronna</option>
        <option value="off" ${fk.mode === 'off' ? 'selected' : ''}>Wyłączony — tylko KSeF</option>
      </select></label>
    </div>`;
}

export function fvInfoHtml(info) {
  if (!info) {
    return '<span class="adk-muted">Parametry konta nie zostały jeszcze pobrane — kliknij „Odśwież" albo uruchom import.</span>';
  }
  const s = info.seller || {};
  const patterns = Object.entries(info.patterns || {}).filter(([, v]) => v);
  return `
    <div class="adk-kv">
      <div><b>Konto:</b> ${esc(info.account?.prefix || '?')}.fakturownia.pl · plan ${esc(info.account?.plan || '—')} · ${esc(String(info.account?.invoices ?? '—'))} dokumentów</div>
      ${s.name ? `<div><b>Sprzedawca:</b> ${esc(s.name)} · NIP ${esc(s.nip || '—')}</div>
      <div class="adk-muted">${esc(s.street || '')}${s.street ? ', ' : ''}${esc(s.postCode || '')} ${esc(s.city || '')}${s.email ? ` · ${esc(s.email)}` : ''}</div>
      ${s.bankAccount ? `<div class="adk-muted">Bank: ${esc(s.bank || '')} ${esc(s.bankAccount)}</div>` : ''}` : ''}
      ${patterns.length ? `<div><b>Wzorce numeracji:</b> ${patterns.map(([k, v]) => `${esc(k)}: <code>${esc(v)}</code>`).join(' · ')}</div>` : ''}
      <div class="adk-muted" style="font-size:.9em">Pobrano ${esc(String(info.fetchedAt || '').replace('T', ' ').slice(0, 19))}</div>
    </div>`;
}

export function renderSettings(el, deps) {
  injectStyle();
  const { store } = deps;
  const companies = store.companies();
  if (!emailAccountsCache.length) {
    deps.cl.listEmailAccounts?.().then((accounts) => {
      if (accounts?.length && !emailAccountsCache.length) {
        emailAccountsCache = accounts;
        renderSettings(el, deps);
      }
    }).catch((err) => deps.cl.log('email accounts load failed:', err));
  }
  el.innerHTML = `
    <h2 class="settings-section-title">🧾 KSeF — polskie e-fakturowanie</h2>
    <p class="settings-section-desc">Firmy — każda z własnym NIP i tokenem KSeF. Pola Fakturowni
    włączają import historii oraz tryb dual (dwustronna synchronizacja).</p>
    <div id="ksefadCompanies">
      ${companies.map((c) => `
        <details class="adk-card" data-id="${esc(c.id)}" ${companies.length === 1 ? 'open' : ''}>
          <summary><b>${esc(c.name)}</b> <span class="adk-muted">· NIP ${esc(c.nip || '—')}
            ${store.syncState(c.id).fakturowniaImportedAt ? ' · zaimportowano ✓' : ''}</span></summary>
          ${companyFormHtml(c)}
          <div class="adk-actions">
            <button class="adk-btn primary ksefadSaveCompany">Zapisz</button>
            <button class="adk-btn ksefadImport">Import z Fakturowni</button>
            <button class="adk-btn ksefadTestKsef">Test połączenia z KSeF</button>
            <button class="adk-btn ksefadR2" title="${esc(r2StatusLine(store, c.id))}">☁️ Backup R2…</button>
            <span style="flex:1"></span>
            <button class="adk-btn danger ksefadDelete">Usuń</button>
          </div>
          <div class="ksefad-status adk-status"></div>
          ${(c.fakturownia?.subdomain && c.fakturownia?.token) ? `
            <div class="adk-subcard">
              <div class="adk-subcard-head">
                <b>Parametry Fakturowni</b>
                <span class="adk-muted">tylko do odczytu — edycja w Fakturowni</span>
                <span style="flex:1"></span>
                <button class="adk-btn ksefadFvRefresh">Odśwież</button>
              </div>
              <div class="ksefad-fvinfo">${fvInfoHtml(store.fvInfo(c.id))}</div>
            </div>` : ''}
        </details>`).join('')}
    </div>
    <button class="adk-btn" id="ksefadAddCompany">+ Dodaj firmę</button>
    <div id="ksefadNewCompany"></div>`;

  const readForm = (container, id) => {
    const get = (f) => container.querySelector(`[data-f="${f}"]`)?.value?.trim() || '';
    return {
      id,
      name: get('name'),
      nip: get('nip'),
      address1: get('address1'),
      address2: get('address2'),
      bankAccount: get('bankAccount'),
      accountantEmail: get('accountantEmail'),
      accountantCc: get('accountantCc'),
      senderEmail: get('senderEmail'),
      numberingPattern: get('numberingPattern'),
      env: get('env') || 'prod',
      ksefToken: get('ksefToken'),
      fakturownia: { subdomain: get('fk_subdomain'), token: get('fk_token'), mode: get('fk_mode') || 'dual' },
    };
  };

  el.querySelectorAll('details[data-id]').forEach((box) => {
    const id = box.dataset.id;
    const status = box.querySelector('.ksefad-status');
    box.querySelector('.ksefadSaveCompany').onclick = async () => {
      await store.saveCompany(readForm(box, id));
      clearTokenCache(id);
      status.textContent = 'Zapisano.';
    };
    box.querySelector('.ksefadDelete').onclick = async () => {
      if (!confirm('Usunąć konfigurację tej firmy? (dane faktur zostają w storage)')) return;
      await store.deleteCompany(id);
      renderSettings(el, deps);
    };
    box.querySelector('.ksefadImport').onclick = async (e) => {
      e.target.disabled = true;
      const company = readForm(box, id);
      await store.saveCompany(company);
      try {
        const res = await importFromFakturownia(deps, company,
          ({ page, total }) => { status.textContent = `Import… strona ${page}, ${total} faktur`; });
        status.textContent = `Import zakończony: pobrano ${res.total}, nowych ${res.added}, zaktualizowanych ${res.updated}.`;
      } catch (err) {
        deps.cl.log('fakturownia import failed:', err);
        status.textContent = `Import nieudany: ${err.message || err}`;
      }
      e.target.disabled = false;
    };
    box.querySelector('.ksefadFvRefresh')?.addEventListener('click', async (e) => {
      e.target.disabled = true;
      try {
        const info = await fetchFakturowniaInfo(deps, readForm(box, id));
        box.querySelector('.ksefad-fvinfo').innerHTML = fvInfoHtml(info);
      } catch (err) {
        deps.cl.log('fakturownia info fetch failed:', err);
        status.textContent = `Nie udało się pobrać parametrów: ${err.message || err}`;
      }
      e.target.disabled = false;
    });
    box.querySelector('.ksefadR2').onclick = () => {
      const company = store.company(id);
      if (company) openR2Modal(deps, company, () => renderSettings(el, deps));
    };
    box.querySelector('.ksefadTestKsef').onclick = async (e) => {
      e.target.disabled = true;
      const company = readForm(box, id);
      await store.saveCompany(company);
      clearTokenCache(id);
      status.textContent = 'Uwierzytelnianie w KSeF…';
      try {
        await syncCompany(deps, company);
        status.textContent = `KSeF OK — synchronizacja zakończona (łącznie ${store.listInvoices({ companyId: id }).length} faktur).`;
      } catch (err) {
        deps.cl.log('ksef test failed:', err);
        status.textContent = `Błąd KSeF: ${err.message || err}`;
      }
      e.target.disabled = false;
    };
  });

  el.querySelector('#ksefadAddCompany').onclick = () => {
    const holder = el.querySelector('#ksefadNewCompany');
    holder.innerHTML = `<div class="adk-card" style="margin-top:12px">${companyFormHtml()}
      <div class="adk-actions"><button class="adk-btn primary" id="ksefadCreateCompany">Utwórz</button></div></div>`;
    holder.querySelector('#ksefadCreateCompany').onclick = async () => {
      const company = readForm(holder, `c${Date.now()}`);
      if (!company.name) return;
      await store.saveCompany(company);
      renderSettings(el, deps);
    };
  };
}
