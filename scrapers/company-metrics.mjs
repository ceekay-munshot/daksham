#!/usr/bin/env node
// Per-company metrics crawler.
//
// Reads public/data/liquid-universe.json (the volume-pass names), opens each
// company's Screener page in Screener's default view (consolidated when
// available, else standalone), expands the Expenses / Other Assets schedules,
// and extracts the raw fundamentals + multi-period series Daksham needs into
// public/data/daksham-companies.json. Runs ONLY on the liquid set.
//
//   SCREENER_EMAIL=... SCREENER_PASSWORD=... node scrapers/company-metrics.mjs
//   START_AT=0 MAX_COMPANIES=3 ...   # resume offset + smoke-test cap

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { launchLoggedIn, gotoWithRetry, sleep } from './lib/screener.mjs';
import { parseCompanyPage, toCsv, inspectCompany } from './lib/company.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.resolve(__dirname, '..', 'public', 'data');
const LIQUID_PATH = path.join(OUT_DIR, 'liquid-universe.json');
const JSON_PATH = path.join(OUT_DIR, 'daksham-companies.json');
const CSV_PATH = path.join(OUT_DIR, 'daksham-companies.csv');
const META_PATH = path.join(OUT_DIR, 'companies-metadata.json');

const BASE = 'https://www.screener.in';
const truthy = (v) => ['1', 'true', 'yes', 'on'].includes(String(v || '').toLowerCase());

// Navigate to the path Screener itself recorded in the universe — it already
// encodes /consolidated/ when consolidated financials exist, so we land on the
// default view (consolidated when available, else standalone). Fall back to slug.
function companyUrl(row) {
  const p = String(row.path || '').trim();
  if (p.startsWith('/company/')) return `${BASE}${p.endsWith('/') ? p : `${p}/`}`;
  return `${BASE}/company/${encodeURIComponent(String(row.slug || '').trim())}/`;
}

function readConfig() {
  const { SCREENER_EMAIL, SCREENER_PASSWORD, START_AT = '0', MAX_COMPANIES = '' } = process.env;
  if (!SCREENER_EMAIL || !SCREENER_PASSWORD) {
    throw new Error('Missing credentials: set SCREENER_EMAIL and SCREENER_PASSWORD.');
  }
  const startAt = Math.max(0, parseInt(START_AT, 10) || 0);
  const maxCompanies = MAX_COMPANIES ? Math.max(1, parseInt(MAX_COMPANIES, 10)) : Infinity;
  return {
    email: SCREENER_EMAIL,
    password: SCREENER_PASSWORD,
    startAt,
    maxCompanies,
    onlyNew: truthy(process.env.ONLY_NEW), // crawl only liquid names not yet in companies.json
    debug: truthy(process.env.DEBUG_DUMP_HTML),
  };
}

// Expand a schedule row (e.g. "Expenses") inside a section so its sub-rows
// (Material Cost %, Inventories) are injected. Screener loads these via AJAX and
// the click is occasionally dropped (rapid sequential expands race), so detect
// whether the row actually expanded — the section's row count grows — and
// re-click only if it didn't. This avoids toggling an already-open row shut and
// avoids burning the full timeout on companies that legitimately lack the row.
async function expandRow(page, sectionId, buttonText, expectText, attempts = 3) {
  const rowsSelector = `${sectionId} table.data-table tr`;
  const targetPresent = async () =>
    expectText
      ? (await page.locator(sectionId).getByText(expectText, { exact: false }).first().count()) > 0
      : false;

  for (let attempt = 0; attempt < attempts; attempt++) {
    if (await targetPresent()) return; // already expanded with the row we need

    const btn = page.locator(`${sectionId} button`, { hasText: buttonText }).first();
    if (!(await btn.count())) return; // no such expandable row (e.g. a financial co)

    const before = await page.locator(rowsSelector).count();
    try {
      await btn.click({ timeout: 4000 });
    } catch {
      return;
    }

    // Wait until the row actually expands (sub-rows get injected).
    await page
      .waitForFunction(
        ([sel, n]) => document.querySelectorAll(sel).length > n,
        [rowsSelector, before],
        { timeout: 5000 }
      )
      .catch(() => {});

    if ((await page.locator(rowsSelector).count()) > before) return; // expanded
    await page.waitForTimeout(300); // click was dropped — settle and retry
  }
}

// Navigate to a company page, wait for the ribbon + sections, expand the
// schedules we read sub-rows from, and return the page HTML (or null).
async function fetchCompanyHtml(page, url, patient) {
  const html = await gotoWithRetry(page, url, {
    waitFor: '#top-ratios',
    isFirst: patient,
    attempts: patient ? 3 : 2,
  });
  if (!html) return null;

  await page.waitForSelector('#profit-loss', { timeout: patient ? 12000 : 6000 }).catch(() => {});

  // Expand the rows whose sub-rows we need (Material Cost %, Inventories).
  await expandRow(page, '#profit-loss', 'Expenses', 'Material Cost');
  await expandRow(page, '#quarters', 'Expenses', 'Material Cost');
  await expandRow(page, '#balance-sheet', 'Other Assets', 'Inventories');

  return page.content();
}

// A parse "looks complete" if the ribbon rendered (current price) or the P&L did.
const looksComplete = (p) => !!p && (p.current_price !== '' || p.revenue_series !== '');

