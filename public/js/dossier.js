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
      { key: 'sales_cagr_3y', icon: 'trending-up', src: 'profit-loss' },
      { key: 'gross_margin_latest', icon: 'percent', src: 'profit-loss' },
      { key: 'gross_margin_3y_increase', icon: 'arrow-up-right', src: 'profit-loss' },
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
      { key: 'sales_fa_below_0_8x', icon: 'factory', src: 'balance-sheet' },
      { key: 'sales_fa_vs_peers', icon: 'bar-chart-3', src: 'peers' },
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
  // Hide structurally-irrelevant rows (e.g. material cost / asset turnover / EBITDA
  // for a lender). Client ask #3: don't show metrics that don't apply to the sector.
  // "Not applicable — …" is the naSector note; "Insufficient history" (naData) stays.
  if (p.verdict === 'NA' && typeof p.note === 'string' && p.note.startsWith('Not applicable')) return '';
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
      trend = `<button class="trend-btn" data-chart="${id}" aria-label="Open ${esc(p.label)} trend chart" title="Open trend chart">
        ${sparkline(vals, { w: 72, h: 26 })}<span class="trend-ic"><i data-lucide="expand"></i></span></button>`;
    }
  }

  const right = trend + (isRaw ? `<span class="prow-val">${fmtMetric(p.key, p.value)}</span>` : pill(p));
  return `<div class="prow">
    <span class="prow-ic"><i data-lucide="${cfg.icon || 'circle'}"></i></span>
    <div class="prow-main">${main}</div>
    <div class="prow-right">${right}${screenerIcon(row && row.path, cfg.src)}</div>
  </div>`;
}

function sectionHtml(sec, rec, store) {
  const rows = sec.rows.map((cfg) => paramRow(rec.params[cfg.key], rec.row, cfg, store)).join('');
  if (!rows.trim()) return ''; // every row hidden (e.g. a manufacturing section for a bank)
  const sub = sectionSub(sec, rec.row, asOfLabel(rec));
  return `<div class="dsection">
    <div class="dsection-head">
      <span class="sec-ic" style="--sec-grad:${sec.grad}"><i data-lucide="${sec.icon}"></i></span>
      <span class="dsection-title">${sec.title}</span>
      ${sub ? `<span class="dsection-sub" title="Period each metric is as of — from its Screener table; live ratios as of the snapshot pull">${esc(sub)}</span>` : ''}
    </div>
    ${rows}
  </div>`;
}

// Lender-only section: the operational metrics that actually matter for a bank /
// NBFC (asset quality + margin), which the generic sections don't carry. Only
// rendered when bank-metrics.json has a real read for this company (rec.bank).
function bankingSectionHtml(rec, store) {
  const b = rec.bank;
  if (!b) return '';
  const rr = rec.row || {};
  const path = rr.path;
  const spark = (series, title, unit) => {
    if (!Array.isArray(series) || series.length < 2) return '';
    const id = `c${store.n++}`;
    store.map[id] = {
      title,
      subtitle: `${series.length} periods · oldest → latest`,
      values: series,
      unit: unit || '',
      source: { label: 'Screener.in', url: `https://www.screener.in${path || ''}#quarters` },
    };
    return `<button class="trend-btn" data-chart="${id}" aria-label="Open ${esc(title)} trend chart" title="Open trend chart">${sparkline(series, { w: 72, h: 26 })}<span class="trend-ic"><i data-lucide="expand"></i></span></button>`;
  };
  const row = (icon, label, value, unit, series, chartTitle, src) => {
    const val = value == null || value === '' ? '—' : `${value}${unit || ''}`;
    return `<div class="prow">
      <span class="prow-ic"><i data-lucide="${icon}"></i></span>
      <div class="prow-main"><div class="prow-label">${esc(label)}</div></div>
      <div class="prow-right">${spark(series, chartTitle || label, unit)}<span class="prow-val">${esc(val)}</span>${screenerIcon(path, src)}</div>
    </div>`;
  };
  const num = (x) => (x == null || x === '' || Number.isNaN(Number(x)) ? null : Number(x));
  return `<div class="dsection">
    <div class="dsection-head">
      <span class="sec-ic" style="--sec-grad:linear-gradient(135deg,#0d9488,#0f766e)"><i data-lucide="landmark"></i></span>
      <span class="dsection-title">Banking metrics</span>
      <span class="dsection-sub" title="Lender-specific operational metrics from Screener">lender · asset quality &amp; margin</span>
    </div>
    ${row('shield-alert', 'Gross NPA %', num(b.gross_npa_pct), '%', b.gross_npa_series, 'Gross NPA %', 'quarters')}
    ${row('shield', 'Net NPA %', num(b.net_npa_pct), '%', null, null, 'quarters')}
    ${row('percent', 'Financing Margin % (NIM proxy)', num(b.financing_margin_pct), '%', b.financing_margin_series, 'Financing Margin %', 'quarters')}
    ${row('trending-up', 'Return on Equity', num(rr.roe), '%', null, null, 'ratios')}
    ${row('book-open', 'Book Value', num(rr.book_value) == null ? null : `₹${num(rr.book_value)}`, '', null, null, 'balance-sheet')}
  </div>`;
}

