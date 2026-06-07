// Full trend-chart modal — opened when a dossier trend row is clicked. Shows an
// axes-and-gridlines line chart, per-point hover values, a latest callout, summary
// stats, and a source link so a client can verify the data on Screener.

import { esc } from './format.js';

const groupIN = (n) => new Intl.NumberFormat('en-IN').format(n);

function fmtVal(v, unit) {
  if (!Number.isFinite(v)) return '—';
  if (unit === '%') return `${v.toFixed(1)}%`;
  if (unit === '₹ Cr') return `₹${groupIN(Math.round(v))} Cr`;
  return v.toFixed(1);
}
function fmtAxis(v, unit) {
  if (unit === '₹ Cr') {
    const a = Math.abs(v);
    if (a >= 1000) return `${(v / 1000).toFixed(a >= 10000 ? 0 : 1)}k`;
    return `${Math.round(v)}`;
  }
  return unit === '%' ? `${Math.round(v)}` : v.toFixed(0);
}

let seq = 0;

export function lineChart(values, { unit = '', w = 640, h = 250 } = {}) {
  const v = (values || []).filter(Number.isFinite);
  if (v.length < 2) return '<div class="chart-empty">Not enough history to chart.</div>';

  const padL = 54;
  const padR = 18;
  const padT = 20;
  const padB = 30;
  const iw = w - padL - padR;
  const ih = h - padT - padB;

  let lo = Math.min(...v);
  let hi = Math.max(...v);
  if (lo === hi) {
    lo -= 1;
    hi += 1;
  }
  const pad = (hi - lo) * 0.1;
  lo -= pad;
  hi += pad;
  const range = hi - lo;

  const x = (i) => padL + (i / (v.length - 1)) * iw;
  const y = (val) => padT + ih - ((val - lo) / range) * ih;
  const up = v[v.length - 1] >= v[0];
  const col = up ? '#10b981' : '#f43f5e';
  const id = `cg${seq++}`;

  let grid = '';
  const ticks = 4;
  for (let t = 0; t <= ticks; t++) {
    const val = lo + (range * t) / ticks;
    const yy = y(val).toFixed(1);
    grid += `<line x1="${padL}" x2="${w - padR}" y1="${yy}" y2="${yy}" class="cgrid"/>`;
    grid += `<text x="${padL - 9}" y="${(+yy + 3.5).toFixed(1)}" class="cylab" text-anchor="end">${fmtAxis(val, unit)}</text>`;
  }

  const line = v.map((val, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(val).toFixed(1)}`).join(' ');
  const area = `${line} L ${x(v.length - 1).toFixed(1)} ${(padT + ih).toFixed(1)} L ${padL} ${(padT + ih).toFixed(1)} Z`;
  const markers = v
    .map((val, i) => {
      const isLast = i === v.length - 1;
      return `<circle cx="${x(i).toFixed(1)}" cy="${y(val).toFixed(1)}" r="${isLast ? 4.2 : 3}" fill="${isLast ? col : '#fff'}" stroke="${col}" stroke-width="1.7" class="cmark"><title>Period ${i + 1} of ${v.length}: ${fmtVal(val, unit)}</title></circle>`;
    })
    .join('');

  const lx = x(v.length - 1);
  const ly = y(v[v.length - 1]);
  const cw = Math.max(46, fmtVal(v[v.length - 1], unit).length * 7.2);
  const cxr = Math.min(lx - cw - 6, w - padR - cw);
  const callout = `<g><rect x="${Math.max(padL, cxr).toFixed(1)}" y="${(ly - 11).toFixed(1)}" width="${cw}" height="22" rx="6" fill="${col}"/><text x="${(Math.max(padL, cxr) + cw / 2).toFixed(1)}" y="${(ly + 4).toFixed(1)}" class="ccallout" text-anchor="middle">${fmtVal(v[v.length - 1], unit)}</text></g>`;

  return `<svg viewBox="0 0 ${w} ${h}" width="100%" height="${h}" class="chart-svg" preserveAspectRatio="xMidYMid meet">
    <defs><linearGradient id="${id}" x1="0" x2="0" y1="0" y2="1">
      <stop offset="0" stop-color="${col}" stop-opacity="0.2"/><stop offset="1" stop-color="${col}" stop-opacity="0"/>
    </linearGradient></defs>
    ${grid}
    <path d="${area}" fill="url(#${id})"/>
    <path d="${line}" fill="none" stroke="${col}" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>
    ${markers}${callout}
    <text x="${padL}" y="${h - 9}" class="cxlab" text-anchor="start">oldest</text>
    <text x="${w - padR}" y="${h - 9}" class="cxlab" text-anchor="end">latest</text>
  </svg>`;
}

let elOverlay;
let elCard;
function ensure() {
  if (elOverlay) return;
  elOverlay = document.getElementById('chart-overlay');
  elCard = document.getElementById('chart');
  elOverlay.addEventListener('click', (e) => {
    if (e.target === elOverlay) closeChart();
  });
}

export const isChartOpen = () => !!elCard && elCard.classList.contains('show');

export function openChart({ title, subtitle, values, unit = '', source }) {
  ensure();
  const v = (values || []).filter(Number.isFinite);
  const latest = v[v.length - 1];
  const first = v[0];
  const change = v.length >= 2 ? latest - first : null;
  const lo = v.length ? Math.min(...v) : null;
  const hi = v.length ? Math.max(...v) : null;
  const changeHtml =
    change == null ? '—' : `${change >= 0 ? '+' : '−'}${fmtVal(Math.abs(change), unit)}`;

  const src = source
    ? `<a class="src-chip" href="${esc(source.url)}" target="_blank" rel="noopener">
         <span class="src-ic"><i data-lucide="shield-check"></i></span>
         <span>Verify on <b>${esc(source.label)}</b></span>
         <i data-lucide="external-link" class="src-ext"></i>
       </a>`
    : '';

  elCard.innerHTML = `
    <div class="chart-head">
      <div>
        <div class="chart-title">${esc(title)}</div>
        <div class="chart-sub">${esc(subtitle || `${v.length} periods · oldest → latest`)}</div>
      </div>
      <button class="modal-close" data-close aria-label="Close chart"><i data-lucide="x"></i></button>
    </div>
    <div class="chart-area">${lineChart(v, { unit })}</div>
    <div class="chart-stats">
      <div class="cstat"><div class="cstat-num">${fmtVal(latest, unit)}</div><div class="cstat-lbl">Latest</div></div>
      <div class="cstat"><div class="cstat-num ${change >= 0 ? 'pos' : 'neg'}">${changeHtml}</div><div class="cstat-lbl">Change over window</div></div>
      <div class="cstat"><div class="cstat-num">${fmtVal(lo, unit)} – ${fmtVal(hi, unit)}</div><div class="cstat-lbl">Range</div></div>
    </div>
    <div class="chart-foot">${src}<span class="chart-foot-note">Figures as reported on Screener.in · oldest → latest</span></div>`;

  elCard.querySelector('[data-close]').addEventListener('click', closeChart);
  elOverlay.classList.remove('hidden');
  requestAnimationFrame(() => {
    elOverlay.classList.add('show');
    elCard.classList.add('show');
  });
  if (window.lucide) window.lucide.createIcons();
}

export function closeChart() {
  if (!isChartOpen()) return;
  elCard.classList.remove('show');
  elOverlay.classList.remove('show');
  setTimeout(() => elOverlay.classList.add('hidden'), 300);
}
