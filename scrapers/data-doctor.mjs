#!/usr/bin/env node
// Data doctor — a READ-ONLY validator for everything the dashboard consumes.
//
// Loads public/data/*.json and runs structural, referential, value-sanity and
// per-lens checks, then prints findings grouped by severity. Exits 1 if any
// ERROR is found (so it can gate CI), 0 otherwise. It NEVER writes anything.
//
//   npm run data:check            # full report
//   node scrapers/data-doctor.mjs --quiet   # errors + warnings only

import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { evaluate, computeIndustryMedians, parseSeries, CHECK_KEYS } from '../eval/evaluate.mjs';
import { FACTOR_KEYS } from './lib/industry.mjs';
import { renormalizeFields } from './lib/qualitative.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.resolve(__dirname, '..', 'public', 'data');
const rd = (f) => { const p = path.join(DATA, f); return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null; };

const finite = (x) => x !== '' && x != null && Number.isFinite(Number(x));
const sample = (a, n = 8) => a.slice(0, n);
const TREND = new Set(['improving', 'stable', 'worsening', 'NA']);
// Qualitative lens: each output_type carries its OWN verdict vocabulary (ground
// truth from the lib/data) — validate verdict ↔ output_type, not one global set.
const QUAL_VERDICTS = {
  implied: new Set(['DISCLOSED', 'NA']),
  pass_fail: new Set(['PASS', 'FAIL', 'NA']),
  pos_neu_neg: new Set(['Positive', 'Neutral', 'Negative', 'NA']),
  scale_1_5: new Set(['1', '2', '3', '4', '5', 'NA']),
  pass_flag: new Set(['PASS', 'FLAG', 'NA']),
};

// ── finding collector ────────────────────────────────────────────────────────
export function makeReport() {
  const items = [];
  const at = (level) => (code, msg, samples) => items.push({ level, code, msg, samples: samples || [] });
  return { items, error: at('error'), warn: at('warn'), info: at('info') };
}

// A bucket helper: collect detail strings per code, emit once at a given level.
function bucketer() {
  const B = {};
  return {
    push: (code, detail) => { (B[code] = B[code] || []).push(detail); },
    flush: (R, codeLevels) => {
      for (const [code, details] of Object.entries(B)) {
        const level = codeLevels[code] || 'warn';
        R[level](code, `${details.length} × ${code.replace(/\./g, ' ')}`, sample(details));
      }
    },
  };
}

// ── companies (the quantitative tier) ────────────────────────────────────────
const HARD = [['market_cap', 1e7], ['current_price', 1e6]]; // <=0 or NaN = impossible
const SOFT = [['stock_pe', 2000], ['pb', 300], ['ev_ebitda', 2000], ['mcap_to_sales', 500], ['roce', 500], ['roe', 500], ['book_value', 1e6]];
const SERIES = ['sales_qtr_series', 'material_cost_pct_qtr_series', 'manufacturing_cost_pct_qtr_series', 'revenue_series', 'opm_series', 'material_cost_pct_annual_series', 'manufacturing_cost_pct_annual_series', 'cfo_series', 'net_block_series', 'inventory_series', 'promoter_holding_series', 'fii_holding_series', 'dii_holding_series'];
const SERIES_CAP = { sales_qtr_series: 12, material_cost_pct_qtr_series: 12, promoter_holding_series: 8, fii_holding_series: 8, dii_holding_series: 8 };

const COMPANY_LEVELS = {
  'value.invalid': 'error', 'value.nan': 'error', 'holding.nan': 'error', 'holding.range': 'error', 'series.nonnumeric': 'error',
  'value.outlier': 'warn', 'holding.inst_mismatch': 'warn', 'holding.sum_over': 'warn',
  'series.too_long': 'warn', 'material_cost.range': 'warn', 'row.no_name': 'warn',
};

