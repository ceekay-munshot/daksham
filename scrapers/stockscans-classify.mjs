#!/usr/bin/env node
// Stockscans.in industry-classification scraper.
//
// The client wants the dashboard's sector / peer grouping to follow Stockscans'
// industry classification (https://www.stockscans.in) instead of Screener's. The
// classification lives behind a login, so this logs in, discovers each company's
// Stockscans page from the sitemap, and extracts its industry + sector into
//   public/data/stockscans-classification.json   { slug -> { symbol, industry, sector } }
//
// Join key: our liquid-universe slugs are NSE symbols, and Stockscans URLs are
// `NSE:<SYMBOL>` — so the mapping is a direct symbol match.
//
// NOTE (v1 — recon): the logged-in page DOM could not be inspected up front, so
// this run is deliberately conservative. With DEBUG_DUMP_HTML=1 (default on the
// smoke run) it saves the rendered HTML + a screenshot of the login page and the
// first companies to public/data/debug/stockscans/, so the extraction selectors
// can be tightened from a real dump. Best-effort extraction runs regardless.
//
//   STOCKSCANS_EMAIL=... STOCKSCANS_PASSWORD=... MAX_COMPANIES=5 node scrapers/stockscans-classify.mjs

import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import * as cheerio from 'cheerio';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.resolve(__dirname, '..', 'public', 'data');
const DEBUG_DIR = path.resolve(OUT_DIR, 'debug', 'stockscans');
const OUT_FILE = path.join(OUT_DIR, 'stockscans-classification.json');
const DEBUG_FILE = path.join(OUT_DIR, 'stockscans-classification-debug.json');

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const truthy = (v) => ['1', 'true', 'yes', 'on'].includes(String(v || '').toLowerCase());
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// ─────────────────────────── pure helpers (unit-tested) ─────────────────────
// Extract every <loc> URL from a sitemap / sitemap-index XML.
export function parseSitemap(xml) {
  const $ = cheerio.load(xml || '', { xmlMode: true });
  const urls = [];
  $('loc').each((_, el) => {
    const u = $(el).text().trim();
    if (u) urls.push(u);
  });
  return urls;
}

// `.../company/NSE:RELIANCE` / `.../NSE:RELIANCE/...` -> { exchange, symbol }.
export function symbolFromUrl(url) {
  const m = String(url || '').match(/\b(NSE|BSE):([A-Za-z0-9&._-]+)/i);
  return m ? { exchange: m[1].toUpperCase(), symbol: m[2].toUpperCase() } : null;
}

export const normSymbol = (s) => String(s || '').trim().toUpperCase();

// Best-effort industry / sector read from a rendered company page. Looks for a
// label cell ("Industry" / "Sector") and takes the nearest value. Deliberately
// forgiving — refined once a real logged-in dump is in hand.
export function extractClassification(html) {
  const $ = cheerio.load(html || '');
  const pick = (labels) => {
    let val = null;
    $('*').each((_, el) => {
      if (val) return;
      const $el = $(el);
      const own = $el.clone().children().remove().end().text().trim().toLowerCase().replace(/:$/, '');
      if (!labels.includes(own)) return;
      const cand =
        $el.next().text().trim() ||
        $el.parent().find('a,span,div').not($el).first().text().trim() ||
        $el.parent().next().text().trim();
      if (cand && cand.length <= 60 && cand.toLowerCase() !== own) val = cand;
    });
    return val || null;
  };
  return { industry: pick(['industry', 'sub-industry', 'sub industry']), sector: pick(['sector']) };
}

