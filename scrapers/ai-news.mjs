#!/usr/bin/env node
// Third-party NEWS lens — the independent, outside-in moat read.
//
// For each liquid company: pull recent headlines from Google News RSS (cached),
// score the SAME 8 moat factors from that external coverage on the free-provider
// round-robin, and write public/data/daksham-news.json (slug → factors), which
// the dashboard joins beside the own + peer lenses to fill the `third_party`
// column. Crash-resumable; refreshes entries older than NEWS_FRESH_DAYS.
//
//   GEMINI_API_KEY=... MAX_COMPANIES=20 node scrapers/ai-news.mjs
//   PROVIDER=mock COMPANIES=AWL node scrapers/ai-news.mjs   # offline (uses cache)

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  newsRssUrl, parseNewsRss, buildNewsInput, newsPrompt,
  shapeFactors, shapePulse, naAllFactors, NEWS_SCHEMA, NEWS_SYSTEM_PROMPT, FACTORS,
} from './lib/news.mjs';
import { createPool, runItem, rateLimiter, poolLabel, poolSummary } from './lib/llm-runner.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'public', 'data');
const CACHE_DIR = path.join(ROOT, 'cache', 'news');
const COMPANIES_PATH = path.join(OUT_DIR, 'daksham-companies.json');
const UNIVERSE_PATH = path.join(OUT_DIR, 'liquid-universe.json');
const OUT_PATH = path.join(OUT_DIR, 'daksham-news.json');