export function checkCompanies(rows, R) {
  if (!Array.isArray(rows) || !rows.length) { R.error('companies.empty', 'daksham-companies.json missing or empty'); return; }
  const b = bucketer();
  const slugCount = {};
  const pathCount = {};
  let missingPeriods = 0;
  for (const r of rows) {
    const slug = r.slug || r.path || '(no-slug)';
    if (!r.slug) R.error('row.no_slug', 'company row with empty slug', [slug]);
    if (!r.path) R.error('row.no_path', 'company row with empty path', [slug]);
    if (!r.name) b.push('row.no_name', slug);
    if (r.slug) slugCount[r.slug] = (slugCount[r.slug] || 0) + 1;
    if (r.path) pathCount[r.path] = (pathCount[r.path] || 0) + 1;

    for (const [f, big] of HARD) {
      const v = r[f]; if (v === '' || v == null) continue;
      const n = Number(v);
      if (!Number.isFinite(n)) b.push('value.invalid', `${slug}.${f}="${v}"`);
      else { if (n <= 0) b.push('value.invalid', `${slug}.${f}=${n}`); if (Math.abs(n) > big) b.push('value.outlier', `${slug}.${f}=${n}`); }
    }
    for (const [f, big] of SOFT) {
      const v = r[f]; if (v === '' || v == null) continue;
      const n = Number(v);
      if (!Number.isFinite(n)) b.push('value.nan', `${slug}.${f}="${v}"`); // P/E, ROE etc. can be legitimately negative
      else if (Math.abs(n) > big) b.push('value.outlier', `${slug}.${f}=${n}`);
    }
    // M-cap/Sales is a ratio of two positives — a negative value is impossible.
    if (finite(r.mcap_to_sales) && Number(r.mcap_to_sales) < 0) b.push('value.invalid', `${slug}.mcap_to_sales=${r.mcap_to_sales}`);
    for (const f of ['promoter_holding', 'fii_holding', 'dii_holding', 'institutional_holding']) {
      const v = r[f]; if (v === '' || v == null) continue;
      if (!Number.isFinite(Number(v))) b.push('holding.nan', `${slug}.${f}="${v}"`);
      else { const n = Number(v); if (n < 0 || n > 100) b.push('holding.range', `${slug}.${f}=${n}`); }
    }
    if (finite(r.fii_holding) && finite(r.dii_holding) && finite(r.institutional_holding)) {
      const exp = Number(r.fii_holding) + Number(r.dii_holding);
      if (Math.abs(exp - Number(r.institutional_holding)) > 1) b.push('holding.inst_mismatch', `${slug}: inst ${r.institutional_holding} vs fii+dii ${exp.toFixed(2)}`);
    }
    if (finite(r.promoter_holding) && finite(r.institutional_holding) && Number(r.promoter_holding) + Number(r.institutional_holding) > 101) {
      b.push('holding.sum_over', `${slug}: promoter+inst ${(Number(r.promoter_holding) + Number(r.institutional_holding)).toFixed(1)}%`);
    }
    for (const s of SERIES) {
      const raw = r[s]; if (raw == null || raw === '') continue;
      const cells = String(raw).split('|').map((x) => x.trim()).filter((x) => x !== '');
      const good = parseSeries(raw).length;
      if (cells.length !== good) b.push('series.nonnumeric', `${slug}.${s} (${cells.length - good} bad cell)`);
    }
    for (const [s, cap] of Object.entries(SERIES_CAP)) {
      const n = parseSeries(r[s]).length;
      if (n > cap) b.push('series.too_long', `${slug}.${s}=${n}>${cap}`);
    }
    for (const s of ['material_cost_pct_qtr_series', 'manufacturing_cost_pct_qtr_series', 'material_cost_pct_annual_series', 'manufacturing_cost_pct_annual_series']) {
      if (parseSeries(r[s]).some((v) => v < 0 || v > 100)) b.push('material_cost.range', `${slug}.${s} out of [0,100]`);
    }
    if (!r.latest_quarter && !r.latest_fy) missingPeriods += 1;
  }
  const dupSlug = Object.entries(slugCount).filter(([, n]) => n > 1).map(([k]) => k);
  const dupPath = Object.entries(pathCount).filter(([, n]) => n > 1).map(([k]) => k);
  if (dupSlug.length) R.error('companies.dup_slug', `${dupSlug.length} duplicate slug(s)`, sample(dupSlug));
  if (dupPath.length) R.error('companies.dup_path', `${dupPath.length} duplicate path(s)`, sample(dupPath));
  b.flush(R, COMPANY_LEVELS);
  if (missingPeriods) R.info('companies.no_period_labels', `${missingPeriods}/${rows.length} rows lack latest_quarter/latest_fy (run the metrics crawl to populate the "as of" stamps)`);
}

// Run the real evaluation on every row — any throw is a hard bug in the data/logic.
export function checkEvaluate(rows, R) {
  if (!Array.isArray(rows) || !rows.length) return;
  const medians = computeIndustryMedians(rows);
  const broke = [];
  for (const r of rows) {
    try {
      const { params } = evaluate(r, medians);
      for (const k of CHECK_KEYS) if (!params[k]) { broke.push(`${r.slug}: missing ${k}`); break; }
    } catch (e) { broke.push(`${r.slug}: ${String(e.message).slice(0, 60)}`); }
  }
  if (broke.length) R.error('evaluate.failed', `${broke.length} rows fail evaluate()`, sample(broke));
}