// ─────────────────────────── config ────────────────────────────────────────
function readConfig() {
  const { STOCKSCANS_EMAIL, STOCKSCANS_PASSWORD } = process.env;
  if (!STOCKSCANS_EMAIL || !STOCKSCANS_PASSWORD) {
    throw new Error('Missing credentials: set STOCKSCANS_EMAIL and STOCKSCANS_PASSWORD.');
  }
  const base = (process.env.STOCKSCANS_BASE || 'https://www.stockscans.in').replace(/\/+$/, '');
  const max = parseInt(process.env.MAX_COMPANIES || '', 10);
  return {
    email: STOCKSCANS_EMAIL,
    password: STOCKSCANS_PASSWORD,
    base,
    loginUrl: process.env.STOCKSCANS_LOGIN_URL || `${base}/login`,
    maxCompanies: Number.isFinite(max) && max > 0 ? max : null, // null = all
    startAt: Math.max(0, parseInt(process.env.START_AT || '0', 10) || 0),
    debug: process.env.DEBUG_DUMP_HTML == null ? true : truthy(process.env.DEBUG_DUMP_HTML),
  };
}

const firstPresent = async (page, selectors) => {
  for (const s of selectors) if (await page.locator(s).count()) return s;
  return null;
};

function dump(name, content) {
  fs.mkdirSync(DEBUG_DIR, { recursive: true });
  fs.writeFileSync(path.join(DEBUG_DIR, name), content);
}

async function login(page, cfg) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await page.goto(cfg.loginUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
      break;
    } catch (err) {
      if (attempt >= 3) throw new Error(`Could not reach Stockscans login after 3 attempts: ${err.message}`);
      await sleep(2000 * attempt);
    }
  }
  await page.waitForSelector('input', { timeout: 20000 }).catch(() => {});
  await sleep(1500); // let the SPA finish painting the form

  const emailSel = await firstPresent(page, [
    'input[type="email"]', 'input[name="email"]', 'input[name="username"]', 'input[autocomplete="username"]', 'input[type="text"]',
  ]);
  const passSel = await firstPresent(page, ['input[type="password"]', 'input[name="password"]']);
  if (!emailSel || !passSel) {
    if (cfg.debug) { dump('login-page.html', await page.content()); await page.screenshot({ path: path.join(DEBUG_DIR, 'login-page.png') }).catch(() => {}); }
    throw new Error('Login form fields not found — is the account email/password (not Google-only)? See debug/stockscans/login-page.html');
  }
  await page.fill(emailSel, cfg.email);
  await page.fill(passSel, cfg.password);
  const btn = page
    .locator('button[type="submit"], button:has-text("Sign in"), button:has-text("Sign In"), button:has-text("Log in"), button:has-text("Login"), button:has-text("Continue")')
    .first();
  if (await btn.count()) await btn.click();
  else await page.press(passSel, 'Enter');

  await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
  await sleep(2000);

  const stillHasPassword = await page.locator('input[type="password"]').count();
  const html = await page.content();
  const loggedIn = !stillHasPassword || /logout|sign out|my account|profile/i.test(html);
  if (cfg.debug) { dump('post-login.html', html); await page.screenshot({ path: path.join(DEBUG_DIR, 'post-login.png') }).catch(() => {}); }
  if (!loggedIn) {
    throw new Error('Login appears to have failed (password field still present, no account indicator). See debug/stockscans/post-login.html');
  }
}

// Pull every company URL Stockscans publishes → Map(SYMBOL -> url).
async function fetchCompanyIndex(cfg) {
  const idx = new Map();
  const sitemaps = [`${cfg.base}/sitemaps/companies.xml`];
  for (const sm of sitemaps) {
    let xml = '';
    try {
      const res = await fetch(sm, { headers: { 'User-Agent': UA } });
      if (!res.ok) { console.warn(`  sitemap: ${sm} -> HTTP ${res.status}`); continue; }
      xml = await res.text();
    } catch (err) { console.warn(`  sitemap: ${sm} failed (${err.message})`); continue; }
    // A sitemap index points to child sitemaps; follow one level.
    const locs = parseSitemap(xml);
    const children = locs.filter((u) => /\.xml($|\?)/.test(u));
    const targets = children.length ? children : [null];
    for (const child of targets) {
      let urls = locs;
      if (child) {
        try {
          const r = await fetch(child, { headers: { 'User-Agent': UA } });
          urls = parseSitemap(await r.text());
        } catch { urls = []; }
      }
      for (const u of urls) {
        const s = symbolFromUrl(u);
        if (s && !idx.has(s.symbol)) idx.set(s.symbol, { url: u, exchange: s.exchange });
      }
    }
  }
  return idx;
}

