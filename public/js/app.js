// Daksham dashboard orchestrator. Loads the data, computes verdicts CLIENT-SIDE
// via the shared eval module, and drives the KPIs / controls / grid / dossier.

import { evaluate, CHECK_KEYS } from './evaluate.mjs';
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
  let companiesMeta = {};
  let universeMeta = {};
  try {
    [companies, companiesMeta, universeMeta] = await Promise.all([
      fetch('data/daksham-companies.json').then((r) => {
        if (!r.ok) throw new Error('companies');
        return r.json();
      }),
      fetch('data/companies-metadata.json').then((r) => r.json()).catch(() => ({})),
      fetch('data/universe-metadata.json').then((r) => r.json()).catch(() => ({})),
    ]);
  } catch (err) {
    return errorState();
  }

  state.records = companies.map(enrich);
  state.bySlug = new Map(state.records.map((r) => [r.slug, r]));
  if (state.records[0]) for (const k of CHECK_KEYS) state.labels[k] = state.records[0].params[k].label;

  hydrateHero(companies.length, companiesMeta, universeMeta);
  renderKpis();
  buildControls();
  wire();
  initDossier();
  apply();
  icons();
}

function enrich(row) {
  const { params } = evaluate(row);
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
  const sectors = new Set(recs.map((r) => r.sector).filter(Boolean)).size;
  const strong = recs.filter((r) => r.passCount >= 5).length;
  const avg = recs.length ? (recs.reduce((s, r) => s + r.passCount, 0) / recs.length).toFixed(1) : '0';

  const cards = [
    { icon: 'building-2', num: groupIN(recs.length), label: 'Liquid companies', grad: 'linear-gradient(135deg,#6366f1,#4f46e5)', shadow: 'rgba(79,70,229,.45)' },
    { icon: 'layout-grid', num: sectors, label: 'Sectors covered', grad: 'linear-gradient(135deg,#a855f7,#7c3aed)', shadow: 'rgba(124,58,237,.45)' },
    { icon: 'award', num: groupIN(strong), label: 'Strong picks · ≥5 signals', grad: 'linear-gradient(135deg,#34d399,#10b981)', shadow: 'rgba(16,185,129,.45)' },
    { icon: 'activity', num: avg, label: 'Avg green signals · of 7', grad: 'linear-gradient(135deg,#fbbf24,#f59e0b)', shadow: 'rgba(245,158,11,.45)' },
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
  if (f.check && rec.params[f.check].verdict !== 'PASS') return false;
  if (f.minSignals && rec.passCount < f.minSignals) return false;
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