// ── referential: liquid spine vs crawled metrics ─────────────────────────────
export function checkUniverse(universe, companies, R) {
  if (!Array.isArray(universe) || !universe.length) { R.warn('universe.empty', 'liquid-universe.json missing/empty'); return; }
  const paths = new Set((companies || []).map((c) => c.path));
  const pending = universe.filter((c) => c && c.path && !paths.has(c.path));
  if (pending.length) R.info('universe.pending', `${pending.length} liquid names await a metrics crawl (shown as "Pending")`, sample(pending.map((c) => c.slug)));
  const noSlug = universe.filter((c) => !c || !c.slug);
  if (noSlug.length) R.error('universe.no_slug', `${noSlug.length} universe entries with no slug`);
}

// ── per-lens validity (own/peer moat, qualitative, news) ─────────────────────
// Validate ONE shaped factor { score, trend, note, confidence }.
function checkOneFactor(f, ctx, b) {
  if (!f || typeof f !== 'object') { b.push('factor.missing', ctx); return; }
  if (!TREND.has(f.trend)) { b.push('factor.bad_trend', `${ctx}="${f.trend}"`); return; }
  if (f.trend === 'NA') { if (f.score != null) b.push('factor.na_with_score', `${ctx}=${f.score}`); return; }
  const s = Number(f.score);
  if (!Number.isInteger(s) || s < 0 || s > 5) b.push('factor.bad_score', `${ctx}=${f.score}`);
  else if ((f.trend === 'worsening' && s > 2) || (f.trend === 'improving' && s < 4)) b.push('factor.band_mismatch', `${ctx}=${s}/${f.trend}`);
}
// A flat factor map (the news lens shape): 8 keys → one shaped factor each.
function checkFactorMap(factors, label, slug, b) {
  for (const k of FACTOR_KEYS) checkOneFactor(factors && factors[k], `${slug}.${label}.${k}`, b);
}
const LENS_LEVELS = { 'factor.missing': 'error', 'factor.bad_trend': 'error', 'factor.bad_score': 'error', 'factor.na_with_score': 'warn', 'factor.band_mismatch': 'warn', 'lens.orphan': 'warn' };

export function checkMoat(moat, validSlugs, R) {
  if (!moat || !moat.companies) { R.info('moat.absent', 'daksham-industry.json not present yet'); return; }
  const b = bucketer();
  for (const [slug, e] of Object.entries(moat.companies)) {
    if (validSlugs.size && !validSlugs.has(slug)) b.push('lens.orphan', `moat:${slug}`);
    if (e.peer_level && !['industry', 'sector', 'broad_sector'].includes(e.peer_level)) b.push('factor.bad_score', `${slug}.peer_level=${e.peer_level}`);
    for (const k of FACTOR_KEYS) {
      const f = e.factors && e.factors[k]; if (!f) { b.push('factor.missing', `${slug}.${k}`); continue; }
      checkOneFactor(f.own, `${slug}.own.${k}`, b); // each factor carries its own + peer reads
      checkOneFactor(f.industry, `${slug}.peer.${k}`, b);
      if (f.third_party != null && typeof f.third_party !== 'object') b.push('factor.bad_score', `${slug}.${k}.third_party`);
    }
  }
  b.flush(R, LENS_LEVELS);
}

export function checkNews(news, validSlugs, R) {
  if (!news || !news.companies) { R.info('news.absent', 'daksham-news.json not present yet — run the news lens'); return; }
  const b = bucketer();
  for (const [slug, e] of Object.entries(news.companies)) {
    if (validSlugs.size && !validSlugs.has(slug)) b.push('lens.orphan', `news:${slug}`);
    checkFactorMap(e.factors, 'news', slug, b);
    if (e.meta && e.meta.latest && Number.isNaN(Date.parse(e.meta.latest))) b.push('factor.bad_trend', `${slug}.meta.latest="${e.meta.latest}"`);
  }
  b.flush(R, LENS_LEVELS);
}

export function checkQualitative(qual, validSlugs, R) {
  if (!qual || !qual.companies) { R.info('qual.absent', 'daksham-qualitative.json not present yet'); return; }
  const b = bucketer();
  const QUAL_LEVELS = { 'qual.bad_verdict': 'error', 'qual.bad_output_type': 'error', 'qual.field_unnormalised': 'error', 'lens.orphan': 'warn', 'qual.all_na_with_docs': 'info' };
  for (const [slug, e] of Object.entries(qual.companies)) {
    if (validSlugs.size && !validSlugs.has(slug)) b.push('lens.orphan', `qual:${slug}`);
    const params = e.params || {};
    let real = 0;
    for (const p of Object.values(params)) {
      const allowed = QUAL_VERDICTS[p.output_type];
      if (!allowed) { b.push('qual.bad_output_type', `${slug}.${p.key || '?'}: "${p.output_type}"`); continue; }
      if (!allowed.has(String(p.verdict))) b.push('qual.bad_verdict', `${slug}.${p.key || '?'}: ${p.output_type}="${p.verdict}"`);
      if (String(p.verdict) !== 'NA') real += 1;
      // A structured numeric field that the sanity guards would still change is a
      // mis-scaled ₹-crore headline (10×–1000× mn/lakh/bn/USD slip) or an over-ceiling
      // %, i.e. the unit/conversion bug class reached the file. Fail — run
      // `node scrapers/normalize-qualitative.mjs` (and check the extractor guard).
      if (p.fields) {
        const fixed = renormalizeFields(p);
        for (const k of Object.keys(fixed)) {
          if (p.fields[k] !== fixed[k]) b.push('qual.field_unnormalised', `${slug}.${k}=${JSON.stringify(p.fields[k])} → ${JSON.stringify(fixed[k])}`);
        }
      }
    }
    if (real === 0 && e.meta && e.meta.docs_used > 0) b.push('qual.all_na_with_docs', slug);
  }
  b.flush(R, QUAL_LEVELS);
}

