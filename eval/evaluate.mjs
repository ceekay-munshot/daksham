// Daksham evaluation layer — pure ESM (browser + Node, no DOM / no node: deps).
//
// Consumes a company row from public/data/daksham-companies.json and returns a
// VERDICT object per parameter. Pure extraction-to-judgement: every threshold
// and trend rule lives in CONFIG below so they're tunable without touching logic.
//
// VERDICT SHAPE: { key, label, value, verdict, output_type, note }
//   output_type ∈ "raw" | "pass_fail" | "deferred"
//   verdict     → "PASS" | "FAIL" | "NA" for pass_fail; null for raw/deferred

// ───────────────────────────── CONFIG ──────────────────────────────────────
export const CONFIG = {
  grossMargin: {
    increaseLookbackYears: 3, // gross_margin_3y_increase = gm_latest - gm_(N years ago)
  },
  yoySalesGrowth12q: {
    minQuarters: 8, // need at least this many quarters to judge a trend
    yoyLagQuarters: 4, // YoY = q[i] / q[i-4] - 1
    maxConsecutiveDeclines: 1, // FAIL once the YoY series declines this many+1 times in a row
    requireLatestNonNegative: true, // latest YoY must be >= 0
  },
  yoyGrossMargin12q: {
    minQuarters: 8,
    lagQuarters: 4, // latest gm vs gm 4 quarters ago
    sustainedContractionQuarters: 4, // FAIL if gm falls this many quarters in a row
  },
  cfoRising3y: {
    lookbackYears: 3, // PASS if latest annual CFO >= CFO this many years prior (net higher)
  },
  ebitdaGt110Sales: {
    ratio: 1.1, // EBITDA YoY growth must exceed ratio × sales YoY growth
  },
  salesFaBelow: {
    factor: 0.8, // PASS if sales/FA latest < factor × mean(last N years)
    meanYears: 3,
  },
  promoterTrendUp: {
    lagQuarters: 4,
    minDelta: -0.1, // PASS if change >= this over 4Q — stable/flat passes, only a real fall fails
  },
  instTrendUp: {
    lagQuarters: 4,
    minDelta: 1.0, // PASS if (fii+dii) latest - value_4q_ago > minDelta (pp)
  },
  salesFaVsPeers: {
    ratio: 0.9, // PASS if company Sales/FA < ratio × the industry median
    minPeers: 5, // need at least this many industry peers with an SFA for a reliable median
  },
};

// The pass/fail checks, for the batch summary.
export const CHECK_KEYS = [
  'yoy_sales_growth_12q',
  'yoy_gross_margin_12q',
  'cfo_rising_3y',
  'ebitda_gt_110_sales',
  'sales_fa_below_0_8x',
  'sales_fa_vs_peers',
  'promoter_trend_up',
  'inst_trend_up',
];

// ──────────────────────────── helpers ──────────────────────────────────────

// Parse a pipe string ("12.3|13.1|14.0") oldest→newest into number[]. Blank
// cells are dropped (rare mid-series gaps), so the result holds only real values.
export function parseSeries(s) {
  if (s == null) return [];
  if (Array.isArray(s)) return s.map(Number).filter(Number.isFinite);
  return String(s)
    .split('|')
    .map((x) => x.trim())
    .filter((x) => x !== '')
    .map(Number)
    .filter(Number.isFinite);
}

const isBlank = (s) => !String(s ?? '').trim();
const num = (x) => {
  if (x === '' || x == null) return '';
  const n = Number(x);
  return Number.isFinite(n) ? n : '';
};
const round1 = (n) => Math.round(n * 10) / 10;
const round2 = (n) => Math.round(n * 100) / 100;
const growthPct = (r) => `${(r * 100).toFixed(1)}%`; // r is a ratio (0.12 → "12.0%")
const pctVal = (x) => `${x.toFixed(1)}%`; // x is already a percent (62.3 → "62.3%")
const signed = (x) => `${x >= 0 ? '+' : ''}${x.toFixed(2)}`;

