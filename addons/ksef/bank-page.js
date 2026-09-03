// UI of the Wyciągi (bank statements) module: pick a month, drop the PDF
// statements, review the automatic invoice matching, assign the leftovers
// by hand (or a category for non-invoice entries) and print the monthly
// report for the accountant.

import { parseStatement, matchTransactions, categorize, counterAccount, buildAccountIndex, scanTaxCalendar } from './bank.js';
import { setPaid, archiveStatementOriginal } from './service.js';
import { fakturowniaMode, createDwInFakturownia } from './fakturownia.js';
import {
  injectStyle, currentMonth, monthAdd, monthLabel, periodBarHtml, bindPeriodBar, periodOf, printDocHtml, invDesc,
  activeCompany, openPdfOverlay,
} from './page.js';

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const money = (n, cur = 'PLN') => `${(Number(n) || 0).toFixed(2)} ${cur}`;

// NKUP: an expense with no invoice at all — the accountant books it as
// "other costs" WITHOUT any tax deduction, so the report must say so
export const NKUP_CATEGORY = 'NKUP — bez odliczenia';
const CATEGORIES = ['opłata bankowa', 'podatek / ZUS', 'przewalutowanie', 'wynagrodzenie', 'odsetki', 'karta / prywatne', NKUP_CATEGORY, 'inne'];

const bankView = {
  query: '',
  mode: 'month',
  month: currentMonth(),
  from: '',
  to: '',
  busy: '',
  error: '',
  info: '',
  show: { ok: true, warn: true, bad: true, in: true, ret: true },
};

// Incoming operations (uznania) are their own visual bucket; the
// settlement column still shows whether they were paired with a sale
function txState(tx) {
  if (tx.refundTxId) return 'ret';
  if (tx.amount > 0) return 'in';
  if (tx.invoiceId) return 'ok';
  return (tx.category || categorize(tx)) ? 'warn' : 'bad';
}

// A cancelled charge and its incoming refund cancel each other out — link
// them both ways so neither side looks like an open item
export async function linkRefund(store, company, charge, refund) {
  const note = (t) => `${t.date} (${t.amount > 0 ? '+' : ''}${t.amount.toFixed(2)} ${t.currency})`;
  await patchTx(store, company, charge, {
    refundTxId: refund.id, refundNote: `zwrot ${note(refund)}`, category: '', invoiceId: '', matchedBy: '', auto: false,
  });
  await patchTx(store, company, refund, {
    refundTxId: charge.id, refundNote: `anulowane obciążenie ${note(charge)}`, category: '', invoiceId: '', matchedBy: '', auto: false,
  });
}

export async function unlinkRefund(store, company, tx) {
  const other = txById(store, company, tx.refundTxId);
  await patchTx(store, company, tx, { refundTxId: '', refundNote: '' });
  if (other) await patchTx(store, company, other, { refundTxId: '', refundNote: '' });
}

function txById(store, company, id) {
  if (!id) return null;
  for (const m of store.bankMonths(company.id)) {
    const hit = store.bankMonth(company.id, m).find((t) => t.id === id);
    if (hit) return hit;
  }
  return null;
}

// Transactions live in buckets keyed by their OWN operation month — the
// picker only selects what is shown, never where an upload lands
function txsForView(store, company) {
  const period = periodOf(bankView);
  const months = store.bankMonths(company.id)
    .filter((m) => (!period.from || m >= period.from.slice(0, 7)) && (!period.to || m <= period.to.slice(0, 7)));
  return months
    .flatMap((m) => store.bankMonth(company.id, m))
    .filter((t) => (!period.from || t.date >= period.from) && (!period.to || t.date <= period.to))
    // seq preserves statement order but restarts every month, so it only
    // orders WITHIN a month — across months the month goes first
    .sort((a, b) => a.account.localeCompare(b.account)
      || a.date.slice(0, 7).localeCompare(b.date.slice(0, 7))
      || (a.seq ?? Number.MAX_SAFE_INTEGER) - (b.seq ?? Number.MAX_SAFE_INTEGER)
      || a.date.localeCompare(b.date));
}

// Assignments in OTHER months must stay off-limits for amount rules —
// without this every month's ZUS transfer lands on the same document
function usedOutsideMonths(store, company, months) {
  const skip = new Set(months);
  const used = new Set();
  for (const m of store.bankMonths(company.id)) {
    if (skip.has(m)) continue;
    for (const t of store.bankMonth(company.id, m)) if (t.invoiceId) used.add(t.invoiceId);
  }
  return used;
}

async function patchTx(store, company, tx, patch) {
  const month = tx.date.slice(0, 7);
  const list = store.bankMonth(company.id, month);
  await store.saveBankMonth(company.id, month, list.map((t) => (t.id === tx.id ? { ...t, ...patch } : t)));
}

// One row per rule for the viewed month: green when the transfer is on the
// statement, yellow when the catch-up landed on a later statement, red when
// missing, muted when the user marked the gap expected. The running month
// only warns softly — its statement isn't complete yet.
function taxAlertsHtml(store, company, month) {
  const txs = store.bankMonth(company.id, month);
  if (!txs.length) return '';
  const byMonth = {};
  for (const mo of store.bankMonths(company.id)) byMonth[mo] = store.bankMonth(company.id, mo);
  const decisions = store.taxAlertState(company.id).decisions || {};
  const inProgress = month === currentMonth();
  const rows = (scanTaxCalendar(byMonth)[month] || []).map((r) => {
    if (r.status === 'found') {
      const hits = r.hits.map((h) => `${h.date.slice(8)}.${h.date.slice(5, 7)} ${money(h.amount)}${h.period ? ` (${h.period})` : ''}`).join(', ');
      return `<span class="ksefad-ok">✓ ${esc(r.label)}</span> <span class="ksefad-muted">${esc(hits)}</span>`;
    }
    if (r.status === 'paid-late') {
      return `<span style="color:var(--warning, #f9e2af)">⏱ ${esc(r.label)}</span> <span class="ksefad-muted">${esc(r.lateNote)}</span>`;
    }
    const decision = decisions[`${month}:${r.id}`];
    if (decision) {
      return `<span class="ksefad-muted">◦ ${esc(r.label)}: brak — przewidywane${decision.note ? ` (${esc(decision.note)})` : ''}
        <button class="ksefad-btn" data-taxundo="${esc(r.id)}" title="Cofnij — to jednak alert">cofnij</button></span>`;
    }
    if (inProgress) {
      return `<span class="ksefad-muted">… ${esc(r.label)}: jeszcze brak <span title="${esc(r.hint)}">(${esc(r.hint)})</span></span>`;
    }
    return `<span style="color:var(--error, #f38ba8)">✗ ${esc(r.label)}: BRAK</span>
      <span class="ksefad-muted">(${esc(r.hint)})</span>
      <button class="ksefad-btn" data-taxok="${esc(r.id)}" title="Brak tej płatności w tym miesiącu jest OK — nie alarmuj">przewidywane</button>`;
  });
  return `<div class="ksefad-bar" style="gap:18px; padding:6px 10px; border:1px solid var(--border, #333); border-radius:6px; align-items:center">
    <span title="Płatności podatkowe, które powinny być na każdym miesięcznym wyciągu">💰 Podatki ${esc(monthLabel(month))}${inProgress ? ' <span class="ksefad-muted">(w toku)</span>' : ''}:</span>
    ${rows.join('<span class="ksefad-muted">·</span>')}
  </div>`;
}

function fmtAccount(acc) {
  return String(acc || '').replace(/(\d{2})(?=(\d{4})+$)/, '$1 ').replace(/(\d{4})(?=\d)/g, '$1 ');
}

