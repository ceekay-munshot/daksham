// Per-company dossier — a centered modal tear-sheet. Trend rows are clickable
// and open the full chart (chart.js) with a Screener source link.

import { CHECK_KEYS } from './evaluate.mjs';
import { esc, inrCr, price, mult, fmtMetric, pill, qualPill } from './format.js';
import { sectorChip } from './sectors.js';
import { sparkline } from './sparkline.js';
import { openChart } from './chart.js';
import { exportCompany } from './export.js';

const parseNums = (s) =>
  String(s ?? '')
    .split('|')
    .map((x) => x.trim())
    .filter((x) => x !== '')
    .map(Number)
    .filter(Number.isFinite);

// Section layout: params, icons, and (for trend rows) the series + chart meta.
// `src` is the Screener company-page anchor used for the verify-source link.
const SECTIONS = [
  {
    title: 'Valuation',
    icon: 'scale',
    grad: 'linear-gradient(135deg,#6366f1,#4f46e5)',
    rows: [
      { key: 'pe', icon: 'gauge' },
      { key: 'pb', icon: 'book-open' },
      { key: 'ev_ebitda', icon: 'scale' },
      { key: 'mcap_to_sales', icon: 'ruler' },
    ],
  },
  {
    title: 'Growth & Margins',
    icon: 'trending-up',
    grad: 'linear-gradient(135deg,#a855f7,#7c3aed)',
    rows: [
      { key: 'sales_cagr_3y', icon: 'trending-up' },
      { key: 'gross_margin_latest', icon: 'percent' },
      { key: 'gross_margin_3y_increase', icon: 'arrow-up-right' },
      { key: 'yoy_sales_growth_12q', icon: 'line-chart', series: 'sales_qtr_series', unit: '₹ Cr', src: 'quarters', chart: 'Quarterly Sales' },
      { key: 'yoy_gross_margin_12q', icon: 'activity', transform: 'gm', series: 'material_cost_pct_qtr_series', unit: '%', src: 'quarters', chart: 'Quarterly Gross Margin' },
      { key: 'ebitda_gt_110_sales', icon: 'zap', transform: 'ebitda', unit: '₹ Cr', src: 'profit-loss', chart: 'Annual EBITDA' },
    ],
  },
  {
    title: 'Cash & Capital',
    icon: 'wallet',
    grad: 'linear-gradient(135deg,#0ea5e9,#0284c7)',
    rows: [
      { key: 'cfo_rising_3y', icon: 'wallet', series: 'cfo_series', unit: '₹ Cr', src: 'cash-flow', chart: 'Operating Cash Flow' },
      { key: 'sales_fa_below_0_8x', icon: 'factory' },
      { key: 'sales_fa_vs_peers', icon: 'bar-chart-3' },
    ],
  },
  {
    title: 'Ownership',
    icon: 'users',
    grad: 'linear-gradient(135deg,#f59e0b,#d97706)',
    rows: [
      { key: 'promoter_holding', icon: 'user-check', series: 'promoter_holding_series', unit: '%', src: 'shareholding', chart: 'Promoter Holding' },
      { key: 'institutional_holding', icon: 'landmark', transform: 'inst', unit: '%', src: 'shareholding', chart: 'Institutional Holding (FII + DII)' },
      { key: 'promoter_trend_up', icon: 'users', series: 'promoter_holding_series', unit: '%', src: 'shareholding', chart: 'Promoter Holding' },
      { key: 'inst_trend_up', icon: 'briefcase', transform: 'inst', unit: '%', src: 'shareholding', chart: 'Institutional Holding (FII + DII)' },
    ],
  },
];

function getSeries(row, cfg) {
  if (cfg.transform === 'inst') {
    const f = parseNums(row.fii_holding_series);
    const d = parseNums(row.dii_holding_series);
    const n = Math.min(f.length, d.length);
    const fs = f.slice(-n);
    const ds = d.slice(-n);
    return fs.map((x, i) => x + ds[i]);
  }
  if (cfg.transform === 'ebitda') {
    const r = parseNums(row.revenue_series);
    const o = parseNums(row.opm_series);
    const n = Math.min(r.length, o.length);
    const rs = r.slice(-n);
    const os = o.slice(-n);
    return rs.map((x, i) => (x * os[i]) / 100);
  }
  let v = parseNums(row[cfg.series]);
  if (cfg.transform === 'gm') v = v.map((x) => 100 - x);
  return v;
}

