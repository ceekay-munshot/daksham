#!/usr/bin/env node
// Verification worksheet — turns "10 random companies + hunt for sources" into a
// structured, source-linked checklist. Picks a STRATIFIED sample (doctor-flagged
// + strong picks + a random per-sector control), and for each prints the
// dashboard's values next to the exact Screener + concall URLs to confirm against.
// Read-only. Writes verification-worksheet.md (gitignored) and a stdout summary.
//
//   npm run data:verify            # default 10 companies, seed 1 (reproducible)
//   node scrapers/verify-worksheet.mjs --seed 7 --n 12

import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { evaluate, computeIndustryMedians, parseSeries, CHECK_KEYS } from '../eval/evaluate.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(ROOT, 'public', 'data');
const rd = (f) => { const p = path.join(DATA, f); return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null; };

const arg = (flag, def) => { const i = process.argv.indexOf(flag); return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : def; };
const SEED = parseInt(arg('--seed', '1'), 10) || 1;
const N = parseInt(arg('--n', '10'), 10) || 10;

// Deterministic RNG so a given seed reproduces the same sample.
function rng(seed) {
  let a = seed >>> 0;
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const rand = rng(SEED);
const shuffle = (arr) => { const a = [...arr]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };

const fmt = (v) => (v === '' || v == null || Number.isNaN(Number(v)) ? '—' : String(v));
const screener = (p, anchor) => `https://www.screener.in${p || ''}${anchor ? `#${anchor}` : ''}`;
const outlier = (r) => Math.abs(Number(r.stock_pe)) > 2000 || Math.abs(Number(r.pb)) > 300 || Math.abs(Number(r.ev_ebitda)) > 2000 || Number(r.mcap_to_sales) > 500 || Number(r.mcap_to_sales) < 0 || Math.abs(Number(r.roce)) > 500 || Math.abs(Number(r.roe)) > 500;
const mcOutOfRange = (r) => [...parseSeries(r.material_cost_pct_qtr_series), ...parseSeries(r.material_cost_pct_annual_series)].some((x) => x < 0 || x > 100);

// Latest concall PDF URL for a quarter (from the harvest manifest).
function pdfFor(manifest, slug, period) {
  const docs = manifest[slug] || [];
  const exact = docs.find((d) => d.type === 'transcript' && d.period === period && d.source);
  if (exact) return exact.source;
  const t = docs.filter((d) => d.type === 'transcript' && d.source).sort((a, b) => String(b.period).localeCompare(String(a.period)))[0];
  return t ? t.source : screener(null, 'documents');
}

function enrich(row, medians) {
  const { params } = evaluate(row, medians);
  let pass = 0, applicable = 0;
  const passed = [], failed = [];
  for (const k of CHECK_KEYS) {
    const v = params[k];
    if (v.verdict === 'PASS') { pass++; applicable++; passed.push(`${v.label} (${v.value})`); }
    else if (v.verdict === 'FAIL') { applicable++; failed.push(`${v.label} (${v.value})`); }
  }
  return { params, pass, applicable, passed, failed };
}

function block(i, r, why, ev, qual, moat, news, manifest) {
  const L = [];
  L.push(`### ${i}. ${r.name || r.slug}  (\`${r.slug}\`) — _${why}_`);
  L.push(`${[r.broad_sector, r.sector, r.industry].filter(Boolean).join(' › ') || '—'}`);
  const period = r.latest_quarter || r.latest_fy || '_pending metrics re-crawl_';
  L.push(`**Source:** ${screener(r.path)}  ·  as of ${period}\n`);

  L.push('| Metric | Dashboard | Screener says | ✓ / ✗ |');
  L.push('|---|---|---|---|');
  const rows = [
    ['Market Cap (₹Cr)', r.market_cap ?? r.mkt_cap], ['CMP (₹)', r.current_price ?? r.cmp], ['P/E', r.stock_pe],
    ['P/B', r.pb], ['EV/EBITDA', r.ev_ebitda], ['M-cap/Sales', r.mcap_to_sales], ['ROCE %', r.roce], ['ROE %', r.roe],
  ];
  for (const [label, v] of rows) L.push(`| ${label} | ${fmt(v)} | | |`);
  const inst = fmt(r.institutional_holding);
  L.push(`| Holdings: Prom / FII / DII / Inst | ${fmt(r.promoter_holding)} / ${fmt(r.fii_holding)} / ${fmt(r.dii_holding)} / ${inst} | (FII+DII = Inst?) | |`);

  L.push(`\n**Signals: ${ev.pass}/${ev.applicable}** — sanity-check one against the shareholding/financials:`);
  if (ev.passed.length) L.push(`- ✅ ${ev.passed.slice(0, 3).join(' · ')}`);
  if (ev.failed.length) L.push(`- ❌ ${ev.failed.slice(0, 3).join(' · ')}`);

  // AI reads to verify against the concall (truthfulness — the part no script can check).
  L.push('\n**AI reads — open the PDF, Ctrl-F the claim, confirm it & the quarter:**');
  let any = false;
  if (qual && qual.params) {
    const reals = Object.values(qual.params).filter((p) => p.verdict && p.verdict !== 'NA').slice(0, 2);
    for (const p of reals) {
      any = true;
      L.push(`- _${p.label}_ → **${p.verdict}** ${p.value ? `"${p.value}"` : ''} · ${p.source || '?'}`);
      if (p.note) L.push(`  > ${p.note}`);
      L.push(`  PDF: ${pdfFor(manifest, r.slug, p.source)}`);
    }
  }
  if (moat && moat.factors) {
    const f = Object.values(moat.factors).find((x) => x.own && x.own.trend && x.own.trend !== 'NA');
    if (f) { any = true; L.push(`- _Moat · ${f.label}_ → Own ${f.own.score}/5 ${f.own.trend}`); if (f.own.note) L.push(`  > ${f.own.note}`); }
  }
  if (news && news.factors) {
    const f = Object.values(news.factors).find((x) => x.trend && x.trend !== 'NA');
    if (f) { any = true; L.push(`- _News · ${f.key}_ → ${f.score}/5 ${f.trend}`); if (f.note) L.push(`  > ${f.note}`); }
  }
  if (!any) L.push('- _(no non-NA AI reads to check for this one)_');

  L.push('\n**Tick:**  numbers ☐   holdings ☐   signals ☐   AI read faithful ☐   _notes:_ ___________________\n');
  L.push('---');
  return L.join('\n');
}

// ── Markdown → standalone HTML (only the constructs this file emits) ─────────
const escH = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
function inlineH(s) {
  return escH(s)
    .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
    .replace(/(^|[\s(])_(.+?)_/g, '$1<i>$2</i>')
    .replace(/(https?:\/\/[^\s)]+)/g, (u) => `<a href="${u}" target="_blank" rel="noopener">${/AnnPdfOpen|\.pdf/i.test(u) ? 'Open PDF ↗' : /screener/i.test(u) ? 'Open on Screener ↗' : u}</a>`)
    .replace(/☐/g, '<input type="checkbox">')
    .replace(/✅/g, '<span class="ok">✓</span>').replace(/❌/g, '<span class="no">✗</span>');
}
function tableH(rows) {
  const cells = (r) => r.replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
  const head = cells(rows[0]);
  const sIdx = head.findIndex((h) => /screener says/i.test(h));
  const cIdx = head.findIndex((h) => /✗/.test(h));
  const th = head.map((h) => `<th>${inlineH(h)}</th>`).join('');
  const body = rows.slice(2).map((r) => {
    const cs = cells(r);
    return `<tr>${cs.map((c, j) => {
      if (!c && j === sIdx) return '<td><input type="text" class="fill" placeholder="from Screener"></td>';
      if (!c && j === cIdx) return '<td style="text-align:center"><input type="checkbox"></td>';
      return `<td>${inlineH(c)}</td>`;
    }).join('')}</tr>`;
  }).join('');
  return `<table><thead><tr>${th}</tr></thead><tbody>${body}</tbody></table>`;
}
function mdToHtml(md) {
  const lines = md.split('\n');
  const out = [];
  for (let i = 0; i < lines.length;) {
    const ln = lines[i];
    if (/^### /.test(ln)) { out.push(`<h3>${inlineH(ln.slice(4))}</h3>`); i++; }
    else if (/^# /.test(ln)) { out.push(`<h1>${inlineH(ln.slice(2))}</h1>`); i++; }
    else if (/^\|/.test(ln)) { const t = []; while (i < lines.length && /^\|/.test(lines[i])) t.push(lines[i++]); out.push(tableH(t)); }
    else if (/^- /.test(ln)) { const it = []; while (i < lines.length && /^- /.test(lines[i])) it.push(`<li>${inlineH(lines[i++].slice(2))}</li>`); out.push(`<ul>${it.join('')}</ul>`); }
    else if (/^> /.test(ln)) { out.push(`<blockquote>${inlineH(ln.slice(2))}</blockquote>`); i++; }
    else if (/^---/.test(ln)) { out.push('<hr>'); i++; }
    else if (ln.trim() === '') { i++; }
    else { out.push(`<p>${inlineH(ln)}</p>`); i++; }
  }
  return out.join('\n');
}
const htmlDoc = (body) => `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Daksham — verification worksheet</title>
<style>
  body{font:15px/1.55 -apple-system,Segoe UI,Roboto,Arial,sans-serif;max-width:900px;margin:24px auto;padding:0 16px;color:#1f2733}
  h1{font-size:24px;margin:0 0 4px} h3{margin:30px 0 6px;font-size:17px;border-top:2px solid #eee;padding-top:18px}
  table{border-collapse:collapse;width:100%;margin:10px 0} th,td{border:1px solid #dde2ea;padding:6px 10px;text-align:left;font-size:14px}
  th{background:#f5f7fb} a{color:#3949ab;font-weight:600} a:visited{color:#5b6bbf}
  blockquote{margin:4px 0 10px;padding:6px 12px;border-left:3px solid #cbd5e1;background:#f8fafc;color:#475569;font-size:14px}
  ul{margin:6px 0;padding-left:20px} .ok{color:#16a34a;font-weight:700}.no{color:#dc2626;font-weight:700}
  input[type=checkbox]{width:16px;height:16px;vertical-align:middle} input.fill{width:110px;padding:2px 6px} hr{border:none}
  .tip{background:#eef2ff;border:1px solid #c7d2fe;padding:10px 14px;border-radius:8px;font-size:14px}
</style></head><body>
<p class="tip">Tick the boxes as you go. Click <b>Open on Screener</b> to check the numbers (type what you see into the yellow box), and <b>Open PDF</b> to confirm each AI quote. When finished, <b>Ctrl+P → Save as PDF</b> keeps a record.</p>
${body}
</body></html>`;

function main() {
  const companies = rd('daksham-companies.json') || [];
  const qualC = (rd('daksham-qualitative.json') || {}).companies || {};
  const moatC = (rd('daksham-industry.json') || {}).companies || {};
  const newsC = (rd('daksham-news.json') || {}).companies || {};
  const manifest = rd('docs-manifest.json') || {};
  const meta = rd('companies-metadata.json') || {};
  if (!companies.length) { console.error('No daksham-companies.json — nothing to verify.'); process.exit(1); }

  const medians = computeIndustryMedians(companies);
  const evBySlug = new Map(companies.map((r) => [r.slug, enrich(r, medians)]));

  // ── stratified pick ──
  const chosen = []; const used = new Set();
  const take = (r, why) => { if (r && r.slug && !used.has(r.slug)) { used.add(r.slug); chosen.push({ r, why }); } };

  // 1) doctor-flagged (outliers + material-cost out of range)
  const flagged = shuffle(companies.filter((r) => outlier(r) || mcOutOfRange(r)));
  for (const r of flagged.slice(0, 3)) take(r, outlier(r) ? 'flagged · extreme ratio' : 'flagged · material-cost % out of range');
  // 2) strong picks (>=5 signals), highest first
  const strong = companies.filter((r) => (evBySlug.get(r.slug)?.pass || 0) >= 5).sort((a, b) => evBySlug.get(b.slug).pass - evBySlug.get(a.slug).pass);
  for (const r of strong.slice(0, 3)) take(r, `strong pick · ${evBySlug.get(r.slug).pass}/8 signals`);
  // 3) random control — distinct broad sectors
  const seenSec = new Set();
  for (const r of shuffle(companies)) {
    if (chosen.length >= N) break;
    const sec = r.broad_sector || '?';
    if (used.has(r.slug) || seenSec.has(sec)) continue;
    seenSec.add(sec); take(r, `random control · ${sec}`);
  }
  // top up if short
  for (const r of shuffle(companies)) { if (chosen.length >= N) break; take(r, 'random control'); }

  // ── render ──
  const out = [];
  out.push(`# Daksham — data verification worksheet`);
  out.push(`_Stratified sample of ${chosen.length} (seed ${SEED}) · data as of ${meta.generated_at || '?'} · generated ${new Date().toISOString().slice(0, 16).replace('T', ' ')}_\n`);
  out.push(`Work top to bottom. **Numbers** → confirm against the Screener link (≈1 min each). **AI reads** → open the concall PDF and confirm management actually said it, in that quarter (this is where hallucination/wrong-quarter bugs hide).\n`);
  out.push(`> Pick mix: 3 doctor-flagged (where number bugs cluster) · 3 strong picks (where a bug hurts most — clients act on these) · the rest a random control across sectors (to estimate the baseline error rate).\n`);
  chosen.forEach((c, i) => out.push(block(i + 1, c.r, c.why, evBySlug.get(c.r.slug), qualC[c.r.slug], moatC[c.r.slug], newsC[c.r.slug], manifest)));

  // orphans worth a hygiene decision (data exists but not in the liquid set)
  const inSet = new Set(companies.map((c) => c.slug));
  const orphans = [...new Set([...Object.keys(qualC), ...Object.keys(manifest)])].filter((s) => !inSet.has(s));
  if (orphans.length) {
    out.push(`### Hygiene · ${orphans.length} orphaned entries (AI/doc data, NOT in the liquid set)`);
    out.push(`Decide: re-include if still investable, else purge so they don't drift. ${orphans.slice(0, 25).join(', ')}${orphans.length > 25 ? ' …' : ''}\n`);
  }

  const md = out.join('\n');
  const file = path.join(ROOT, 'verification-worksheet.md');
  const htmlFile = path.join(ROOT, 'verification-worksheet.html');
  writeFileSync(file, `${md}\n`);
  writeFileSync(htmlFile, htmlDoc(mdToHtml(md)));
  console.log('✅ Worksheet written:');
  console.log(`   • ${htmlFile}   ← double-click to open in your browser (recommended)`);
  console.log(`   • ${file}   (markdown)`);
  console.log(`   ${chosen.length} companies — ${chosen.map((c) => c.r.slug).join(', ')}`);
  console.log('   (re-run with --seed N for a different sample, --n N for size)');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
