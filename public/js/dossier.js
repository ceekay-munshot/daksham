// Per-company dossier — a centered modal tear-sheet. Trend rows are clickable
// and open the full chart (chart.js) with a Screener source link.

import { CHECK_KEYS } from './evaluate.mjs';
import { esc, inrCr, price, mult, fmtMetric, pill } from './format.js';
import { sectorChip } from './sectors.js';
import { sparkline } from './sparkline.js';
import { openChart } from './chart.js';

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

function moatHtml(rec) {
  const deferred = Object.values(rec.params).filter((p) => p.output_type === 'deferred');
  const rows = deferred
    .map(
      (p) => `<div class="prow">
        <span class="prow-ic"><i data-lucide="sparkles"></i></span>
        <div class="prow-main"><div class="prow-label">${esc(p.label)}</div><div class="prow-note">${esc(p.note)}</div></div>
        <div class="prow-right">${pill(p)}</div>
      </div>`
    )
    .join('');
  return `<div class="dsection">
    <div class="dsection-head">
      <span class="sec-ic" style="--sec-grad:linear-gradient(135deg,#64748b,#475569)"><i data-lucide="shield"></i></span>
      <span class="dsection-title">Moat &amp; Qualitative</span>
      <span class="dsection-sub">${deferred.length} on the roadmap</span>
    </div>
    ${rows}
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

export function initDossier() {
  elDossier = document.getElementById('dossier');
  elOverlay = document.getElementById('dossier-overlay');
  elOverlay.addEventListener('click', (e) => {
    if (e.target === elOverlay) closeDossier();
  });
  elDossier.addEventListener('click', (e) => {
    if (e.target.closest('[data-close]')) return closeDossier();
    const btn = e.target.closest('[data-chart]');
    if (btn && charts[btn.dataset.chart]) openChart(charts[btn.dataset.chart]);
  });
}

export const isDossierOpen = () => !!elDossier && elDossier.classList.contains('show');

export function openDossier(rec) {
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
  const body = SECTIONS.map((s) => sectionHtml(s, rec, store)).join('') + moatHtml(rec);
  charts = store.map;

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