function invoiceLabel(store, id) {
  const inv = id ? store.getInvoice(id) : null;
  if (!inv) return '';
  return `${inv.number || inv.ksefNumber} · ${money(inv.gross, inv.currency)} · ${inv.dir === 'cost' ? inv.sellerName : inv.buyerName}`;
}

export function bankOnKey(e, el, deps) {
  if (e.metaKey || e.ctrlKey || e.altKey) return false;
  if (document.querySelector('.ksefad-overlay')) return false;
  const tag = document.activeElement?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return false;
  if (e.key === '/') {
    el.querySelector('#bankQuery')?.focus();
    e.preventDefault();
    return true;
  }
  if ((e.key === '[' || e.key === ']') && bankView.mode === 'month') {
    bankView.month = monthAdd(bankView.month, e.key === '[' ? -1 : 1);
    renderBankPage(el, deps);
    return true;
  }
  return false;
}

export function renderBankPage(el, deps) {
  injectStyle();
  const { store } = deps;
  const companies = store.companies();
  if (!companies.length) {
    el.innerHTML = '<div class="ksefad"><h2>🏦 Wyciągi bankowe</h2><p>Najpierw dodaj firmę w Ustawieniach → Addons → KSeF.</p></div>';
    return;
  }
  const company = activeCompany(store);
  const txs = company ? txsForView(store, company) : [];
  // Free-text search sweeps every column the table shows: dates, type,
  // description, amounts, account, category and the paired invoice
  const q = bankView.query.trim().toLowerCase();
  const matchesQuery = (t) => !q || [
    t.date, t.valueDate, t.type, t.desc, t.account, t.currency,
    String(t.amount), t.amount.toFixed(2), t.amount.toFixed(2).replace('.', ','),
    t.category || categorize(t), t.matchedBy,
    t.invoiceId ? invoiceLabel(store, t.invoiceId) : '',
    txClient(t),
  ].some((v) => String(v || '').toLowerCase().includes(q));
  const acctIndex = company ? buildAccountIndex(store.clientAccounts(company.id)) : new Map();
  const txClient = (t) => acctIndex.get(counterAccount(t.desc))?.name || '';
  const txFileMap = company ? store.fileByInvoice(company.id) : new Map();
  const invIndex = company ? new Map(store.listInvoices({ companyId: company.id }).map((i) => [i.id, i])) : new Map();
  const shown = txs.filter((t) => bankView.show[txState(t)] && matchesQuery(t));
  // No paging on purpose (desktop app, a few thousand rows render fine) —
  // the cap only guards against an unbounded future archive
  const RENDER_CAP = 2500;
  let budget = RENDER_CAP;
  const byAccount = new Map();
  for (const tx of shown) {
    if (budget <= 0) break;
    budget--;
    const key = `${tx.account}|${tx.currency}`;
    if (!byAccount.has(key)) byAccount.set(key, []);
    byAccount.get(key).push(tx);
  }
  const counts = { ok: 0, warn: 0, bad: 0, in: 0, ret: 0 };
  for (const t of txs) counts[txState(t)]++;
  const { ok: matched, warn: categorized, bad: open, in: incoming, ret: refunded } = counts;
  const months = company ? store.bankMonths(company.id) : [];

  el.innerHTML = `
    <div class="ksefad">
      <div class="ksefad-bar">
        <h2 style="margin:0; font-size:17px">🏦 Wyciągi bankowe</h2>
        ${bankView.mode === 'all' ? '' : periodBarHtml(bankView)}
        <label class="ksefad-muted" style="white-space:nowrap"><input type="checkbox" id="bankAllTime" ${bankView.mode === 'all' ? 'checked' : ''}> wszystko</label>
        <input id="bankQuery" placeholder="szukaj… (/)" value="${esc(bankView.query)}" style="flex:1; min-width:110px">
        <input type="file" id="bankFiles" multiple accept=".pdf" style="display:none">
        <button class="ksefad-btn primary" id="bankUpload" ${bankView.busy ? 'disabled' : ''}>${bankView.busy === 'parse' ? 'Analizuję…' : '+ Wgraj wyciągi (PDF)'}</button>
        <span style="flex:1"></span>
        ${txs.length ? `
          <button class="ksefad-btn" id="bankRematch">Dopasuj ponownie</button>
          <button class="ksefad-btn" id="bankMarkPaid">Oznacz dopasowane jako zapłacone</button>
          <select id="bankReportMode" title="Lokalny: raport i załącznik otwierają się na tym komputerze. Email: wysyłka do księgowej z załącznikami (raport PDF, faktury spoza KSeF, oryginalne wyciągi).">
            <option value="local" ${bankView.reportMode !== 'email' ? 'selected' : ''}>Lokalny</option>
            <option value="email" ${bankView.reportMode === 'email' ? 'selected' : ''}>Email</option>
          </select>
          <button class="ksefad-btn primary" id="bankReport">Raport dla księgowej</button>` : ''}
      </div>
      ${bankView.error ? `<div class="ksefad-error">${esc(bankView.error)}</div>` : ''}
      ${bankView.info ? `<div class="ksefad-muted">${esc(bankView.info)}</div>` : ''}
      ${company && bankView.mode === 'month' ? taxAlertsHtml(store, company, bankView.month) : ''}
      ${txs.length ? `
        <div class="ksefad-bar ksefad-muted" style="gap:16px">
          <span>${txs.length} operacji, pokazuję ${Math.min(shown.length, RENDER_CAP)}${shown.length > RENDER_CAP ? ` z ${shown.length} — zawęź szukajką` : ''}:</span>
          <label style="color:var(--success, #a6e3a1)"><input type="checkbox" data-show="ok" ${bankView.show.ok ? 'checked' : ''}> przypisane (${matched})</label>
          <label style="color:var(--warning, #f9e2af)"><input type="checkbox" data-show="warn" ${bankView.show.warn ? 'checked' : ''}> opłaty / kategorie (${categorized})</label>
          <label style="color:var(--error, #f38ba8)"><input type="checkbox" data-show="bad" ${bankView.show.bad ? 'checked' : ''}> nieprzypisane (${open})</label>
          <label style="color:#94e2d5"><input type="checkbox" data-show="in" ${bankView.show.in ? 'checked' : ''}> uznania (${incoming})</label>
          <label style="color:#b4befe"><input type="checkbox" data-show="ret" ${bankView.show.ret ? 'checked' : ''}> zwroty / anulowane (${refunded})</label>
        </div>` : ''}
      <div class="ksefad-scroll">
        ${[...byAccount.entries()].map(([key, list]) => {
          const [account, currency] = key.split('|');
          return `
          <h3 style="margin:14px 0 6px">${esc(list[0].bank || 'Bank')} · ${esc(fmtAccount(account))} <span class="ksefad-muted">(${esc(currency)})</span></h3>
          <table class="ksefad-table">
            <thead><tr><th>Data</th><th>Typ</th><th>Opis</th><th style="text-align:right">Kwota</th><th>Klient</th><th>Faktura / kategoria</th><th>Plik</th><th title="faktura przyszła z KSeF — plik PDF nie istnieje, bo dokument jest elektroniczny">KSeF</th></tr></thead>
            <tbody>
              ${list.map((tx) => `
                <tr data-tx="${esc(tx.id)}" class="ksefad-row-${txState(tx)}">
                  <td style="white-space:nowrap">${esc(tx.date)}</td>
                  <td>${esc(tx.type)}</td>
                  <td title="${esc(tx.desc)}">${esc(tx.desc.length > 80 ? `${tx.desc.slice(0, 80)}…` : tx.desc)}</td>
                  <td style="text-align:right; white-space:nowrap; color:${tx.amount < 0 ? 'var(--error, #f38ba8)' : 'var(--success, #a6e3a1)'}">${money(tx.amount, currency)}</td>
                  <td style="white-space:nowrap">${txClient(tx) ? `👤 ${esc(txClient(tx))}` : '<span class="ksefad-muted">—</span>'}</td>
                  <td>
                    ${tx.refundTxId
                      ? `<span style="color:#b4befe">↩ ${tx.amount < 0 ? 'anulowane' : 'zwrot'}</span>
                         <span class="ksefad-muted">${esc(tx.refundNote || '')}</span>
                         <button class="ksefad-btn" data-unlink-ret="${esc(tx.id)}" title="Rozłącz parę zwrotu">×</button>`
                      : tx.invoiceId
                        ? `<span class="ksefad-ok">✓</span> ${esc(invoiceLabel(store, tx.invoiceId))}
                           <span class="ksefad-muted">(${esc(tx.matchedBy || 'ręcznie')})</span>
                           <button class="ksefad-btn" data-unassign="${esc(tx.id)}" title="Odepnij">×</button>`
                        : `<button class="ksefad-btn" data-assign="${esc(tx.id)}">Przypisz fakturę</button>
                           <select data-category="${esc(tx.id)}">
                             <option value="">— kategoria —</option>
                             ${CATEGORIES.map((c) => `<option ${tx.category === c ? 'selected' : ''}>${c}</option>`).join('')}
                           </select>`}
                  </td>
                  <td style="text-align:center">${tx.invoiceId && txFileMap.has(tx.invoiceId)
                    ? `<button class="ksefad-btn" data-txfile="${esc(tx.invoiceId)}" title="podgląd pliku faktury">📄</button>`
                    : '<span class="ksefad-muted">—</span>'}</td>
                  <td style="text-align:center">${(() => {
                    const inv = tx.invoiceId ? invIndex.get(tx.invoiceId) : null;
                    if (!inv) return '<span class="ksefad-muted">—</span>';
                    return inv.ksefNumber
                      ? `<span class="ksefad-ok" title="${esc(inv.ksefNumber)}">✓</span>`
                      : '<span class="ksefad-muted">—</span>';
                  })()}</td>
                </tr>`).join('')}
            </tbody>
          </table>`;
        }).join('')
        || `<p class="ksefad-muted" style="padding:14px">${txs.length
          ? 'Wszystkie operacje odfiltrowane — zaznacz któryś z checkboxów powyżej.'
          : `Brak operacji w tym okresie. Wgraj pliki PDF z wyciągami (iPKO Biznes) — trafią do miesięcy wynikających z dat operacji${months.length ? `; zapisane miesiące: ${months.join(', ')}` : ''}.`}</p>`}
      </div>
      <div class="ksefad-muted">[/]: miesiąc · klik w wiersz: szczegóły operacji</div>
    </div>`;

  const rerender = () => renderBankPage(el, deps);
  bindPeriodBar(el, bankView, rerender);
  el.querySelectorAll('[data-taxok]').forEach((btn) => {
    btn.onclick = async () => {
      await store.setTaxAlertDecision(company.id, bankView.month, btn.dataset.taxok,
        { expected: true, note: '', at: new Date().toISOString() });
      rerender();
    };
  });
  el.querySelectorAll('[data-taxundo]').forEach((btn) => {
    btn.onclick = async () => {
      await store.setTaxAlertDecision(company.id, bankView.month, btn.dataset.taxundo, null);
      rerender();
    };
  });
  el.querySelectorAll('[data-show]').forEach((cb) => {
    cb.onchange = () => { bankView.show[cb.dataset.show] = cb.checked; rerender(); };
  });
  el.querySelector('#bankAllTime').onchange = (e) => {
    if (e.target.checked) {
      bankView.prevMode = bankView.mode;
      bankView.mode = 'all';
    } else {
      bankView.mode = bankView.prevMode === 'all' ? 'month' : (bankView.prevMode || 'month');
    }
    rerender();
  };
  const query = el.querySelector('#bankQuery');
  // Re-rendering replaces the input the user is typing into, so focus and
  // caret have to be put back or only the first keystroke ever lands
  query.oninput = (e) => {
    bankView.query = e.target.value;
    const caret = e.target.selectionStart;
    rerender();
    const next = el.querySelector('#bankQuery');
    next.focus();
    next.setSelectionRange(caret, caret);
  };
  el.querySelector('#bankUpload').onclick = () => el.querySelector('#bankFiles').click();
  el.querySelector('#bankFiles').onchange = (e) => ingestFiles(el, deps, company, e.target.files);
  el.querySelector('#bankRematch')?.addEventListener('click', async () => {
    const invoices = store.listInvoices({ companyId: company.id });
    const cleared = matchTransactions(
      txs.map((t) => (t.auto ? { ...t, invoiceId: '', matchedBy: '', category: '' } : t)),
      invoices,
      {
        accounts: store.clientAccounts(company.id),
        usedInvoiceIds: usedOutsideMonths(store, company, new Set(txs.map((t) => t.date.slice(0, 7)))),
      },
    );
    for (const t of cleared) await patchTx(store, company, t, t);
    rerender();
  });
  el.querySelector('#bankMarkPaid')?.addEventListener('click', async (e) => {
    e.target.disabled = true;
    let n = 0;
    for (const tx of txs) {
      if (!tx.invoiceId) continue;
      const inv = store.getInvoice(tx.invoiceId);
      if (inv && !inv.paid && inv.dir === 'cost') {
        try {
          await setPaid(deps, company, inv.id, true, tx.date);
          n++;
        } catch (err) {
          deps.cl.log('bank mark paid failed:', err);
          bankView.error = `${inv.number}: ${err.message || err}`;
        }
      }
    }
    bankView.info = `Oznaczono ${n} faktur kosztowych jako zapłacone.`;
    rerender();
  });
  el.querySelector('#bankReportMode')?.addEventListener('change', (e) => {
    bankView.reportMode = e.target.value;
  });
  el.querySelector('#bankReport')?.addEventListener('click', async () => {
    await printReport(deps, company,
      bankView.mode === 'month' ? monthLabel(bankView.month)
        : bankView.mode === 'all' ? 'cała historia'
          : `${bankView.from} — ${bankView.to}`, txs, bankView.reportMode || 'local');
    rerender();
  });
  el.querySelectorAll('[data-tx]').forEach((row) => {
    row.onclick = (e) => {
      if (e.target.closest('button, select')) return;
      openTxDetail(el, deps, company, txs.find((t) => t.id === row.dataset.tx));
    };
  });
  el.querySelectorAll('[data-assign]').forEach((btn) => {
    btn.onclick = () => openAssignModal(el, deps, company, txs.find((t) => t.id === btn.dataset.assign));
  });
  el.querySelectorAll('[data-unlink-ret]').forEach((btn) => {
    btn.onclick = async () => {
      const tx = txs.find((t) => t.id === btn.dataset.unlinkRet);
      if (tx) await unlinkRefund(store, company, tx);
      rerender();
    };
  });
  el.querySelectorAll('[data-txfile]').forEach((btn) => {
    btn.onclick = () => {
      const rec = txFileMap.get(btn.dataset.txfile);
      if (rec) openPdfOverlay(deps, rec);
    };
  });
  el.querySelectorAll('[data-unassign]').forEach((btn) => {
    btn.onclick = async () => {
      const tx = txs.find((t) => t.id === btn.dataset.unassign);
      if (tx) await patchTx(store, company, tx, { invoiceId: '', matchedBy: '', auto: false });
      rerender();
    };
  });
  el.querySelectorAll('[data-category]').forEach((sel) => {
    sel.onchange = async () => {
      const tx = txs.find((t) => t.id === sel.dataset.category);
      if (!tx) return;
      // In dual mode a payroll/tax categorization becomes a Fakturownia
      // DW document, so their expense reports stay complete
      if (DW_CATEGORIES.includes(sel.value) && fakturowniaMode(company) === 'dual') {
        openDwModal(el, deps, company, tx, sel.value, txClient(tx));
        return;
      }
      await patchTx(store, company, tx, { category: sel.value, auto: false });
      rerender();
    };
  });
}