function paramRow(p, row, cfg, store) {
  if (!p) return '';
  const isRaw = p.output_type === 'raw';

  let main = `<div class="prow-label">${esc(p.label)}</div>`;
  if (!isRaw && p.value !== '' && p.value != null) main += `<div class="prow-subval">${esc(String(p.value))}</div>`;
  if (p.note) main += `<div class="prow-note">${esc(p.note)}</div>`;

  let trend = '';
  if (cfg.series || cfg.transform) {
    const vals = getSeries(row, cfg);
    if (vals.length >= 2) {
      const id = `c${store.n++}`;
      store.map[id] = {
        title: cfg.chart || p.label,
        subtitle: `${vals.length} periods · oldest → latest`,
        values: vals,
        unit: cfg.unit || '',
        source: {
          label: 'Screener.in',
          url: `https://www.screener.in${row.path || ''}${cfg.src ? `#${cfg.src}` : ''}`,
        },
      };
      trend = `<button class="trend-btn" data-chart="${id}" title="Open trend chart">
        ${sparkline(vals, { w: 72, h: 26 })}<span class="trend-ic"><i data-lucide="expand"></i></span></button>`;
    }
  }

  const right = trend + (isRaw ? `<span class="prow-val">${fmtMetric(p.key, p.value)}</span>` : pill(p));
  return `<div class="prow">
    <span class="prow-ic"><i data-lucide="${cfg.icon || 'circle'}"></i></span>
    <div class="prow-main">${main}</div>
    <div class="prow-right">${right}</div>
  </div>`;
}

function sectionHtml(sec, rec, store) {
  return `<div class="dsection">
    <div class="dsection-head">
      <span class="sec-ic" style="--sec-grad:${sec.grad}"><i data-lucide="${sec.icon}"></i></span>
      <span class="dsection-title">${sec.title}</span>
    </div>
    ${sec.rows.map((cfg) => paramRow(rec.params[cfg.key], rec.row, cfg, store)).join('')}
  </div>`;
}

// ── Qualitative · own-document lens (AI extraction) ──────────────────────────
const QUAL_ORDER = [
  'guidance_revenue', 'guidance_margin', 'order_book', 'mgmt_tone',
  'strategic_stocking', 'market_share', 'demand_anticipation', 'capital_raised',
];
const QUAL_ICONS = {
  guidance_revenue: 'trending-up', guidance_margin: 'percent', order_book: 'clipboard-list',
  mgmt_tone: 'mic', strategic_stocking: 'package', market_share: 'pie-chart',
  demand_anticipation: 'radar', capital_raised: 'banknote',
};

// The exact source URL for a given quarter's document (from the harvest manifest),
// and a chip-list of all the source PDFs an AI section was extracted from — so
// every read links straight to where it came from.
function docLink(rec, period, type = 'transcript') {
  const d = (rec.docs || []).find((x) => x.type === type && x.period === period && x.source);
  return d ? d.source : '';
}
function sourceChips(rec) {
  const docs = (rec.docs || []).filter((d) => d && d.source);
  if (!docs.length) return '';
  const chips = docs
    .map((d) => {
      const label = d.type === 'ppt' ? `Investor PPT ${d.period}` : `Concall ${d.period}`;
      return `<a class="src-pill" href="${esc(d.source)}" target="_blank" rel="noopener" title="Open the source PDF">
        <i data-lucide="file-text"></i>${esc(label)}<i data-lucide="external-link" class="src-pill-ext"></i></a>`;
    })
    .join('');
  return `<div class="src-pills"><span class="src-pills-lbl">Sources</span>${chips}</div>`;
}

