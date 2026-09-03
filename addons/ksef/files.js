// Invoice files: field extraction from PDF text and matching against the
// invoice registry. Shared by the Pliki page (single upload) and the
// one-off archive import scripts — deterministic first, LLM only for what
// this cannot read.

import { normalizeNip } from './store.js';

function nipChecksumOk(nip) {
  if (!/^\d{10}$/.test(nip)) return false;
  const w = [6, 5, 7, 2, 3, 4, 5, 6, 7];
  const sum = w.reduce((s, wi, i) => s + wi * Number(nip[i]), 0);
  return sum % 11 === Number(nip[9]);
}

function plNumber(s) {
  const t = String(s).replace(/[\s ]/g, '');
  // 1.234,56 and 1,234.56 both appear on invoices — the decimal separator
  // is whichever of the two comes last
  const lastComma = t.lastIndexOf(',');
  const lastDot = t.lastIndexOf('.');
  const dec = lastComma > lastDot ? ',' : '.';
  const cleaned = t.split(dec === ',' ? '.' : ',').join('');
  return Number(cleaned.replace(dec, '.'));
}

const DATE_PATTERNS = [
  { re: /\b(\d{4})-(\d{2})-(\d{2})\b/g, ymd: (m) => [m[1], m[2], m[3]] },
  { re: /\b(\d{2})[-./](\d{2})[-./](\d{4})\b/g, ymd: (m) => [m[3], m[2], m[1]] },
  { re: /\b(\d{4})\/(\d{2})\/(\d{2})\b/g, ymd: (m) => [m[1], m[2], m[3]] },
];

const MONTHS_PL = {
  stycznia: '01', lutego: '02', marca: '03', kwietnia: '04', maja: '05', czerwca: '06',
  lipca: '07', sierpnia: '08', wrzesnia: '09', września: '09', pazdziernika: '10',
  października: '10', listopada: '11', grudnia: '12',
};

const MONTHS_EN = {
  january: '01', february: '02', march: '03', april: '04', may: '05', june: '06',
  july: '07', august: '08', september: '09', october: '10', november: '11', december: '12',
};

export function extractDates(text) {
  const out = new Set();
  for (const { re, ymd } of DATE_PATTERNS) {
    for (const m of text.matchAll(re)) {
      const [y, mo, d] = ymd(m);
      if (Number(y) >= 2015 && Number(y) <= 2035 && Number(mo) >= 1 && Number(mo) <= 12 && Number(d) >= 1 && Number(d) <= 31) {
        out.add(`${y}-${mo}-${d}`);
      }
    }
  }
  for (const m of text.matchAll(/\b(\d{1,2})\s+([a-ząćęłńóśźż]+)\s+(\d{4})\b/gi)) {
    const mo = MONTHS_PL[m[2].toLowerCase()];
    if (mo && Number(m[3]) >= 2015 && Number(m[3]) <= 2035) {
      out.add(`${m[3]}-${mo}-${String(m[1]).padStart(2, '0')}`);
    }
  }
  for (const m of text.matchAll(/\b([a-z]+)\s+(\d{1,2}),\s*(\d{4})\b/gi)) {
    const mo = MONTHS_EN[m[1].toLowerCase()];
    if (mo && Number(m[3]) >= 2015 && Number(m[3]) <= 2035) {
      out.add(`${m[3]}-${mo}-${String(m[2]).padStart(2, '0')}`);
    }
  }
  return [...out].sort();
}

export function extractNips(text, ownNip) {
  const own = normalizeNip(ownNip);
  const out = [];
  for (const m of text.matchAll(/(?:NIP|VAT\s*(?:ID|No\.?|Number)?|PL)[:\s.]*((?:\d[\s-]?){10})/gi)) {
    const nip = m[1].replace(/\D/g, '');
    if (nipChecksumOk(nip) && nip !== own && !out.includes(nip)) out.push(nip);
  }
  // Fallback: any standalone 10-digit run with a valid checksum
  if (!out.length) {
    for (const m of text.matchAll(/\b(\d{3}[-\s]?\d{3}[-\s]?\d{2}[-\s]?\d{2}|\d{10})\b/g)) {
      const nip = m[1].replace(/\D/g, '');
      if (nipChecksumOk(nip) && nip !== own && !out.includes(nip)) out.push(nip);
    }
  }
  return out;
}