const DW_CATEGORIES = ['wynagrodzenie', 'podatek / ZUS'];

function dwCounterpartyGuess(tx, clientName) {
  if (clientName) return clientName;
  const d = `${tx.type} ${tx.desc}`.toUpperCase();
  if (/ZUS|UBEZPIECZE/.test(d)) return 'Zakład Ubezpieczeń Społecznych';
  if (/URZAD SKARBOWY|US URZAD|PODATEK|VAT-7|PIT|CIT/.test(d)) return 'Urząd Skarbowy';
  return '';
}

function openDwModal(el, deps, company, tx, category, clientName) {
  const { store } = deps;
  const monthLbl = tx.date.slice(0, 7).split('-').reverse().join('/');
  const defaultPos = category === 'wynagrodzenie'
    ? `Wynagrodzenie ${monthLbl}`
    : `Podatek / ZUS ${monthLbl}`;
  const overlay = document.createElement('div');
  overlay.className = 'ksefad-overlay modal-overlay';
  overlay.innerHTML = `
    <div class="ksefad-modal lg" style="width:min(560px, 92vw)">
      <h2 style="margin-bottom:6px">Dowód wewnętrzny w Fakturowni</h2>
      <div class="ksefad-muted" style="margin-bottom:14px">Operacja ${esc(tx.date)} · ${money(tx.amount, tx.currency)} —
        kategoria „${esc(category)}" utworzy DW w Fakturowni i sparuje go z tą operacją.</div>
      <div class="adk-form">
        <label class="adk-field"><span>Kontrahent</span><input id="dwWho" value="${esc(dwCounterpartyGuess(tx, clientName))}"></label>
        <label class="adk-field"><span>Nazwa pozycji</span><input id="dwPos" value="${esc(defaultPos)}"></label>
        <label class="adk-field"><span>Kwota</span><input value="${Math.abs(tx.amount).toFixed(2)} ${esc(tx.currency)}" disabled></label>
        <label class="adk-field"><span>Data (z operacji)</span><input value="${esc(tx.date)}" disabled></label>
      </div>
      <div class="adk-actions">
        <span class="ksefad-error" id="dwError"></span>
        <span style="flex:1"></span>
        <button class="adk-btn primary" id="dwCreate">Utwórz DW i sparuj</button>
        <button class="adk-btn" id="dwOnlyCat">Tylko kategoria (bez DW)</button>
        <button class="adk-btn" id="dwCancel">Anuluj</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  const close = () => overlay.remove();
  overlay.onclick = (e) => { if (e.target === overlay) close(); };
  overlay.querySelector('#dwCancel').onclick = () => { close(); renderBankPage(el, deps); };
  overlay.querySelector('#dwOnlyCat').onclick = async () => {
    await patchTx(store, company, tx, { category, auto: false });
    close();
    renderBankPage(el, deps);
  };
  overlay.querySelector('#dwCreate').onclick = async () => {
    const who = overlay.querySelector('#dwWho').value.trim();
    if (!who) {
      overlay.querySelector('#dwError').textContent = 'Kontrahent jest wymagany';
      return;
    }
    const btn = overlay.querySelector('#dwCreate');
    btn.disabled = true;
    btn.textContent = 'Tworzę…';
    try {
      const doc = await createDwInFakturownia(deps, company, {
        issueDate: tx.date,
        paidDate: tx.date,
        currency: tx.currency,
        counterparty: who,
        gross: Math.abs(tx.amount),
        positionName: overlay.querySelector('#dwPos').value.trim() || defaultPos,
      });
      // Same identity the Fakturownia import uses, so the next sync merges
      // instead of duplicating
      const record = {
        id: `fv:${company.id}:${doc.id}`,
        src: 'fakturownia',
        dir: 'cost',
        kind: 'dw',
        number: doc.number || '',
        fvId: doc.id,
        issueDate: tx.date,
        sellerNip: '',
        sellerName: who,
        buyerNip: company.nip,
        buyerName: company.name,
        net: Math.abs(tx.amount),
        vat: 0,
        gross: Math.abs(tx.amount),
        currency: tx.currency,
        paid: true,
        paidDate: tx.date,
      };
      await store.upsertInvoices(company.id, [record]);
      await patchTx(store, company, tx, {
        invoiceId: record.id,
        matchedBy: `DW ${doc.number || doc.id} (z wyciągu)`,
        category: '',
        auto: false,
      });
      bankView.info = `✓ Utworzono ${doc.number || `DW #${doc.id}`} w Fakturowni (${who}, ${money(Math.abs(tx.amount), tx.currency)}) i sparowano z operacją ${tx.date}.`;
      bankView.error = '';
      close();
      renderBankPage(el, deps);
    } catch (err) {
      deps.cl.log('DW create failed:', err);
      btn.disabled = false;
      btn.textContent = 'Utwórz DW i sparuj';
      overlay.querySelector('#dwError').textContent = `Fakturownia odrzuciła: ${err.message || err}`;
    }
  };
}

async function ingestFiles(el, deps, company, files) {
  const { store, cl } = deps;
  if (!company) {
    bankView.error = 'Wybierz firmę.';
    renderBankPage(el, deps);
    return;
  }
  bankView.busy = 'parse';
  bankView.error = '';
  bankView.info = '';
  renderBankPage(el, deps);
  try {
    const accountsSeen = new Set();
    let parsed = [];
    for (const file of files) {
      const buf = new Uint8Array(await file.arrayBuffer());
      let bin = '';
      for (let i = 0; i < buf.length; i += 0x8000) {
        bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
      }
      const b64 = btoa(bin);
      const st = parseStatement(await cl.pdfText(b64));
      accountsSeen.add(st.account);
      parsed.push(...st.txs.map((t) => ({
        ...t, account: st.account, currency: st.currency, bank: st.bank, stmtPeriod: st.period, stmtNo: st.stmtNo,
      })));
      // The original statement PDF goes to the archive (and later to the
      // R2 mirror) — the accountant email attaches it from here
      try {
        await archiveStatementOriginal(deps, company, b64, file.name, st);
      } catch (err) {
        cl.log('statement original archive failed:', err);
      }
    }
    const invoices = store.listInvoices({ companyId: company.id });
    // Every operation lands in the bucket of its own month; re-uploading a
    // statement replaces that account's rows in the affected months but
    // keeps other accounts and every manual assignment made before
    const byMonth = new Map();
    for (const t of parsed) {
      const m = t.date.slice(0, 7);
      if (!byMonth.has(m)) byMonth.set(m, []);
      byMonth.get(m).push(t);
    }
    for (const [month, list] of byMonth) {
      const existing = store.bankMonth(company.id, month);
      const keepManual = new Map(existing.filter((t) => t.invoiceId || t.category).map((t) => [t.id, t]));
      const kept = existing.filter((t) => !accountsSeen.has(t.account));
      const merged = list.map((t) => {
        const old = keepManual.get(t.id);
        return old ? { ...t, invoiceId: old.invoiceId, matchedBy: old.matchedBy, category: old.category, auto: old.auto } : t;
      });
      await store.saveBankMonth(company.id, month,
        [...kept, ...matchTransactions(merged, invoices, { accounts: store.clientAccounts(company.id), usedInvoiceIds: usedOutsideMonths(store, company, [month]) })]
          .sort((a, b) => a.account.localeCompare(b.account)
            || (a.seq ?? 0) - (b.seq ?? 0)
            || a.date.localeCompare(b.date)));
    }
    // Jump the view to where the data actually went
    const monthsTouched = [...byMonth.keys()].sort();
    if (monthsTouched.length) {
      bankView.mode = 'month';
      bankView.month = monthsTouched[0];
    }
    bankView.info = `Wczytano ${files.length} plik(i): ${parsed.length} operacji z ${accountsSeen.size} kont → ${monthsTouched.map(monthLabel).join(', ') || 'brak operacji'}.`;
  } catch (err) {
    deps.cl.log('bank ingest failed:', err);
    bankView.error = String(err.message || err);
  }
  bankView.busy = '';
  renderBankPage(el, deps);
}

function openAssignModal(el, deps, company, tx) {
  if (!tx) return;
  const { store } = deps;
  const dir = tx.amount < 0 ? 'cost' : 'sale';
  const overlay = document.createElement('div');
  overlay.className = 'ksefad-overlay modal-overlay';
  const candidates = () => {
    const q = overlay.querySelector('#bankAssignQuery').value.toLowerCase();
    return store.listInvoices({ companyId: company.id, dir, query: q || undefined })
      .sort((a, b) => Math.abs(a.gross - Math.abs(tx.amount)) - Math.abs(b.gross - Math.abs(tx.amount)))
      .slice(0, 25);
  };
  overlay.innerHTML = `
    <div class="ksefad-modal lg" style="width:min(760px, 92vw)">
      <h2 style="margin-bottom:8px">Przypisz fakturę</h2>
      <div class="ksefad-muted" style="margin-bottom:12px">${esc(tx.date)} · ${money(tx.amount, tx.currency)} · ${esc(tx.desc.slice(0, 110))}</div>
      <input id="bankAssignQuery" placeholder="szukaj po numerze / kontrahencie…" style="width:100%; margin-bottom:10px">
      <div id="bankAssignList" class="ksefad-scroll" style="max-height:46vh"></div>
      <div class="adk-actions"><span style="flex:1"></span><button class="adk-btn" id="bankAssignCancel">Anuluj</button></div>
    </div>`;
  document.body.appendChild(overlay);
  const close = () => overlay.remove();
  overlay.onclick = (e) => { if (e.target === overlay) close(); };
  overlay.querySelector('#bankAssignCancel').onclick = close;
  const renderList = () => {
    overlay.querySelector('#bankAssignList').innerHTML = `
      <table class="ksefad-table"><tbody>
        ${candidates().map((inv) => `
          <tr data-pick="${esc(inv.id)}">
            <td>${esc(inv.number || inv.ksefNumber || '—')}</td>
            <td>${esc(inv.issueDate)}</td>
            <td>${esc(dir === 'cost' ? inv.sellerName : inv.buyerName)}
              ${inv.lines?.length ? `<div class="ksefad-muted" style="font-size:.9em">${esc(invDesc(inv, 55))}</div>` : ''}</td>
            <td style="text-align:right">${money(inv.gross, inv.currency)}</td>
          </tr>`).join('') || '<tr><td class="ksefad-muted">Brak faktur.</td></tr>'}
      </tbody></table>`;
    overlay.querySelectorAll('[data-pick]').forEach((row) => {
      row.onclick = async () => {
        await patchTx(store, company, tx, { invoiceId: row.dataset.pick, matchedBy: '', category: '', auto: false });
        close();
        renderBankPage(el, deps);
      };
    });
  };
  overlay.querySelector('#bankAssignQuery').oninput = renderList;
  renderList();
  overlay.querySelector('#bankAssignQuery').focus();
}

// Full-detail popup for one statement operation, with the assignment
// actions available from the row inline controls too
function openTxDetail(el, deps, company, tx) {
  if (!tx) return;
  const { store } = deps;
  const inv = tx.invoiceId ? store.getInvoice(tx.invoiceId) : null;
  const overlay = document.createElement('div');
  overlay.className = 'ksefad-overlay modal-overlay';
  overlay.innerHTML = `
    <div class="ksefad-modal lg" style="width:min(720px, 92vw)">
      <div class="ksefad-doc-head">
        <h2>${esc(tx.type)}</h2>
        <div class="ksefad-doc-dates">
          <div><span>Data operacji</span><b>${esc(tx.date)}</b></div>
          <div><span>Kwota</span><b style="color:${tx.amount < 0 ? 'var(--error, #f38ba8)' : 'var(--success, #a6e3a1)'}">${money(tx.amount, tx.currency)}</b></div>
        </div>
      </div>
      <div class="adk-kv" style="margin-bottom:14px">
        <div><b>Rachunek:</b> ${esc(fmtAccount(tx.account))} (${esc(tx.currency)}) · ${esc(tx.bank || '')}</div>
        <div><b>Identyfikator operacji:</b> ${esc(tx.id)}</div>
        <div><b>Pełny opis:</b></div>
        <div style="white-space:pre-wrap; background:var(--bg-surface, #313244); border-radius:8px; padding:10px 12px">${esc(tx.desc)}</div>
        ${tx.refundTxId ? `
          <div style="margin-top:6px"><b>Para zwrotu:</b> <span style="color:#b4befe">↩ ${tx.amount < 0 ? 'anulowane' : 'zwrot'}</span>
            <span class="adk-muted">${esc(tx.refundNote || '')}</span></div>` : ''}
        ${inv ? `
          <div style="margin-top:6px"><b>Przypisana faktura:</b> ${esc(inv.number || inv.ksefNumber)}
            <span class="adk-muted">(${esc(tx.matchedBy || 'ręcznie')})</span></div>
          <div class="adk-muted">${esc(inv.dir === 'cost' ? inv.sellerName : inv.buyerName)} · ${money(inv.gross, inv.currency)}
            · ${inv.paid ? 'opłacona' : 'nieopłacona'}${inv.ksefNumber ? ` · KSeF ${esc(inv.ksefNumber)}` : ''}</div>
          ${inv.lines?.length ? `<div class="adk-muted">${esc(invDesc(inv, 90))}</div>` : ''}`
        : tx.refundTxId ? ''
        : `<div style="margin-top:6px"><b>Faktura:</b> <span class="ksefad-no">brak przypisania</span>
            ${tx.category ? `· kategoria: <b>${esc(tx.category)}</b>` : ''}</div>`}
      </div>
      <div class="adk-actions">
        ${inv && /do weryfikacji/.test(tx.matchedBy || '') ? '<button class="adk-btn primary" id="txVerify">✓ Zweryfikuj przypisanie</button>' : ''}
        ${tx.refundTxId ? '<button class="adk-btn" id="txUnlinkRet">Rozłącz parę zwrotu</button>' : ''}
        ${inv ? `<button class="adk-btn" id="txUnassign">Odepnij fakturę</button>`
          : tx.refundTxId ? '' : `<button class="adk-btn primary" id="txAssign">Przypisz fakturę</button>`}
        ${!inv && !tx.refundTxId ? '<button class="adk-btn" id="txLinkRet">↩ Powiąż ze zwrotem</button>' : ''}
        ${!inv && tx.amount < 0 && fakturowniaMode(company) === 'dual' ? '<button class="adk-btn" id="txMakeDw">Utwórz DW w Fakturowni…</button>' : ''}
        <span style="flex:1"></span>
        <button class="adk-btn" id="txClose">Zamknij (Esc)</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  const close = () => overlay.remove();
  overlay.onclick = (e) => { if (e.target === overlay) close(); };
  overlay.querySelector('#txClose').onclick = close;
  overlay.querySelector('#txAssign')?.addEventListener('click', () => {
    close();
    openAssignModal(el, deps, company, tx);
  });
  overlay.querySelector('#txMakeDw')?.addEventListener('click', () => {
    close();
    const clientName = buildAccountIndex(store.clientAccounts(company.id)).get(counterAccount(tx.desc))?.name || '';
    openDwModal(el, deps, company, tx, tx.category || 'wynagrodzenie', clientName);
  });
  // Confirming turns the tentative auto-match into a manual-grade one, so
  // "Dopasuj ponownie" will never move it again
  overlay.querySelector('#txVerify')?.addEventListener('click', async () => {
    const verified = `${(tx.matchedBy || '').replace(/\s*\(do weryfikacji\)/, '')} (zweryfikowane)`;
    await patchTx(store, company, tx, { matchedBy: verified, auto: false });
    close();
    renderBankPage(el, deps);
  });
  overlay.querySelector('#txUnassign')?.addEventListener('click', async () => {
    await patchTx(store, company, tx, { invoiceId: '', matchedBy: '', auto: false });
    close();
    renderBankPage(el, deps);
  });
  overlay.querySelector('#txUnlinkRet')?.addEventListener('click', async () => {
    await unlinkRefund(store, company, tx);
    close();
    renderBankPage(el, deps);
  });
  overlay.querySelector('#txLinkRet')?.addEventListener('click', () => {
    close();
    openLinkRefundModal(el, deps, company, tx);
  });
}