function qualRow(p, rec) {
  if (!p) return '';
  let main = `<div class="prow-label">${esc(p.label)}</div>`;
  if (p.value) main += `<div class="prow-subval">${esc(String(p.value))}</div>`;
  if (p.note) main += `<div class="prow-note">${esc(p.note)}</div>`;
  const meta = [];
  if (p.verdict !== 'NA' && p.source) {
    const url = docLink(rec, p.source);
    meta.push(
      url
        ? `<a class="qmeta-src qmeta-link" href="${esc(url)}" target="_blank" rel="noopener" title="Open the ${esc(p.source)} concall">${esc(p.source)} ↗</a>`
        : `<span class="qmeta-src">${esc(p.source)}</span>`
    );
  }
  if (p.verdict !== 'NA' && p.confidence) meta.push(`<span class="qmeta-conf qconf-${esc(p.confidence)}">${esc(p.confidence)} confidence</span>`);
  if (meta.length) main += `<div class="prow-meta">${meta.join('')}</div>`;
  return `<div class="prow">
    <span class="prow-ic"><i data-lucide="${QUAL_ICONS[p.key] || 'sparkles'}"></i></span>
    <div class="prow-main">${main}</div>
    <div class="prow-right">${qualPill(p)}</div>
  </div>`;
}

function qualHtml(rec) {
  const head = (sub) => `<div class="dsection-head">
    <span class="sec-ic" style="--sec-grad:linear-gradient(135deg,#14b8a6,#0d9488)"><i data-lucide="message-square-quote"></i></span>
    <span class="dsection-title">Qualitative · own-document lens</span>
    <span class="dsection-sub">${sub}</span>
  </div>`;

  if (!rec.qual || !rec.qual.params) {
    return `<div class="dsection">${head('AI read pending')}
      <div class="prow">
        <span class="prow-ic"><i data-lucide="hourglass"></i></span>
        <div class="prow-main"><div class="prow-note">Not yet extracted — run the AI qualitative extraction workflow to fill these from the company's concalls &amp; investor PPT.</div></div>
        <div class="prow-right"><span class="pill pill-soon">Pending</span></div>
      </div></div>`;
  }

  const params = rec.qual.params;
  const real = QUAL_ORDER.filter((k) => params[k] && params[k].verdict !== 'NA').length;
  const latest = rec.qual.meta && rec.qual.meta.source ? ` · latest ${esc(rec.qual.meta.source)}` : '';
  const rows = QUAL_ORDER.map((k) => qualRow(params[k], rec)).join('');
  return `<div class="dsection">${head(`${real}/8 from management commentary${latest}`)}${rows}${sourceChips(rec)}</div>`;
}

// ── Moat & Qualitative · industry lens (Porter-style, trend-scored 0-5) ──────
const MOAT_ORDER = [
  'competition', 'barriers_to_entry', 'buyer_power', 'supplier_power',
  'substitution_risk', 'china_imports', 'govt_regulation', 'inventory_buildup',
];
const MOAT_ICONS = {
  competition: 'swords', barriers_to_entry: 'shield-check', buyer_power: 'shopping-cart',
  supplier_power: 'truck', substitution_risk: 'repeat', china_imports: 'ship',
  govt_regulation: 'landmark', inventory_buildup: 'package',
};

// 0-5 score chip (higher = more favorable) with a trend arrow; NA when not discussed.
function moatScore(f) {
  if (!f || f.trend === 'NA' || f.score == null) return '<span class="moat-cell moat-na">N/A</span>';
  const cls = f.score >= 4 ? 'ms-good' : f.score >= 2 ? 'ms-mid' : 'ms-bad';
  const arrow = { improving: '↑', stable: '→', worsening: '↓' }[f.trend] || '';
  return `<span class="moat-cell ${cls}" title="${esc(f.trend)} trend · ${esc(f.confidence || '')} confidence">${arrow} ${f.score}/5</span>`;
}