// verdict builders
const raw = (key, label, value, note = '') => ({ key, label, value, verdict: null, output_type: 'raw', note });
const passFail = (key, label, value, pass, note = '') => ({
  key,
  label,
  value,
  verdict: pass ? 'PASS' : 'FAIL',
  output_type: 'pass_fail',
  note,
});
// Two flavours of NA so the UI can tell "structurally absent for this sector"
// apart from "data missing / too short". NA always rides on output_type pass_fail.
const naSector = (key, label, reason, value = '') => ({
  key,
  label,
  value,
  verdict: 'NA',
  output_type: 'pass_fail',
  note: `Not applicable — ${reason}`,
});
const naData = (key, label, reason, value = '') => ({
  key,
  label,
  value,
  verdict: 'NA',
  output_type: 'pass_fail',
  note: `Insufficient history — ${reason}`,
});
const deferred = (key, label, note) => ({ key, label, value: '', verdict: null, output_type: 'deferred', note });

// Longest run of strictly-decreasing steps in a numeric series.
function longestDeclineRun(arr) {
  let max = 0;
  let run = 0;
  for (let i = 1; i < arr.length; i++) {
    if (arr[i] < arr[i - 1]) {
      run += 1;
      if (run > max) max = run;
    } else {
      run = 0;
    }
  }
  return max;
}

// ─────────────────────────── raw display ───────────────────────────────────

function rawFields(row) {
  const out = [];
  const tags = [row.broad_sector, row.sector, row.industry].filter((x) => String(x ?? '').trim());
  out.push(raw('industry', 'Sector / Industry', tags.join(' / ')));
  out.push(raw('market_cap', 'Market Cap (₹ Cr)', num(row.market_cap ?? row.mkt_cap)));
  out.push(raw('mcap_to_sales', 'M-Cap / Sales', num(row.mcap_to_sales)));
  out.push(raw('pe', 'P/E', num(row.stock_pe)));
  out.push(raw('pb', 'P/B', num(row.pb)));
  out.push(raw('ev_ebitda', 'EV / EBITDA', num(row.ev_ebitda)));
  out.push(raw('roce', 'ROCE %', num(row.roce)));
  out.push(raw('roe', 'ROE %', num(row.roe)));
  out.push(raw('promoter_holding', 'Promoter Holding %', num(row.promoter_holding)));
  out.push(raw('institutional_holding', 'Institutional Holding %', num(row.institutional_holding)));
  out.push(raw('sales_cagr_3y', 'Sales CAGR 3Y %', num(row.sales_cagr_3y)));
  out.push(grossMarginLatest(row));
  out.push(grossMargin3yIncrease(row));
  return out;
}

function grossMarginLatest(row) {
  const key = 'gross_margin_latest';
  const label = 'Gross Margin (latest) %';
  if (isBlank(row.material_cost_pct_annual_series))
    return naSector(key, label, 'no material-cost line (financials/IT/services)');
  const mc = parseSeries(row.material_cost_pct_annual_series);
  if (!mc.length) return naData(key, label, 'no annual material-cost values');
  return raw(key, label, round1(100 - mc[mc.length - 1]));
}

function grossMargin3yIncrease(row) {
  const key = 'gross_margin_3y_increase';
  const label = 'Gross Margin Δ 3Y (pp)';
  if (isBlank(row.material_cost_pct_annual_series))
    return naSector(key, label, 'no material-cost line (financials/IT/services)');
  const mc = parseSeries(row.material_cost_pct_annual_series);
  const lb = CONFIG.grossMargin.increaseLookbackYears;
  if (mc.length < lb + 1) return naData(key, label, `need ≥${lb + 1} annual points, have ${mc.length}`);
  const gmLatest = 100 - mc[mc.length - 1];
  const gmAgo = 100 - mc[mc.length - 1 - lb];
  return raw(key, label, round1(gmLatest - gmAgo));
}

// ─────────────────────────── pass / fail ───────────────────────────────────

