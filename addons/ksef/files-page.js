// Pliki (invoice files) page: browse the blob-store archive of expense/
// sale documents, preview PDFs, upload new files (images convert to PDF
// on the host) and pair them with invoices — automatically where the
// extracted fields allow, by hand otherwise.

import {
  injectStyle, currentMonth, monthAdd, periodBarHtml, bindPeriodBar, periodOf,
  activeCompany, openPdfOverlay, invDesc, r2DashUrl,
} from './page.js';
import { extractFields, matchFileToInvoice } from './files.js';
import { createCostFromFile, ensureFileExtraction } from './service.js';
import { fakturowniaMode } from './fakturownia.js';

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const zl = (n, cur = 'PLN') => `${(Number(n) || 0).toFixed(2)} ${cur}`;

const filesView = {
  mode: 'month',
  month: currentMonth(),
  from: '',
  to: '',
  query: '',
  show: { linked: true, unlinked: true },
  types: { invoices: true, statements: true },
  selected: 0,
  busy: '',
  error: '',
  info: '',
};

function monthOf(rec) {
  return (rec.docDate || '').slice(0, 7) || rec.month || '';
}

function filesForView(store, company) {
  const period = periodOf(filesView);
  const fromM = (period.from || '').slice(0, 7);
  const toM = (period.to || '').slice(0, 7);
  let list = store.files(company.id).filter((f) => {
    const m = monthOf(f);
    // A file with no readable date must stay reachable in every period,
    // or it would be invisible in month navigation forever
    if (!m) return true;
    if (fromM && m < fromM) return false;
    if (toM && m > toM) return false;
    return true;
  });
  list = list.filter((f) => (f.invoiceId ? filesView.show.linked : filesView.show.unlinked));
  if (!filesView.types.invoices) list = [];

  // Original bank statements live in their own registry but browse here
  // alongside invoice files (one archive, one page)
  if (filesView.types.statements) {
    const stmts = store.stmtFiles(company.id)
      .filter((s) => {
        const m = s.months?.[0] || '';
        if (!m) return true;
        if (fromM && (s.months[s.months.length - 1] || m) < fromM) return false;
        if (toM && m > toM) return false;
        return true;
      })
      .map((s) => ({ stmt: true, id: s.sha256.slice(0, 16), key: s.key, name: s.name, month: s.months?.[0] || '', account: s.account, period: s.period, currency: s.currency, ops: s.ops }));
    list = [...list, ...stmts].sort((a, b) => String(b.docDate || b.month || '').localeCompare(String(a.docDate || a.month || '')));
  }
  if (filesView.query) {
    const q = filesView.query.toLowerCase();
    list = list.filter((f) => [f.name, f.number, f.nip, f.note, f.account, f.period].some((v) => String(v || '').toLowerCase().includes(q)));
  }
  return list;
}

