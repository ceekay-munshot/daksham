#!/usr/bin/env node
// Industry / moat lens — two lenses on the free-provider round-robin:
//   Phase B  INDUSTRY-PEER : once per industry, from a sample of all members' passages.
//   Phase A  OWN           : once per company, from its own transcripts.
// Writes daksham-industry-lens.json (industry → factors, reusable) and
// daksham-industry.json (company → factor → { own, industry, third_party:null }).
// Crash-resumable; the third-party-news lens is a later routine.
//
//   GEMINI_API_KEY=... INDUSTRIES="Private Sector Bank,Housing Finance Company" node scrapers/ai-industry.mjs
//   PROVIDER=mock MAX_INDUSTRIES=2 node scrapers/ai-industry.mjs   # offline dry run

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ensureCorpus } from './corpus-archive.mjs';
import { readDoc } from './docs-check.mjs';
import {
  buildIndustryInput, ownPrompt, industryPrompt, shapeFactors, naAllFactors,
  combineCompany, FACTORS, RESPONSE_SCHEMA, CONFIG, SYSTEM_PROMPT,
} from './lib/industry.mjs';
import { createPool, runItem, poolLabel, poolSummary } from './lib/llm-runner.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'public', 'data');
const MANIFEST_PATH = path.join(OUT_DIR, 'docs-manifest.json');
const COMPANIES_PATH = path.join(OUT_DIR, 'daksham-companies.json');
const LENS_PATH = path.join(OUT_DIR, 'daksham-industry-lens.json');
const OUT_PATH = path.join(OUT_DIR, 'daksham-industry.json');

const truthy = (v) => ['1', 'true', 'yes', 'on'].includes(String(v || '').toLowerCase());
const readJSON = (p, fb) => (existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : fb);
const writeJSON = (p, o) => writeFileSync(p, `${JSON.stringify({ ...o, generated_at: new Date().toISOString() }, null, 2)}\n`);

