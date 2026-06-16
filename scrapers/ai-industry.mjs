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
  PEER_LEVELS, lensKey, resolvePeerLevel, peerHasSignal, inheritedAllNA, extractOwn,
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

  // Doc-having members + counts at each peer level (industry → sector → broad_sector).
  const membersByLevel = { industry: new Map(), sector: new Map(), broad_sector: new Map() };
  const countsByLevel = { industry: {}, sector: {}, broad_sector: {} };
  const tagsOf = new Map(); // slug -> { name, industry, sector, broad_sector }
  for (const c of companies) {
    if (!c || !c.slug || !have.has(c.slug)) continue;
    const tags = {
      name: c.name || c.slug,
      industry: String(c.industry || '').trim(),
      sector: String(c.sector || '').trim(),
      broad_sector: String(c.broad_sector || '').trim(),
    };
    tagsOf.set(c.slug, tags);
    for (const level of PEER_LEVELS) {
      const name = tags[level];
      if (!name) continue;
      if (!membersByLevel[level].has(name)) membersByLevel[level].set(name, []);
      membersByLevel[level].get(name).push({ slug: c.slug, name: tags.name });
      countsByLevel[level][name] = (countsByLevel[level][name] || 0) + 1;
    }
  }

  // Scope: explicit INDUSTRIES, else all industries (largest first, capped). The
  // companies in scope are what we process; each resolves its OWN narrowest
  // qualifying peer group — which may be its sector when the industry is too thin.
  const byInd = membersByLevel.industry;
  const scopeIndustries = cfg.industries.length
    ? cfg.industries.filter((i) => byInd.has(i))
    : [...byInd.keys()].sort((a, b) => byInd.get(b).length - byInd.get(a).length).slice(0, cfg.maxIndustries);
  const scopeSlugs = [];
  const seenSlug = new Set();
  for (const ind of scopeIndustries) for (const m of byInd.get(ind)) if (!seenSlug.has(m.slug)) { seenSlug.add(m.slug); scopeSlugs.push(m.slug); }

  // Resolve each scoped company's peer group + the distinct groups we must score.
  const peerOf = new Map();
  const neededGroups = new Map();
  for (const slug of scopeSlugs) {
    const g = resolvePeerLevel(tagsOf.get(slug), countsByLevel, CONFIG.minPeers);
    peerOf.set(slug, g);
    if (g) neededGroups.set(lensKey(g.level, g.name), g);
  }

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

  const stats = { lensRun: 0, lensNA: 0, own: 0, ownNA: 0, upgraded: 0, failed: 0, transient: 0 };
  const t0 = Date.now();
  let stopped = false;
  const stop = () => { stopped = true; log('\n⚠ All providers exhausted/disabled — progress saved, re-run to resume.'); };

  // ── Phase B — PEER lens (one call per distinct resolved group) ──
  const groups = [...neededGroups.values()];
  log(`\nPhase B — peer lens (${groups.length} groups)`);
  for (const g of groups) {
    if (stopped) break;
    const key = lensKey(g.level, g.name);
    // Skip only entries that already carry a real read; retry NA ones (recover a
    // weak/failed earlier run) so a normal scheduled run self-heals without force.
    if (!cfg.force && lens.industries[key] && peerHasSignal(lens.industries[key].factors)) { log(`  [lens] ${key} — done, skip`); continue; }
    const members = membersByLevel[g.level].get(g.name) || [];

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
      lens.industries[key] = { level: g.level, peers: members.length, factors: naAllFactors('No relevant peer passages') };
      stats.lensNA += 1;
      writeJSON(LENS_PATH, lens);
      continue;
    }

    log(`  [lens] ${key} (${g.level}) — ${members.length} peers, ${pooled.length} chars`);
    const res = await runItem(pool, { system: SYSTEM_PROMPT, user: industryPrompt(g.name, pooled), schema: RESPONSE_SCHEMA }, cfg, log);
    if (res.kind === 'stop') { writeJSON(LENS_PATH, lens); stop(); break; }
    if (res.kind === 'transient') { stats.transient += 1; continue; } // leave for resume
    lens.industries[key] = {
      level: g.level,
      peers: members.length,
      provider: res.provider,
      factors: res.kind === 'failed' ? naAllFactors('Extraction failed') : shapeFactors(res.parsed),
    };
    res.kind === 'failed' ? (stats.failed += 1) : (stats.lensRun += 1);
    writeJSON(LENS_PATH, lens);
  }

  // ── Phase A — OWN factors per company + inherit the resolved peer lens ──
  log(`\nPhase A — own-document factors (${scopeSlugs.length} companies)`);
  for (const slug of scopeSlugs) {
    if (stopped) break;
    const tags = tagsOf.get(slug);
    const g = peerOf.get(slug);
    const groupFactors = g ? (lens.industries[lensKey(g.level, g.name)] && lens.industries[lensKey(g.level, g.name)].factors) : null;
    const peerName = g ? g.name : tags.industry;
    const peerLevel = g ? g.level : 'industry';

    const existing = out.companies[slug];
    if (!cfg.force && existing) {
      // Upgrade in place: a previously-NA peer read + a now-qualifying fallback
      // group → re-attach the better peer factors WITHOUT re-reading 'own'.
      if (g && peerHasSignal(groupFactors) && inheritedAllNA(existing.factors)) {
        out.companies[slug] = {
          name: tags.name, industry_name: peerName, own_industry: tags.industry,
          peer_level: peerLevel, peer_name: peerName,
          factors: combineCompany(peerName, extractOwn(existing.factors), groupFactors),
        };
        stats.upgraded += 1;
        log(`  ${slug} — peer read upgraded → ${peerLevel} ${peerName}`);
        writeJSON(OUT_PATH, out);
      } else {
        log(`  ${slug} — done, skip`);
      }
      continue;
    }

    const { text } = buildIndustryInput(gatherDocs(manifest, slug), { maxChars: cfg.maxInputChars });
    let ownFactors;
    if (!text) {
      ownFactors = naAllFactors('No relevant transcript passages');
      stats.ownNA += 1;
    } else {
      const res = await runItem(pool, { system: SYSTEM_PROMPT, user: ownPrompt(tags.name, tags.industry, text), schema: RESPONSE_SCHEMA }, cfg, log);
      if (res.kind === 'stop') { stop(); break; }
      if (res.kind === 'transient') { stats.transient += 1; continue; } // leave for resume
      ownFactors = res.kind === 'failed' ? naAllFactors('Extraction failed') : shapeFactors(res.parsed);
      res.kind === 'failed' ? (stats.failed += 1) : (stats.own += 1);
    }
    out.companies[slug] = {
      name: tags.name, industry_name: peerName, own_industry: tags.industry,
      peer_level: peerLevel, peer_name: peerName,
      factors: combineCompany(peerName, ownFactors, groupFactors || naAllFactors(`too few peers (<${CONFIG.minPeers})`)),
    };
    writeJSON(OUT_PATH, out);
  }

  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  console.log('\n──────── summary ────────');
  console.log(`providers      : ${poolSummary(pool)}`);
  console.log(`peer-group lens : ${stats.lensRun} scored, ${stats.lensNA} NA (no passages)`);
  console.log(`company own     : ${stats.own} scored, ${stats.ownNA} no-passages, ${stats.upgraded} peer-upgraded, ${stats.failed} failed`);
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