function yoySalesGrowth12q(row) {
  const key = 'yoy_sales_growth_12q';
  const label = 'YoY Sales Growth (12Q)';
  const c = CONFIG.yoySalesGrowth12q;
  const q = parseSeries(row.sales_qtr_series);
  if (q.length < c.minQuarters) return naData(key, label, `need ≥${c.minQuarters} quarters, have ${q.length}`);

  const yoy = [];
  for (let i = c.yoyLagQuarters; i < q.length; i++) {
    const base = q[i - c.yoyLagQuarters];
    if (base !== 0) yoy.push(q[i] / base - 1);
  }
  if (yoy.length < 2) return naData(key, label, 'not enough YoY points');

  const declines = longestDeclineRun(yoy);
  const latest = yoy[yoy.length - 1];
  const pass = declines <= c.maxConsecutiveDeclines && (!c.requireLatestNonNegative || latest >= 0);
  return passFail(key, label, growthPct(latest), pass, `latest YoY ${growthPct(latest)}, longest decline run ${declines}`);
}

function yoyGrossMargin12q(row) {
  const key = 'yoy_gross_margin_12q';
  const label = 'YoY Gross Margin (12Q)';
  if (isBlank(row.material_cost_pct_qtr_series))
    return naSector(key, label, 'no material-cost line (financials/IT/services)');
  const c = CONFIG.yoyGrossMargin12q;
  const mc = parseSeries(row.material_cost_pct_qtr_series);
  if (mc.length < c.minQuarters) return naData(key, label, `need ≥${c.minQuarters} quarters, have ${mc.length}`);

  const gm = mc.map((x) => 100 - x);
  const latest = gm[gm.length - 1];
  const ago = gm[gm.length - 1 - c.lagQuarters];
  const contraction = longestDeclineRun(gm);
  const pass = latest >= ago && contraction < c.sustainedContractionQuarters;
  return passFail(
    key,
    label,
    pctVal(latest),
    pass,
    `gm latest ${latest.toFixed(1)} vs 4Q ago ${ago.toFixed(1)}, longest contraction ${contraction}Q`
  );
}

function cfoRising3y(row) {
  const key = 'cfo_rising_3y';
  const label = 'Operating cash flow trending up (3Y)';
  const lb = CONFIG.cfoRising3y.lookbackYears;
  const cfo = parseSeries(row.cfo_series);
  if (cfo.length < lb + 1) return naData(key, label, `need ≥${lb + 1} annual CFO, have ${cfo.length}`);
  const latest = cfo[cfo.length - 1];
  const prior = cfo[cfo.length - 1 - lb];
  // Net higher across the window — interim dips are allowed.
  return passFail(key, label, `${prior} → ${latest}`, latest >= prior, `latest CFO vs ${lb}Y prior`);
}

function ebitdaGt110Sales(row) {
  const key = 'ebitda_gt_110_sales';
  const label = 'EBITDA Growth > 1.1× Sales';
  const rev = parseSeries(row.revenue_series);
  const opm = parseSeries(row.opm_series);
  if (rev.length < 2) return naData(key, label, `need ≥2 annual revenue, have ${rev.length}`);
  if (opm.length < 2) return naData(key, label, `need ≥2 annual OPM, have ${opm.length}`);

  const n = Math.min(rev.length, opm.length);
  const r = rev.slice(-n);
  const o = opm.slice(-n);
  const ebitda = r.map((x, i) => (x * o[i]) / 100);
  const rPrev = r[n - 2];
  const ePrev = ebitda[n - 2];
  if (rPrev <= 0 || ePrev <= 0) return naData(key, label, 'non-positive base year');

  const salesG = r[n - 1] / rPrev - 1;
  const ebitdaG = ebitda[n - 1] / ePrev - 1;
  const pass = ebitdaG > CONFIG.ebitdaGt110Sales.ratio * salesG;
  return passFail(
    key,
    label,
    `EBITDA ${growthPct(ebitdaG)} vs Sales ${growthPct(salesG)}`,
    pass,
    `pass if EBITDA growth > ${CONFIG.ebitdaGt110Sales.ratio}× sales growth`
  );
}