// Candidates for the other half of a refund pair: opposite sign, same
// absolute amount, within 90 days, not spoken for yet
function openLinkRefundModal(el, deps, company, tx) {
  const { store } = deps;
  const anchor = Date.parse(tx.date);
  const candidates = store.bankMonths(company.id)
    .flatMap((m) => store.bankMonth(company.id, m))
    .filter((t) => t.id !== tx.id
      && Math.sign(t.amount) === -Math.sign(tx.amount)
      && Math.abs(Math.abs(t.amount) - Math.abs(tx.amount)) < 0.015
      && !t.refundTxId && !t.invoiceId
      && Math.abs(Date.parse(t.date) - anchor) <= 90 * 86400e3)
    .sort((a, b) => Math.abs(Date.parse(a.date) - anchor) - Math.abs(Date.parse(b.date) - anchor));
  const overlay = document.createElement('div');
  overlay.className = 'ksefad-overlay modal-overlay';
  overlay.innerHTML = `
    <div class="ksefad-modal lg" style="width:min(760px, 92vw)">
      <h2 style="margin-bottom:6px">↩ Powiąż ze zwrotem</h2>
      <div class="ksefad-muted" style="margin-bottom:12px">${esc(tx.date)} · ${money(tx.amount, tx.currency)} · ${esc(tx.desc.slice(0, 90))}</div>
      ${candidates.length ? `
        <table class="ksefad-table">
          <thead><tr><th>Data</th><th>Kwota</th><th>Opis</th></tr></thead>
          <tbody>
            ${candidates.map((t) => `
              <tr data-pick-ret="${esc(t.id)}" style="cursor:pointer">
                <td style="white-space:nowrap">${esc(t.date)}</td>
                <td style="white-space:nowrap">${money(t.amount, t.currency)}</td>
                <td>${esc(t.desc.slice(0, 80))}</td>
              </tr>`).join('')}
          </tbody>
        </table>`
    : '<p class="ksefad-muted">Brak operacji o przeciwnej kwocie w ±90 dni.</p>'}
      <div class="adk-actions"><span style="flex:1"></span><button class="adk-btn" id="lrCancel">Anuluj</button></div>
    </div>`;
  document.body.appendChild(overlay);
  const close = () => overlay.remove();
  overlay.onclick = (e) => { if (e.target === overlay) close(); };
  overlay.querySelector('#lrCancel').onclick = close;
  overlay.querySelectorAll('[data-pick-ret]').forEach((row) => {
    row.onclick = async () => {
      const other = candidates.find((t) => t.id === row.dataset.pickRet);
      const charge = tx.amount < 0 ? tx : other;
      const refund = tx.amount < 0 ? other : tx;
      await linkRefund(store, company, charge, refund);
      close();
      renderBankPage(el, deps);
    };
  });
}

