#!/usr/bin/env node
// NSE bhavcopy volume gate.
//
// Reads public/data/daksham-universe.json, computes each NSE-listed company's
// 30-trading-day average daily traded VALUE from NSE "full" bhavcopy, and writes
// the subset with avg >= ₹4 Cr to public/data/liquid-universe.json. BSE-only
// names (numeric Screener slugs) have no NSE turnover and are excluded for now.
//
//   node scrapers/bhavcopy-liquidity.mjs
//   FIRECRAWL_API_KEY=... node scrapers/bhavcopy-liquidity.mjs   # optional fallback

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseBhavcopy, buildTurnoverIndex, computeLiquidUniverse } from './lib/bhav.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'public', 'data');
const CACHE_DIR = path.join(ROOT, '.cache', 'bhav');
const UNIVERSE_PATH = path.join(OUT_DIR, 'daksham-universe.json');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const NSE_HOME = 'https://www.nseindia.com/';
const BHAV_BASE = 'https://nsearchives.nseindia.com/products/content';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function readConfig() {
  const {
    FIRECRAWL_API_KEY = '',
    BHAV_DAYS = '30',
    BHAV_MIN_DAYS = '20',
    BHAV_MAX_LOOKBACK = '60',
    ADTV_THRESHOLD_CR = '4',
  } = process.env;
  return {
    firecrawlKey: FIRECRAWL_API_KEY.trim(),
    want: Math.max(1, parseInt(BHAV_DAYS, 10) || 30),
    minDays: Math.max(1, parseInt(BHAV_MIN_DAYS, 10) || 20),
    maxLookback: Math.max(1, parseInt(BHAV_MAX_LOOKBACK, 10) || 60),
    threshold: Number(ADTV_THRESHOLD_CR) || 4,
  };
}

function fmtDDMMYYYY(d) {
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  return `${dd}${mm}${d.getFullYear()}`;
}
function fmtISO(d) {
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}
const bhavUrl = (ddmmyyyy) => `${BHAV_BASE}/sec_bhavdata_full_${ddmmyyyy}.csv`;
const cacheFile = (ddmmyyyy) => path.join(CACHE_DIR, `sec_bhavdata_full_${ddmmyyyy}.csv`);

function readCache(ddmmyyyy) {
  const f = cacheFile(ddmmyyyy);
  if (!existsSync(f)) return null;
  try {
    const t = readFileSync(f, 'utf8');
    return t && t.trim() ? t : null;
  } catch {
    return null;
  }
}
function writeCache(ddmmyyyy, text) {
  mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(cacheFile(ddmmyyyy), text);
}

// NSE blocks bare archive requests; visit the homepage first to obtain cookies.
async function primeSession() {
  try {
    const res = await fetch(NSE_HOME, {
      headers: {
        'User-Agent': UA,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });
    await res.arrayBuffer().catch(() => {});
    const setCookies =
      typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
    return setCookies.map((c) => c.split(';')[0]).join('; ');
  } catch {
    return '';
  }
}

async function fetchBhav(ddmmyyyy, cookie) {
  try {
    const res = await fetch(bhavUrl(ddmmyyyy), {
      headers: {
        'User-Agent': UA,
        Accept: 'text/csv,application/csv,application/octet-stream,*/*',
        'Accept-Language': 'en-US,en;q=0.9',
        Referer: NSE_HOME,
        ...(cookie ? { Cookie: cookie } : {}),
      },
    });
    if (res.status === 200) return { status: 200, text: await res.text() };
    await res.arrayBuffer().catch(() => {});
    return { status: res.status };
  } catch {
    return { status: 0 };
  }
}

// Optional fallback when NSE blocks direct fetches. Best-effort: asks Firecrawl
// for the raw content and accepts it only if it looks like a bhavcopy CSV.
async function fetchViaFirecrawl(url, key) {
  try {
    const res = await fetch('https://api.firecrawl.dev/v1/scrape', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ url, formats: ['rawHtml'], timeout: 30000 }),
    });
    if (!res.ok) return null;
    const data = await res.json().catch(() => null);
    const content = data?.data?.rawHtml ?? data?.data?.html ?? data?.data?.markdown ?? null;
    return content && String(content).includes('SYMBOL') ? String(content) : null;
  } catch {
    return null;
  }
}