// What period a metric is "as of", by the Screener table it comes from. Live
// ratios (no source table) fall back to the snapshot-pull date.
function rowAsOfInfo(cfg, row, snap) {
  const r = row || {};
  switch (cfg.src) {
    case 'quarters': return { period: r.latest_quarter || '', kind: 'quarterly' };
    case 'shareholding': return { period: r.shareholding_quarter || r.latest_quarter || '', kind: 'quarterly' };
    case 'profit-loss':
    case 'cash-flow':
    case 'balance-sheet':
    case 'peers': return { period: r.latest_fy || '', kind: 'annual' };
    default: return { period: snap, kind: 'live' }; // valuation ratios — live snapshot
  }
}

// One "as of" stamp per section: a single period when uniform, else the distinct
// periods tagged by axis (the growth section mixes annual + quarterly). Degrades
// to the snapshot date before a period-aware re-crawl populates the labels.
function sectionSub(sec, row, snap) {
  const buckets = new Map(); // period -> kind, first-seen order
  for (const cfg of sec.rows) {
    const { period, kind } = rowAsOfInfo(cfg, row, snap);
    if (period && !buckets.has(period)) buckets.set(period, kind);
  }
  if (!buckets.size) return snap ? `as of ${snap}` : '';
  if (buckets.size === 1) return `as of ${[...buckets.keys()][0]}`;
  return [...buckets.entries()].map(([p, k]) => `${k} ${p}`).join(' · ');
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

// Every row links straight to where it came from. Two source kinds:
//  • Screener.in (all the quantitative / fundamental data) — a bar-chart icon to
//    the company page at the exact section anchor (P&L, cash-flow, shareholding…).
//  • A concall / investor-PPT PDF (the AI reads) — a file-text icon to that PDF.
const srcLink = (url, title, icon) =>
  `<a class="row-src" href="${esc(url)}" target="_blank" rel="noopener" aria-label="${esc(title)}" title="${esc(title)}"><i data-lucide="${icon}"></i></a>`;

// Screener is a point-in-time pull — show the crawl-snapshot date as the "as of".
function asOfLabel(rec) {
  const ts = rec && rec.asOf;
  if (!ts) return '';
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
}

const screenerUrl = (path, anchor) =>
  `https://www.screener.in${path || ''}${anchor ? `#${anchor}` : ''}`;

// Human label for each Screener section anchor (blank = the top-of-page ratios).
const SRC_LABEL = {
  '': 'company ratios', 'profit-loss': 'P&L statement', quarters: 'quarterly results',
  'cash-flow': 'cash-flow statement', 'balance-sheet': 'balance sheet',
  shareholding: 'shareholding pattern', peers: 'peer comparison', ratios: 'ratios',
};
// Screener source icon for a quantitative row, pointed at its section.
function screenerIcon(path, anchor = '') {
  const label = SRC_LABEL[anchor] || 'company data';
  return srcLink(screenerUrl(path, anchor), `Open source — ${label} on Screener.in`, 'bar-chart-3');
}

// The exact source URL for a given quarter's document (from the harvest manifest).
function docLink(rec, period, type = 'transcript') {
  const d = (rec.docs || []).find((x) => x.type === type && x.period === period && x.source);
  return d ? d.source : '';
}
// The source PDF to open for one read: the specific quarter's concall when known,
// else the latest concall, else any doc, else the company's Screener documents.
function primarySource(rec, period) {
  if (period) { const u = docLink(rec, period); if (u) return { url: u, q: period }; }
  const docs = (rec.docs || []).filter((d) => d.source);
  const t = docs.filter((d) => d.type === 'transcript').sort((a, b) => String(b.period).localeCompare(String(a.period)))[0] || docs[0];
  if (t) return { url: t.source, q: t.period };
  return { url: screenerUrl(rec.row && rec.row.path, 'documents'), q: '' };
}
// Per-row source icon → opens the exact document the read came from.
function srcIcon(rec, period) {
  const { url, q } = primarySource(rec, period);
  return srcLink(url, `Open source — ${q ? q + ' concall' : 'documents on Screener'}`, 'file-text');
}

function qualRow(p, rec) {
  if (!p) return '';
  let main = `<div class="prow-label">${esc(p.label)}</div>`;
  if (p.value) main += `<div class="prow-subval">${esc(String(p.value))}</div>`;
  if (p.note) main += `<div class="prow-note">${esc(p.note)}</div>`;
  // The exact sentence the source-verifier grounded the read in (best evidence).
  if (p.verdict !== 'NA' && p.quote) main += `<div class="qverify-quote">“${esc(p.quote)}”</div>`;
  const meta = [];
  if (p.verdict !== 'NA' && p.source) {
    const url = docLink(rec, p.source);
    meta.push(
      url
        ? `<a class="qmeta-src qmeta-link" href="${esc(url)}" target="_blank" rel="noopener" title="Open the ${esc(p.source)} concall">${esc(p.source)} ↗</a>`
        : `<span class="qmeta-src">${esc(p.source)}</span>`
    );
  }
  // Verifier badge — only when the verifier has run on this read.
  if (p.verdict !== 'NA' && p.verified === true) meta.push('<span class="qverify ok" title="An independent model found the exact supporting sentence in the source">✓ verified</span>');
  else if (p.verdict !== 'NA' && p.verified === false) meta.push('<span class="qverify warn" title="The verifier could not ground this in the source — treat with caution">⚠ unverified</span>');
  if (p.verdict !== 'NA' && p.confidence) meta.push(`<span class="qmeta-conf qconf-${esc(p.confidence)}">${esc(p.confidence)} confidence</span>`);
  if (meta.length) main += `<div class="prow-meta">${meta.join('')}</div>`;
  return `<div class="prow">
    <span class="prow-ic"><i data-lucide="${QUAL_ICONS[p.key] || 'sparkles'}"></i></span>
    <div class="prow-main">${main}</div>
    <div class="prow-right">${qualPill(p)}${srcIcon(rec, p.source)}</div>
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

  // Nothing surfaced — say WHY honestly (nothing filed / scanned-only / genuinely
  // not discussed) instead of eight bare "N/A" rows.
  if (real === 0) {
    const docs = rec.docs || [];
    const readable = docs.some((d) => !d.ocr_needed && (d.chars || 0) > 500);
    let why = 'No concall transcripts or investor PPTs have been filed yet.';
    let icon = 'file-x';
    if (docs.length && !readable) { why = 'The available concall / PPT documents are scanned images — OCR pending.'; icon = 'scan-line'; }
    else if (readable) { why = 'This period’s commentary didn’t surface any of the eight signals.'; icon = 'info'; }
    return `<div class="dsection">${head('0/8 from management commentary')}
      <div class="prow">
        <span class="prow-ic"><i data-lucide="${icon}"></i></span>
        <div class="prow-main"><div class="prow-note">${esc(why)}</div></div>
        <div class="prow-right">${docs.length ? srcIcon(rec) : ''}</div>
      </div></div>`;
  }

  const latest = rec.qual.meta && rec.qual.meta.source ? ` · latest ${esc(rec.qual.meta.source)}` : '';
  const rows = QUAL_ORDER.map((k) => qualRow(params[k], rec)).join('');
  return `<div class="dsection">${head(`${real}/8 from management commentary${latest}`)}${rows}</div>`;
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
// The peer read is scored against the narrowest grouping with enough listed
// peers — its own industry, else a sector fallback — labelled so for the reader.
const PEER_LABEL = { industry: 'Industry', sector: 'Sector', broad_sector: 'Sector group' };
const peerLabel = (rec) => PEER_LABEL[rec && rec.moat && rec.moat.peer_level] || 'Industry';

// 0-5 score chip (higher = more favorable) with a trend arrow; NA when not discussed.
function moatScore(f) {
  if (!f || f.trend === 'NA' || f.score == null) return '<span class="moat-cell moat-na">N/A</span>';
  const cls = f.score >= 4 ? 'ms-good' : f.score >= 2 ? 'ms-mid' : 'ms-bad';
  const arrow = { improving: '↑', stable: '→', worsening: '↓' }[f.trend] || '';
  return `<span class="moat-cell ${cls}" title="${esc(f.trend)} trend · ${esc(f.confidence || '')} confidence">${arrow} ${f.score}/5</span>`;
}

function moatRow(factor, rec) {
  if (!factor) return '';
  const own = factor.own || {};
  const ind = factor.industry || {};
  const news = rec.news && rec.news.factors ? rec.news.factors[factor.key] : null;
  const newsCell = news ? `<span class="moat-tag moat-tag-news">News</span>${moatScore(news)}` : '';
  // The row toggles an evidence panel (rendered right after it) — click to see WHY.
  return `<div class="prow prow-expand" data-evidence="${esc(factor.key)}" role="button" tabindex="0" aria-expanded="false" title="Show the reasoning + sources">
    <span class="prow-ic"><i data-lucide="${MOAT_ICONS[factor.key] || 'shield'}"></i></span>
    <div class="prow-main">
      <div class="prow-label">${esc(factor.label)}</div>
      <div class="moat-scores"><span class="moat-tag">Own</span>${moatScore(own)}<span class="moat-tag">${esc(peerLabel(rec))}</span>${moatScore(ind)}${newsCell}</div>
    </div>
    <div class="prow-right"><i data-lucide="chevron-down" class="prow-chev"></i></div>
  </div>
  ${evidencePanel(factor, rec)}`;
}

// One lens's evidence: its score + confidence, the reasoning note, and source(s).
function evidenceBlock(tag, f, sources) {
  if (!f) return '';
  const conf = f.confidence ? `<span class="ev-conf qconf-${esc(f.confidence)}">${esc(f.confidence)} conf.</span>` : '';
  const note = f.note && String(f.note).trim() ? f.note : 'Not discussed in the source.';
  return `<div class="ev-block">
    <div class="ev-head"><span class="moat-tag">${esc(tag)}</span>${moatScore(f)}${conf}</div>
    <div class="ev-note">${esc(note)}</div>
    ${sources || ''}
  </div>`;
}

// The drill-down box: why each lens scored what it did, with the actual sources —
// this company's concall (Own), the peer companies (Industry), the headlines (News).
function evidencePanel(factor, rec) {
  const own = factor.own || {};
  const ind = factor.industry || {};
  const news = rec.news && rec.news.factors ? rec.news.factors[factor.key] : null;

  const ps = primarySource(rec);
  const ownSrc = `<div class="ev-src"><a href="${esc(ps.url)}" target="_blank" rel="noopener"><i data-lucide="file-text"></i>${ps.q ? `${esc(ps.q)} concall` : 'source document'} ↗</a></div>`;

  const peers = (rec.moat && rec.moat.peers) || [];
  const peerSrc = peers.length
    ? `<div class="ev-src ev-peers">From ${peers.length} peers — open one to see its own read: ${peers
        .slice(0, 10)
        .map((p) => `<button class="ev-peer" data-peer="${esc(p.slug)}" title="Open ${esc(p.name)}">${esc(p.name)}</button>`)
        .join('')}</div>`
    : '<div class="ev-src ev-muted">Peer list populates on the next moat-lens run.</div>';

  const heads = (rec.news && rec.news.headlines) || [];
  const newsSrc = heads.length
    ? `<ul class="ev-news">${heads
        .slice(0, 6)
        .map((h) => `<li><a href="${esc(h.url || '#')}" target="_blank" rel="noopener">${esc(h.title || '')}</a><span class="ev-meta">${esc(h.source || '')}${h.date ? ` · ${esc(h.date)}` : ''}</span></li>`)
        .join('')}</ul>`
    : '<div class="ev-src ev-muted">Headlines populate on the next news-lens run.</div>';

  return `<div class="moat-ev">
    ${evidenceBlock('Own', own, ownSrc)}
    ${evidenceBlock(peerLabel(rec), ind, peerSrc)}
    ${news ? evidenceBlock('News', news, newsSrc) : ''}
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
  const lvl = moat.peer_level || 'industry';
  const peerName = esc(moat.industry_name || 'sector');
  const ownInd = esc(moat.own_industry || moat.industry_name || '');
  const lvlWord = (PEER_LABEL[lvl] || 'Industry').toLowerCase();
  const headSub = lvl === 'industry' ? `${peerName} · own vs peers` : `${ownInd} · own vs ${peerName} ${lvlWord} peers`;
  const footPeers = lvl === 'industry'
    ? `${peerName} peers' concalls`
    : `${peerName} ${lvlWord} peers' concalls (too few listed ${ownInd} peers for a direct read)`;
  const hasNews = !!(rec.news && rec.news.factors);
  const newsFoot = hasNews
    ? `<b>News</b> from recent third-party headlines (Google News${rec.news.meta && rec.news.meta.latest ? `, latest ${esc(rec.news.meta.latest)}` : ''}).`
    : '<b>News</b> (third-party) — pending its first run.';
  const rows = MOAT_ORDER.map((k) => moatRow(moat.factors[k], rec)).join('');
  return `<div class="dsection">${head(headSub)}${rows}
    <div class="moat-foot"><b>Own</b> from this company's concalls (tap the source icon on each row); <b>${esc(peerLabel(rec))}</b> from ${footPeers}. ${newsFoot} Scored on TREND, 0–5, higher = more favorable; comparable within the group only.</div>
  </div>`;
}

// Recent News — the digestible third-party pulse (what the moat-factor lens drops):
// a sentiment + event tags + a one-line summary, plus the actual headlines.
function newsHtml(rec) {
  const nw = rec.news;
  const heads = (nw && nw.headlines) || [];
  if (!nw || (!nw.pulse && !heads.length)) return ''; // nothing worth a section
  const meta = nw.meta || {};
  const sub = meta.latest ? `latest ${esc(meta.latest)}` : meta.items ? `${meta.items} headlines` : '';
  const head = `<div class="dsection-head">
    <span class="sec-ic" style="--sec-grad:linear-gradient(135deg,#6366f1,#4f46e5)"><i data-lucide="newspaper"></i></span>
    <span class="dsection-title">Recent News · third-party</span>
    ${sub ? `<span class="dsection-sub" title="Google News, newest first">${sub}</span>` : ''}
  </div>`;

  let pulse = '';
  if (nw.pulse) {
    const s = nw.pulse.sentiment || 'neutral';
    const cls = s === 'positive' ? 'pulse-pos' : s === 'negative' ? 'pulse-neg' : 'pulse-neu';
    const events = (nw.pulse.events || []).map((e) => `<span class="news-event">${esc(e.replace(/_/g, ' '))}</span>`).join('');
    pulse = `<div class="news-pulse">
      <div class="news-pulse-top"><span class="news-sent ${cls}">${esc(s)}</span>${events}</div>
      <div class="news-pulse-sum">${esc(nw.pulse.summary)}</div>
    </div>`;
  }
  const list = heads.length
    ? `<ul class="news-list">${heads.slice(0, 8).map((h) => `<li><a href="${esc(h.url || '#')}" target="_blank" rel="noopener">${esc(h.title || '')}</a><span class="news-meta">${esc(h.source || '')}${h.date ? ` · ${esc(h.date)}` : ''}</span></li>`).join('')}</ul>`
    : '<div class="news-list-soon">Headlines populate on the next news run.</div>';
  return `<div class="dsection">${head}<div class="news-body">${pulse}${list}</div></div>`;
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

// Hero source — the headline figures (market cap, CMP, EV/EBITDA, ratios) all
// come from the company's Screener page; link straight to it, stamped with the
// snapshot date so the reader sees both where and when.
const heroSrc = (rec) => {
  const path = rec && rec.row && rec.row.path;
  const asOf = asOfLabel(rec);
  const stamp = asOf ? ` · ${esc(asOf)}` : '';
  return `<a class="hero-src" href="${esc(screenerUrl(path, ''))}" target="_blank" rel="noopener" aria-label="Market cap, price and ratios from Screener.in${asOf ? ', as of ' + esc(asOf) : ''}" title="Market cap, price &amp; ratios — Screener.in snapshot${asOf ? ', ' + esc(asOf) : ''}"><i data-lucide="bar-chart-3"></i><span>Source · Screener.in${stamp}</span><i data-lucide="external-link" class="hs-ext"></i></a>`;
};

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
    if (btn && charts[btn.dataset.chart]) return openChart(charts[btn.dataset.chart]);
    // moat factor row → toggle its evidence panel (let links / peer buttons pass through)
    const ev = e.target.closest('[data-evidence]');
    if (ev && !e.target.closest('a, [data-peer]')) toggleEvidence(ev);
  });
  elDossier.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const ev = e.target.closest('[data-evidence]');
    if (!ev) return;
    e.preventDefault();
    toggleEvidence(ev);
  });
}