// The accountant report mirrors the source statement 1:1 — same order,
// same per-operation fields (both dates, operation id, amount, running
// balance) — so the original can be laid next to it. One template per
// bank; new banks add a parser in bank.js and a template here.
const plMoney = (n) => (Number(n) || 0).toLocaleString('pl-PL', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function txStatus(store, tx) {
  if (tx.refundTxId) {
    return {
      color: '#e2e5f7',
      label: tx.amount < 0
        ? `<b>ANULOWANE</b><br><span style="color:#555">${esc(tx.refundNote || 'zwrócone')}</span>`
        : `<b>ZWROT</b><br><span style="color:#555">${esc(tx.refundNote || 'za anulowane obciążenie')}</span>`,
      ksef: '',
    };
  }
  if (tx.category === NKUP_CATEGORY) {
    return {
      color: '#fde8d7',
      label: '<b>KOSZT BEZ FAKTURY — NKUP</b><br><span style="color:#555">zaksięgować w koszty inne, bez odliczenia podatku (faktura nie istnieje)</span>',
      ksef: '',
    };
  }
  if (tx.invoiceId) {
    const inv = store.getInvoice(tx.invoiceId);
    return {
      color: '#e3f1e3',
      label: `<b>${esc(inv?.number || inv?.ksefNumber || tx.invoiceId)}</b>`
        + `${inv ? `<br>${esc(inv.dir === 'cost' ? inv.sellerName : inv.buyerName)}` : ''}`
        + `<br><span style="color:#555">${esc(tx.matchedBy || 'przypisano ręcznie')}</span>`,
      ksef: inv?.ksefNumber || '',
    };
  }
  const category = tx.category || categorize(tx);
  if (category) return { color: '#fbf3d2', label: `${esc(category)}<br><span style="color:#555">bez faktury</span>`, ksef: '' };
  return { color: '#f8dcdc', label: '<b>DO WYJAŚNIENIA</b>', ksef: '' };
}

function ipkoReportSection(store, company, account, currency, list) {
  const first = list[0] || {};
  const sumMa = list.filter((t) => t.amount > 0).reduce((s, t) => s + t.amount, 0);
  const sumWn = list.filter((t) => t.amount < 0).reduce((s, t) => s + t.amount, 0);
  const hasSaldo = list.every((t) => typeof t.saldo === 'number');
  const saldoStart = hasSaldo && list.length ? list[0].saldo - list[0].amount : null;
  const saldoEnd = hasSaldo && list.length ? list[list.length - 1].saldo : null;
  const cell = 'border:1px solid #bbb; padding:3px 6px; vertical-align:top;';
  return `
    <div style="border-top:2px solid #333; margin-top:20px; padding-top:8px">
      <table style="width:100%; margin-bottom:8px"><tr>
        <td style="vertical-align:top">
          <div style="font-size:14px"><b>WYCIĄG za okres ${esc(first.stmtPeriod || '')}</b> — raport rozliczenia</div>
          <div>Nr: ${esc(first.stmtNo || '—')} · ${esc(first.bank || '')}</div>
          <div>Nr rachunku: <b>${esc(fmtAccount(account))}</b> · Waluta: ${esc(currency)}</div>
        </td>
        <td style="vertical-align:top; text-align:right">
          <div>${esc(company.name)}</div>
          <div>Obroty MA: <b>${plMoney(sumMa)}</b> · Obroty WN: <b>${plMoney(sumWn)}</b></div>
          ${saldoStart !== null ? `<div>Saldo poprzednie: <b>${plMoney(saldoStart)}</b> · Saldo końcowe: <b>${plMoney(saldoEnd)}</b></div>` : ''}
        </td>
      </tr></table>
      <table style="width:100%; border-collapse:collapse; font-size:10.5px">
        <thead><tr>
          ${['Data operacji<br>Data waluty', 'Identyfikator operacji<br>Opis operacji', 'TYP OPERACJI', 'Kwota operacji', 'Saldo', 'Rozliczenie', 'KSeF']
            .map((h) => `<th style="${cell} background:#e8e8e8; text-align:left">${h}</th>`).join('')}
        </tr></thead>
        <tbody>
          ${list.map((t) => {
            const st = txStatus(store, t);
            return `
            <tr style="background:${st.color}">
              <td style="${cell} border-bottom:none; white-space:nowrap">${esc(t.date)}</td>
              <td style="${cell} border-bottom:none">${esc(t.id)}</td>
              <td style="${cell} border-bottom:none">${esc(t.type)}</td>
              <td style="${cell} border-bottom:none; text-align:right; white-space:nowrap"><b>${plMoney(t.amount)}</b></td>
              <td style="${cell} border-bottom:none; text-align:right; white-space:nowrap">${typeof t.saldo === 'number' ? plMoney(t.saldo) : ''}</td>
              <td style="${cell}" rowspan="2">${st.label}</td>
              <td style="${cell} text-align:center" rowspan="2">${st.ksef
                ? `✓<br><span style="font-size:8px; color:#555; word-break:break-all">${esc(st.ksef)}</span>`
                : '<span style="color:#999">—</span>'}</td>
            </tr>
            <tr style="background:${st.color}">
              <td style="${cell} border-top:none; white-space:nowrap">${esc(t.valueDate || '')}</td>
              <td style="${cell} border-top:none" colspan="4"><span style="color:#333">${esc(t.desc)}</span></td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>
    </div>`;
}

const REPORT_TEMPLATES = {
  'PKO BP (iPKO Biznes)': ipkoReportSection,
};

// Invoices the accountant cannot pull from KSeF herself — everything of
// the period without a KSeF number (foreign invoices above all); DW and
// proformas are not invoices and stay out
// Non-KSeF documents issued in the selected period. Calendar bounds, not
// the first/last operation date — a 1st-of-month invoice must not fall out
// of the report just because the bank was quiet that day.
function nonKsefInvoices(store, company, txs) {
  const period = periodOf(bankView);
  const txDates = txs.map((t) => t.date).sort();
  const from = period.from || txDates[0];
  const to = period.to || txDates[txDates.length - 1];
  if (!from) return [];
  // Sales first, then costs — the merged attachment and the report tables
  // share this order
  return store.listInvoices({ companyId: company.id, from, to })
    .filter((i) => !i.ksefNumber && i.kind !== 'dw' && i.kind !== 'proforma')
    .sort((a, b) => (a.dir === b.dir ? a.issueDate.localeCompare(b.issueDate) : (a.dir === 'sale' ? -1 : 1)));
}

async function printReport(deps, company, month, txs, mode = 'local') {
  const { store } = deps;
  const byAccount = new Map();
  for (const tx of txs) {
    const key = `${tx.account}|${tx.currency}`;
    if (!byAccount.has(key)) byAccount.set(key, []);
    byAccount.get(key).push(tx);
  }
  const counts = {
    ret: txs.filter((t) => t.refundTxId).length,
    nkup: txs.filter((t) => !t.refundTxId && t.category === NKUP_CATEGORY).length,
    ok: txs.filter((t) => !t.refundTxId && t.invoiceId).length,
    warn: txs.filter((t) => !t.refundTxId && !t.invoiceId && t.category !== NKUP_CATEGORY && (t.category || categorize(t))).length,
  };
  counts.bad = txs.length - counts.ok - counts.warn - counts.ret - counts.nkup;

  // Second deliverable: the non-KSeF invoices of the period merged into
  // one PDF from the file archive (Fakturownia PDFs land there during
  // sync, so by report time the archive is complete)
  const extraInvoices = nonKsefInvoices(store, company, txs);
  const fileMap = store.fileByInvoice(company.id);
  const withPdf = extraInvoices.filter((i) => fileMap.has(i.id));
  const withoutPdf = extraInvoices.filter((i) => !fileMap.has(i.id));
  let mergedNote = '';
  let mergedKey = '';
  if (withPdf.length) {
    const outName = `reports/faktury-poza-ksef-${month.replace(/[^\dA-Za-z-]+/g, '_')}.pdf`;
    try {
      await deps.cl.mergePdfs(withPdf.map((i) => fileMap.get(i.id).key), outName, { open: mode === 'local' });
      mergedKey = outName;
      mergedNote = `Załącznik: <b>${withPdf.length}</b> faktur spoza KSeF w osobnym pliku PDF (${esc(outName.split('/').pop())}).`;
      if (mode === 'local') bankView.info = `✓ Raport (przeglądarka) + ${withPdf.length} faktur spoza KSeF w jednym PDF (otwarty).`;
    } catch (err) {
      deps.cl.log('invoice merge failed:', err);
      mergedNote = `<span style="color:#c0392b">Nie udało się skleić załącznika PDF: ${esc(err.message || err)}</span>`;
      bankView.error = `Załącznik PDF nie powstał: ${err.message || err}`;
    }
  }
  // Lp runs through both tables so the numbers keep matching the page
  // order of the merged attachment (sales first, then costs)
  const invoiceTable = (list, offset) => `
      <table style="border-collapse:collapse; width:100%; font-size:11px">
        <thead><tr>
          <th style="border:1px solid #bbb; padding:3px 6px; text-align:left">Lp</th>
          <th style="border:1px solid #bbb; padding:3px 6px; text-align:left">Numer</th>
          <th style="border:1px solid #bbb; padding:3px 6px; text-align:left">Data</th>
          <th style="border:1px solid #bbb; padding:3px 6px; text-align:left">Kontrahent</th>
          <th style="border:1px solid #bbb; padding:3px 6px; text-align:right">Brutto</th>
          <th style="border:1px solid #bbb; padding:3px 6px; text-align:left">PDF</th>
        </tr></thead>
        <tbody>
          ${list.map((i, n) => `
            <tr${fileMap.has(i.id) ? '' : ' style="background:#f8dcdc"'}>
              <td style="border:1px solid #bbb; padding:3px 6px">${offset + n + 1}</td>
              <td style="border:1px solid #bbb; padding:3px 6px">${esc(i.number || '—')}</td>
              <td style="border:1px solid #bbb; padding:3px 6px">${esc(i.issueDate)}</td>
              <td style="border:1px solid #bbb; padding:3px 6px">${esc(i.dir === 'cost' ? i.sellerName : i.buyerName)}</td>
              <td style="border:1px solid #bbb; padding:3px 6px; text-align:right">${plMoney(i.gross)} ${esc(i.currency)}</td>
              <td style="border:1px solid #bbb; padding:3px 6px">${fileMap.has(i.id) ? 'w załączniku' : 'BRAK PLIKU'}</td>
            </tr>`).join('')}
        </tbody>
      </table>`;
  const extraSales = extraInvoices.filter((i) => i.dir === 'sale');
  const extraCosts = extraInvoices.filter((i) => i.dir === 'cost');
  const extraSection = extraInvoices.length ? `
      <h3 style="margin:22px 0 4px">Faktury spoza KSeF w tym okresie (${extraInvoices.length})</h3>
      <div style="color:#555; margin-bottom:6px">Tych dokumentów nie ma w KSeF — ich obrazy ${withPdf.length ? 'są w załączonym pliku PDF, w kolejności jak niżej (najpierw przychody, potem wydatki)' : 'wymagają osobnego przekazania'}. ${mergedNote}</div>
      ${extraSales.length ? `<h4 style="margin:10px 0 3px">Przychody (${extraSales.length})</h4>${invoiceTable(extraSales, 0)}` : ''}
      ${extraCosts.length ? `<h4 style="margin:10px 0 3px">Wydatki (${extraCosts.length})</h4>${invoiceTable(extraCosts, extraSales.length)}` : ''}
      ${withoutPdf.length ? `<div style="color:#c0392b; margin-top:4px">Uwaga: ${withoutPdf.length} pozycji bez pliku PDF w archiwum.</div>` : ''}` : '';
  const legend = (color, label) =>
    `<span style="display:inline-block; padding:1px 10px; background:${color}; border:1px solid #bbb; margin-right:8px">${label}</span>`;
  const body = `
    <div style="font-family: Arial, Helvetica, sans-serif; font-size:12px; padding:24px; max-width:980px; margin:0 auto">
      <h2 style="margin-bottom:2px">Rozliczenie wyciągów bankowych — ${esc(month)}</h2>
      <div style="color:#555; margin-bottom:6px">${esc(company.name)} · NIP ${esc(company.nip)} · wygenerowano ${new Date().toISOString().slice(0, 10)}</div>
      <div style="margin-bottom:4px">
        ${legend('#e3f1e3', `przypisane do faktury (${counts.ok})`)}
        ${legend('#fbf3d2', `bez faktury — opłaty/podatki (${counts.warn})`)}
        ${counts.ret ? legend('#e2e5f7', `anulowane / zwroty (${counts.ret})`) : ''}
        ${counts.nkup ? legend('#fde8d7', `bez faktury — NKUP (${counts.nkup})`) : ''}
        ${legend('#f8dcdc', `do wyjaśnienia (${counts.bad})`)}
      </div>
      ${counts.ret ? '<div style="color:#555; margin-bottom:4px">Pozycje <b>ANULOWANE / ZWROT</b> to pary operacji, które się wzajemnie znoszą (anulowana płatność i jej zwrot) — nie ma do nich faktur i nie wymagają księgowania.</div>' : ''}
      ${counts.nkup ? '<div style="color:#555; margin-bottom:4px">Pozycje <b>KOSZT BEZ FAKTURY — NKUP</b>: faktura nie istnieje i nie będzie — proszę zaksięgować w koszty inne, bez odliczenia podatku.</div>' : ''}
      <div style="color:#555; margin-bottom:4px">Kolumna <b>KSeF</b>: ✓ = faktura jest w KSeF (z podanym numerem) — dokument pobierze się automatycznie, nie trzeba go szukać ani weryfikować ręcznie.</div>
      ${[...byAccount.entries()].map(([key, list]) => {
        const [account, currency] = key.split('|');
        const template = REPORT_TEMPLATES[list[0]?.bank] || ipkoReportSection;
        return template(store, company, account, currency, list);
      }).join('')}
      ${extraSection}
    </div>`;
  const title = `Rozliczenie wyciągów ${month} — ${company.name}`;
  if (mode === 'local') {
    deps.cl.openPreview(printDocHtml(title, body), title).catch((err) => {
      deps.cl.log('report preview failed:', err);
      bankView.error = `Nie udało się otworzyć raportu: ${err.message || err}`;
    });
    return;
  }

  // Email mode: the report becomes a real PDF and goes out with the merged
  // invoices and the ORIGINAL statement PDFs of the period attached
  try {
    const slug = month.replace(/[^\dA-Za-z-]+/g, '_');
    const reportKey = `reports/rozliczenie-${slug}.pdf`;
    await deps.cl.htmlToPdf(printDocHtml(title, body), reportKey);
    const monthsInPeriod = new Set(txs.map((t) => t.date.slice(0, 7)));
    const stmtKeys = store.stmtFiles(company.id)
      .filter((s) => (s.months || []).some((m) => monthsInPeriod.has(m)))
      .map((s) => ({ key: s.key, label: `wyciąg: ${s.name}` }));
    const attachments = [
      { key: reportKey, label: `rozliczenie-${slug}.pdf (raport)` },
      ...(mergedKey ? [{ key: mergedKey, label: `${mergedKey.split('/').pop()} (${withPdf.length} faktur spoza KSeF)` }] : []),
      ...stmtKeys,
    ];
    openEmailModal(deps, company, {
      subject: `${company.name} — dokumenty za ${month}`,
      bodyText: `Dzień dobry,\n\nw załączeniu dokumenty za ${month}:\n— rozliczenie wyciągów bankowych (płatność ↔ faktura),\n— faktury spoza KSeF w jednym pliku PDF${stmtKeys.length ? ',\n— oryginalne wyciągi bankowe' : ''}.\n\nPozdrawiam\n${company.name}`,
      attachments,
    });
  } catch (err) {
    deps.cl.log('email report failed:', err);
    bankView.error = `Nie udało się przygotować wysyłki: ${err.message || err}`;
  }
}

function openEmailModal(deps, company, { subject, bodyText, attachments }) {
  const ccList = String(company.accountantCc || '').split(',').map((s) => s.trim()).filter(Boolean);
  const overlay = document.createElement('div');
  overlay.className = 'ksefad-overlay modal-overlay';
  overlay.innerHTML = `
    <div class="ksefad-modal lg" style="width:min(640px, 92vw)">
      <h2 style="margin-bottom:6px">Wyślij do księgowej</h2>
      <div class="ksefad-muted" style="margin-bottom:10px">Z konta: <b>${esc(company.senderEmail || 'pierwsze skonfigurowane konto Gmail')}</b> <span class="adk-muted">(zmiana w Ustawieniach firmy)</span></div>
      <div class="adk-form" style="grid-template-columns:1fr">
        <label class="adk-field"><span>Do</span><input id="emTo" type="email" value="${esc(company.accountantEmail || '')}" placeholder="ustaw e-mail księgowej w Ustawieniach firmy"></label>
        <label class="adk-field"><span>Temat</span><input id="emSubject" value="${esc(subject)}"></label>
        <label class="adk-field"><span>Treść</span><textarea id="emBody" rows="6">${esc(bodyText)}</textarea></label>
      </div>
      ${ccList.length ? `
      <div class="adk-kv" style="margin-top:8px"><b>CC:</b>
        ${ccList.map((cc, i) => `<label style="display:block"><input type="checkbox" data-cc="${i}" checked> ${esc(cc)}</label>`).join('')}
      </div>` : ''}
      <div class="adk-kv" style="margin-top:8px"><b>Załączniki (${attachments.length}):</b>
        ${attachments.map((a) => `<div class="adk-muted">📎 ${esc(a.label)}</div>`).join('')}
      </div>
      <div class="adk-actions">
        <span class="ksefad-error" id="emError"></span>
        <span style="flex:1"></span>
        <button class="adk-btn primary" id="emSend">Wyślij</button>
        <button class="adk-btn" id="emCancel">Anuluj</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  const close = () => overlay.remove();
  overlay.onclick = (e) => { if (e.target === overlay) close(); };
  overlay.querySelector('#emCancel').onclick = close;
  overlay.querySelector('#emSend').onclick = async () => {
    const to = overlay.querySelector('#emTo').value.trim();
    if (!to) {
      overlay.querySelector('#emError').textContent = 'Adres „Do" jest wymagany (Ustawienia → firma → E-mail księgowej)';
      return;
    }
    const cc = ccList.filter((_, i) => overlay.querySelector(`[data-cc="${i}"]`)?.checked).join(', ');
    const btn = overlay.querySelector('#emSend');
    btn.disabled = true;
    btn.textContent = 'Wysyłam…';
    try {
      await deps.cl.sendEmail({
        account: company.senderEmail || '',
        to,
        cc,
        subject: overlay.querySelector('#emSubject').value.trim(),
        body: overlay.querySelector('#emBody').value,
        attachmentKeys: attachments.map((a) => a.key),
      });
      bankView.info = `✓ Wysłano do ${to}${cc ? ` (CC: ${cc})` : ''} — ${attachments.length} załączników.`;
      bankView.error = '';
      close();
    } catch (err) {
      deps.cl.log('email send failed:', err);
      btn.disabled = false;
      btn.textContent = 'Wyślij';
      overlay.querySelector('#emError').textContent = `Wysyłka nie powiodła się: ${err.message || err}`;
    }
  };
}
