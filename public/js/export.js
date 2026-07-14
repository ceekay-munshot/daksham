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

// Structured qualitative columns (own-document lens) — mirrors PARAMS[].fields in
// scrapers/lib/qualitative.mjs. Each is a NUMBER you can threshold on or a fixed
// ENUM you can multi-select — never a bare "was it mentioned" flag. `demand` is the
// standalone 1–5 scale (the param's verdict, not a sub-field).
const QUAL_COLUMNS = [
  { param: 'guidance_revenue', field: 'rev_low_pct', header: 'Rev guid – Low %', kind: 'num' },
  { param: 'guidance_revenue', field: 'rev_high_pct', header: 'Rev guid – High %', kind: 'num' },
  { param: 'guidance_revenue', field: 'rev_vs_prior', header: 'Rev guid vs prior', kind: 'enum' },
  { param: 'guidance_margin', field: 'margin_direction', header: 'Margin – Direction', kind: 'enum' },
  { param: 'guidance_margin', field: 'margin_level_pct', header: 'Margin – Level %', kind: 'num' },
  { param: 'order_book', field: 'ob_trend', header: 'Order book trend', kind: 'enum' },
  { param: 'order_book', field: 'ob_size_cr', header: 'Order book (₹ Cr)', kind: 'num' },
  { param: 'order_book', field: 'ob_book_to_bill', header: 'Book-to-bill (x)', kind: 'num' },
  { param: 'mgmt_tone', field: 'tone_grade', header: 'Mgmt tone', kind: 'enum' },
  { param: 'strategic_stocking', field: 'stocking_grade', header: 'Channel stocking', kind: 'enum' },
  { param: 'market_share', field: 'ms_trend', header: 'Market share trend', kind: 'enum' },
  { param: 'demand_anticipation', field: null, header: 'Forward demand (1=strong…5=weak)', kind: 'demand' },
  { param: 'capital_raised', field: 'cap_amount_cr', header: 'Capital raised (₹ Cr)', kind: 'num' },
  { param: 'capital_raised', field: 'cap_purpose', header: 'Capital purpose', kind: 'enum' },
  { param: 'capital_raised', field: 'cap_dilution_pct', header: 'Dilution %', kind: 'num' },
];

// Coverage flag (the client's NA-disambiguation): "Covered" = we read ≥1 of this
// company's own transcripts; "Not covered" = none harvested, so every blank qual
// cell means "we haven't looked", not "management didn't disclose". A blank enum on
// a COVERED row reads as "Not disclosed" (management didn't say).
const isCovered = (rec) => !!(rec.qual && rec.qual.meta && Number(rec.qual.meta.docs_used) > 0);

// Read one structured qual value for a record, honouring coverage. Numbers → number
// or null; enums → the category, or 'Not covered' when the company was never read.
function qualCell(rec, col) {
  const covered = isCovered(rec);
  if (col.kind === 'demand') {
    const v = rec.qual && rec.qual.params && rec.qual.params.demand_anticipation;
    if (!covered) return { text: 'Not covered' };
    const n = v && /^[1-5]$/.test(String(v.verdict)) ? Number(v.verdict) : null;
    return { number: n };
  }
  const p = rec.qual && rec.qual.params && rec.qual.params[col.param];
  const f = p && p.fields ? p.fields[col.field] : undefined;
  if (col.kind === 'num') {
    return { number: covered && typeof f === 'number' ? f : null };
  }
  // enum
  if (!covered) return { text: 'Not covered' };
  return { text: f || 'Not disclosed' };
}

// Excel column key + number format per structured qual field.
const qkey = (col) => `q_${col.field || col.param}`;
const QUAL_FMT = {
  rev_low_pct: '0.0', rev_high_pct: '0.0', margin_level_pct: '0.0', cap_dilution_pct: '0.0',
  ob_size_cr: '#,##0', cap_amount_cr: '#,##0', ob_book_to_bill: '0.00',
};

// Moat / Porter factors (industry lens) — key → short header. Scored 0–5 on
// TREND, higher = more favorable. The grid export carries the company's OWN
// (own-concall) read per factor; the per-company sheet shows all three lenses.
const MOAT_COLS = [
  ['competition', 'Moat: Competition'],
  ['barriers_to_entry', 'Moat: Barriers'],
  ['buyer_power', 'Moat: Buyer power'],
  ['supplier_power', 'Moat: Supplier power'],
  ['substitution_risk', 'Moat: Substitution'],
  ['china_imports', 'Moat: China imports'],
  ['govt_regulation', 'Moat: Govt/regln'],
  ['inventory_buildup', 'Moat: Inventory'],
];