async function sha256Hex(buf) {
  const h = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function bufToBase64(buf) {
  const bytes = new Uint8Array(buf);
  let out = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    out += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(out);
}

export function renderFilesPage(el, deps) {
  injectStyle();
  el.dataset.ksefadPage = 'files';
  const { store } = deps;
  const company = activeCompany(store);
  if (!company) {
    el.innerHTML = '<div class="ksefad"><h2>📄 Pliki faktur</h2><p>Najpierw dodaj firmę w Ustawieniach → Addons → KSeF.</p></div>';
    return;
  }
  const list = filesForView(store, company);
  filesView.selected = Math.min(filesView.selected, Math.max(0, list.length - 1));
  const all = store.files(company.id);
  const linked = all.filter((f) => f.invoiceId).length;
  const invIndex = new Map(store.listInvoices({ companyId: company.id }).map((i) => [i.id, i]));
  const r2 = store.r2Index(company.id);
  const r2Cell = (key) => (r2.has(key)
    ? `<button class="ksefad-btn" data-r2="${esc(key)}" title="kopia w R2 — otwórz w panelu Cloudflare">☁️</button>`
    : `<span class="ksefad-muted" title="${store.r2Config(company.id) ? 'jeszcze bez kopii w R2 — uruchom backup' : 'backup R2 nie jest skonfigurowany'}">—</span>`);

  el.innerHTML = `
    <div class="ksefad">
      <div class="ksefad-bar">
        ${periodBarHtml(filesView)}
        <input id="filesQuery" placeholder="szukaj… (/)" value="${esc(filesView.query)}" style="flex:1; min-width:120px">
        <input type="file" id="filesInput" multiple accept=".pdf,.png,.jpg,.jpeg" style="display:none">
        <button class="ksefad-btn primary" id="filesUpload" ${filesView.busy ? 'disabled' : ''}>${filesView.busy === 'upload' ? 'Przetwarzam…' : '+ Dodaj fakturę (n)'}</button>
      </div>
      ${filesView.error ? `<div class="ksefad-error">${esc(filesView.error)}</div>` : ''}
      ${filesView.info ? `<div class="ksefad-muted">${esc(filesView.info)}</div>` : ''}
      <div class="ksefad-bar ksefad-muted" style="gap:16px">
        <span>${all.length} faktur (przypisanych ${linked}), ${store.stmtFiles(company.id).length} wyciągów:</span>
        <label><input type="checkbox" data-ftype="invoices" ${filesView.types.invoices ? 'checked' : ''}> Faktury</label>
        <label><input type="checkbox" data-ftype="statements" ${filesView.types.statements ? 'checked' : ''}> Wyciągi</label>
        <span style="opacity:.4">|</span>
        <label style="color:var(--success, #a6e3a1)"><input type="checkbox" data-fshow="linked" ${filesView.show.linked ? 'checked' : ''}> przypisane</label>
        <label style="color:var(--error, #f38ba8)"><input type="checkbox" data-fshow="unlinked" ${filesView.show.unlinked ? 'checked' : ''}> nieprzypisane</label>
      </div>
      <div class="ksefad-scroll">
        <table class="ksefad-table">
          <thead><tr><th>Data</th><th>Plik</th><th>Numer</th><th>Kwota</th><th>Faktura w systemie</th><th>PDF</th><th title="kopia w Cloudflare R2">R2</th></tr></thead>
          <tbody>
            ${list.map((f, i) => {
              if (f.stmt) {
                return `
              <tr data-stmt="${esc(f.key)}" class="${i === filesView.selected ? 'sel' : ''}">
                <td>${esc(f.month || '—')}</td>
                <td style="max-width:340px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap" title="${esc(f.name)}">🏦 ${esc(f.name)}</td>
                <td class="ksefad-muted">…${esc((f.account || '').slice(-4))} ${esc(f.currency || '')}</td>
                <td style="text-align:right" class="ksefad-muted">—</td>
                <td class="ksefad-muted">wyciąg bankowy${f.ops === 0 ? ' <span title="konto VAT bez ruchu w tym miesiącu">(0 operacji)</span>' : ''} · ${esc(f.period || '')}</td>
                <td style="text-align:center"><button class="ksefad-btn" data-preview-stmt="${esc(f.key)}">📄</button></td>
                <td style="text-align:center">${r2Cell(f.key)}</td>
              </tr>`;
              }
              const inv = f.invoiceId ? invIndex.get(f.invoiceId) : null;
              return `
              <tr data-fid="${esc(f.id)}" class="${i === filesView.selected ? 'sel' : ''} ${f.invoiceId ? 'ksefad-row-ok' : 'ksefad-row-bad'}">
                <td>${esc(f.docDate || f.month || '—')}</td>
                <td style="max-width:340px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap" title="${esc(f.name)}">${esc(f.name)}</td>
                <td>${esc(f.number || '—')}</td>
                <td style="text-align:right">${f.gross ? zl(f.gross, f.currency || 'PLN') : '—'}</td>
                <td>${inv
                  ? `${esc(inv.number || inv.ksefNumber || '—')} <span class="ksefad-muted">${esc(invDesc(inv, 40))}</span>`
                  : '<span style="color:var(--error, #f38ba8)">✗ brak</span>'}</td>
                <td style="text-align:center"><button class="ksefad-btn" data-preview="${esc(f.id)}">📄</button></td>
                <td style="text-align:center">${r2Cell(f.key)}</td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>
        ${list.length ? '' : '<p class="ksefad-muted" style="padding:12px">Brak plików w tym okresie.</p>'}
      </div>
      <div class="ksefad-muted">${list.length} pozycji · [/]: miesiąc · j/k wybór · Enter szczegóły · n dodaj plik</div>
    </div>`;

  bindPeriodBar(el, filesView, () => renderFilesPage(el, deps));
  const query = el.querySelector('#filesQuery');
  query.oninput = (e) => {
    filesView.query = e.target.value;
    filesView.selected = 0;
    const caret = e.target.selectionStart;
    renderFilesPage(el, deps);
    const next = el.querySelector('#filesQuery');
    next.focus();
    next.setSelectionRange(caret, caret);
  };
  el.querySelectorAll('[data-fshow]').forEach((box) => {
    box.onchange = () => {
      filesView.show[box.dataset.fshow] = box.checked;
      renderFilesPage(el, deps);
    };
  });
  el.querySelectorAll('[data-ftype]').forEach((box) => {
    box.onchange = () => {
      filesView.types[box.dataset.ftype] = box.checked;
      renderFilesPage(el, deps);
    };
  });
  el.querySelectorAll('[data-r2]').forEach((btn) => {
    btn.onclick = (e) => {
      e.stopPropagation();
      deps.cl.openUrl(r2DashUrl(store.r2Config(company.id), btn.dataset.r2));
    };
  });
  el.querySelectorAll('[data-preview-stmt]').forEach((btn) => {
    btn.onclick = (e) => {
      e.stopPropagation();
      const s = store.stmtFiles(company.id).find((x) => x.key === btn.dataset.previewStmt);
      if (s) openPdfOverlay(deps, { key: s.key, name: s.name, month: s.months?.[0] || '' });
    };
  });
  el.querySelector('#filesUpload').onclick = () => el.querySelector('#filesInput').click();
  el.querySelector('#filesInput').onchange = (e) => uploadFiles(el, deps, company, e.target.files);
  el.querySelectorAll('[data-preview]').forEach((btn) => {
    btn.onclick = (e) => {
      e.stopPropagation();
      const rec = store.files(company.id).find((f) => f.id === btn.dataset.preview);
      openPdfOverlay(deps, rec);
    };
  });
  el.querySelectorAll('tbody tr').forEach((tr, i) => {
    tr.onclick = () => {
      filesView.selected = i;
      if (tr.dataset.stmt) {
        const s = store.stmtFiles(company.id).find((x) => x.key === tr.dataset.stmt);
        if (s) openPdfOverlay(deps, { key: s.key, name: s.name, month: s.months?.[0] || '' });
        return;
      }
      const rec = store.files(company.id).find((f) => f.id === tr.dataset.fid);
      if (rec) openFileDetail(el, deps, company, rec);
    };
  });
}

async function uploadFiles(el, deps, company, fileList) {
  const { store } = deps;
  const picked = [...(fileList || [])];
  if (!picked.length) return;
  filesView.busy = 'upload';
  filesView.error = '';
  filesView.info = '';
  renderFilesPage(el, deps);
  const invoices = store.listInvoices({ companyId: company.id });
  let added = 0;
  let matched = 0;
  let skipped = 0;
  let lastRec = null;
  for (const file of picked) {
    try {
      const buf = await file.arrayBuffer();
      const sha = await sha256Hex(buf);
      if (store.files(company.id).some((f) => f.sha256 === sha)) {
        skipped++;
        continue;
      }
      const safeName = file.name.normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 80);
      const key = `files/manual/${sha.slice(0, 12)}-${safeName.replace(/\.(png|jpe?g)$/i, '')}.pdf`.replace(/\.pdf\.pdf$/i, '.pdf');
      await deps.cl.putDataFile(key, bufToBase64(buf), { toPdf: true });

      let fields = { nips: [], vatIds: [], seller: null, dates: [], amounts: { strong: [], all: [] }, numbers: [], currency: '' };
      const isPdf = /\.pdf$/i.test(file.name);
      if (isPdf) {
        try {
          fields = extractFields(await deps.cl.pdfText(bufToBase64(buf)), company.nip);
        } catch (err) {
          deps.cl.log('files: pdfText failed (scanned pdf?):', err);
        }
      }
      const match = matchFileToInvoice(fields, invoices, { dir: 'cost' })
        || matchFileToInvoice(fields, invoices, { dir: 'sale' });
      const rec = {
        id: sha.slice(0, 16),
        sha256: sha,
        key,
        name: file.name,
        month: (fields.dates[0] || '').slice(0, 7) || currentMonth(),
        source: 'manual',
        invoiceId: match?.invoice.id || '',
        matchedBy: match?.how || '',
        nip: fields.nips[0] || '',
        vatId: fields.vatIds?.[0] || '',
        sellerName: fields.seller?.name || '',
        sellerAddress1: fields.seller?.address1 || '',
        sellerAddress2: fields.seller?.address2 || '',
        number: fields.numbers[0] || '',
        docDate: fields.dates[0] || '',
        gross: fields.amounts.strong[0] || 0,
        currency: fields.currency || '',
        vatRate: fields.vatRate ?? null,
      };
      await store.upsertFiles(company.id, [rec]);
      added++;
      if (match) matched++;
      lastRec = rec;
    } catch (err) {
      deps.cl.log('files: upload failed:', err);
      filesView.error = `${file.name}: ${err.message || err}`;
    }
  }
  filesView.busy = '';
  filesView.info = `Dodano ${added} plików (${matched} dopasowanych automatycznie${skipped ? `, ${skipped} pominiętych — już w archiwum` : ''}).`;
  renderFilesPage(el, deps);
  // A single unmatched upload goes straight to pairing — that is why the
  // user uploaded it
  if (picked.length === 1 && added === 1 && !matched && lastRec) {
    openFileDetail(el, deps, company, lastRec);
  }
}

function openFileDetail(el, deps, company, rec) {
  const { store } = deps;
  const inv = rec.invoiceId ? store.getInvoice(rec.invoiceId) : null;
  const overlay = document.createElement('div');
  overlay.className = 'ksefad-overlay modal-overlay';
  overlay.innerHTML = `
    <div class="ksefad-modal lg" style="width:min(1200px, 96vw); height:92vh; display:flex; gap:16px">
      <embed src="${esc(deps.cl.dataFileUrl(rec.key))}" type="application/pdf" style="flex:1.4; min-width:0; border:1px solid var(--border, #45475a); border-radius:8px; background:#fff">
      <div style="flex:1; min-width:320px; overflow:auto; display:flex; flex-direction:column; gap:12px">
        <h2 style="margin:0; font-size:16px; word-break:break-all">📄 ${esc(rec.name)}</h2>
        <div class="adk-kv">
          <div><b>Data dokumentu:</b> ${esc(rec.docDate || '—')} <span class="ksefad-muted">(miesiąc ${esc(rec.month || '—')})</span></div>
          <div><b>Numer (odczytany):</b> ${esc(rec.number || '—')}</div>
          <div><b>NIP (odczytany):</b> ${esc(rec.nip || '—')}</div>
          <div><b>Kwota (odczytana):</b> ${rec.gross ? zl(rec.gross, rec.currency || 'PLN') : '—'}</div>
          <div><b>Źródło:</b> ${esc(rec.source || '—')}</div>
          ${rec.matchedBy ? `<div><b>Dopasowano po:</b> ${esc(rec.matchedBy)}</div>` : ''}
          <div><b>Backup R2:</b> ${store.r2Index(company.id).has(rec.key)
            ? '☁️ w chmurze <button class="adk-btn" id="fdR2" style="padding:2px 8px">Otwórz w Cloudflare</button>'
            : `<span class="ksefad-muted">${store.r2Config(company.id) ? 'jeszcze bez kopii — uruchom backup w Ustawieniach' : 'nie skonfigurowany'}</span>`}</div>
        </div>
        <div class="adk-kv">
          <div><b>Faktura w systemie:</b></div>
          ${inv
            ? `<div>${esc(inv.number || inv.ksefNumber)} · ${esc(inv.issueDate)} · ${zl(inv.gross, inv.currency)}<br>
               <span class="ksefad-muted">${esc(inv.dir === 'cost' ? inv.sellerName : inv.buyerName)} · ${esc(invDesc(inv, 60))}</span></div>`
            : '<div style="color:var(--error, #f38ba8)">✗ nieprzypisany</div>'}
        </div>
        <div class="adk-actions" style="flex-wrap:wrap">
          <button class="adk-btn primary" id="fdAssign">${inv ? 'Zmień przypisanie' : 'Przypisz do faktury'}</button>
          ${inv ? '<button class="adk-btn" id="fdUnassign">Odepnij</button>' : ''}
          ${!inv ? '<button class="adk-btn" id="fdCreate">Dodaj jako nową fakturę</button>' : ''}
          <button class="adk-btn danger" id="fdDelete">Usuń plik</button>
          <span style="flex:1"></span>
          <button class="adk-btn" id="fdClose">Zamknij (Esc)</button>
        </div>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  const close = () => overlay.remove();
  const rerender = () => renderFilesPage(el, deps);
  overlay.onclick = (e) => { if (e.target === overlay) close(); };
  overlay.querySelector('#fdClose').onclick = close;
  overlay.querySelector('#fdR2')?.addEventListener('click', () => {
    deps.cl.openUrl(r2DashUrl(store.r2Config(company.id), rec.key));
  });
  overlay.querySelector('#fdAssign').onclick = () => {
    close();
    openAssignFileModal(el, deps, company, rec);
  };
  overlay.querySelector('#fdUnassign')?.addEventListener('click', async () => {
    await store.updateFileRec(company.id, rec.id, { invoiceId: '', matchedBy: '' });
    close();
    rerender();
  });
  overlay.querySelector('#fdCreate')?.addEventListener('click', () => {
    close();
    openCreateCostForm(el, deps, company, rec);
  });
  overlay.querySelector('#fdDelete').onclick = async () => {
    if (!confirm(`Usunąć plik ${rec.name} z archiwum?`)) return;
    try {
      await deps.cl.deleteDataFile(rec.key);
      await store.deleteFileRec(company.id, rec.id);
      close();
      rerender();
    } catch (err) {
      deps.cl.log('files: delete failed:', err);
      alert(`Nie udało się usunąć: ${err.message || err}`);
    }
  };
}

const VAT_OPTIONS = [
  ['23', 'VAT 23%'], ['8', 'VAT 8%'], ['5', 'VAT 5%'], ['0', 'VAT 0%'],
  ['zw', 'zwolniona (zw)'], ['np', 'nie podlega (np)'], ['disabled', 'bez rozbicia VAT'],
];

// Creating an invoice record out of a document needs a human glance at the
// extracted fields (currency and VAT above all) — and ends with explicit
// confirmation of what landed where (system + Fakturownia in dual mode)
async function openCreateCostForm(el, deps, company, rec) {
  const { store } = deps;
  rec = await ensureFileExtraction(deps, company, rec);
  const dual = fakturowniaMode(company) === 'dual';
  const defaultVat = rec.vatRate ?? (rec.currency && rec.currency !== 'PLN' ? 'np' : '23');
  const overlay = document.createElement('div');
  overlay.className = 'ksefad-overlay modal-overlay';
  overlay.innerHTML = `
    <div class="ksefad-modal lg" style="width:min(640px, 92vw)">
      <h2 style="margin-bottom:6px">Nowa faktura kosztowa z pliku</h2>
      <div class="ksefad-muted" style="margin-bottom:14px">${esc(rec.name)}${dual ? ' · zostanie też utworzona w Fakturowni' : ''}</div>
      <div class="adk-form">
        <label class="adk-field"><span>Numer dokumentu</span><input id="fcNumber" value="${esc(rec.number || '')}"></label>
        <label class="adk-field"><span>Data wystawienia</span><input id="fcDate" type="date" value="${esc(rec.docDate || `${rec.month || currentMonth()}-01`)}"></label>
        <label class="adk-field"><span>Sprzedawca</span><input id="fcSeller" value="${esc(rec.sellerName || rec.name.replace(/\.(pdf|png|jpe?g)$/i, '').replace(/[_-]+/g, ' '))}"></label>
        <label class="adk-field"><span>NIP sprzedawcy</span><input id="fcNip" value="${esc(rec.nip || '')}" placeholder="polski NIP (cyfry)"></label>
        <label class="adk-field"><span>VAT ID (zagraniczny)</span><input id="fcVatId" value="${esc(rec.vatId || '')}" placeholder="np. IE9692928F"></label>
        <label class="adk-field"><span>Adres — ulica</span><input id="fcAddr1" value="${esc(rec.sellerAddress1 || '')}"></label>
        <label class="adk-field"><span>Kod, miasto, kraj</span><input id="fcAddr2" value="${esc(rec.sellerAddress2 || '')}" placeholder="np. D04 X2K5 Dublin 4, Ireland"></label>
        <label class="adk-field"><span>Kwota brutto</span><input id="fcGross" type="number" step="0.01" value="${rec.gross || ''}"></label>
        <label class="adk-field"><span>Waluta</span>
          <select id="fcCurrency">
            ${['PLN', 'EUR', 'USD', 'GBP', 'CHF'].map((c) => `<option value="${c}" ${c === (rec.currency || 'PLN') ? 'selected' : ''}>${c}</option>`).join('')}
          </select></label>
        <label class="adk-field"><span>Stawka VAT</span>
          <select id="fcVat">
            ${VAT_OPTIONS.map(([v, l]) => `<option value="${v}" ${String(defaultVat) === v ? 'selected' : ''}>${l}</option>`).join('')}
          </select></label>
        <label class="adk-field"><span>Status</span>
          <select id="fcPaid"><option value="">nieopłacona</option><option value="paid">opłacona</option></select></label>
      </div>
      <div class="adk-actions">
        <span class="ksefad-error" id="fcError"></span>
        <span style="flex:1"></span>
        <button class="adk-btn primary" id="fcSave">Utwórz fakturę</button>
        <button class="adk-btn" id="fcCancel">Anuluj</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  const close = () => overlay.remove();
  overlay.onclick = (e) => { if (e.target === overlay) close(); };
  overlay.querySelector('#fcCancel').onclick = close;
  overlay.querySelector('#fcSave').onclick = async () => {
    const val = (id) => overlay.querySelector(id).value.trim();
    const gross = Number(val('#fcGross'));
    const fail = (msg) => { overlay.querySelector('#fcError').textContent = msg; };
    if (!val('#fcSeller')) return fail('Sprzedawca jest wymagany');
    if (!val('#fcDate')) return fail('Data jest wymagana');
    if (!(gross > 0)) return fail('Kwota brutto musi być większa od zera');
    const btn = overlay.querySelector('#fcSave');
    btn.disabled = true;
    btn.textContent = 'Tworzę…';
    const vatSel = val('#fcVat');
    try {
      const { record, fv, fvError } = await createCostFromFile(deps, company, {
        fileId: rec.id,
        number: val('#fcNumber'),
        issueDate: val('#fcDate'),
        sellerName: val('#fcSeller'),
        sellerNip: val('#fcNip'),
        sellerVatId: val('#fcVatId'),
        sellerAddress1: val('#fcAddr1'),
        sellerAddress2: val('#fcAddr2'),
        gross,
        currency: val('#fcCurrency'),
        vatRate: /^\d+$/.test(vatSel) ? Number(vatSel) : vatSel,
        paid: val('#fcPaid') === 'paid',
      });
      await store.updateFileRec(company.id, rec.id, { invoiceId: record.id, matchedBy: 'ręcznie (nowa)' });
      filesView.error = fvError ? `⚠ Faktura ${record.number || ''} dodana do systemu, ale NIE utworzona w Fakturowni: ${fvError}` : '';
      filesView.info = fvError
        ? ''
        : `✓ Dodano fakturę ${record.number || record.id} (${gross.toFixed(2)} ${val('#fcCurrency')}) do systemu${fv ? ` ✓ utworzona w Fakturowni (ID ${fv.id})` : ''}`;
      close();
      renderFilesPage(el, deps);
    } catch (err) {
      deps.cl.log('files: create invoice failed:', err);
      btn.disabled = false;
      btn.textContent = 'Utwórz fakturę';
      fail(`Nie udało się dodać: ${err.message || err}`);
    }
  };
}

function openAssignFileModal(el, deps, company, rec) {
  const { store } = deps;
  let q = rec.number || (rec.gross ? String(rec.gross.toFixed(2)) : '');
  const overlay = document.createElement('div');
  overlay.className = 'ksefad-overlay modal-overlay';
  document.body.appendChild(overlay);
  const close = () => overlay.remove();

  const candidates = () => {
    let pool = store.listInvoices({ companyId: company.id, query: q || undefined, limit: 40 });
    if (!q && rec.gross) {
      pool = store.listInvoices({ companyId: company.id })
        .filter((i) => Math.abs(i.gross - rec.gross) < Math.max(0.015, rec.gross * 0.02))
        .slice(0, 40);
    }
    if (rec.docDate) {
      const anchor = Date.parse(rec.docDate);
      pool.sort((a, b) => Math.abs(Date.parse(a.issueDate) - anchor) - Math.abs(Date.parse(b.issueDate) - anchor));
    }
    return pool;
  };

  const rerenderModal = () => {
    overlay.innerHTML = `
      <div class="ksefad-modal lg" style="width:min(860px, 94vw); max-height:88vh; display:flex; flex-direction:column; gap:12px">
        <h2 style="margin:0">Przypisz plik: <span class="ksefad-muted" style="font-size:.8em">${esc(rec.name)}</span></h2>
        <input id="faQuery" placeholder="szukaj po numerze / kontrahencie / kwocie…" value="${esc(q)}">
        <div style="flex:1; overflow:auto">
          <table class="ksefad-table">
            <thead><tr><th>Numer</th><th>Data</th><th>Kontrahent</th><th>Brutto</th></tr></thead>
            <tbody>
              ${candidates().map((i) => `
                <tr data-pick="${esc(i.id)}" style="cursor:pointer">
                  <td>${esc(i.number || i.ksefNumber || '—')}</td>
                  <td>${esc(i.issueDate)}</td>
                  <td>${esc(i.dir === 'cost' ? i.sellerName : i.buyerName)} <span class="ksefad-muted">${esc(invDesc(i, 40))}</span></td>
                  <td style="text-align:right">${zl(i.gross, i.currency)}</td>
                </tr>`).join('')}
            </tbody>
          </table>
        </div>
        <div class="adk-actions"><span style="flex:1"></span><button class="adk-btn" id="faCancel">Anuluj</button></div>
      </div>`;
    const input = overlay.querySelector('#faQuery');
    input.oninput = (e) => {
      q = e.target.value;
      const caret = e.target.selectionStart;
      rerenderModal();
      const next = overlay.querySelector('#faQuery');
      next.focus();
      next.setSelectionRange(caret, caret);
    };
    overlay.querySelector('#faCancel').onclick = close;
    overlay.querySelectorAll('[data-pick]').forEach((row) => {
      row.onclick = async () => {
        await store.updateFileRec(company.id, rec.id, { invoiceId: row.dataset.pick, matchedBy: 'ręcznie' });
        const inv = store.getInvoice(row.dataset.pick);
        filesView.info = `✓ Przypisano ${rec.name} do faktury ${inv?.number || row.dataset.pick}`;
        close();
        renderFilesPage(el, deps);
      };
    });
  };
  overlay.onclick = (e) => { if (e.target === overlay) close(); };
  rerenderModal();
  overlay.querySelector('#faQuery').focus();
}

export function filesOnKey(e, el, deps) {
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
  const { store } = deps;
  const company = activeCompany(store);
  if (!company) return false;

  if ((e.key === '[' || e.key === ']') && filesView.mode === 'month') {
    filesView.month = monthAdd(filesView.month, e.key === '[' ? -1 : 1);
    filesView.selected = 0;
    renderFilesPage(el, deps);
    return true;
  }
  const list = filesForView(store, company);
  switch (e.key) {
    case '/': el.querySelector('#filesQuery')?.focus(); e.preventDefault(); return true;
    case 'j': filesView.selected = Math.min(filesView.selected + 1, Math.max(0, list.length - 1)); renderFilesPage(el, deps); return true;
    case 'k': filesView.selected = Math.max(filesView.selected - 1, 0); renderFilesPage(el, deps); return true;
    case 'Enter':
      if (list[filesView.selected]) openFileDetail(el, deps, company, list[filesView.selected]);
      return true;
    case 'n': el.querySelector('#filesInput')?.click(); return true;
    default: return false;
  }
}
