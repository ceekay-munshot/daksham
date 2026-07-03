#!/usr/bin/env node
// Bank / NBFC operational-metrics scraper.
//
// Client ask #3: "For Banks/NBFCs, incorporate the relevant operational metrics
// to that industry — much of the displayed metrics are not relevant." The
// generic manufacturing-style series (material cost, asset turnover, inventory)
// mean nothing for a lender. Screener's PUBLIC company page carries the ones that
// DO — Gross/Net NPA % (asset quality) and Financing Margin % (a NIM proxy) — as
// plain server-rendered ratio rows, so no login is needed.
//
// For every financial in daksham-companies.json we fetch /company/<slug>/ and
// read those rows into
//   public/data/bank-metrics.json  { <slug>: { gross_npa_pct, net_npa_pct, financing_margin_pct, …series } }
//
//   MAX_COMPANIES=5 node scrapers/bank-metrics.mjs   # smoke
//   node scrapers/bank-metrics.mjs                   # all financials

import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as cheerio from 'cheerio';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.resolve(__dirname, '..', 'public', 'data');
const OUT_FILE = path.join(OUT_DIR, 'bank-metrics.json');
const DEBUG_FILE = path.join(OUT_DIR, 'bank-metrics-debug.json');

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// Financials (banks / NBFCs / insurers) — same test the evaluator uses.
export const isFinancial = (row) =>
  /financ|\bbank|insur|nbfc/i.test([row.broad_sector, row.sector, row.industry].join(' '));

// ─────────────────────────── pure helpers (unit-tested) ─────────────────────
// A Screener ratio row is `<td class="text">Label</td>` then one `<td>` per
// period. Screener prints periods OLDEST → NEWEST left-to-right, so the returned
// series is oldest-first (matching the repo's other series) and the LATEST value
// is the last element. Numbers only; "4.37%" / "24,115" → 4.37 / 24115.
export function bankRatioSeries(html, label) {
  const $ = cheerio.load(html || '');
  let out = null;
  $('table tr').each((_, tr) => {
    if (out) return;
    const name = $(tr).find('td.text').first().text().replace(/\s+/g, ' ').trim();
    if (name.toLowerCase() !== label.toLowerCase()) return;
    out = $(tr)
      .find('td')
      .slice(1)
      .map((__, td) => {
        const t = $(td).text().replace(/,/g, '').replace('%', '').replace(/\s+/g, '').trim();
        const n = Number(t);
        return Number.isFinite(n) && t !== '' ? n : null;
      })
      .get()
      .filter((n) => n !== null);
  });
  return out && out.length ? out : null;
}

export function extractBankMetrics(html) {
  const gnpa = bankRatioSeries(html, 'Gross NPA %');
  const nnpa = bankRatioSeries(html, 'Net NPA %');
  const fmargin = bankRatioSeries(html, 'Financing Margin %');
  const latest = (a) => (a && a.length ? a[a.length - 1] : null);
  return {
    gross_npa_pct: latest(gnpa),
    net_npa_pct: latest(nnpa),
    financing_margin_pct: latest(fmargin),
    gross_npa_series: gnpa,
    financing_margin_series: fmargin,
  };
}

// ─────────────────────────── fetch ─────────────────────────────────────────
async function fetchHtml(url, tries = 3) {
  for (let i = 1; i <= tries; i += 1) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'en-IN,en;q=0.9' } });
      if (res.status === 404) return { status: 404, html: null };
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return { status: 200, html: await res.text() };
    } catch (err) {
      if (i === tries) return { status: 0, html: null, error: err.message };
      await sleep(800 * i);
    }
  }
  return { status: 0, html: null };
}

function readConfig() {
  const base = (process.env.SCREENER_BASE || 'https://www.screener.in').replace(/\/+$/, '');
  const max = parseInt(process.env.MAX_COMPANIES || '', 10);
  return {
    base,
    maxCompanies: Number.isFinite(max) && max > 0 ? max : null,
    startAt: Math.max(0, parseInt(process.env.START_AT || '0', 10) || 0),
    politenessMs: Math.max(0, parseInt(process.env.POLITENESS_MS || '300', 10) || 300),
  };
}

const hasAny = (m) => m.gross_npa_pct != null || m.net_npa_pct != null || m.financing_margin_pct != null;

function writeOut(base, companies) {
  fs.writeFileSync(
    OUT_FILE,
    JSON.stringify({ generated_at: new Date().toISOString(), source: base, count: Object.keys(companies).length, companies }, null, 0)
  );
}

async function main() {
  const cfg = readConfig();
  const companies = JSON.parse(fs.readFileSync(path.join(OUT_DIR, 'daksham-companies.json'), 'utf8'));
  const financials = companies.filter(isFinancial);
  console.log('Bank / NBFC metrics scraper (public Screener pages, no login)');
  console.log(`  financials in set : ${financials.length}`);
  console.log(`  scope : ${cfg.maxCompanies ? `${cfg.maxCompanies} (smoke)` : 'all'} from index ${cfg.startAt}`);

  const existing = fs.existsSync(OUT_FILE) ? JSON.parse(fs.readFileSync(OUT_FILE, 'utf8')).companies || {} : {};
  const out = { ...existing };

  let slice = financials.slice(cfg.startAt);
  if (cfg.maxCompanies) slice = slice.slice(0, cfg.maxCompanies);

  const stats = { generated_at: new Date().toISOString(), financials_in: financials.length, attempted: slice.length, with_metrics: 0, no_metrics: 0, errors: 0 };
  let i = 0;
  for (const c of slice) {
    i += 1;
    const slug = c.slug;
    if (out[slug] && hasAny(out[slug])) continue; // resume
    const url = `${cfg.base}/company/${slug}/`;
    const res = await fetchHtml(url);
    if (res.status !== 200) {
      stats.errors += 1;
      out[slug] = { slug, name: c.name, status: `http_${res.status}`, url };
      console.warn(`  ${i}/${slice.length} ${slug} — fetch failed (${res.error || res.status})`);
    } else {
      const m = extractBankMetrics(res.html);
      if (hasAny(m)) stats.with_metrics += 1;
      else stats.no_metrics += 1;
      out[slug] = { slug, name: c.name, ...m, url };
      console.log(`  ${i}/${slice.length} ${slug} -> GNPA ${m.gross_npa_pct ?? '—'}% | NNPA ${m.net_npa_pct ?? '—'}% | FinMargin ${m.financing_margin_pct ?? '—'}%`);
    }
    writeOut(cfg.base, out);
    if (cfg.politenessMs) await sleep(cfg.politenessMs);
  }

  writeOut(cfg.base, out);
  fs.writeFileSync(DEBUG_FILE, JSON.stringify(stats, null, 2));
  console.log(`\nDone — ${stats.with_metrics} with metrics, ${stats.no_metrics} without, ${stats.errors} errors (of ${slice.length}).`);
  console.log(`  ${OUT_FILE}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(`\nFATAL: ${err.message}`);
    process.exit(1);
  });
}