function moatRow(factor) {
  if (!factor) return '';
  const own = factor.own || {};
  const ind = factor.industry || {};
  const note = own.trend && own.trend !== 'NA' && own.note ? own.note : ind.note || '';
  return `<div class="prow">
    <span class="prow-ic"><i data-lucide="${MOAT_ICONS[factor.key] || 'shield'}"></i></span>
    <div class="prow-main">
      <div class="prow-label">${esc(factor.label)}</div>
      <div class="moat-scores"><span class="moat-tag">Own</span>${moatScore(own)}<span class="moat-tag">Industry</span>${moatScore(ind)}</div>
      ${note ? `<div class="prow-note">${esc(note)}</div>` : ''}
    </div>
  </div>`;
}

function moatHtml(rec) {
  const moat = rec.moat;
  const head = (sub) => `<div class="dsection-head">
    <span class="sec-ic" style="--sec-grad:linear-gradient(135deg,#64748b,#475569)"><i data-lucide="shield"></i></span>
    <span class="dsection-title">Moat &amp; Qualitative · industry lens</span>
    <span class="dsection-sub">${sub}</span>
  </div>`;
  if (!moat || !moat.factors) {
    return `<div class="dsection">${head('AI lens pending')}
      <div class="prow">
        <span class="prow-ic"><i data-lucide="hourglass"></i></span>
        <div class="prow-main"><div class="prow-note">Industry / moat factors not yet extracted — run the AI industry / moat lens workflow.</div></div>
        <div class="prow-right"><span class="pill pill-soon">Pending</span></div>
      </div></div>`;
  }
  const rows = MOAT_ORDER.map((k) => moatRow(moat.factors[k])).join('');
  return `<div class="dsection">${head(`${esc(moat.industry_name || '')} · own vs peers`)}${rows}${sourceChips(rec)}
    <div class="moat-foot"><b>Own</b> from this company's concalls (linked above); <b>Industry</b> from ${esc(moat.industry_name || 'sector')} peers' concalls. Scored on TREND, 0–5, higher = more favorable; comparable within the industry only. Third-party news lens — coming next.</div>
  </div>`;
}

function heroSignals(params) {
  let pass = 0;
  let applicable = 0;
  const dots = CHECK_KEYS.map((k) => {
    const v = params[k].verdict;
    if (v === 'PASS') {
      pass += 1;
      applicable += 1;
      return '<span class="sdot dot-pass"></span>';
    }
    if (v === 'FAIL') {
      applicable += 1;
      return '<span class="sdot dot-fail"></span>';
    }
    return '<span class="sdot dot-na"></span>';
  }).join('');
  return `<div class="dossier-signal-ring">
    <div><div class="dossier-stat-num">${pass}<span class="den">/${applicable}</span></div>
    <div class="dossier-stat-lbl">Green signals</div></div>
    <span class="signals-dots" style="margin-left:auto;gap:5px">${dots}</span>
  </div>`;
}

let elDossier;
let elOverlay;
let charts = {};
let currentRec = null;

async function handleExport(btn) {
  if (!currentRec) return;
  const span = btn.querySelector('span');
  const orig = span ? span.textContent : '';
  btn.disabled = true;
  if (span) span.textContent = 'Preparing…';
  try {
    await exportCompany(currentRec);
  } catch (err) {
    console.error(err);
    alert(`Export failed: ${err.message}`);
  } finally {
    btn.disabled = false;
    if (span) span.textContent = orig;
  }
}

export function initDossier() {
  elDossier = document.getElementById('dossier');
  elOverlay = document.getElementById('dossier-overlay');
  elOverlay.addEventListener('click', (e) => {
    if (e.target === elOverlay) closeDossier();
  });
  elDossier.addEventListener('click', (e) => {
    const exp = e.target.closest('[data-export]');
    if (exp) return handleExport(exp);
    if (e.target.closest('[data-close]')) return closeDossier();
    const btn = e.target.closest('[data-chart]');
    if (btn && charts[btn.dataset.chart]) openChart(charts[btn.dataset.chart]);
  });
}

export const isDossierOpen = () => !!elDossier && elDossier.classList.contains('show');

