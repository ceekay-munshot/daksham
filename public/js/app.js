// Daksham dashboard orchestrator. Loads the data, computes verdicts CLIENT-SIDE
// via the shared eval module, and drives the KPIs / controls / grid / dossier.

import { evaluate, computeIndustryMedians, CHECK_KEYS } from './evaluate.mjs';
import { esc } from './format.js';
import * as grid from './grid.js';
import { initDossier, openDossier, closeDossier, isDossierOpen } from './dossier.js';
import { isChartOpen, closeChart } from './chart.js';

const N = (x) => {
  const v = Number(x);
  return Number.isFinite(v) ? v : null;
};
const groupIN = (n) => new Intl.NumberFormat('en-IN').format(n);
const debounce = (fn, ms) => {
  let t;
  return (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
};
const icons = () => window.lucide && window.lucide.createIcons();
const $ = (id) => document.getElementById(id);

const state = {
  records: [],
  bySlug: new Map(),
  labels: {},
  sort: { key: 'passCount', dir: 'desc' },
  filters: { search: '', sector: '', check: '', mcap: '', minSignals: 0 },
};

// ── data load ───────────────────────────────────────────────────────────────
async function load() {
  skeleton();
  let companies;
  let liquid = null;
  let companiesMeta = {};
  let universeMeta = {};
  let qual = null;
  try {
    [companies, liquid, companiesMeta, universeMeta, qual] = await Promise.all([
      fetch('data/daksham-companies.json').then((r) => {
        if (!r.ok) throw new Error('companies');
        return r.json();
      }),
      fetch('data/liquid-universe.json').then((r) => (r.ok ? r.json() : null)).catch(() => null),
      fetch('data/companies-metadata.json').then((r) => r.json()).catch(() => ({})),
      fetch('data/universe-metadata.json').then((r) => r.json()).catch(() => ({})),
      fetch('data/daksham-qualitative.json').then((r) => (r.ok ? r.json() : null)).catch(() => null),
    ]);
  } catch (err) {
    return errorState();
  }

  // Industry SFA medians for the peer check — computed once over the full
  // crawled set, then passed into every evaluate().
  state.medians = computeIndustryMedians(companies);

  // The current liquid set is the spine; join per-company metrics where crawled,
  // and mark not-yet-crawled entrants as "metrics pending".
  const byPath = new Map(companies.map((c) => [c.path, c]));
  const spine = Array.isArray(liquid) && liquid.length ? liquid : companies;

  // AI qualitative cluster (own-document lens) — a separate file, joined by slug.
  const qualBySlug = new Map();
  if (qual && qual.companies) for (const [slug, v] of Object.entries(qual.companies)) qualBySlug.set(slug, v);
  state.qualMeta = qual ? { generated_at: qual.generated_at, provider: qual.provider, model: qual.model, dry_run: qual.dry_run } : null;

  state.records = spine.map((row) => {
    const full = byPath.get(row.path);
    const rec = full ? enrich(full) : enrichPending(row);
    const q = qualBySlug.get(rec.slug);
    rec.qual = q && q.params ? q : null;
    rec.qualReal = rec.qual ? Object.values(rec.qual.params).filter((p) => p.verdict !== 'NA').length : 0;
    return rec;
  });
  state.bySlug = new Map(state.records.map((r) => [r.slug, r]));
  const sample = state.records.find((r) => !r.pending);
  if (sample) for (const k of CHECK_KEYS) state.labels[k] = sample.params[k].label;

  hydrateHero(state.records.length, companiesMeta, universeMeta);
  renderKpis();
  buildControls();
  wire();
  initDossier();
  apply();
  icons();
}

function enrich(row) {
  const { params } = evaluate(row, state.medians);
  let passCount = 0;
  let applicable = 0;
  for (const k of CHECK_KEYS) {
    const v = params[k].verdict;
    if (v === 'PASS') {
      passCount += 1;
      applicable += 1;
    } else if (v === 'FAIL') applicable += 1;
  }
  return {
    row,
    params,
    name: row.name || row.slug || '—',
    slug: row.slug || '',
    sector: row.broad_sector || '',
    industry: row.industry || '',
    mcap: N(row.market_cap ?? row.mkt_cap),
    pe: N(row.stock_pe),
    pb: N(row.pb),
    evEbitda: N(row.ev_ebitda),
    mcapSales: N(row.mcap_to_sales),
    passCount,
    applicable,
    pending: false,
  };
}

// A liquid name not yet present in daksham-companies.json — show what the
// universe/liquidity files already have; full metrics + verdicts come on the
// next crawl.
function enrichPending(row) {
  return {
    row,
    params: null,
    pending: true,
    name: row.name || row.slug || '—',
    slug: row.slug || '',
    sector: row.broad_sector || '',
    industry: row.industry || '',
    mcap: N(row.market_cap ?? row.mkt_cap),
    pe: N(row.stock_pe ?? row.pe),
    pb: N(row.pb),
    evEbitda: N(row.ev_ebitda),
    mcapSales: N(row.mcap_to_sales),
    adtv: N(row.adtv_30d_cr),
    passCount: null,
    applicable: 0,
  };
}

// ── hero + KPIs ─────────────────────────────────────────────────────────────
function hydrateHero(liquidCount, cMeta, uMeta) {
  $('funnel-universe').textContent = groupIN(uMeta.company_count || 5019);
  $('funnel-liquid').textContent = groupIN(liquidCount);
  const ts = cMeta.generated_at;
  $('last-updated').textContent = ts
    ? `Updated ${new Date(ts).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })} · live verdicts`
    : 'Live verdicts';
}

function renderKpis() {
  const recs = state.records;
  const complete = recs.filter((r) => !r.pending);
  const sectors = new Set(recs.map((r) => r.sector).filter(Boolean)).size;
  const strong = complete.filter((r) => r.passCount >= 5).length;
  const avg = complete.length ? (complete.reduce((s, r) => s + r.passCount, 0) / complete.length).toFixed(1) : '0';

  const cards = [
    { icon: 'building-2', num: groupIN(recs.length), label: 'Liquid companies', grad: 'linear-gradient(135deg,#6366f1,#4f46e5)', shadow: 'rgba(79,70,229,.45)' },
    { icon: 'layout-grid', num: sectors, label: 'Sectors covered', grad: 'linear-gradient(135deg,#a855f7,#7c3aed)', shadow: 'rgba(124,58,237,.45)' },
    { icon: 'award', num: groupIN(strong), label: 'Strong picks · ≥5 signals', grad: 'linear-gradient(135deg,#34d399,#10b981)', shadow: 'rgba(16,185,129,.45)' },
    { icon: 'activity', num: avg, label: `Avg green signals · of ${CHECK_KEYS.length}`, grad: 'linear-gradient(135deg,#fbbf24,#f59e0b)', shadow: 'rgba(245,158,11,.45)' },
  ];
  $('kpis').innerHTML = cards
    .map(
      (c, i) => `<div class="kpi-card" style="--kpi-grad:${c.grad};--kpi-shadow:${c.shadow};animation-delay:${i * 70}ms">
        <div class="kpi-top"><span class="kpi-icon"><i data-lucide="${c.icon}"></i></span></div>
        <div class="kpi-num">${c.num}</div>
        <div class="kpi-label">${esc(c.label)}</div>
      </div>`
    )
    .join('');
}

// ── controls ────────────────────────────────────────────────────────────────
function buildControls() {
  const sectors = [...new Set(state.records.map((r) => r.sector).filter(Boolean))].sort();
  $('sector-filter').innerHTML =
    '<option value="">All sectors</option>' + sectors.map((s) => `<option value="${esc(s)}">${esc(s)}</option>`).join('');
  $('check-filter').innerHTML =
    '<option value="">Any signal</option>' +
    CHECK_KEYS.map((k) => `<option value="${k}">${esc(state.labels[k] || k)}</option>`).join('');
}

function wire() {
  $('search').addEventListener(
    'input',
    debounce((e) => {
      state.filters.search = e.target.value.trim().toLowerCase();
      apply();
    }, 110)
  );
  $('sector-filter').addEventListener('change', (e) => {
    state.filters.sector = e.target.value;
    apply();
  });
  $('check-filter').addEventListener('change', (e) => {
    state.filters.check = e.target.value;
    apply();
  });
  $('mcap-filter').addEventListener('change', (e) => {
    state.filters.mcap = e.target.value;
    apply();
  });
  $('shortlist').addEventListener('click', (e) => {
    const btn = e.target.closest('.seg');
    if (!btn) return;
    state.filters.minSignals = Number(btn.dataset.min);
    [...$('shortlist').children].forEach((c) => c.classList.toggle('active', c === btn));
    apply();
  });
  $('clear-filters').addEventListener('click', resetFilters);

  // Esc closes the chart first (if open), then the dossier.
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (isChartOpen()) closeChart();
    else if (isDossierOpen()) closeDossier();
  });

  // delegated: sort on header click
  $('master-head').addEventListener('click', (e) => {
    const th = e.target.closest('th[data-key]');
    if (!th) return;
    const key = th.dataset.key;
    const col = grid.COLS.find((c) => c.key === key);
    if (state.sort.key === key) state.sort.dir = state.sort.dir === 'asc' ? 'desc' : 'asc';
    else state.sort = { key, dir: col && col.type === 'str' ? 'asc' : 'desc' };
    apply();
  });
  // delegated: open dossier on row click
  $('master-body').addEventListener('click', (e) => {
    const tr = e.target.closest('tr[data-slug]');
    if (!tr) return;
    const rec = state.bySlug.get(tr.dataset.slug);
    if (rec) openDossier(rec);
  });
}