async function fetchCsvText(ddmmyyyy, session) {
  let res = await fetchBhav(ddmmyyyy, session.cookie);
  if (res.status === 401 || res.status === 403) {
    session.cookie = await primeSession(); // re-prime once on auth failure
    res = await fetchBhav(ddmmyyyy, session.cookie);
  }
  if (res.status === 200 && res.text) return res.text;
  if (res.status === 404) return null; // not a trading day
  if (session.firecrawlKey) {
    const t = await fetchViaFirecrawl(bhavUrl(ddmmyyyy), session.firecrawlKey);
    if (t) return t;
  }
  return null;
}

// Walk backward from today collecting the last `want` trading days of bhavcopy.
async function collectBhavcopies(c) {
  const session = { cookie: await primeSession(), firecrawlKey: c.firecrawlKey };
  console.log(session.cookie ? '  session: NSE cookies acquired' : '  session: no cookies (will still try archives)');

  const collected = [];
  const today = new Date();
  for (let back = 0; back <= c.maxLookback && collected.length < c.want; back++) {
    const d = new Date(today);
    d.setDate(today.getDate() - back);
    if (d.getDay() === 0 || d.getDay() === 6) continue; // weekends: never published

    const ddmmyyyy = fmtDDMMYYYY(d);
    let text = readCache(ddmmyyyy);
    const cached = text != null;
    if (!cached) {
      text = await fetchCsvText(ddmmyyyy, session);
      if (text == null) continue; // 404 / holiday / blocked
    }

    let rows;
    try {
      rows = parseBhavcopy(text);
    } catch {
      rows = [];
    }
    if (!rows.length) continue; // not a real bhavcopy (e.g. a block page) — don't cache

    if (!cached) writeCache(ddmmyyyy, text);
    collected.push({ iso: fmtISO(d), rows });
    console.log(
      `  bhav   : ${fmtISO(d)} — ${rows.length} EQ rows  [${collected.length}/${c.want}]${cached ? ' (cache)' : ''}`
    );
    if (!cached) await sleep(250); // be gentle with NSE
  }

  if (collected.length < c.minDays) {
    throw new Error(
      `Only ${collected.length} valid bhavcopy days collected (need >= ${c.minDays}). ` +
        'NSE may be blocking requests or down — check session priming / set FIRECRAWL_API_KEY.'
    );
  }
  return collected;
}

async function main() {
  const c = readConfig();
  console.log('Bhavcopy volume gate');
  console.log(`  rule   : avg daily traded value >= ₹${c.threshold} Cr over ${c.want} trading days`);

  if (!existsSync(UNIVERSE_PATH)) {
    throw new Error(`Universe file not found: ${UNIVERSE_PATH}. Run the universe scraper first.`);
  }
  const universe = JSON.parse(readFileSync(UNIVERSE_PATH, 'utf8'));
  if (!Array.isArray(universe) || !universe.length) {
    throw new Error('Universe file is empty or not an array.');
  }
  console.log(`  universe_in: ${universe.length}`);

  const collected = await collectBhavcopies(c);
  const turnoverIndex = buildTurnoverIndex(collected.map((d) => d.rows));
  const daysUsed = collected.map((d) => d.iso);

  const { liquid, debug } = computeLiquidUniverse({
    universe,
    turnoverIndex,
    daysUsed,
    threshold: c.threshold,
  });

  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(path.join(OUT_DIR, 'liquid-universe.json'), `${JSON.stringify(liquid, null, 2)}\n`);
  writeFileSync(path.join(OUT_DIR, 'liquidity-debug.json'), `${JSON.stringify(debug, null, 2)}\n`);

  console.log(
    `\nDone — days_used: ${debug.days_used.length}, universe_in: ${debug.universe_in}, ` +
      `passed: ${debug.passed}, failed: ${debug.failed}, bse_only_excluded: ${debug.bse_only_excluded}`
  );
  console.log(`  ${path.join(OUT_DIR, 'liquid-universe.json')}`);
  console.log(`  ${path.join(OUT_DIR, 'liquidity-debug.json')}`);
}

main().catch((err) => {
  console.error(`\nFATAL: ${err.message}`);
  process.exit(1);
});
