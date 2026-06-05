// Pure parsing for a Screener.in saved-screen results page.
//
// This module only depends on cheerio (no Playwright), so the table parsing,
// column-name mapping and value cleaning can be unit-tested against an HTML
// fixture without launching a browser or hitting the network.

import * as cheerio from 'cheerio';

// Canonical output keys, in the order we want them to appear. The scraper always
// emits all of these (defaulting to "") so the universe has a stable schema; any
// screen column we don't recognise is additionally kept under its raw header name.
export const CANONICAL_KEYS = [
  'ev_ebitda',
  'pe',
  'pb',
  'roce',
  'roe',
  'promoter_holding',
  'sales_growth_3y',
  'mkt_cap',
  'cmp',
];

// Collapse runs of whitespace to single spaces and trim. Used for human-facing
// text (company names, header labels) where internal spaces are meaningful.
export function collapse(s) {
  return (s || '').replace(/\s+/g, ' ').trim();
}

// Normalise a header label to a comparable token: lowercase, alphanumeric only.
// e.g. "Mar Cap Rs.Cr." -> "marcaprscr", "Prom. Hold. %" -> "promhold".
export function normalizeHeader(text) {
  return (text || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

// Clean a numeric ratio cell: drop the rupee sign, thousands separators, percent
// signs and all whitespace. Blank cells become "".
export function cleanValue(s) {
  return (s || '').replace(/[₹,%\s]/g, '').trim();
}

// Map a (raw) Screener column header to one of our canonical keys, or null if we
// don't recognise it. Screener renders headers abbreviated and the exact label
// depends on how the screen was built, so match on normalised tokens rather than
// exact strings. Order matters (check ROCE before ROE, etc.).
export function canonicalKey(header) {
  const h = normalizeHeader(header);
  if (!h) return null;
  if (/evebitda/.test(h)) return 'ev_ebitda';
  if (h === 'pe' || /priceearning|pricetoearning/.test(h)) return 'pe';
  if (h === 'pb' || /pricetobook|pricebook/.test(h)) return 'pb';
  if (/^roce/.test(h)) return 'roce';
  if (/^roe/.test(h)) return 'roe';
  if (/promoter|promhold/.test(h)) return 'promoter_holding';
  if (/sales/.test(h) && /(3year|3yr|3y|var3|growth3)/.test(h)) return 'sales_growth_3y';
  if (/marcap|marketcap|mktcap|mcap/.test(h)) return 'mkt_cap';
  if (/cmp|currentmarketprice|currentprice/.test(h)) return 'cmp';
  return null;
}

// Header tokens that are not data columns and should be skipped.
const SKIP_HEADERS = new Set(['', 'sno', 'srno', 'srno.', 'name']);

const COMPANY_LINK = 'a[href^="/company/"]';

// Detect the total number of pages from the "Page X of Y" pagination text.
function detectTotalPages($) {
  const text = collapse($('body').text());
  const m = text.match(/page\s+(\d+)\s+of\s+(\d+)/i);
  return m ? parseInt(m[2], 10) : null;
}

// Locate the header cells of a results table, tolerating tables with or without
// an explicit <thead>, and headers built from <th> or <td>. Screener's screen
// table does not use <thead><th>, so the fallback is the load-bearing path: the
// first row that has no /company/ link is the header row.
export function findHeaderCells($, table) {
  let cells = table.find('thead th');
  if (cells.length) return cells;
  cells = table.find('thead td');
  if (cells.length) return cells;

  let headerCells = $();
  table.find('tr').each((_, tr) => {
    if (headerCells.length) return;
    const $tr = $(tr);
    if ($tr.find(COMPANY_LINK).length) return; // a data row, not the header
    const c = $tr.find('th').length ? $tr.find('th') : $tr.find('td');
    if (c.length) headerCells = c;
  });
  return headerCells;
}

function buildHeaderMap($, table) {
  const headers = {};
  findHeaderCells($, table).each((i, cell) => {
    const raw = collapse($(cell).text());
    headers[i] = { raw, key: canonicalKey(raw) };
  });
  return headers;
}

// The data rows of the table. Prefer <tbody>, fall back to all <tr> (the header
// row is skipped later because it has no /company/ link).
function findDataRows(table) {
  const rows = table.find('tbody tr');
  return rows.length ? rows : table.find('tr');
}

// Parse a single <tr>. Returns a row object, or null if the row is not a company
// row (e.g. the header row, or a separator/aggregate row with no /company/ link).
// Throws on truly malformed input so the caller can log-and-continue.
function parseRow($, $tr, headers) {
  const link = $tr.find(COMPANY_LINK).first();
  if (!link.length) return null;

  const name = collapse(link.text());
  const path = link.attr('href') || '';
  const slug = path.split('/').filter(Boolean)[1] || '';

  const row = { name, path, slug };
  for (const k of CANONICAL_KEYS) row[k] = '';

  $tr.find('td').each((i, td) => {
    const header = headers[i];
    if (!header) return;
    const $td = $(td);
    if ($td.find(COMPANY_LINK).length) return; // the name cell, captured above
    if (SKIP_HEADERS.has(normalizeHeader(header.raw))) return;

    const value = cleanValue($td.text());
    if (header.key) row[header.key] = value;
    else row[header.raw] = value; // keep unrecognised columns under their raw label
  });

  return row;
}

// Parse a Screener screen results page.
// Returns { hasTable, totalPages, rows, warnings }.
export function parseScreenTable(html) {
  const $ = cheerio.load(html);
  $('script, style, noscript').remove();

  const totalPages = detectTotalPages($);
  const table = $('table.data-table').first();
  const hasTable = table.length > 0;

  const rows = [];
  const warnings = [];

  if (!hasTable) return { hasTable, totalPages, rows, warnings };

  const headers = buildHeaderMap($, table);

  findDataRows(table).each((idx, tr) => {
    try {
      const row = parseRow($, $(tr), headers);
      if (row) rows.push(row);
    } catch (err) {
      warnings.push(`row ${idx}: ${err.message}`);
    }
  });

  return { hasTable, totalPages, rows, warnings };
}

// De-duplicate rows by their /company/ path. `seen` can be shared across pages so
// the caller accumulates a single de-duplicated universe. Returns only the rows
// that were newly added.
export function dedupeByPath(rows, seen = new Set()) {
  const fresh = [];
  for (const r of rows) {
    if (!r || !r.path || seen.has(r.path)) continue;
    seen.add(r.path);
    fresh.push(r);
  }
  return fresh;
}

// Structural diagnostics for debugging the parser against the live DOM. Prints,
// per data-table: the thead th/td counts, the detected header labels, and the
// first data row's actual cell texts — which reveals whether values are even
// present in the server-rendered HTML.
export function inspectTable(html) {
  const $ = cheerio.load(html);
  $('script, style, noscript').remove();

  const tables = $('table.data-table');
  const out = [`data-table count: ${tables.length}`];

  tables.each((ti, t) => {
    const $t = $(t);
    const firstData = $t
      .find('tr')
      .filter((_, tr) => $(tr).find(COMPANY_LINK).length)
      .first();
    const headerTexts = findHeaderCells($, $t)
      .map((_, c) => collapse($(c).text()))
      .get();
    const cellTexts = firstData
      .find('td')
      .map((_, c) => collapse($(c).text()))
      .get();

    out.push(
      `table[${ti}] thead th=${$t.find('thead th').length} thead td=${$t.find('thead td').length} ` +
        `tbody tr=${$t.find('tbody tr').length} firstDataRow td=${firstData.find('td').length}`
    );
    out.push(`table[${ti}] headers(${headerTexts.length}): ${JSON.stringify(headerTexts)}`);
    out.push(`table[${ti}] firstRowCells: ${JSON.stringify(cellTexts)}`);
  });

  return out.join('\n');
}