function salesFaBelow(row) {
  const key = 'sales_fa_below_0_8x';
  const label = 'Sales/FA below 0.8× 3Y avg';
  const c = CONFIG.salesFaBelow;
  const rev = parseSeries(row.revenue_series);
  const nb = parseSeries(row.net_block_series);
  const n = Math.min(rev.length, nb.length);
  if (n < c.meanYears) return naData(key, label, `need ≥${c.meanYears} aligned years, have ${n}`);

  const r = rev.slice(-n);
  const b = nb.slice(-n);
  const sfa = r.map((x, i) => (b[i] !== 0 ? x / b[i] : NaN)).filter(Number.isFinite);
  if (sfa.length < c.meanYears) return naData(key, label, 'net block zero/missing');

  const lastN = sfa.slice(-c.meanYears);
  const mean = lastN.reduce((a, x) => a + x, 0) / lastN.length;
  const latest = sfa[sfa.length - 1];
  const pass = latest < c.factor * mean;
  return passFail(
    key,
    label,
    `${latest.toFixed(2)} vs ${c.meanYears}Y avg ${mean.toFixed(2)}`,
    pass,
    `pass if latest < ${c.factor}× ${c.meanYears}Y avg`
  );
}

function promoterTrendUp(row) {
  const key = 'promoter_trend_up';
  const label = 'Promoter holding stable or rising (12mo)';
  const c = CONFIG.promoterTrendUp;
  const p = parseSeries(row.promoter_holding_series);
  if (p.length < c.lagQuarters + 1)
    return naData(key, label, `need ≥${c.lagQuarters + 1} quarters, have ${p.length}`);
  const latest = p[p.length - 1];
  const ago = p[p.length - 1 - c.lagQuarters];
  const delta = latest - ago;
  // Stable/flat passes; only a genuine decline (beyond rounding tolerance) fails.
  return passFail(
    key,
    label,
    `${ago.toFixed(2)}% → ${latest.toFixed(2)}% (Δ${signed(delta)})`,
    delta >= c.minDelta,
    `pass if holding did not fall over ${c.lagQuarters}Q (≥ ${c.minDelta}pp tolerance)`
  );
}

function instTrendUp(row) {
  const key = 'inst_trend_up';
  const label = 'Institutional Holding Trend ↑';
  const c = CONFIG.instTrendUp;
  const fii = parseSeries(row.fii_holding_series);
  const dii = parseSeries(row.dii_holding_series);
  const n = Math.min(fii.length, dii.length);
  if (n < c.lagQuarters + 1) return naData(key, label, `need ≥${c.lagQuarters + 1} aligned quarters, have ${n}`);
  const f = fii.slice(-n);
  const d = dii.slice(-n);
  const inst = f.map((x, i) => x + d[i]);
  const latest = inst[inst.length - 1];
  const ago = inst[inst.length - 1 - c.lagQuarters];
  const delta = latest - ago;
  return passFail(
    key,
    label,
    `${ago.toFixed(2)}% → ${latest.toFixed(2)}% (Δ${signed(delta)})`,
    delta > c.minDelta,
    `pass if Δ > ${c.minDelta}pp over ${c.lagQuarters}Q`
  );
}

// ─────────────────────── peer engine (rule R27) ────────────────────────────

