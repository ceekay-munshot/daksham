#!/usr/bin/env node
// Source-verifier pass — fact-checks the qualitative reads against their own
// source excerpts. For each company it re-shows the model the SAME passages the
// extractor saw plus the claims produced, and requires an exact supporting quote
// per claim. Writes public/data/daksham-qualitative-verify.json (slug → per-claim
// { verified, quote }), which the dashboard joins into the qualitative reads.
// Free-provider round-robin, crash-resumable, $0.
//
//   GEMINI_API_KEY=... MAX_COMPANIES=20 node scrapers/ai-verify.mjs
//   PROVIDER=mock COMPANIES=AWL node scrapers/ai-verify.mjs   # offline

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ensureCorpus } from './corpus-archive.mjs';
import { readDoc } from './docs-check.mjs';
import { buildInput } from './lib/qualitative.mjs';
import { createPool, runItem, poolLabel, poolSummary } from './lib/llm-runner.mjs';
import { claimsFromParams, verifyPrompt, verifySchema, shapeVerification, verifyStats, VERIFY_SYSTEM } from './lib/verify.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'public', 'data');
const MANIFEST_PATH = path.join(OUT_DIR, 'docs-manifest.json');
const QUAL_PATH = path.join(OUT_DIR, 'daksham-qualitative.json');
const OUT_PATH = path.join(OUT_DIR, 'daksham-qualitative-verify.json');

const truthy = (v) => ['1', 'true', 'yes', 'on'].includes(String(v || '').toLowerCase());
const readJSON = (p, fb) => (existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : fb);
const writeJSON = (p, o) => writeFileSync(p, `${JSON.stringify({ ...o, generated_at: new Date().toISOString() }, null, 2)}\n`);

function readConfig() {
  const env = process.env;
  return {
    env,
    companies: String(env.COMPANIES || '').split(',').map((s) => s.trim()).filter(Boolean),
    maxCompanies: env.MAX_COMPANIES ? Math.max(1, parseInt(env.MAX_COMPANIES, 10)) : Infinity,
    rpm: env.RPM ? Math.max(1, parseInt(env.RPM, 10)) : 10,
    maxInputChars: env.MAX_INPUT_CHARS ? Math.max(2000, parseInt(env.MAX_INPUT_CHARS, 10)) : 24000,
    maxBackoff: 4,
    stopAfter: 4,
    force: truthy(env.FORCE),
  };
}

function gatherDocs(manifest, slug) {
  const docs = [];
  for (const e of manifest[slug] || []) {
    if (e.ocr_needed) continue;
    const t = readDoc(e);
    if (t && t.trim()) docs.push({ type: e.type, period: e.period, text: t });
  }
  return docs;
}

async function main() {
  const cfg = readConfig();
  const log = (...a) => console.log(...a);
  const pool = createPool(cfg.env, { rpm: cfg.rpm });
  const isMock = pool.isMock;

  log(`Source-verifier — providers: ${poolLabel(pool)}`);
  ensureCorpus();

  const manifest = readJSON(MANIFEST_PATH, null);
  if (!manifest) throw new Error('No docs-manifest.json — run the harvester first.');
  const qual = readJSON(QUAL_PATH, null);
  if (!qual || !qual.companies) throw new Error('No daksham-qualitative.json — run the extractor first.');

  const stamp = { provider: isMock ? 'mock' : pool.providers.map((p) => p.provider).join(', '), model: pool.providers.map((p) => p.model).join(', '), dry_run: isMock };
  const out = readJSON(OUT_PATH, null) || { companies: {} };
  if (Object.keys(out.companies || {}).length && (out.dry_run === true || out.provider === 'mock') !== isMock) out.companies = {};
  Object.assign(out, stamp);

  // Only companies that have something to verify (a non-NA read).
  let slugs = Object.keys(qual.companies).filter((s) => claimsFromParams(qual.companies[s].params).length);
  if (cfg.companies.length) slugs = slugs.filter((s) => cfg.companies.includes(s));
  slugs = slugs.slice(0, cfg.maxCompanies === Infinity ? undefined : cfg.maxCompanies);

  const stats = { done: 0, verified: 0, checked: 0, noSource: 0, failed: 0, transient: 0 };
  const t0 = Date.now();
  let stopped = false;

  log(`\nVerifying ${slugs.length} companies with non-NA reads\n`);

  for (const slug of slugs) {
    if (stopped) break;
    const entry = qual.companies[slug];
    const src = entry.meta && entry.meta.source;
    const done = out.companies[slug];
    // Skip if already verified against the same extraction (source quarter unchanged).
    if (!cfg.force && done && done.src === src) continue;

    const claims = claimsFromParams(entry.params);
    const docs = gatherDocs(manifest, slug);
    const { text } = buildInput(docs, { maxChars: cfg.maxInputChars });
    if (!text) {
      out.companies[slug] = { params: {}, src, meta: { checked: 0, verified: 0, note: 'no source text', verified_at: new Date().toISOString() } };
      stats.noSource += 1;
      writeJSON(OUT_PATH, out);
      continue;
    }

    const res = await runItem(pool, { system: VERIFY_SYSTEM, user: verifyPrompt(claims, text), schema: verifySchema(claims) }, cfg, log);
    if (res.kind === 'stop') { writeJSON(OUT_PATH, out); stopped = true; log('\n⚠ All providers exhausted — progress saved, re-run to resume.'); break; }
    if (res.kind === 'transient') { stats.transient += 1; continue; }

    const shaped = res.kind === 'failed' ? {} : shapeVerification(res.parsed, claims);
    const st = verifyStats(shaped);
    out.companies[slug] = { params: shaped, src, meta: { checked: st.checked, verified: st.verified, verified_at: new Date().toISOString(), provider: res.provider } };
    res.kind === 'failed' ? (stats.failed += 1) : (stats.done += 1);
    stats.verified += st.verified; stats.checked += st.checked;
    log(`  ${slug} — ${st.verified}/${st.checked} claims grounded`);
    writeJSON(OUT_PATH, out);
  }

  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  console.log('\n──────── summary ────────');
  console.log(`providers      : ${poolSummary(pool)}`);
  console.log(`verified        : ${stats.done} companies | ${stats.verified}/${stats.checked} claims grounded | ${stats.checked - stats.verified} flagged | no-source ${stats.noSource} | failed ${stats.failed}`);
  if (stats.transient) console.log(`transient skips: ${stats.transient} (left for a later run)`);
  console.log(`cost           : ${isMock ? '$0 (offline mock)' : '$0 (free tiers)'}`);
  console.log(`elapsed        : ${secs}s`);
  console.log(`output         : public/data/daksham-qualitative-verify.json`);
}

main().catch((e) => {
  console.error(e.stack || e.message);
  process.exit(1);
});
