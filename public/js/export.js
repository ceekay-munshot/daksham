// Client-side Excel export — ExcelJS via CDN (window.ExcelJS). No backend and no
// re-fetch: it works entirely off the records + evaluate() verdicts the dashboard
// already holds. Two entry points: exportGrid (current filtered view, one row per
// company) and exportCompany (a single company's full vertical tear-sheet).

import { CHECK_KEYS } from './evaluate.mjs';

const num = (x) => {
  if (x === '' || x == null) return null;
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
};
const today = () => new Date().toISOString().slice(0, 10);
const slugScope = (s) =>
  String(s || 'all').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'all';

// Short headers for the 8 signal columns (CHECK_KEYS order).
const SIGNAL_HEADERS = {
  yoy_sales_growth_12q: 'YoY Sales ↑ (12Q)',
  yoy_gross_margin_12q: 'YoY GM ↑ (12Q)',
  cfo_rising_3y: 'CFO Rising (3Y)',
  ebitda_gt_110_sales: 'EBITDA > 1.1× Sales',
  sales_fa_below_0_8x: 'Sales/FA < 0.8× avg',
  sales_fa_vs_peers: 'Sales/FA < peers',
  promoter_trend_up: 'Promoter ↑',
  inst_trend_up: 'Institutional ↑',
};

// Qualitative params (own-document lens) — key → short header.
const QUAL_COLS = [
  ['guidance_revenue', 'Q: Rev guidance'],
  ['guidance_margin', 'Q: Margin guidance'],
  ['order_book', 'Q: Order book'],
  ['mgmt_tone', 'Q: Mgmt tone'],
  ['strategic_stocking', 'Q: Stocking'],
  ['market_share', 'Q: Market share'],
  ['demand_anticipation', 'Q: Demand 1-5'],
  ['capital_raised', 'Q: Capital raised'],
];

// Per-cell number formats by param key (real Excel numbers + a display suffix).
const FMT = {
  market_cap: '#,##0',
  pe: '0.0"x"',
  pb: '0.0"x"',
  ev_ebitda: '0.0"x"',
  mcap_to_sales: '0.0"x"',
  roce: '0.0"%"',
  roe: '0.0"%"',
  promoter_holding: '0.0"%"',
  institutional_holding: '0.0"%"',
  sales_cagr_3y: '0.0"%"',
  gross_margin_latest: '0.0"%"',
  gross_margin_3y_increase: '0.0" pp"',
};

const HEAD_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E1B4B' } };
const SECTION_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEEF2FF' } };
const GREEN = { argb: 'FF047857' };
const RED = { argb: 'FFBE123C' };
const GREY = { argb: 'FF94A3B8' };

function styleHeaderRow(row) {
  row.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  row.fill = HEAD_FILL;
  row.alignment = { vertical: 'middle' };
  row.height = 20;
}

function colourVerdict(cell, verdict) {
  const v = String(verdict || '').toUpperCase();
  if (['PASS', 'POSITIVE', 'DISCLOSED'].includes(v)) cell.font = { bold: true, color: GREEN };
  else if (['FAIL', 'NEGATIVE', 'FLAG'].includes(v)) cell.font = { bold: true, color: RED };
  else if (v === 'NA') cell.font = { color: GREY };
}

function download(buffer, filename) {
  const blob = new Blob([buffer], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

const verdictOf = (params, key) => (params && params[key] ? params[key].verdict || '' : '');
const qualVerdict = (qual, key) => (qual && qual.params && qual.params[key] ? qual.params[key].verdict : '');

// ── Grid export — one row per company, honouring the current filtered view ───
export async function exportGrid(records, scope) {
  if (!window.ExcelJS) throw new Error('ExcelJS not loaded');
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Daksham';
  wb.created = new Date();
  const ws = wb.addWorksheet('Companies', { views: [{ state: 'frozen', ySplit: 1 }] });

  const columns = [
    { header: 'Company', key: 'company', width: 28 },
    { header: 'Sector', key: 'sector', width: 18 },
    { header: 'Industry', key: 'industry', width: 22 },
    { header: 'Market Cap (₹ Cr)', key: 'mcap', width: 16, style: { numFmt: '#,##0' } },
    { header: 'CMP (₹)', key: 'cmp', width: 12, style: { numFmt: '#,##0.00' } },
    { header: 'P/E', key: 'pe', width: 9, style: { numFmt: '0.0"x"' } },
    { header: 'P/B', key: 'pb', width: 9, style: { numFmt: '0.0"x"' } },
    { header: 'EV/EBITDA', key: 'evEbitda', width: 11, style: { numFmt: '0.0"x"' } },
    { header: 'M-Cap/Sales', key: 'mcapSales', width: 12, style: { numFmt: '0.0"x"' } },
    { header: 'ROCE %', key: 'roce', width: 9, style: { numFmt: '0.0' } },
    { header: 'ROE %', key: 'roe', width: 9, style: { numFmt: '0.0' } },
    { header: 'Promoter %', key: 'promoter', width: 11, style: { numFmt: '0.0' } },
    { header: 'Institutional %', key: 'inst', width: 13, style: { numFmt: '0.0' } },
    ...CHECK_KEYS.map((k) => ({ header: SIGNAL_HEADERS[k] || k, key: `sig_${k}`, width: 17 })),
    { header: '3Y Sales CAGR %', key: 'salesCagr', width: 15, style: { numFmt: '0.0' } },
    { header: '3Y GM Δ (pp)', key: 'gmDelta', width: 13, style: { numFmt: '0.0' } },
    { header: 'ADTV (₹ Cr)', key: 'adtv', width: 12, style: { numFmt: '0.0' } },
    { header: 'Signals passed', key: 'passed', width: 13, style: { numFmt: '0' } },
    ...QUAL_COLS.map(([k, h]) => ({ header: h, key: `q_${k}`, width: 15 })),
  ];
  ws.columns = columns;
  styleHeaderRow(ws.getRow(1));

  for (const rec of records) {
    const p = rec.params || {};
    const row = rec.row || {};
    const figure = (key) => (p[key] && p[key].output_type === 'raw' ? num(p[key].value) : null);
    const data = {
      company: rec.name || rec.slug || '',
      sector: rec.sector || '',
      industry: rec.industry || '',
      mcap: num(rec.mcap),
      cmp: num(row.cmp ?? row.current_price),
      pe: num(rec.pe),
      pb: num(rec.pb),
      evEbitda: num(rec.evEbitda),
      mcapSales: num(rec.mcapSales),
      roce: num(row.roce),
      roe: num(row.roe),
      promoter: num(row.promoter_holding),
      inst: num(row.institutional_holding),
      salesCagr: figure('sales_cagr_3y'),
      gmDelta: figure('gross_margin_3y_increase'),
      adtv: num(row.adtv_30d_cr ?? rec.adtv),
      passed: rec.pending ? null : rec.passCount,
    };
    for (const k of CHECK_KEYS) data[`sig_${k}`] = verdictOf(p, k);
    for (const [k] of QUAL_COLS) data[`q_${k}`] = qualVerdict(rec.qual, k);
    const r = ws.addRow(data);
    for (const k of CHECK_KEYS) colourVerdict(r.getCell(`sig_${k}`), data[`sig_${k}`]);
  }

  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: columns.length } };
  download(await wb.xlsx.writeBuffer(), `daksham-${slugScope(scope)}-${today()}.xlsx`);
}