function toggleEvidence(row) {
  const panel = row.nextElementSibling;
  if (!panel || !panel.classList.contains('moat-ev')) return;
  row.setAttribute('aria-expanded', String(panel.classList.toggle('open')));
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
        ${heroSrc(rec)}
      </div>
      <div class="dossier-body">
        <div class="pending-card">
          <span class="pending-ic"><i data-lucide="hourglass"></i></span>
          <div class="pending-title">Metrics pending</div>
          <p>This name just entered the liquid universe (avg daily traded value ≥ ₹2 Cr over the last 30 sessions). Its full fundamentals and signal checks are gathered on the next weekly refresh.</p>
          <a class="src-chip" href="${esc(screener)}" target="_blank" rel="noopener">
            <span class="src-ic"><i data-lucide="shield-check"></i></span><span>View on <b>Screener.in</b></span><i data-lucide="external-link" class="src-ext"></i>
          </a>
        </div>
      </div>`;
    finishOpen();
    return;
  }

  const store = { n: 0, map: {} };
  const secs = SECTIONS.map((s) => sectionHtml(s, rec, store));
  // For lenders, slot the bank-specific section right after Valuation.
  const body = secs[0] + bankingSectionHtml(rec, store) + secs.slice(1).join('') + qualHtml(rec) + moatHtml(rec) + newsHtml(rec);
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
      ${heroSrc(rec)}
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
