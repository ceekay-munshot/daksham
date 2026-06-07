#!/usr/bin/env node
// Document harvester — foundation of the qualitative tier.
//
// For each liquid company, collect the last 4 concall TRANSCRIPTS + the latest
// investor PPT from Screener's "Documents / Concalls" section, download the PDFs
// (via the logged-in browser context), extract text, and cache it. The cache is
// gitignored; only the small manifest + todo are committed.
//
//   SCREENER_EMAIL=... SCREENER_PASSWORD=... MAX_COMPANIES=15 node scrapers/doc-harvester.mjs

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { launchLoggedIn, gotoWithRetry, sleep, DESKTOP_UA } from './lib/screener.mjs';
import { parseDocuments, selectDocs, manifestEntry, slugSafe } from './lib/docs.mjs';
import pdf from 'pdf-parse/lib/pdf-parse.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'public', 'data');
const LIQUID_PATH = path.join(OUT_DIR, 'liquid-universe.json');
const MANIFEST_PATH = path.join(OUT_DIR, 'docs-manifest.json');
const TODO_PATH = path.join(OUT_DIR, 'docs-todo.json');

const BASE = 'https://www.screener.in';
const truthy = (v) => ['1', 'true', 'yes', 'on'].includes(String(v || '').toLowerCase());

function readConfig() {
  const { SCREENER_EMAIL, SCREENER_PASSWORD, START_AT = '0', MAX_COMPANIES = '' } = process.env;
  if (!SCREENER_EMAIL || !SCREENER_PASSWORD) {
    throw new Error('Missing credentials: set SCREENER_EMAIL and SCREENER_PASSWORD.');
  }
  return {
    email: SCREENER_EMAIL,
    password: SCREENER_PASSWORD,
    startAt: Math.max(0, parseInt(START_AT, 10) || 0),
    maxCompanies: MAX_COMPANIES ? Math.max(1, parseInt(MAX_COMPANIES, 10)) : Infinity,
    firecrawlKey: (process.env.FIRECRAWL_API_KEY || '').trim(),
    debug: truthy(process.env.DEBUG_DUMP_HTML),
  };
}

function companyUrl(row) {
  const p = String(row.path || '').trim();
  if (p.startsWith('/company/')) return `${BASE}${p.endsWith('/') ? p : `${p}/`}`;
  return `${BASE}/company/${encodeURIComponent(String(row.slug || '').trim())}/`;
}

const loadJson = (p, fallback) => {
  if (!existsSync(p)) return fallback;
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return fallback;
  }
};

async function extractPdfText(buf) {
  try {
    const data = await pdf(buf);
    return data && data.text ? data.text : '';
  } catch {
    return ''; // encrypted / malformed → treat as no text (ocr_needed)
  }
}

// Download a PDF, preferring the logged-in browser context (carries cookies + a
// real UA, so BSE / IR hosts are less likely to block). Falls back to fetch().
async function downloadPdf(context, url) {
  try {
    const r = await context.request.get(url, { timeout: 45000, headers: { Referer: BASE } });
    if (r.ok()) {
      const b = await r.body();
      if (b && b.length) return b;
    }
  } catch {
    /* try fetch next */
  }
  try {
    const r = await fetch(url, { headers: { 'User-Agent': DESKTOP_UA, Referer: BASE } });
    if (r.ok) {
      const b = Buffer.from(await r.arrayBuffer());
      if (b.length) return b;
    }
  } catch {
    /* give up */
  }
  return null;
}