function writeOut(companies, meta) {
  fs.writeFileSync(
    OUT_FILE,
    JSON.stringify({ generated_at: new Date().toISOString(), source: meta.base, count: Object.keys(companies).length, companies }, null, 0)
  );
}

async function main() {
  const cfg = readConfig();
  console.log('Stockscans classification scraper');
  console.log(`  base   : ${cfg.base}`);
  console.log(`  scope  : ${cfg.maxCompanies ? `${cfg.maxCompanies} companies (smoke)` : 'all liquid companies'} from index ${cfg.startAt}`);

  const liquid = JSON.parse(fs.readFileSync(path.join(OUT_DIR, 'liquid-universe.json'), 'utf8'));
  const existing = fs.existsSync(OUT_FILE) ? JSON.parse(fs.readFileSync(OUT_FILE, 'utf8')).companies || {} : {};
  const out = { ...existing };

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ userAgent: UA });
  const page = await context.newPage();
  page.setDefaultNavigationTimeout(60000);

  const stats = { generated_at: new Date().toISOString(), universe_in: liquid.length, matched: 0, unmatched: 0, extracted: 0, unmatched_slugs: [], no_class_slugs: [] };
  try {
    await login(page, cfg);
    console.log('  login  : ok');

    const idx = await fetchCompanyIndex(cfg);
    console.log(`  sitemap: Stockscans lists ${idx.size} companies`);

    let slice = liquid.slice(cfg.startAt);
    if (cfg.maxCompanies) slice = slice.slice(0, cfg.maxCompanies);

    let i = 0;
    for (const row of slice) {
      i += 1;
      const symbol = normSymbol(row.slug);
      const hit = idx.get(symbol);
      if (!hit) { stats.unmatched += 1; stats.unmatched_slugs.push(symbol); continue; }
      stats.matched += 1;

      let html = null;
      for (let attempt = 1; attempt <= 3 && html == null; attempt++) {
        try {
          await page.goto(hit.url, { waitUntil: 'domcontentloaded' });
          await page.waitForSelector('body', { timeout: 15000 });
          await sleep(1200); // SPA render
          html = await page.content();
        } catch { await sleep(1000 * attempt); }
      }
      if (html == null) { stats.no_class_slugs.push(symbol); continue; }

      if (cfg.debug && i <= 3) {
        dump(`company-${symbol}.html`, html);
        await page.screenshot({ path: path.join(DEBUG_DIR, `company-${symbol}.png`) }).catch(() => {});
      }

      const cls = extractClassification(html);
      if (cls.industry || cls.sector) stats.extracted += 1;
      else stats.no_class_slugs.push(symbol);

      out[symbol] = { slug: row.slug, symbol, exchange: hit.exchange, industry: cls.industry, sector: cls.sector, url: hit.url };
      writeOut(out, cfg); // flush each — resumable
      console.log(`  ${i}/${slice.length} ${symbol} -> industry=${cls.industry ?? '—'} sector=${cls.sector ?? '—'}`);
      await sleep(400);
    }

    // one index page for reference on the recon run
    if (cfg.debug) {
      try {
        await page.goto(`${cfg.base}/index/NSE:CNXIT`, { waitUntil: 'domcontentloaded' });
        await sleep(1500);
        dump('index-CNXIT.html', await page.content());
      } catch { /* best effort */ }
    }

    writeOut(out, cfg);
    fs.writeFileSync(DEBUG_FILE, JSON.stringify(stats, null, 2));
    console.log(`\nDone — matched ${stats.matched}, extracted ${stats.extracted}, unmatched ${stats.unmatched}.`);
    console.log(`  ${OUT_FILE}`);
    if (cfg.debug) console.log(`  debug dumps: public/data/debug/stockscans/`);
  } finally {
    await browser.close();
  }
}

// Only run when invoked directly (not when imported by the unit test).
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(`\nFATAL: ${err.message}`);
    process.exit(1);
  });
}
