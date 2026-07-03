#!/usr/bin/env node
// Stockscans.in industry-classification scraper.
//
// The client wants the dashboard's sector / peer grouping to follow Stockscans'
// industry classification. That tag turns out to be PUBLIC — server-rendered on
// every company page — so no login and no browser are needed.
//
// Our liquid-universe slugs are NSE symbols, and the page URL is
// `/company/NSE:<SYMBOL>`. For each liquid company we fetch the page and read the
// "Industry:" link into
//   public/data/stockscans-classification.json  { <SYMBOL>: { slug, symbol, industry, url } }
//
//   MAX_COMPANIES=5 node scrapers/stockscans-classify.mjs   # smoke
//   node scrapers/stockscans-classify.mjs                   # full liquid set

import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as cheerio from 'cheerio';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.resolve(__dirname, '..', 'public', 'data');
const OUT_FILE = path.join(OUT_DIR, 'stockscans-classification.json');
const DEBUG_FILE = path.join(OUT_DIR, 'stockscans-classification-debug.json');

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// ─────────────────────────── pure helpers (unit-tested) ─────────────────────
export const normSymbol = (s) => String(s || '').trim().toUpperCase();
export const companyUrl = (base, symbol) => `${String(base).replace(/\/+$/, '')}/company/NSE:${normSymbol(symbol)}`;

// The industry is a link to a pre-filtered scan:
//   <span class="…metaLinkLabel…">Industry:</span>
//   <a class="…metaLinkValue…" href="/scans/new?industry=…">Abrasives &amp; Grinding Wheels</a>
// The anchor text is the clean name (the href param mangles "&" → "_"), so read
// the text. Falls back to the label-adjacent value if the class ever changes.
export function extractIndustry(html) {
  const $ = cheerio.load(html || '');
  let a = $('a[href*="/scans/new?industry="]').first();
  if (!a.length) {
    // fallback: a metaLinkValue anchor sitting right after an "Industry:" label
    $('span').each((_, el) => {
      if (a.length) return;
      if (/^industry:?$/i.test($(el).text().trim())) {
        const next = $(el).next('a');
        if (next.length) a = next;
      }
    });
  }
  const txt = a.text().replace(/\s+/g, ' ').trim();
  return txt || null;
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
  const base = (process.env.STOCKSCANS_BASE || 'https://www.stockscans.in').replace(/\/+$/, '');
  const max = parseInt(process.env.MAX_COMPANIES || '', 10);
  return {
    base,
    maxCompanies: Number.isFinite(max) && max > 0 ? max : null, // null = all
    startAt: Math.max(0, parseInt(process.env.START_AT || '0', 10) || 0),
    politenessMs: Math.max(0, parseInt(process.env.POLITENESS_MS || '250', 10) || 250),
  };
}

function writeOut(base, companies) {
  fs.writeFileSync(
    OUT_FILE,
    JSON.stringify(
      { generated_at: new Date().toISOString(), source: base, count: Object.keys(companies).length, companies },
      null,
      0
    )
  );
}

async function main() {
  const cfg = readConfig();
  console.log('Stockscans classification scraper (public pages, no login)');
  console.log(`  base   : ${cfg.base}`);
  console.log(`  scope  : ${cfg.maxCompanies ? `${cfg.maxCompanies} companies (smoke)` : 'all liquid companies'} from index ${cfg.startAt}`);

  const liquid = JSON.parse(fs.readFileSync(path.join(OUT_DIR, 'liquid-universe.json'), 'utf8'));
  const existing = fs.existsSync(OUT_FILE) ? JSON.parse(fs.readFileSync(OUT_FILE, 'utf8')).companies || {} : {};
  const out = { ...existing };

  let slice = liquid.slice(cfg.startAt);
  if (cfg.maxCompanies) slice = slice.slice(0, cfg.maxCompanies);

  const stats = { generated_at: new Date().toISOString(), universe_in: liquid.length, attempted: slice.length, found: 0, not_found: 0, errors: 0, missing_industry: [] };
  let i = 0;
  for (const row of slice) {
    i += 1;
    const symbol = normSymbol(row.slug);
    // resume: skip names already classified with a real industry
    if (out[symbol] && out[symbol].industry) continue;

    const url = companyUrl(cfg.base, symbol);
    const res = await fetchHtml(url);
    if (res.status === 404) {
      stats.not_found += 1;
      out[symbol] = { slug: row.slug, symbol, industry: null, status: 'not_found', url };
    } else if (res.status !== 200) {
      stats.errors += 1;
      out[symbol] = { slug: row.slug, symbol, industry: null, status: `http_${res.status}`, url };
      console.warn(`  ${i}/${slice.length} ${symbol} — fetch failed (${res.error || res.status})`);
    } else {
      const industry = extractIndustry(res.html);
      if (industry) stats.found += 1;
      else stats.missing_industry.push(symbol);
      out[symbol] = { slug: row.slug, symbol, industry, url };
      console.log(`  ${i}/${slice.length} ${symbol} -> ${industry ?? '(no industry tag)'}`);
    }
    writeOut(cfg.base, out); // flush each — resumable
    if (cfg.politenessMs) await sleep(cfg.politenessMs);
  }

  writeOut(cfg.base, out);
  fs.writeFileSync(DEBUG_FILE, JSON.stringify(stats, null, 2));
  console.log(`\nDone — ${stats.found} industries, ${stats.not_found} not on Stockscans, ${stats.errors} errors (of ${slice.length}).`);
  console.log(`  ${OUT_FILE}`);
}

// Only run when invoked directly (not when imported by the unit test).
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(`\nFATAL: ${err.message}`);
    process.exit(1);
  });
}