function buildMetadata(rows, failures) {
  const counts = {};
  for (const r of rows) {
    const v = r.financials_view || 'unknown';
    counts[v] = (counts[v] || 0) + 1;
  }
  return {
    generated_at: new Date().toISOString(),
    financials_view_counts: counts,
    company_count: rows.length,
    failures,
  };
}

function flush(rows, failures) {
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(JSON_PATH, `${JSON.stringify(rows, null, 2)}\n`);
  writeFileSync(CSV_PATH, toCsv(rows));
  writeFileSync(META_PATH, `${JSON.stringify(buildMetadata(rows, failures), null, 2)}\n`);
}

function loadExisting() {
  if (!existsSync(JSON_PATH)) return [];
  try {
    const d = JSON.parse(readFileSync(JSON_PATH, 'utf8'));
    return Array.isArray(d) ? d : [];
  } catch {
    return [];
  }
}

// Debug: dump a company's post-expansion HTML (gitignored; uploaded as a CI
// artifact when DEBUG_DUMP_HTML is set) so the live DOM can be inspected.
function dumpCompanyHtml(slug, html) {
  const dir = path.join(OUT_DIR, 'debug');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, `company-${slug.replace(/[^A-Za-z0-9_-]/g, '_')}.html`), html);
}

async function main() {
  const cfg = readConfig();

  if (!existsSync(LIQUID_PATH)) {
    throw new Error(`Liquid universe not found: ${LIQUID_PATH}. Run the bhavcopy volume gate first.`);
  }
  const liquid = JSON.parse(readFileSync(LIQUID_PATH, 'utf8'));
  if (!Array.isArray(liquid) || !liquid.length) throw new Error('liquid-universe.json is empty.');

  console.log('Per-company metrics crawler');
  console.log(`  liquid_in : ${liquid.length}`);

  // Results keyed by path so a resume / only-new run replaces rather than duplicates.
  const byPath = new Map();
  const seed = () => {
    for (const r of loadExisting()) if (r && r.path) byPath.set(r.path, r);
  };

  // Decide which companies to crawl this run.
  let toProcess;
  if (cfg.onlyNew) {
    seed(); // keep everything already crawled
    toProcess = liquid.filter((r) => r.path && !byPath.has(r.path));
    if (cfg.maxCompanies !== Infinity) toProcess = toProcess.slice(0, cfg.maxCompanies);
    console.log(`  mode      : only-new — ${toProcess.length} new liquid entrant(s) to crawl`);
  } else {
    if (cfg.startAt > 0) seed();
    toProcess = liquid.slice(cfg.startAt, cfg.startAt + cfg.maxCompanies);
    console.log(`  range     : [${cfg.startAt}..${cfg.startAt + toProcess.length})`);
  }
  if (byPath.size) console.log(`  seeded    : ${byPath.size} companies from a previous run`);

  if (!toProcess.length) {
    console.log('Nothing to crawl — companies.json already covers the liquid set.');
    return;
  }

  const failures = [];
  const { browser, page } = await launchLoggedIn(cfg.email, cfg.password);
  try {
    console.log('  login     : ok');

    for (let i = 0; i < toProcess.length; i++) {
      const row = toProcess[i];
      const idx = cfg.onlyNew ? i : cfg.startAt + i;
      const slug = String(row.slug || '').trim();
      if (!slug) {
        failures.push({ slug: '', error: 'missing slug' });
        continue;
      }

      const url = companyUrl(row);
      try {
        let html = await fetchCompanyHtml(page, url, false);
        let parsed = html ? parseCompanyPage(html, { url }) : null;

        if (!looksComplete(parsed)) {
          // Retry once with extra patience if the ribbon/sections didn't render.
          await sleep(500);
          html = await fetchCompanyHtml(page, url, true);
          parsed = html ? parseCompanyPage(html, { url }) : null;
        }

        if (cfg.debug && html) {
          dumpCompanyHtml(slug, html);
          console.log(`  inspect [${slug}]:\n${inspectCompany(html)}`);
        }

        if (!looksComplete(parsed)) {
          failures.push({ slug, error: 'ribbon/sections did not render' });
          console.warn(`  [${idx}] ${slug} — FAILED (no render)`);
        } else {
          byPath.set(row.path, { ...row, ...parsed });
          const yrs = parsed.revenue_series ? parsed.revenue_series.split('|').length : 0;
          const qtrs = parsed.sales_qtr_series ? parsed.sales_qtr_series.split('|').length : 0;
          console.log(
            `  [${idx}] ${slug} — ${parsed.financials_view || '?'} | ${yrs}y rev | ${qtrs}q sales | pb ${parsed.pb}`
          );
        }
      } catch (err) {
        failures.push({ slug, error: err.message });
        console.warn(`  [${idx}] ${slug} — ERROR ${err.message}`);
      }

      flush([...byPath.values()], failures); // incremental: crash-resumable
      await sleep(300);
    }

    const rows = [...byPath.values()];
    flush(rows, failures);
    console.log(`\nDone — companies: ${rows.length}, failures: ${failures.length}`);
    console.log(`  views: ${JSON.stringify(buildMetadata(rows, failures).financials_view_counts)}`);
    console.log(`  ${JSON_PATH}`);
    console.log(`  ${CSV_PATH}`);
    console.log(`  ${META_PATH}`);
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error(`\nFATAL: ${err.message}`);
  process.exit(1);
});