const truthy = (v) => ['1', 'true', 'yes', 'on'].includes(String(v || '').toLowerCase());
const readJSON = (p, fb) => (existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : fb);
const writeJSON = (p, o) => writeFileSync(p, `${JSON.stringify({ ...o, generated_at: new Date().toISOString() }, null, 2)}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ageDays = (iso) => (iso ? (Date.now() - Date.parse(iso)) / 86400000 : Infinity);

function readConfig() {
  const env = process.env;
  return {
    env,
    companies: String(env.COMPANIES || '').split(',').map((s) => s.trim()).filter(Boolean),
    maxCompanies: env.MAX_COMPANIES ? Math.max(1, parseInt(env.MAX_COMPANIES, 10)) : Infinity,
    rpm: env.RPM ? Math.max(1, parseInt(env.RPM, 10)) : 10,
    maxInputChars: env.MAX_INPUT_CHARS ? Math.max(2000, parseInt(env.MAX_INPUT_CHARS, 10)) : 16000,
    maxItems: env.NEWS_MAX_ITEMS ? Math.max(5, parseInt(env.NEWS_MAX_ITEMS, 10)) : 40,
    queryDays: env.NEWS_DAYS ? Math.max(7, parseInt(env.NEWS_DAYS, 10)) : 60,
    freshDays: (env.NEWS_FRESH_DAYS ?? '') !== '' ? Math.max(0, parseInt(env.NEWS_FRESH_DAYS, 10) || 0) : 5,
    fetchRpm: env.NEWS_FETCH_RPM ? Math.max(1, parseInt(env.NEWS_FETCH_RPM, 10)) : 30, // polite pace to Google
    maxBackoff: 4,
    stopAfter: 4,
    force: truthy(env.FORCE),
  };
}

// Liquid-universe order (the spine), names + industry joined from companies.
function buildIndex(companies, universe) {
  const nameBySlug = new Map();
  const indBySlug = new Map();
  for (const c of companies) if (c && c.slug) { nameBySlug.set(c.slug, c.name || c.slug); indBySlug.set(c.slug, c.industry || ''); }
  for (const c of universe) if (c && c.slug && !nameBySlug.has(c.slug)) nameBySlug.set(c.slug, c.name || c.slug);
  const order = [];
  const seen = new Set();
  for (const c of (universe.length ? universe : companies)) {
    if (c && c.slug && !seen.has(c.slug)) { seen.add(c.slug); order.push(c.slug); }
  }
  return { nameBySlug, indBySlug, order };
}

// Fetch one RSS feed with a timeout + bounded retry. Throws on final failure.
async function fetchRss(url, log) {
  for (let n = 0; ; n++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    try {
      const r = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0 (compatible; DakshamBot/1.0)' }, signal: ctrl.signal });
      if (!r.ok) {
        if ((r.status === 429 || r.status >= 500) && n < 3) { await sleep(2000 * 2 ** n); continue; }
        throw new Error(`HTTP ${r.status}`);
      }
      return await r.text();
    } catch (e) {
      if (n < 3 && /abort|network|fetch failed|ECONN|ETIMEDOUT/i.test(String(e.message))) { await sleep(2000 * 2 ** n); continue; }
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }
}

// Recent headlines for a company: a fresh on-disk cache if we have one, else a
// live RSS pull (then cache it). On fetch failure, fall back to any stale cache.
async function getNews(slug, name, fetchRl, cfg, log) {
  const cacheFile = path.join(CACHE_DIR, `${slug}.json`);
  const cached = readJSON(cacheFile, null);
  if (cached && !cfg.force && ageDays(cached.fetched_at) < cfg.freshDays) return cached.items || [];
  try {
    await fetchRl.wait();
    const xml = await fetchRss(newsRssUrl(name, { days: cfg.queryDays }), log);
    const items = parseNewsRss(xml);
    mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync(cacheFile, `${JSON.stringify({ fetched_at: new Date().toISOString(), items }, null, 2)}\n`);
    return items;
  } catch (e) {
    log(`    news fetch failed (${String(e.message).slice(0, 60)})${cached ? ' — using stale cache' : ''}`);
    return cached ? cached.items || [] : [];
  }
}

async function main() {
  const cfg = readConfig();
  const log = (...a) => console.log(...a);
  const pool = createPool(cfg.env, { rpm: cfg.rpm });
  const isMock = pool.isMock;
  const fetchRl = rateLimiter(cfg.fetchRpm);

  log(`News lens — providers: ${poolLabel(pool)}`);

  const companies = readJSON(COMPANIES_PATH, []);
  const universe = readJSON(UNIVERSE_PATH, []);
  const { nameBySlug, indBySlug, order } = buildIndex(companies, universe);

  const scope = cfg.companies.length
    ? cfg.companies.filter((s) => nameBySlug.has(s))
    : order.slice(0, cfg.maxCompanies);

  const stamp = { provider: isMock ? 'mock' : pool.providers.map((p) => p.provider).join(', '), model: pool.providers.map((p) => p.model).join(', '), dry_run: isMock, query_days: cfg.queryDays };
  const out = readJSON(OUT_PATH, null) || { companies: {} };
  if (Object.keys(out.companies || {}).length && (out.dry_run === true || out.provider === 'mock') !== isMock) out.companies = {};
  Object.assign(out, stamp);
  if (isMock) out.note = 'MOCK dry-run — synthetic scores. Set an API key for real extraction.';
  else delete out.note;

  const stats = { scored: 0, noNews: 0, skipped: 0, failed: 0, transient: 0, items: 0 };
  const t0 = Date.now();
  let stopped = false;

  log(`\nScoring ${scope.length} companies (refresh older than ${cfg.freshDays}d)\n`);

  for (let i = 0; i < scope.length; i++) {
    if (stopped) break;
    const slug = scope[i];
    const name = nameBySlug.get(slug) || slug;
    const entry = out.companies[slug];
    if (!cfg.force && entry && entry.meta && ageDays(entry.meta.fetched_at) < cfg.freshDays) {
      stats.skipped += 1;
      continue;
    }

    const items = await getNews(slug, name, fetchRl, cfg, log);
    const { text, count, latest, items: used } = buildNewsInput(items, { maxChars: cfg.maxInputChars, maxItems: cfg.maxItems });

    if (!text) {
      out.companies[slug] = { name, factors: naAllFactors('No recent news found'), meta: { items: 0, fetched_at: new Date().toISOString() } };
      stats.noNews += 1;
      log(`[${i}] ${slug} (${name}) — no recent news → NA`);
      writeJSON(OUT_PATH, out);
      continue;
    }

    log(`[${i}] ${slug} (${name}) — ${count} headlines (latest ${latest})`);
    const res = await runItem(pool, { system: NEWS_SYSTEM_PROMPT, user: newsPrompt(name, indBySlug.get(slug) || '', text), schema: NEWS_SCHEMA }, cfg, log);
    if (res.kind === 'stop') { writeJSON(OUT_PATH, out); stopped = true; log('\n⚠ All providers exhausted — progress saved, re-run to resume.'); break; }
    if (res.kind === 'transient') { stats.transient += 1; continue; } // leave for resume

    const factors = res.kind === 'failed' ? naAllFactors('Extraction failed') : shapeFactors(res.parsed);
    const pulse = res.kind === 'failed' ? null : shapePulse(res.parsed.pulse); // the digestible "what's the recent news" read
    // Keep the headlines that drove the read, so the dossier can show "what news".
    const headlines = (used || []).slice(0, 10).map((h) => ({ title: h.title, source: h.source, date: h.date, url: h.link }));
    out.companies[slug] = { name, factors, pulse, headlines, meta: { items: count, latest, fetched_at: new Date().toISOString(), provider: res.provider } };
    res.kind === 'failed' ? (stats.failed += 1) : (stats.scored += 1);
    stats.items += count;
    writeJSON(OUT_PATH, out);
  }

  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  console.log('\n──────── summary ────────');
  console.log(`providers      : ${poolSummary(pool)}`);
  console.log(`scored         : ${stats.scored} | no-news ${stats.noNews} | skipped-fresh ${stats.skipped} | failed ${stats.failed}`);
  if (stats.transient) console.log(`transient skips: ${stats.transient} (left for a later run)`);
  console.log(`headlines used : ${stats.items} across ${stats.scored} scored`);
  console.log(`cost           : ${isMock ? '$0 (offline mock)' : '$0 (free tiers — Gemini / Groq / Mistral / Cerebras)'}`);
  console.log(`elapsed        : ${secs}s`);
  console.log(`output         : public/data/daksham-news.json`);
  console.log(`factors        : ${FACTORS.map((f) => f.key).join(', ')}`);
}

main().catch((e) => {
  console.error(e.stack || e.message);
  process.exit(1);
});