export function checkManifest(man, validSlugs, R) {
  if (!man || typeof man !== 'object') { R.warn('manifest.absent', 'docs-manifest.json missing'); return; }
  const b = bucketer();
  const ML = { 'manifest.bad_entry': 'error', 'manifest.bad_period': 'warn', 'manifest.no_source': 'warn', 'lens.orphan': 'info' };
  for (const [slug, docs] of Object.entries(man)) {
    if (validSlugs.size && !validSlugs.has(slug)) b.push('lens.orphan', `docs:${slug}`);
    if (!Array.isArray(docs)) { b.push('manifest.bad_entry', slug); continue; }
    for (const d of docs) {
      if (d.type === 'transcript' && d.period && !/^\d{4}-\d{2}$/.test(d.period)) b.push('manifest.bad_period', `${slug}:${d.period}`);
      if (!d.ocr_needed && !d.source) b.push('manifest.no_source', `${slug}:${d.type}/${d.period || '?'}`);
    }
  }
  b.flush(R, ML);
}

export function checkMeta(meta, label, R) {
  if (!meta || !meta.generated_at) { R.warn('meta.no_timestamp', `${label} has no generated_at`); return; }
  const t = Date.parse(meta.generated_at);
  if (Number.isNaN(t)) { R.error('meta.bad_timestamp', `${label}.generated_at = "${meta.generated_at}"`); return; }
  const ageD = (Date.now() - t) / 86400000;
  if (ageD < -1) R.warn('meta.future', `${label}.generated_at is in the future`);
  else if (ageD > 30) R.warn('meta.stale', `${label} is ${Math.round(ageD)} days old`);
}

// ── orchestration ────────────────────────────────────────────────────────────
export function runChecks(data, R) {
  const valid = new Set([...(data.companies || []).map((c) => c.slug), ...(data.universe || []).map((c) => c && c.slug)].filter(Boolean));
  checkCompanies(data.companies, R);
  checkEvaluate(data.companies, R);
  checkUniverse(data.universe, data.companies, R);
  checkQualitative(data.qual, valid, R);
  checkMoat(data.moat, valid, R);
  checkNews(data.news, valid, R);
  checkManifest(data.manifest, valid, R);
  checkMeta(data.companiesMeta, 'companies-metadata.json', R);
  return R;
}

function main() {
  const quiet = process.argv.includes('--quiet');
  const data = {
    companies: rd('daksham-companies.json') || [],
    universe: rd('liquid-universe.json') || [],
    companiesMeta: rd('companies-metadata.json') || {},
    qual: rd('daksham-qualitative.json'),
    moat: rd('daksham-industry.json'),
    news: rd('daksham-news.json'),
    manifest: rd('docs-manifest.json'),
  };
  const R = makeReport();
  runChecks(data, R);

  const order = { error: 0, warn: 1, info: 2 };
  const icon = { error: '✖', warn: '⚠', info: 'ℹ' };
  const items = R.items.filter((i) => !quiet || i.level !== 'info').sort((a, b) => order[a.level] - order[b.level]);
  const counts = R.items.reduce((m, i) => ((m[i.level] = (m[i.level] || 0) + 1), m), {});

  console.log(`\n🩺 Daksham data doctor — ${data.companies.length} companies\n${'─'.repeat(60)}`);
  for (const it of items) {
    console.log(`${icon[it.level]} [${it.code}] ${it.msg}`);
    if (it.samples.length) console.log(`    e.g. ${it.samples.join(' · ')}`);
  }
  console.log('─'.repeat(60));
  console.log(`${icon.error} ${counts.error || 0} errors   ${icon.warn} ${counts.warn || 0} warnings   ${icon.info} ${counts.info || 0} info`);
  process.exit((counts.error || 0) > 0 ? 1 : 0);
}

// Run only as a CLI (keep importable for tests).
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