function median(arr) {
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// A company's asset turnover: latest Sales / latest Fixed Assets (Net Block).
// Returns null when either is missing or fixed assets are non-positive.
function latestSfa(row) {
  const rev = parseSeries(row.revenue_series);
  const nb = parseSeries(row.net_block_series);
  if (!rev.length || !nb.length) return null;
  const fa = nb[nb.length - 1];
  if (!(fa > 0)) return null;
  const sfa = rev[rev.length - 1] / fa;
  return Number.isFinite(sfa) ? sfa : null;
}

// Group companies by `industry`, compute each one's Sales/Fixed-Assets, and per
// industry return the median SFA + peer count. Compute once, pass into evaluate().
export function computeIndustryMedians(companies) {
  const groups = {};
  for (const c of companies || []) {
    const ind = String(c.industry || '').trim();
    if (!ind) continue;
    const sfa = latestSfa(c);
    if (sfa == null) continue;
    (groups[ind] ||= []).push(sfa);
  }
  const out = {};
  for (const [ind, arr] of Object.entries(groups)) {
    out[ind] = { median_sfa: median(arr), count: arr.length };
  }
  return out;
}

// R27: low asset turnover vs peers = under-utilised capacity / operating-leverage
// headroom. PASS if the company's Sales/FA is below `ratio` × the industry median.
function salesFaVsPeers(row, medians) {
  const key = 'sales_fa_vs_peers';
  const label = 'Sales/FA below industry peers';
  const c = CONFIG.salesFaVsPeers;
  const sfa = latestSfa(row);
  if (sfa == null) return naData(key, label, 'company Sales/FA unavailable');
  const peer = medians && medians[String(row.industry || '').trim()];
  if (!peer || peer.count < c.minPeers) {
    return naData(key, label, `too few industry peers for a reliable median (need ≥${c.minPeers})`);
  }
  const pass = sfa < c.ratio * peer.median_sfa;
  return passFail(
    key,
    label,
    `${sfa.toFixed(2)} vs peer median ${peer.median_sfa.toFixed(2)}`,
    pass,
    `pass if < ${c.ratio}× industry median (${peer.count} peers)`
  );
}

// ─────────────────────────── deferred stubs ────────────────────────────────

const DEFERRED = [
  ['capital_allocation', 'Capital Allocation', 'Deferred — needs capital-employed + cost-of-capital'],
  ['revenue_guidance', 'Revenue Guidance', 'Deferred — qualitative / management commentary'],
  ['margin_guidance', 'Margin Guidance', 'Deferred — qualitative / management commentary'],
  ['capital_raised', 'Capital Raised', 'Deferred — qualitative / filings'],
  ['order_book', 'Order Book', 'Deferred — qualitative / filings'],
  ['mgmt_tone', 'Management Tone', 'Deferred — qualitative / AI'],
  ['market_share', 'Market Share', 'Deferred — qualitative / industry data'],
  ['competition', 'Competition', 'Deferred — qualitative / AI'],
  ['barriers_to_entry', 'Barriers to Entry', 'Deferred — qualitative / AI'],
  ['buyer_power', 'Buyer Power', 'Deferred — qualitative / AI'],
  ['supplier_power', 'Supplier Power', 'Deferred — qualitative / AI'],
  ['substitution', 'Substitution Risk', 'Deferred — qualitative / AI'],
  ['china_imports', 'China Imports Risk', 'Deferred — qualitative / AI'],
  ['govt_regulation', 'Govt / Regulation', 'Deferred — qualitative / AI'],
  ['inventory_buildup', 'Inventory Build-up', 'Deferred — needs inventory-vs-sales model'],
  ['strategic_stocking', 'Strategic Stocking', 'Deferred — qualitative / AI'],
  ['demand_anticipation', 'Demand Anticipation', 'Deferred — qualitative / AI'],
];

// ───────────────────────────── evaluate ────────────────────────────────────

const CHECKS = [
  yoySalesGrowth12q,
  yoyGrossMargin12q,
  cfoRising3y,
  ebitdaGt110Sales,
  salesFaBelow,
  promoterTrendUp,
  instTrendUp,
];

export function evaluate(row, industryMedians = {}) {
  const params = {};
  const put = (v) => {
    params[v.key] = v;
  };

  for (const v of rawFields(row)) put(v);
  for (const check of CHECKS) put(check(row));
  put(salesFaVsPeers(row, industryMedians));
  for (const [key, label, note] of DEFERRED) put(deferred(key, label, note));

  return {
    company: {
      name: row.name,
      slug: row.slug,
      path: row.path,
      broad_sector: row.broad_sector,
      sector: row.sector,
      industry: row.industry,
    },
    params,
  };
}
