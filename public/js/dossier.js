// Per-company dossier — a polished slide-over tear sheet.

import { CHECK_KEYS } from './evaluate.mjs';
import { esc, inrCr, price, mult, fmtMetric, pill } from './format.js';
import { sectorChip } from './sectors.js';
import { sparkline } from './sparkline.js';

const parseNums = (s) =>
  String(s ?? '')
    .split('|')
    .map((x) => x.trim())
    .filter((x) => x !== '')
    .map(Number)
    .filter(Number.isFinite);

// Section layout: which params, their icons, and any series to sparkline.
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
      { key: 'gross_margin_3y_increase', icon: 'percent-diamond' },
      { key: 'yoy_sales_growth_12q', icon: 'line-chart', series: 'sales_qtr_series' },
      { key: 'yoy_gross_margin_12q', icon: 'activity', series: 'material_cost_pct_qtr_series', transform: 'gm' },
      { key: 'ebitda_gt_110_sales', icon: 'zap', series: 'revenue_series' },
    ],
  },
  {
    title: 'Cash & Capital',
    icon: 'wallet',
    grad: 'linear-gradient(135deg,#34d399,#10b981)',
    rows: [
      { key: 'cfo_rising_3y', icon: 'wallet', series: 'cfo_series' },
      { key: 'sales_fa_below_0_8x', icon: 'factory' },
    ],
  },
  {
    title: 'Ownership',
    icon: 'users',
    grad: 'linear-gradient(135deg,#f59e0b,#d97706)',
    rows: [
      { key: 'promoter_holding', icon: 'user-check' },
      { key: 'institutional_holding', icon: 'landmark' },
      { key: 'promoter_trend_up', icon: 'users', series: 'promoter_holding_series' },
      { key: 'inst_trend_up', icon: 'briefcase', series: 'inst' },
    ],
  },
];

function getSeries(row, cfg) {
  if (cfg.series === 'inst') {
    const f = parseNums(row.fii_holding_series);
    const d = parseNums(row.dii_holding_series);
    const n = Math.min(f.length, d.length);
    return f.slice(-n).map((x, i) => x + d.slice(-n)[i]);
  }
  let v = parseNums(row[cfg.series]);
  if (cfg.transform === 'gm') v = v.map((x) => 100 - x);
  return v;
}

function paramRow(p, row, cfg) {
  if (!p) return '';
  const isRaw = p.output_type === 'raw';

  let main = `<div class="prow-label">${esc(p.label)}</div>`;
  if (!isRaw && p.value !== '' && p.value != null) main += `<div class="prow-subval">${esc(String(p.value))}</div>`;
  if (p.note) main += `<div class="prow-note">${esc(p.note)}</div>`;

  let right = '';
  if (cfg.series) {
    const vals = getSeries(row, cfg);
    if (vals.length >= 2) right += `<span class="prow-spark">${sparkline(vals)}</span>`;
  }
  right += isRaw ? `<span class="prow-val">${fmtMetric(p.key, p.value)}</span>` : pill(p);

  return `<div class="prow">
    <span class="prow-ic"><i data-lucide="${cfg.icon || 'circle'}"></i></span>
    <div class="prow-main">${main}</div>
    <div class="prow-right">${right}</div>
  </div>`;
}

function sectionHtml(sec, rec) {
  const rows = sec.rows.map((cfg) => paramRow(rec.params[cfg.key], rec.row, cfg)).join('');
  return `<div class="dsection">
    <div class="dsection-head">
      <span class="sec-ic" style="--sec-grad:${sec.grad}"><i data-lucide="${sec.icon}"></i></span>
      <span class="dsection-title">${sec.title}</span>
    </div>
    ${rows}
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
    <div><div class="dossier-stat-num">${pass}<span style="opacity:.6;font-size:13px">/${applicable}</span></div>
    <div class="dossier-stat-lbl">Green signals</div></div>
    <span class="signals-dots" style="margin-left:auto;gap:5px">${dots}</span>
  </div>`;
}

let elDossier;
let elOverlay;

export function initDossier() {
  elDossier = document.getElementById('dossier');
  elOverlay = document.getElementById('dossier-overlay');
  elOverlay.addEventListener('click', closeDossier);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeDossier();
  });
}

export function openDossier(rec) {
  const r = rec.row;
  const html = `
    <div class="dossier-hero">
      <div class="glow"></div>
      <button class="dossier-close" data-close aria-label="Close"><i data-lucide="x"></i></button>
      <div class="dossier-name">${esc(rec.name)}</div>
      <div style="margin-top:10px;display:flex;align-items:center;gap:10px;flex-wrap:wrap">
        ${sectorChip(rec.sector)}
        <span style="font-size:12px;color:#c0c5ea">${esc(rec.industry || '')}</span>
      </div>
      <div class="dossier-statline">
        <div><div class="dossier-stat-num">${inrCr(rec.mcap)}</div><div class="dossier-stat-lbl">Market Cap</div></div>
        <div><div class="dossier-stat-num">${price(r.cmp ?? r.current_price)}</div><div class="dossier-stat-lbl">CMP</div></div>
        <div><div class="dossier-stat-num">${mult(rec.evEbitda)}</div><div class="dossier-stat-lbl">EV/EBITDA</div></div>
        <div><div class="dossier-stat-num" style="text-transform:capitalize">${esc(r.financials_view || '—')}</div><div class="dossier-stat-lbl">Statements</div></div>
      </div>
      ${heroSignals(rec.params)}
    </div>
    <div class="dossier-body">
      ${SECTIONS.map((s) => sectionHtml(s, rec)).join('')}
      ${moatHtml(rec)}
    </div>`;

  elDossier.innerHTML = html;
  elDossier.setAttribute('aria-hidden', 'false');
  elDossier.querySelector('[data-close]').addEventListener('click', closeDossier);

  elOverlay.classList.remove('hidden');
  // next frame → transition in
  requestAnimationFrame(() => {
    elOverlay.classList.add('show');
    elDossier.classList.add('show');
  });
  if (window.lucide) window.lucide.createIcons();
  document.body.style.overflow = 'hidden';
}

export function closeDossier() {
  if (!elDossier || !elDossier.classList.contains('show')) return;
  elDossier.classList.remove('show');
  elOverlay.classList.remove('show');
  elDossier.setAttribute('aria-hidden', 'true');
  document.body.style.overflow = '';
  setTimeout(() => elOverlay.classList.add('hidden'), 360);
}