function resetFilters() {
  state.filters = { search: '', sector: '', check: '', mcap: '', minSignals: 0 };
  $('search').value = '';
  $('sector-filter').value = '';
  $('check-filter').value = '';
  $('mcap-filter').value = '';
  [...$('shortlist').children].forEach((c, i) => c.classList.toggle('active', i === 0));
  apply();
}

// ── filter + sort + render ──────────────────────────────────────────────────
function matches(rec, f) {
  if (f.search && !(rec.name.toLowerCase().includes(f.search) || rec.slug.toLowerCase().includes(f.search))) return false;
  if (f.sector && rec.sector !== f.sector) return false;
  if (f.check && (!rec.params || rec.params[f.check].verdict !== 'PASS')) return false;
  if (f.minSignals && (rec.passCount == null || rec.passCount < f.minSignals)) return false;
  if (f.mcap) {
    const [lo, hi] = f.mcap.split('-').map(Number);
    if (rec.mcap == null || rec.mcap < lo || rec.mcap >= hi) return false;
  }
  return true;
}

function apply() {
  const f = state.filters;
  let view = state.records.filter((r) => matches(r, f));
  view = grid.sortRecords(view, state.sort.key, state.sort.dir);

  $('master-head').innerHTML = grid.headHtml(state.sort);
  $('master-body').innerHTML = grid.bodyHtml(view);

  const total = state.records.length;
  $('showing-count').innerHTML = `Showing <b>${groupIN(view.length)}</b> of ${groupIN(total)}`;
  renderChips();

  $('empty-state').classList.toggle('hidden', view.length > 0);
  $('master').classList.toggle('hidden', view.length === 0);
  icons();
}

