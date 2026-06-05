#!/usr/bin/env node
// Screener.in universe scraper.
//
// Logs in to Screener, paginates a saved screen, parses the results table with
// cheerio and writes the candidate universe (company list + the current-value
// ratio columns shown on the screen) to public/data/.
//
// It STOPS at the screen list — it does not crawl individual company pages. The
// per-company crawl and the bhavcopy volume gate are separate, later steps.
//
//   SCREENER_EMAIL=... SCREENER_PASSWORD=... node scrapers/screener-universe.mjs

import { chromium } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseScreenTable, dedupeByPath } from './lib/parse.mjs';
import { writeUniverse, loadExistingUniverse } from './lib/output.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.resolve(__dirname, '..', 'public', 'data');

const LOGIN_URL = 'https://www.screener.in/login/';
const DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function readConfig() {
  const {
    SCREENER_EMAIL,
    SCREENER_PASSWORD,
    SCREEN_URL = 'https://www.screener.in/screens/3706521/daksham-universe-mcap-25000/',
    MAX_PAGES = '60',
    START_AT = '0',
  } = process.env;

  if (!SCREENER_EMAIL || !SCREENER_PASSWORD) {
    throw new Error(
      'Missing credentials: set SCREENER_EMAIL and SCREENER_PASSWORD. ' +
        'Login is required to read the saved screen and its columns.'
    );
  }

  const maxPages = Math.max(1, parseInt(MAX_PAGES, 10) || 60);
  const startAt = Math.max(0, parseInt(START_AT, 10) || 0);
  const startPage = startAt > 0 ? startAt : 1;
  // Drop any query string and trailing slash so we can append `/?page=N`.
  const base = SCREEN_URL.split('?')[0].replace(/\/+$/, '');

  return {
    email: SCREENER_EMAIL,
    password: SCREENER_PASSWORD,
    screenUrl: SCREEN_URL,
    base,
    maxPages,
    startPage,
  };
}

async function login(page, email, password) {
  await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded' });
  await page.fill('input[name="username"]', email);
  await page.fill('input[name="password"]', password);

  const submit = page.locator('button[type="submit"]');
  if (await submit.count()) await submit.first().click();
  else await page.press('input[name="password"]', 'Enter');

  await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});

  const html = await page.content();
  if (!html.includes('/logout/')) {
    throw new Error(
      'Screener login failed: no /logout/ link found after submitting credentials. ' +
        'Double-check SCREENER_EMAIL / SCREENER_PASSWORD.'
    );
  }
}

// Fetch a screen page and return its HTML, or null if the results table never
// appears (used to detect that we have paginated past the last page).
async function fetchPageHtml(page, url, isFirst) {
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  try {
    await page.waitForSelector('table.data-table', { timeout: isFirst ? 20000 : 10000 });
  } catch {
    return null;
  }
  return page.content();
}

async function main() {
  const cfg = readConfig();
  console.log('Screener universe scraper');
  console.log(`  screen : ${cfg.screenUrl}`);
  console.log(`  pages  : ${cfg.startPage}..${cfg.maxPages}`);

  // Accumulated, de-duplicated universe. When resuming (START_AT > 1) seed it
  // from the previous run so earlier pages are not lost.
  const seen = new Set();
  const all = [];
  if (cfg.startPage > 1) {
    for (const r of loadExistingUniverse(OUT_DIR)) {
      if (r && r.path && !seen.has(r.path)) {
        seen.add(r.path);
        all.push(r);
      }
    }
    if (all.length) console.log(`  resume : loaded ${all.length} companies from previous run`);
  }

  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ userAgent: DESKTOP_UA });
    const page = await context.newPage();

    await login(page, cfg.email, cfg.password);
    console.log('  login  : ok');

    let totalPages = null;
    for (let p = cfg.startPage; p <= cfg.maxPages; p++) {
      const url = `${cfg.base}/?page=${p}`;
      const html = await fetchPageHtml(page, url, p === cfg.startPage);

      if (html === null) {
        if (p === 1) {
          throw new Error(
            `No table.data-table on page 1 (${url}). ` +
              'Check that the credentials are valid and the screen URL is correct.'
          );
        }
        console.log(`page ${p} — no data-table, stopping.`);
        break;
      }

      const { hasTable, totalPages: tp, rows, warnings } = parseScreenTable(html);
      if (tp) totalPages = tp;
      for (const w of warnings) console.warn(`  warn page ${p}: ${w}`);

      if (p === 1 && (!hasTable || rows.length === 0)) {
        throw new Error(
          `Page 1 returned 0 companies (${url}). ` +
            'The screen looks empty or its layout changed.'
        );
      }

      const fresh = dedupeByPath(rows, seen);
      all.push(...fresh);

      const newNote = fresh.length === rows.length ? '' : ` (${fresh.length} new)`;
      console.log(`page ${p} of ${totalPages ?? '?'} — ${rows.length} companies${newNote}`);

      // Flush after every page so a crash mid-run is resumable.
      writeUniverse({ outDir: OUT_DIR, rows: all, source: cfg.screenUrl });

      if (totalPages && p >= totalPages) break;
      if (p > 1 && rows.length === 0) break;

      await sleep(300);
    }

    const out = writeUniverse({ outDir: OUT_DIR, rows: all, source: cfg.screenUrl });
    console.log(`\nDone — ${all.length} companies in the universe.`);
    console.log(`  ${out.jsonPath}`);
    console.log(`  ${out.csvPath}`);
    console.log(`  ${out.metaPath}`);
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error(`\nFATAL: ${err.message}`);
  process.exit(1);
});