export function openDossier(rec) {
  currentRec = rec;
  const r = rec.row;

  if (rec.pending) {
    charts = {};
    const screener = `https://www.screener.in${r.path || ''}`;
    elDossier.innerHTML = `
      <div class="dossier-hero">
        <div class="glow"></div>
        <button class="modal-close" data-close aria-label="Close"><i data-lucide="x"></i></button>
        <div class="dossier-name">${esc(rec.name)}</div>
        <div class="dossier-tags">${sectorChip(rec.sector)}<span class="dossier-ind">${esc(rec.industry || '')}</span></div>
        <div class="dossier-statline">
          <div><div class="dossier-stat-num">${inrCr(rec.mcap)}</div><div class="dossier-stat-lbl">Market Cap</div></div>
          <div><div class="dossier-stat-num">${price(r.cmp ?? r.current_price)}</div><div class="dossier-stat-lbl">CMP</div></div>
          <div><div class="dossier-stat-num">${mult(rec.evEbitda)}</div><div class="dossier-stat-lbl">EV / EBITDA</div></div>
          <div><div class="dossier-stat-num">${rec.adtv != null ? `₹${rec.adtv.toFixed(1)} Cr` : '—'}</div><div class="dossier-stat-lbl">ADV · 30d</div></div>
        </div>
      </div>
      <div class="dossier-body">
        <div class="pending-card">
          <span class="pending-ic"><i data-lucide="hourglass"></i></span>
          <div class="pending-title">Metrics pending</div>
          <p>This name just entered the liquid universe (avg daily traded value ≥ ₹4 Cr over the last 30 sessions). Its full fundamentals and signal checks are gathered on the next weekly refresh.</p>
          <a class="src-chip" href="${esc(screener)}" target="_blank" rel="noopener">
            <span class="src-ic"><i data-lucide="shield-check"></i></span><span>View on <b>Screener.in</b></span><i data-lucide="external-link" class="src-ext"></i>
          </a>
        </div>
      </div>`;
    finishOpen();
    return;
  }

  const store = { n: 0, map: {} };
  const body = SECTIONS.map((s) => sectionHtml(s, rec, store)).join('') + qualHtml(rec) + moatHtml(rec);
  charts = store.map;

  elDossier.innerHTML = `
    <div class="dossier-hero">
      <div class="glow"></div>
      <button class="dossier-export" data-export title="Export this company to Excel"><i data-lucide="file-spreadsheet"></i><span>Export</span></button>
      <button class="modal-close" data-close aria-label="Close"><i data-lucide="x"></i></button>
      <div class="dossier-name">${esc(rec.name)}</div>
      <div class="dossier-tags">${sectorChip(rec.sector)}<span class="dossier-ind">${esc(rec.industry || '')}</span></div>
      <div class="dossier-statline">
        <div><div class="dossier-stat-num">${inrCr(rec.mcap)}</div><div class="dossier-stat-lbl">Market Cap</div></div>
        <div><div class="dossier-stat-num">${price(r.cmp ?? r.current_price)}</div><div class="dossier-stat-lbl">CMP</div></div>
        <div><div class="dossier-stat-num">${mult(rec.evEbitda)}</div><div class="dossier-stat-lbl">EV / EBITDA</div></div>
        <div><div class="dossier-stat-num" style="text-transform:capitalize">${esc(r.financials_view || '—')}</div><div class="dossier-stat-lbl">Statements</div></div>
      </div>
      ${heroSignals(rec.params)}
    </div>
    <div class="dossier-body">${body}</div>`;

  finishOpen();
}

function finishOpen() {
  elDossier.setAttribute('aria-hidden', 'false');
  elDossier.scrollTop = 0;
  elOverlay.classList.remove('hidden');
  requestAnimationFrame(() => {
    elOverlay.classList.add('show');
    elDossier.classList.add('show');
  });
  if (window.lucide) window.lucide.createIcons();
  document.body.style.overflow = 'hidden';
}

export function closeDossier() {
  if (!isDossierOpen()) return;
  elDossier.classList.remove('show');
  elOverlay.classList.remove('show');
  elDossier.setAttribute('aria-hidden', 'true');
  document.body.style.overflow = '';
  setTimeout(() => elOverlay.classList.add('hidden'), 320);
}
