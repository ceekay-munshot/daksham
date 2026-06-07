// Pure parsing for a Screener.in company page.
//
// Depends only on cheerio + the shared cleaners, so the ribbon/series/sector
// extraction (including the expanded "Material Cost %" sub-row) is unit-testable
// against a saved fixture. The Playwright navigation + expand-clicks live in the
// orchestrator; this module just reads whatever HTML it is handed.

import * as cheerio from 'cheerio';
import { collapse, cleanValue } from './parse.mjs';
import { round2 } from './bhav.mjs';

// --- ribbon (#top-ratios) ----------------------------------------------------

function ribbonKey(name) {
  const n = name.toLowerCase().replace(/[^a-z]/g, '');
  if (n.includes('stockpe') || n === 'pe' || n.includes('priceearning')) return 'stock_pe';
  if (n.includes('roce')) return 'roce';
  if (n.includes('roe')) return 'roe';
  if (n.includes('bookvalue')) return 'book_value';
  if (n.includes('currentprice')) return 'current_price';
  if (n.includes('marketcap') || n.includes('marcap')) return 'market_cap';
  return null;
}

function parseRibbon($) {
  const out = {};
  $('#top-ratios li').each((_, li) => {
    const name = collapse($(li).find('.name').text());
    const key = ribbonKey(name);
    if (!key) return;
    const numberEl = $(li).find('.number').first();
    const value = cleanValue(numberEl.length ? numberEl.text() : $(li).find('.value').text());
    out[key] = value;
  });
  return out;
}

// --- sector tags -------------------------------------------------------------

function sectorTag($, title) {
  const scoped = $(`p.sub a[title="${title}"]`).first();
  const el = scoped.length ? scoped : $(`a[title="${title}"]`).first();
  return collapse(el.text());
}

// --- compounded growth (ranges-table) ----------------------------------------

function parseCompounded($) {
  const out = {};
  $('table.ranges-table').each((_, t) => {
    const $t = $(t);
    const header = collapse($t.find('th').first().text()).toLowerCase();
    if (!header.includes('compounded sales growth')) return;
    $t.find('tr').each((_, tr) => {
      const tds = $(tr).find('td');
      if (tds.length < 2) return;
      const label = collapse($(tds[0]).text()).toLowerCase();
      const val = cleanValue($(tds[1]).text());
      if (/3\s*year/.test(label)) out.sales_cagr_3y = val;
      else if (/5\s*year/.test(label)) out.sales_cagr_5y = val;
      else if (/ttm/.test(label)) out.sales_cagr_ttm = val;
    });
  });
  return out;
}

// --- financial section tables (#quarters, #profit-loss, …) --------------------

// Parse a section's data-table into { periods, rows:[{label, values}] }. Works
// whether or not the table uses <thead>: the first <tr> is always the period
// header, the rest are data rows. The leading (row-label) column is dropped from
// periods/values.
export function parseSectionTable($, sectionId) {
  const table = $(`${sectionId} table.data-table`).first();
  if (!table.length) return null;

  const trs = table.find('tr');
  if (trs.length < 2) return null;

  const periods = [];
  trs
    .first()
    .find('th, td')
    .each((i, c) => {
      if (i > 0) periods.push(collapse($(c).text()));
    });

  const rows = [];
  trs.slice(1).each((_, tr) => {
    const cells = $(tr).find('td, th');
    if (!cells.length) return;
    const label = collapse($(cells[0]).text())
      .replace(/\s*[+\-−]\s*$/, '') // strip the expand +/- indicator
      .trim();
    const values = [];
    cells.each((i, c) => {
      if (i > 0) values.push(cleanValue($(c).text()));
    });
    rows.push({ label, values });
  });

  return { periods, rows };
}

function findRow(parsed, ...matchers) {
  if (!parsed) return null;
  for (const row of parsed.rows) {
    const norm = row.label.toLowerCase();
    if (matchers.some((m) => (m instanceof RegExp ? m.test(norm) : norm.includes(m)))) return row;
  }
  return null;
}

// Pipe-join a row's values (oldest -> newest), optionally dropping any TTM column
// and keeping only the last `last` periods. Missing row -> "".
function seriesValues(parsed, row, { dropTtm = false, last = null } = {}) {
  if (!parsed || !row) return '';
  let vals = row.values.slice();
  if (dropTtm) vals = vals.filter((_, i) => !/ttm/i.test(parsed.periods[i] || ''));
  if (last != null) vals = vals.slice(-last);
  return vals.join('|');
}

const lastOf = (series) => {
  if (!series) return '';
  const a = series.split('|');
  return a[a.length - 1];
};

function detectView($) {
  const text = $.root().text();
  if (/consolidated\s+figures/i.test(text)) return 'consolidated';
  if (/standalone\s+figures/i.test(text)) return 'standalone';
  return '';
}