function writeOutputs(manifest, todoSet) {
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`);
  const names = [...todoSet].sort();
  writeFileSync(
    TODO_PATH,
    `${JSON.stringify({ generated_at: new Date().toISOString(), none_found: names.length, names }, null, 2)}\n`
  );
}

async function main() {
  const cfg = readConfig();

  if (!existsSync(LIQUID_PATH)) {
    throw new Error(`Liquid universe not found: ${LIQUID_PATH}. Run the bhavcopy gate first.`);
  }
  const liquid = JSON.parse(readFileSync(LIQUID_PATH, 'utf8'));
  if (!Array.isArray(liquid) || !liquid.length) throw new Error('liquid-universe.json is empty.');

  const slice = liquid.slice(cfg.startAt, cfg.startAt + cfg.maxCompanies);
  console.log('Document harvester');
  console.log(`  liquid_in : ${liquid.length}`);
  console.log(`  range     : [${cfg.startAt}..${cfg.startAt + slice.length})`);

  // Accumulate across batches.
  const manifest = loadJson(MANIFEST_PATH, {});
  const todoSet = new Set((loadJson(TODO_PATH, {}).names) || []);

  const stats = { companies_with_docs: 0, transcripts_cached: 0, ppts_cached: 0, none_found: 0 };

  const { browser, context, page } = await launchLoggedIn(cfg.email, cfg.password);
  try {
    console.log('  login     : ok');

    for (let i = 0; i < slice.length; i++) {
      const row = slice[i];
      const idx = cfg.startAt + i;
      const slug = String(row.slug || '').trim();
      if (!slug) continue;
      const url = companyUrl(row);

      try {
        const html = await gotoWithRetry(page, url, { waitFor: '#top-ratios', attempts: 2 });
        if (!html) {
          console.warn(`  [${idx}] ${slug} — page did not render`);
          continue;
        }
        if (cfg.debug) {
          const dbg = path.join(ROOT, 'cache', 'docs', '_debug');
          mkdirSync(dbg, { recursive: true });
          writeFileSync(path.join(dbg, `${slugSafe(slug)}.html`), html);
        }

        const docs = selectDocs(parseDocuments(html));
        if (!docs.length) {
          todoSet.add(slug);
          delete manifest[slug];
          stats.none_found += 1;
          console.log(`  [${idx}] ${slug} — no documents`);
          writeOutputs(manifest, todoSet);
          await sleep(300);
          continue;
        }

        const entries = [];
        for (const doc of docs) {
          const abs = path.join(ROOT, manifestEntry(doc, '', slug).cached_path);
          let text;
          if (existsSync(abs)) {
            text = readFileSync(abs, 'utf8'); // already cached (incl. empty = known image PDF)
          } else {
            const buf = await downloadPdf(context, doc.url);
            if (!buf) {
              console.warn(`    ${slug} ${doc.type} ${doc.period} — download failed (will retry next run)`);
              continue;
            }
            text = await extractPdfText(buf);
            mkdirSync(path.dirname(abs), { recursive: true });
            writeFileSync(abs, text);
            await sleep(200);
          }
          const entry = manifestEntry(doc, text, slug);
          entries.push(entry);
          if (entry.type === 'transcript') stats.transcripts_cached += 1;
          else stats.ppts_cached += 1;
        }

        if (entries.length) {
          manifest[slug] = entries;
          todoSet.delete(slug);
          stats.companies_with_docs += 1;
          const t = entries.filter((e) => e.type === 'transcript').length;
          const p = entries.filter((e) => e.type === 'ppt').length;
          const ocr = entries.filter((e) => e.ocr_needed).length;
          console.log(`  [${idx}] ${slug} — ${t} transcript(s), ${p} ppt(s)${ocr ? `, ${ocr} ocr_needed` : ''}`);
        } else {
          todoSet.add(slug);
          stats.none_found += 1;
          console.log(`  [${idx}] ${slug} — documents listed but none downloaded`);
        }
      } catch (err) {
        console.warn(`  [${idx}] ${slug} — ERROR ${err.message}`);
      }

      writeOutputs(manifest, todoSet); // incremental flush (crash-resumable)
      await sleep(300); // politeness
    }

    writeOutputs(manifest, todoSet);
    console.log(
      `\nDone — companies_with_docs: ${stats.companies_with_docs}, transcripts_cached: ${stats.transcripts_cached}, ppts_cached: ${stats.ppts_cached}, none_found: ${stats.none_found}`
    );
    console.log(`  ${MANIFEST_PATH}`);
    console.log(`  ${TODO_PATH}`);
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error(`\nFATAL: ${err.message}`);
  process.exit(1);
});