// A moat lens sub-object → its 0–5 score (or null). trend arrow for display.
const TREND_ARROW = { improving: '↑', stable: '→', worsening: '↓' };
const lensScore = (o) => (o && typeof o.score === 'number' ? o.score : null);
const moatOwnScore = (rec, key) => {
  const f = rec.moat && rec.moat.factors && rec.moat.factors[key];
  return f ? lensScore(f.own) : null;
};
function colourMoat(cell, score) {
  if (score == null) return;
  cell.font = score >= 4 ? { bold: true, color: GREEN } : score < 2 ? { bold: true, color: RED } : { color: GREY };
}

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
    { header: 'Qual coverage', key: 'qual_cov', width: 13 },
    ...QUAL_COLUMNS.map((col) => {
      const c = { header: col.header, key: qkey(col), width: col.kind === 'enum' ? 16 : 14 };
      if (col.kind === 'num') c.style = { numFmt: QUAL_FMT[col.field] || '0.0' };
      else if (col.kind === 'demand') c.style = { numFmt: '0' };
      return c;
    }),
    ...MOAT_COLS.map(([k, h]) => ({ header: h, key: `m_${k}`, width: 13, style: { numFmt: '0' } })),
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
    data.qual_cov = isCovered(rec) ? 'Covered' : 'Not covered';
    for (const col of QUAL_COLUMNS) {
      const cell = qualCell(rec, col);
      data[qkey(col)] = 'number' in cell ? cell.number : cell.text;
    }
    for (const [k] of MOAT_COLS) data[`m_${k}`] = moatOwnScore(rec, k);
    const r = ws.addRow(data);
    for (const k of CHECK_KEYS) colourVerdict(r.getCell(`sig_${k}`), data[`sig_${k}`]);
    if (data.qual_cov === 'Not covered') r.getCell('qual_cov').font = { color: GREY };
    for (const [k] of MOAT_COLS) colourMoat(r.getCell(`m_${k}`), data[`m_${k}`]);
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
    const covered = isCovered(rec);
    ws.addRow(['Coverage', covered ? 'Covered — own transcript(s) read' : 'Not covered — no transcript harvested', '', '']).getCell(2).font = covered
      ? { color: GREEN }
      : { color: GREY };
    for (const pk of [...new Set(QUAL_COLUMNS.map((c) => c.param))]) {
      const q = rec.qual.params[pk];
      if (!q) continue;
      const r = ws.addRow([q.label, String(q.value ?? ''), q.verdict || '', q.note || '']);
      colourVerdict(r.getCell(3), q.verdict);
      // Structured sub-fields, indented — the deep file mirrors the master columns.
      for (const col of QUAL_COLUMNS.filter((c) => c.param === pk && c.field)) {
        const cell = qualCell(rec, col);
        const val = 'number' in cell ? (cell.number == null ? '' : cell.number) : cell.text;
        ws.addRow([`    • ${col.header}`, val, '', '']).getCell(1).font = { color: GREY };
      }
    }
  } else {
    ws.addRow(['AI extraction pending for this company', '', '', '']).getCell(1).font = { italic: true, color: GREY };
  }

  sectionRow('Moat · Porter factors (0–5 on trend, higher = more favorable)');
  if (rec.moat && rec.moat.factors) {
    const lensCell = (o) => (lensScore(o) != null ? `${o.score}/5 ${TREND_ARROW[o.trend] || ''}`.trim() : 'N/A');
    for (const [k] of MOAT_COLS) {
      const f = rec.moat.factors[k];
      if (!f) continue;
      const own = f.own || {};
      const news = rec.news && rec.news.factors ? rec.news.factors[k] : null;
      const val = `Own ${lensCell(own)} · Peers ${lensCell(f.industry)}${news ? ` · News ${lensCell(news)}` : ''}`;
      const score = lensScore(own);
      const r = ws.addRow([f.label || k, val, score != null ? String(score) : '', own.note || '']);
      colourMoat(r.getCell(3), score);
    }
  } else {
    ws.addRow(['Moat / industry lens pending for this company', '', '', '']).getCell(1).font = { italic: true, color: GREY };
  }

  download(await wb.xlsx.writeBuffer(), `daksham-${slugScope(rec.name || rec.slug)}-${today()}.xlsx`);
}