function readConfig() {
  const env = process.env;
  return {
    env,
    industries: String(env.INDUSTRIES || '').split(',').map((s) => s.trim()).filter(Boolean),
    maxIndustries: env.MAX_INDUSTRIES ? Math.max(1, parseInt(env.MAX_INDUSTRIES, 10)) : Infinity,
    rpm: env.RPM ? Math.max(1, parseInt(env.RPM, 10)) : 10,
    maxInputChars: env.MAX_INPUT_CHARS ? Math.max(2000, parseInt(env.MAX_INPUT_CHARS, 10)) : CONFIG.maxInputChars,
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

  log(`Industry / moat lens — providers: ${poolLabel(pool)}`);
  log('Ensuring corpus is present…');
  ensureCorpus();

  const manifest = readJSON(MANIFEST_PATH, null);
  if (!manifest) throw new Error('No docs-manifest.json — run the harvester first.');
  const companies = readJSON(COMPANIES_PATH, []);
  const have = new Set(Object.keys(manifest));

  // industry -> [{slug,name}] (only companies that have docs)
  const byInd = new Map();
  for (const c of companies) {
    if (!c || !c.slug || !have.has(c.slug)) continue;
    const ind = String(c.industry || '').trim();
    if (!ind) continue;
    if (!byInd.has(ind)) byInd.set(ind, []);
    byInd.get(ind).push({ slug: c.slug, name: c.name || c.slug });
  }

  // scope: explicit INDUSTRIES, else all industries (largest first, capped by MAX_INDUSTRIES)
  let scope = cfg.industries.length
    ? cfg.industries.filter((i) => byInd.has(i))
    : [...byInd.keys()].sort((a, b) => byInd.get(b).length - byInd.get(a).length).slice(0, cfg.maxIndustries);

  const stamp = { provider: isMock ? 'mock' : pool.providers.map((p) => p.provider).join(', '), model: pool.providers.map((p) => p.model).join(', '), dry_run: isMock };
  const lens = readJSON(LENS_PATH, null) || { industries: {} };
  const out = readJSON(OUT_PATH, null) || { companies: {} };
  // Never let a MOCK dry-run and a real run inherit each other's entries.
  if (Object.keys(lens.industries || {}).length && (lens.dry_run === true || lens.provider === 'mock') !== isMock) lens.industries = {};
  if (Object.keys(out.companies || {}).length && (out.dry_run === true || out.provider === 'mock') !== isMock) out.companies = {};
  Object.assign(lens, stamp);
  Object.assign(out, stamp);
  if (isMock) { lens.note = out.note = 'MOCK dry-run — synthetic scores. Set an API key for real extraction.'; }
  else { delete lens.note; delete out.note; }

  const stats = { lensRun: 0, lensNA: 0, own: 0, ownNA: 0, failed: 0, transient: 0 };
  const t0 = Date.now();
  let stopped = false;
  const stop = () => { stopped = true; log('\n⚠ All providers exhausted/disabled — progress saved, re-run to resume.'); };

  // ── Phase B — INDUSTRY-PEER lens (one call per industry) ──
  log(`\nPhase B — industry-peer lens (${scope.length} industries)`);
  for (const ind of scope) {
    if (stopped) break;
    const members = byInd.get(ind);
    if (!cfg.force && lens.industries[ind]) { log(`  [lens] ${ind} — done, skip`); continue; }

    if (members.length < CONFIG.minPeers) {
      lens.industries[ind] = { peers: members.length, factors: naAllFactors(`too few peers (<${CONFIG.minPeers})`) };
      stats.lensNA += 1;
      log(`  [lens] ${ind} — ${members.length} peers → NA`);
      writeJSON(LENS_PATH, lens);
      continue;
    }

    // Pool sampled members' passages, tagged per company, capped to the input budget.
    const blocks = [];
    let budget = cfg.maxInputChars;
    for (const m of members.slice(0, CONFIG.peer.sampleCompanies)) {
      if (budget <= 0) break;
      const { text } = buildIndustryInput(gatherDocs(manifest, m.slug), { maxChars: Math.min(CONFIG.peer.charsPerCompany, budget) });
      if (!text) continue;
      blocks.push(`[${m.name}]\n${text}`);
      budget -= text.length + m.name.length + 4;
    }
    const pooled = blocks.join('\n\n').slice(0, cfg.maxInputChars);
    if (!pooled) {
      lens.industries[ind] = { peers: members.length, factors: naAllFactors('No relevant peer passages') };
      stats.lensNA += 1;
      writeJSON(LENS_PATH, lens);
      continue;
    }

    log(`  [lens] ${ind} — ${members.length} peers, ${pooled.length} chars`);
    const res = await runItem(pool, { system: SYSTEM_PROMPT, user: industryPrompt(ind, pooled), schema: RESPONSE_SCHEMA }, cfg, log);
    if (res.kind === 'stop') { writeJSON(LENS_PATH, lens); stop(); break; }
    if (res.kind === 'transient') { stats.transient += 1; continue; } // leave for resume
    lens.industries[ind] = {
      peers: members.length,
      provider: res.provider,
      factors: res.kind === 'failed' ? naAllFactors('Extraction failed') : shapeFactors(res.parsed),
    };
    res.kind === 'failed' ? (stats.failed += 1) : (stats.lensRun += 1);
    writeJSON(LENS_PATH, lens);
  }

  // ── Phase A — OWN factors (one call per company) ──
  log(`\nPhase A — own-document factors`);
  for (const ind of scope) {
    if (stopped) break;
    const industryFactors = lens.industries[ind] && lens.industries[ind].factors;
    for (const m of byInd.get(ind)) {
      if (stopped) break;
      if (!cfg.force && out.companies[m.slug]) { log(`  ${m.slug} — done, skip`); continue; }

      const { text } = buildIndustryInput(gatherDocs(manifest, m.slug), { maxChars: cfg.maxInputChars });
      let ownFactors;
      if (!text) {
        ownFactors = naAllFactors('No relevant transcript passages');
        stats.ownNA += 1;
      } else {
        const res = await runItem(pool, { system: SYSTEM_PROMPT, user: ownPrompt(m.name, ind, text), schema: RESPONSE_SCHEMA }, cfg, log);
        if (res.kind === 'stop') { stop(); break; }
        if (res.kind === 'transient') { stats.transient += 1; continue; } // leave for resume
        ownFactors = res.kind === 'failed' ? naAllFactors('Extraction failed') : shapeFactors(res.parsed);
        res.kind === 'failed' ? (stats.failed += 1) : (stats.own += 1);
      }
      out.companies[m.slug] = { name: m.name, industry_name: ind, factors: combineCompany(ind, ownFactors, industryFactors) };
      writeJSON(OUT_PATH, out);
    }
  }

  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  console.log('\n──────── summary ────────');
  console.log(`providers      : ${poolSummary(pool)}`);
  console.log(`industries lens: ${stats.lensRun} scored, ${stats.lensNA} NA (too few peers)`);
  console.log(`company own     : ${stats.own} scored, ${stats.ownNA} no-passages, ${stats.failed} failed`);
  if (stats.transient) console.log(`transient skips: ${stats.transient} (left for a later run)`);
  console.log(`cost           : ${isMock ? '$0 (offline mock)' : '$0 (free tiers — Gemini / Groq / Mistral / Cerebras)'}`);
  console.log(`elapsed        : ${secs}s`);
  console.log(`outputs        : daksham-industry-lens.json + daksham-industry.json`);
  console.log(`factors        : ${FACTORS.map((f) => f.key).join(', ')}`);
}

main().catch((e) => {
  console.error(e.stack || e.message);
  process.exit(1);
});