// Gross candidates, strongest first: amounts on "do zapłaty"-style lines,
// then every plausible money value found anywhere (largest first)
export function extractAmounts(text) {
  const strong = [];
  const all = new Set();
  const MONEY_RE = /(\d{1,3}(?:[\s .,]\d{3})*[.,]\d{2})/g;
  for (const line of text.split('\n')) {
    const amounts = [...line.matchAll(MONEY_RE)].map((m) => plNumber(m[1])).filter((n) => n > 0 && n < 10_000_000);
    if (!amounts.length) continue;
    for (const a of amounts) all.add(a);
    if (/do\s+zap[lł]aty|raz[ae]m\s+do|total\s+due|amount\s+due|grand\s+total|suma\s+brutto|warto[sś][cć]\s+brutto|[lł][aą]czna\s+kwota|total(?!\s+net)/i.test(line)) {
      strong.push(...amounts);
    }
  }
  return { strong: [...new Set(strong)], all: [...all].sort((a, b) => b - a) };
}

export function extractInvoiceNumbers(text) {
  const out = [];
  const moneyLike = (s) => /^\d{1,3}(?:[ .,]\d{3})*[.,]\d{2}$/.test(s);
  const dateLike = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s) || /^\d{2}[-./]\d{2}[-./]\d{4}$/.test(s);
  const push = (raw) => {
    const num = String(raw).trim().replace(/[.,:]$/, '');
    if (/\d/.test(num) && !moneyLike(num) && !dateLike(num) && !out.includes(num)) out.push(num);
  };
  // Labeled forms first ("Numer faktury: FS 4207/02/2026", "Invoice number
  // DLG34FJH-0001") — the number may contain single spaces, so trailing
  // alpha-only tokens after the digits are column neighbours, not the number
  const takeSpacedNumber = (raw) => {
    const tokens = raw.trim().split(/\s+/);
    let end = tokens.length;
    let seenDigit = false;
    for (let i = 0; i < tokens.length; i++) {
      if (/\d/.test(tokens[i])) {
        seenDigit = true;
      } else if (seenDigit) {
        end = i;
        break;
      }
    }
    push(tokens.slice(0, end).join(' '));
  };
  for (const m of text.matchAll(/(?:numer\s+faktury|nr\s+faktury|invoice\s+(?:id|no\.?|number|#))[.:\s]*([A-Za-z0-9][A-Za-z0-9 \/\-._]{2,30})/gi)) {
    takeSpacedNumber(m[1]);
  }
  // Column layouts split "Faktura … / nr: F/11/02/26" across lines with the
  // right-hand column in between — a line-initial "nr:" shortly after the
  // word "faktura" is that continuation
  for (const m of text.matchAll(/(?:^|\n)[^\S\n]*nr[.:][^\S\n]*([A-Za-z0-9][A-Za-z0-9 \/\-._]{2,30})/gi)) {
    if (/faktur/i.test(text.slice(Math.max(0, m.index - 250), m.index))) takeSpacedNumber(m[1]);
  }
  for (const m of text.matchAll(/(?:faktur[aey](?:\s+(?:vat|nr|numer|proforma))*|invoice\s*(?:no\.?|number|#)?|rachunek\s+nr)[:\s]*([A-Za-z0-9][A-Za-z0-9\/\-._]{2,30})/gi)) {
    push(m[1]);
  }
  return out;
}

// The document currency is whichever symbol/code appears most often next
// to money amounts; bare counts over the whole text would drown in VAT-law
// boilerplate mentioning PLN
export function extractCurrency(text) {
  const votes = { PLN: 0, EUR: 0, USD: 0, GBP: 0, CHF: 0 };
  const AMOUNT = String.raw`\d(?:[\d\s.,]*\d)?[.,]\d{2}`;
  for (const m of text.matchAll(new RegExp(String.raw`(EUR|USD|GBP|CHF|PLN|€|\$|£|zł)\s*${AMOUNT}|${AMOUNT}\s*(EUR|USD|GBP|CHF|PLN|€|\$|£|zł)`, 'gi'))) {
    const tok = (m[1] || m[2] || '').toUpperCase();
    const cur = { '€': 'EUR', $: 'USD', '£': 'GBP', 'ZŁ': 'PLN' }[tok] || tok;
    if (cur in votes) votes[cur]++;
  }
  const best = Object.entries(votes).sort((a, b) => b[1] - a[1])[0];
  return best[1] > 0 ? best[0] : '';
}

// A VAT rate only counts when the document actually talks about VAT —
// otherwise any "5%" discount would look like a tax rate
export function extractVatRate(text) {
  if (!/VAT|PTU|podatek/i.test(text)) return null;
  if (/zwolnion|\bzw\.?\b/i.test(text)) return 'zw';
  if (/odwrotne obci|reverse charge|\bnp\.?\b/i.test(text) && !/np\.\s/i.test(text)) return 'np';
  for (const rate of [23, 8, 5]) {
    if (new RegExp(`\\b${rate}\\s?%`).test(text)) return rate;
  }
  if (/\b0\s?%/.test(text)) return 0;
  return null;
}

// 'EU' is the OSS/MOSS registration prefix used by non-EU sellers (GoDaddy,
// Amazon US), not a country code — but on invoices it works like one
const EU_CC = new Set(['AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'EL', 'HU',
  'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE', 'GB', 'CH', 'NO', 'EU']);

// Foreign (non-PL) VAT ids, only on lines that actually talk about VAT —
// a bare "DE 12345678" on an address line is a postcode, not a tax id
export function extractVatIds(text) {
  const out = [];
  for (const line of text.split('\n')) {
    if (!/VAT|USt|TVA|BTW|MwSt|Tax\s*(ID|Reg)/i.test(line)) continue;
    for (const m of line.matchAll(/\b([A-Z]{2})\s?([0-9A-Z]{8,12})\b/g)) {
      if (!EU_CC.has(m[1]) || !/\d/.test(m[2])) continue;
      const id = m[1] + m[2];
      if (!out.includes(id)) out.push(id);
    }
  }
  return out;
}

// pdftotext -layout keeps columns as runs of 3+ spaces; a "cell" is one run
function splitSegments(line) {
  const out = [];
  let idx = 0;
  for (const part of line.split(/(\s{3,})/)) {
    if (!/^\s*$/.test(part)) out.push({ start: idx, text: part });
    idx += part.length;
  }
  return out;
}

// The issuer's name and address sit in the lines directly above its tax id,
// in the same layout column — collect that block walking upward
export function extractSellerBlock(text, taxToken) {
  if (!taxToken) return null;
  const digits = String(taxToken).replace(/\D/g, '');
  const lines = text.split('\n');
  const clean = (s) => s.replace(/\s+/g, ' ').trim();
  const inSeg = (seg) => {
    const packed = seg.text.replace(/[\s-]/g, '');
    return packed.includes(taxToken) || (digits.length >= 9 && packed.replace(/\D/g, '').includes(digits));
  };
  for (let i = 0; i < lines.length; i++) {
    const seg = splitSegments(lines[i]).find(inSeg);
    if (!seg) continue;
    const block = [];
    let blankSkipped = false;
    for (let j = i - 1; j >= 0 && block.length < 5; j--) {
      const cell = splitSegments(lines[j]).find((s) => Math.abs(s.start - seg.start) <= 14);
      const t = cell ? clean(cell.text) : '';
      if (!t) {
        // one blank line may separate the name from the address block
        if (blankSkipped || !block.length) break;
        blankSkipped = true;
        continue;
      }
      if (/^(faktura|invoice|rachunek|paragon|data |date |nr |no\.|iban|swift|konto|account)/i.test(t)) break;
      if (/^[\d\s.,%-]+$/.test(t)) break;
      if (/sprzedawca|seller|wystawca|issuer|dostawca|supplier|bill from/i.test(t)) break;
      // corporate-registry footers (board, court register) are below the
      // company data, never part of the address
      if (/CEO|Gesch[aä]ftsf|Registration Office|Managing Director|Zarz[ąa]d|HRB|KRS|REGON|Kapita[łl]/i.test(t)) {
        block.length = 0;
        continue;
      }
      block.unshift(t.replace(/^(adres|address)[:\s]+/i, ''));
    }
    if (!block.length) continue;
    // A street or postcode as the first line means the actual name sits
    // outside the column — better no name than an address posing as one
    let name = block[0];
    let rest = block.slice(1);
    if (/^(ul\.|al\.|aleja|ulica|pl\.|os\.)\s/i.test(name) || /^\d{2}-\d{3}\s/.test(name)) {
      rest = block;
      name = '';
    }
    return {
      name,
      address1: rest[0] || '',
      address2: clean(rest.slice(1).join(', ')),
    };
  }
  return null;
}

// German-style envelope header: "Hetzner Online GmbH • Industriestr. 25 •
// 91710 Gunzenhausen • Germany" — one line, so the column scan above the
// tax id finds only the name and the address must come from here
function fillAddressFromBulletHeader(seller, text) {
  if (!seller?.name || seller.address1) return seller;
  const escaped = seller.name.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  const m = new RegExp(`^\\s*${escaped}\\s*[•·]\\s*(.+)$`, 'mi').exec(text);
  if (!m) return seller;
  const parts = m[1].split(/\s*[•·]\s*/).map((s) => s.replace(/\s+/g, ' ').trim()).filter(Boolean);
  if (!parts.length) return seller;
  return {
    ...seller,
    address1: parts[0],
    address2: parts.slice(1).join(', '),
  };
}

export function extractFields(text, ownNip) {
  const amounts = extractAmounts(text);
  const nips = extractNips(text, ownNip);
  const vatIds = extractVatIds(text);
  const seller = fillAddressFromBulletHeader(
    extractSellerBlock(text, nips[0]) || extractSellerBlock(text, vatIds[0]), text);
  return {
    nips,
    vatIds,
    seller,
    dates: extractDates(text),
    amounts,
    numbers: extractInvoiceNumbers(text),
    currency: extractCurrency(text),
    vatRate: extractVatRate(text),
  };
}

const normToken = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9/]/g, '');

// Match extracted fields against the registry. Confidence order: exact
// number + NIP, number + amount, NIP + amount (+ closest date), unique
// amount within the file's date window. Returns {invoice, how} or null.
export function matchFileToInvoice(fields, invoices, { dir = 'cost' } = {}) {
  const pool = invoices.filter((i) => !dir || i.dir === dir);
  const grossOk = (inv, a) => Math.abs(inv.gross - a) < 0.015;
  const candidates = [...fields.amounts.strong, ...fields.amounts.all.slice(0, 8)];
  const dateSet = fields.dates;

  const numTokens = fields.numbers.map(normToken).filter((t) => t.length >= 3);
  for (const inv of pool) {
    const invTok = normToken(inv.number);
    if (!invTok || invTok.length < 3) continue;
    if (!numTokens.some((t) => t === invTok || t.includes(invTok) || invTok.includes(t))) continue;
    const party = dir === 'cost' ? inv.sellerNip : inv.buyerNip;
    if (party && fields.nips.includes(party)) return { invoice: inv, how: 'numer + NIP' };
    if (candidates.some((a) => grossOk(inv, a))) return { invoice: inv, how: 'numer + kwota' };
  }

  const dated = (inv) => dateSet.includes(inv.issueDate)
    || dateSet.some((d) => Math.abs(Date.parse(d) - Date.parse(inv.issueDate)) <= 45 * 86400e3);
  const byNip = pool.filter((inv) => {
    const party = dir === 'cost' ? inv.sellerNip : inv.buyerNip;
    return party && fields.nips.includes(party) && candidates.some((a) => grossOk(inv, a));
  });
  if (byNip.length === 1) return { invoice: byNip[0], how: 'NIP + kwota' };
  if (byNip.length > 1 && dateSet.length) {
    const close = byNip.filter(dated);
    if (close.length === 1) return { invoice: close[0], how: 'NIP + kwota + data' };
    if (close.length > 1) {
      const anchor = Date.parse(dateSet[0]);
      close.sort((a, b) => Math.abs(Date.parse(a.issueDate) - anchor) - Math.abs(Date.parse(b.issueDate) - anchor));
      return { invoice: close[0], how: 'NIP + kwota (najbliższa data)' };
    }
  }

  // Amount-only fallback. Recurring bills (hosting, SaaS) repeat the exact
  // amount every month, so this must not reach back to last month's record:
  // a document whose own number is readable and differs from the candidate's
  // is a different invoice, and the date window stays under one billing cycle.
  if (dateSet.length && fields.amounts.strong.length) {
    const otherNumber = (inv) => {
      const invTok = normToken(inv.number);
      if (!numTokens.length || !invTok || invTok.length < 3) return false;
      return !numTokens.some((t) => t === invTok || t.includes(invTok) || invTok.includes(t));
    };
    const withinCycle = (inv) => dateSet.some((d) => Math.abs(Date.parse(d) - Date.parse(inv.issueDate)) <= 20 * 86400e3);
    for (const a of fields.amounts.strong) {
      const near = pool.filter((inv) => grossOk(inv, a) && withinCycle(inv) && !otherNumber(inv));
      if (near.length === 1) return { invoice: near[0], how: 'kwota + data (do weryfikacji)' };
    }
  }
  return null;
}