function renderChips() {
  const f = state.filters;
  const chips = [];
  if (f.minSignals) chips.push(['minSignals', `≥${f.minSignals} signals`]);
  if (f.sector) chips.push(['sector', f.sector]);
  if (f.check) chips.push(['check', state.labels[f.check] || f.check]);
  if (f.mcap) chips.push(['mcap', $('mcap-filter').selectedOptions[0].textContent]);
  if (f.search) chips.push(['search', `"${f.search}"`]);

  $('active-chips').innerHTML = chips
    .map(
      ([k, label]) =>
        `<span class="fchip">${esc(label)}<button data-clear="${k}" aria-label="Remove"><i data-lucide="x"></i></button></span>`
    )
    .join('');

  $('active-chips')
    .querySelectorAll('[data-clear]')
    .forEach((b) =>
      b.addEventListener('click', () => {
        const k = b.dataset.clear;
        if (k === 'minSignals') {
          state.filters.minSignals = 0;
          [...$('shortlist').children].forEach((c, i) => c.classList.toggle('active', i === 0));
        } else {
          state.filters[k] = '';
          const map = { sector: 'sector-filter', check: 'check-filter', mcap: 'mcap-filter', search: 'search' };
          if (map[k]) $(map[k]).value = '';
        }
        apply();
      })
    );
}

// ── states ──────────────────────────────────────────────────────────────────
function skeleton() {
  $('master-head').innerHTML =
    '<tr>' + Array.from({ length: 7 }, () => '<th><span class="sk" style="display:inline-block;width:70px;height:11px"></span></th>').join('') + '</tr>';
  $('master-body').innerHTML = Array.from({ length: 10 }, () =>
    `<tr>${Array.from({ length: 7 }, (_, c) =>
      `<td><span class="sk" style="display:inline-block;height:14px;width:${c === 0 ? 170 : 60}px"></span></td>`
    ).join('')}</tr>`
  ).join('');
}

function errorState() {
  $('master-head').innerHTML = '';
  $('master-body').innerHTML = '';
  $('empty-state').classList.remove('hidden');
  $('empty-state').innerHTML =
    '<i data-lucide="server-crash"></i><p>Couldn\'t load the dataset. Serve from the repo root so <code>data/</code> and <code>eval/</code> are reachable.</p>';
  icons();
}

load();