// ── Per-company export — a readable vertical tear-sheet ──────────────────────
const COMPANY_SECTIONS = [
  ['Valuation', ['market_cap', 'pe', 'pb', 'ev_ebitda', 'mcap_to_sales']],
  ['Growth & Margins', ['sales_cagr_3y', 'gross_margin_latest', 'gross_margin_3y_increase', 'yoy_sales_growth_12q', 'yoy_gross_margin_12q', 'ebitda_gt_110_sales']],
  ['Cash & Capital', ['cfo_rising_3y', 'sales_fa_below_0_8x', 'sales_fa_vs_peers']],
  ['Ownership', ['promoter_holding', 'institutional_holding', 'promoter_trend_up', 'inst_trend_up']],
];

export async function exportCompany(rec) {
  if (!window.ExcelJS) throw new Error('ExcelJS not loaded');
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Daksham';
  const safeName = String(rec.name || rec.slug || 'company').replace(/[\\/?*[\]:]/g, ' ').slice(0, 28);
  const ws = wb.addWorksheet(safeName || 'Company');
  ws.columns = [
    { key: 'param', width: 38 },
    { key: 'value', width: 28 },
    { key: 'verdict', width: 12 },
    { key: 'note', width: 72 },
  ];
  const p = rec.params || {};

  ws.addRow([rec.name || rec.slug]).getCell(1).font = { bold: true, size: 16 };
  ws.addRow([[rec.sector, rec.industry].filter(Boolean).join('  ·  ')]).getCell(1).font = { color: GREY, size: 11 };
  ws.addRow([rec.pending ? 'Metrics pending — newly liquid' : `Signals passed: ${rec.passCount}/${rec.applicable}`]).getCell(1).font = {
    italic: true,
    color: { argb: 'FF475569' },
  };
  ws.addRow([]);

  const hdr = ws.addRow(['Parameter', 'Value', 'Verdict', 'Note']);
  styleHeaderRow(hdr);
  ws.views = [{ state: 'frozen', ySplit: hdr.number }];

  const sectionRow = (title) => {
    const r = ws.addRow([title]);
    for (let c = 1; c <= 4; c++) r.getCell(c).fill = SECTION_FILL;
    r.getCell(1).font = { bold: true, color: { argb: 'FF3730A3' } };
  };
  const addParam = (param) => {
    if (!param) return;
    const r = ws.addRow([param.label, '', param.verdict || '', param.note || '']);
    const n = param.output_type === 'raw' ? num(param.value) : null;
    if (n !== null) {
      r.getCell(2).value = n;
      r.getCell(2).numFmt = FMT[param.key] || '0.00';
    } else {
      r.getCell(2).value = String(param.value ?? '');
    }
    colourVerdict(r.getCell(3), param.verdict);
  };

  for (const [title, keys] of COMPANY_SECTIONS) {
    sectionRow(title);
    for (const k of keys) addParam(p[k]);
  }

  sectionRow('Qualitative · own-document lens');
  if (rec.qual && rec.qual.params) {
    for (const [k] of QUAL_COLS) {
      const q = rec.qual.params[k];
      if (!q) continue;
      const r = ws.addRow([q.label, String(q.value ?? ''), q.verdict || '', q.note || '']);
      colourVerdict(r.getCell(3), q.verdict);
    }
  } else {
    ws.addRow(['AI extraction pending for this company', '', '', '']).getCell(1).font = { italic: true, color: GREY };
  }

  download(await wb.xlsx.writeBuffer(), `daksham-${slugScope(rec.name || rec.slug)}-${today()}.xlsx`);
}