// Extract every field Daksham needs from a (post-expansion) company page HTML.
export function parseCompanyPage(html) {
  const $ = cheerio.load(html);
  $('script, style, noscript').remove();

  const ribbon = parseRibbon($);
  const compounded = parseCompounded($);

  const quarters = parseSectionTable($, '#quarters');
  const pl = parseSectionTable($, '#profit-loss');
  const cf = parseSectionTable($, '#cash-flow');
  const bs = parseSectionTable($, '#balance-sheet');
  const sh = parseSectionTable($, '#shareholding');

  // Quarterly (last 12), oldest -> newest.
  const sales_qtr_series = seriesValues(quarters, findRow(quarters, /sales|revenue/), { last: 12 });
  const material_cost_pct_qtr_series = seriesValues(
    quarters,
    findRow(quarters, /material cost/),
    { last: 12 }
  );

  // Annual P&L (skip TTM column).
  const revenue_series = seriesValues(pl, findRow(pl, /sales|revenue/), { dropTtm: true });
  const opm_series = seriesValues(pl, findRow(pl, /opm/), { dropTtm: true });
  const material_cost_pct_annual_series = seriesValues(
    pl,
    findRow(pl, /material cost/),
    { dropTtm: true }
  );

  // Cash flow (last 10 years).
  const cfo_series = seriesValues(cf, findRow(cf, /cash from operating/), { last: 10 });

  // Balance sheet.
  const net_block_series = seriesValues(bs, findRow(bs, /net block/, /fixed assets/));
  const inventory_series = seriesValues(bs, findRow(bs, /inventor/));

  // Shareholding (last 8 quarters).
  const promoter_holding_series = seriesValues(sh, findRow(sh, /promoter/), { last: 8 });
  const fii_holding_series = seriesValues(sh, findRow(sh, /fii|foreign/), { last: 8 });
  const dii_holding_series = seriesValues(sh, findRow(sh, /dii|domestic/), { last: 8 });

  const promoter_holding = lastOf(promoter_holding_series);
  const fii_holding = lastOf(fii_holding_series);
  const dii_holding = lastOf(dii_holding_series);
  const fiiNum = parseFloat(fii_holding);
  const diiNum = parseFloat(dii_holding);
  const institutional_holding =
    Number.isFinite(fiiNum) || Number.isFinite(diiNum)
      ? round2((Number.isFinite(fiiNum) ? fiiNum : 0) + (Number.isFinite(diiNum) ? diiNum : 0))
      : '';

  // Computed scalars.
  const cp = parseFloat(ribbon.current_price);
  const bv = parseFloat(ribbon.book_value);
  const pb = Number.isFinite(cp) && Number.isFinite(bv) && bv !== 0 ? round2(cp / bv) : '';

  const mc = parseFloat(ribbon.market_cap);
  const latestRev = parseFloat(lastOf(revenue_series));
  const mcap_to_sales =
    Number.isFinite(mc) && Number.isFinite(latestRev) && latestRev !== 0
      ? round2(mc / latestRev)
      : '';

  return {
    financials_view: detectView($),

    stock_pe: ribbon.stock_pe ?? '',
    roce: ribbon.roce ?? '',
    roe: ribbon.roe ?? '',
    book_value: ribbon.book_value ?? '',
    current_price: ribbon.current_price ?? '',
    market_cap: ribbon.market_cap ?? '',
    pb,

    broad_sector: sectorTag($, 'Broad Sector'),
    sector: sectorTag($, 'Sector'),
    industry: sectorTag($, 'Industry'),

    sales_cagr_3y: compounded.sales_cagr_3y ?? '',
    sales_cagr_5y: compounded.sales_cagr_5y ?? '',
    sales_cagr_ttm: compounded.sales_cagr_ttm ?? '',

    sales_qtr_series,
    material_cost_pct_qtr_series,

    revenue_series,
    opm_series,
    material_cost_pct_annual_series,

    cfo_series,

    net_block_series,
    inventory_series,

    promoter_holding_series,
    fii_holding_series,
    dii_holding_series,
    promoter_holding,
    fii_holding,
    dii_holding,
    institutional_holding,

    mcap_to_sales,
  };
}

// Flat CSV from an array of row objects (union of all keys, first-seen order).
// Series stay as pipe-delimited strings.
export function toCsv(rows) {
  const cols = [];
  const seen = new Set();
  for (const r of rows) for (const k of Object.keys(r)) if (!seen.has(k)) { seen.add(k); cols.push(k); }

  const esc = (v) => {
    const s = v == null ? '' : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };

  const lines = [cols.map(esc).join(',')];
  for (const r of rows) lines.push(cols.map((c) => esc(r[c])).join(','));
  return `${lines.join('\n')}\n`;
}
