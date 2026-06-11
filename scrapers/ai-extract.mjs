#!/usr/bin/env node
// AI extraction — company OWN-DOCUMENT qualitative cluster.
//
// Reads the harvested corpus (actions/cache or the committed archive, via
// corpus-archive `ensure`) and, for each company, pre-filters the last 4 concall
// transcripts + latest PPT down to the relevant passages, makes ONE structured
// model call, and writes verdict objects to public/data/daksham-qualitative.json.
//
// Provider is chosen by whichever API key is set (Gemini free tier by default).
// Batched, crash-resumable (START_AT), incremental flush per company.
//
//   GEMINI_API_KEY=... MAX_COMPANIES=20 node scrapers/ai-extract.mjs
//   PROVIDER=mock MAX_COMPANIES=20 node scrapers/ai-extract.mjs   # offline dry run

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ensureCorpus } from './corpus-archive.mjs';
import { readDoc } from './docs-check.mjs';
import {
  buildInput,
  userPrompt,
  shapeVerdicts,
  naAllParams,
  availableProviders,
  nextProvider,
  estimateTokens,
  SYSTEM_PROMPT,
  PARAMS,
} from './lib/qualitative.mjs';
import { callLLM } from './lib/llm.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'public', 'data');
const MANIFEST_PATH = path.join(OUT_DIR, 'docs-manifest.json');
const COMPANIES_PATH = path.join(OUT_DIR, 'daksham-companies.json');
const UNIVERSE_PATH = path.join(OUT_DIR, 'liquid-universe.json');
const OUT_PATH = path.join(OUT_DIR, 'daksham-qualitative.json');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const truthy = (v) => ['1', 'true', 'yes', 'on'].includes(String(v || '').toLowerCase());
const readJSON = (p, fallback) => (existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : fallback);

function readConfig() {
  const env = process.env;
  return {
    providerSpecs: availableProviders(env), // one (PROVIDER set) or all keys present
    startAt: Math.max(0, parseInt(env.START_AT || '0', 10) || 0),
    maxCompanies: env.MAX_COMPANIES ? Math.max(1, parseInt(env.MAX_COMPANIES, 10)) : Infinity,
    rpm: env.RPM ? Math.max(1, parseInt(env.RPM, 10)) : 10, // conservative for free tiers
    maxInputChars: env.MAX_INPUT_CHARS ? Math.max(2000, parseInt(env.MAX_INPUT_CHARS, 10)) : 24000,
    maxBackoff: 4, // per-company retries on 429/5xx before giving up on it
    stopAfter: env.STOP_AFTER ? Math.max(1, parseInt(env.STOP_AFTER, 10)) : 4, // consecutive failures → halt (outage)
    force: truthy(env.FORCE),
  };
}

// Stable order: liquid-universe order, restricted to companies that have docs,
// then any manifest-only slugs. Keeps START_AT meaningful across runs.
function orderedSlugs(manifest, universe) {
  const have = new Set(Object.keys(manifest));
  const seen = new Set();
  const order = [];
  for (const c of universe) {
    if (c && have.has(c.slug) && !seen.has(c.slug)) {
      order.push(c.slug);
      seen.add(c.slug);
    }
  }
  for (const slug of Object.keys(manifest)) if (!seen.has(slug)) order.push(slug);
  return order;
}

function rateLimiter(rpm) {
  let minInterval = rpm > 0 ? Math.ceil(60000 / rpm) : 0;
  let last = 0;
  return {
    async wait() {
      if (!minInterval) return;
      const dt = Date.now() - last;
      if (dt < minInterval) await sleep(minInterval - dt);
      last = Date.now();
    },
    // After a 429 we're going too fast — permanently slow the pace (cap ~4 RPM).
    slowDown() {
      if (minInterval) minInterval = Math.min(Math.ceil(minInterval * 1.5), 15000);
    },
  };
}

// Gather this company's docs as { type, period, text } (skips image/empty docs).
function gatherDocs(manifest, slug) {
  const docs = [];
  for (const entry of manifest[slug] || []) {
    if (entry.ocr_needed) continue;
    const text = readDoc(entry);
    if (text && text.trim()) docs.push({ type: entry.type, period: entry.period, text });
  }
  return docs;
}

// One attempt at a company with ONE provider. Returns a tagged outcome (never
// throws), so the caller can fail over to another provider:
//   { kind:'ok', params, usage } | { kind:'failed', params }  — provider responded
//   { kind:'transient', detail }  — 429/5xx/network exhausted (try another provider)
//   { kind:'fatal', detail }      — 4xx structural (disable this provider)
async function attemptCompany(prov, name, inputText, sourceQuarter, cfg, log) {
  const user = userPrompt(name, inputText);
  let parseRetried = false;
  let attempt = 0;
  for (;;) {
    await prov.rl.wait();
    try {
      const { parsed, usage } = await callLLM({ provider: prov.provider, model: prov.model, apiKey: prov.apiKey, system: SYSTEM_PROMPT, user });
      return { kind: 'ok', params: shapeVerdicts(parsed, { sourceQuarter }), usage };
    } catch (e) {
      if (e.retryable) {
        // A multi-minute Retry-After means the provider's window/daily quota is
        // gone — don't sleep it off (could be >1h); set it aside and fail over.
        if (e.retryAfterMs > 120000) {
          return { kind: 'transient', cooldown: true, detail: `rate-limited (~${Math.round(e.retryAfterMs / 1000)}s cooldown)` };
        }
        attempt += 1;
        if (attempt > cfg.maxBackoff) return { kind: 'transient', detail: `${e.status || 'net'} ${String(e.body || e.message).slice(0, 110)}` };
        // 429 = rate/quota: back off (capped 60s) + permanently slow the pace.
        const delay = e.retryAfterMs
          ? Math.min(e.retryAfterMs, 60000)
          : e.status === 429
            ? Math.min(60000, 10000 * 2 ** (attempt - 1))
            : Math.min(32000, 1000 * 2 ** attempt);
        if (e.status === 429) prov.rl.slowDown();
        log(`    ${prov.provider} ${e.status || 'net'} retry ${attempt}/${cfg.maxBackoff} (${delay}ms): ${String(e.body || e.message).slice(0, 100)}`);
        await sleep(delay + Math.floor(Math.random() * 250));
        continue;
      }
      if (e.parse && !parseRetried) {
        parseRetried = true;
        log(`    ${prov.provider} malformed JSON — retrying once`);
        continue;
      }
      if (e.parse) return { kind: 'failed', params: naAllParams('Extraction failed (malformed model output)') };
      return { kind: 'fatal', detail: `${e.status || ''} ${String(e.body || e.message).slice(0, 200)}`.trim() };
    }
  }
}

function costNote(providers) {
  if (providers.length === 1 && providers[0].provider === 'mock') return '$0 (offline mock — no API call)';
  const paid = providers.filter((p) => p.provider === 'openai' || p.provider === 'anthropic');
  if (paid.length) return `includes a paid provider (${paid.map((p) => p.provider).join(', ')}) — check billing`;
  return '$0 (all free tiers — Gemini / Groq)';
}

async function main() {
  const cfg = readConfig();
  const log = (...a) => console.log(...a);

  // Stateful provider pool — each gets its own rate limiter + failure state, so
  // we round-robin across free quotas and fail over when one is rate-limited.
  const isMock = cfg.providerSpecs.length === 1 && cfg.providerSpecs[0].provider === 'mock';
  const providers = cfg.providerSpecs.map((s) => ({
    ...s,
    rl: rateLimiter(s.provider === 'mock' ? 0 : cfg.rpm),
    fails: 0,
    exhausted: false,
    disabled: false,
    done: 0,
  }));

  log(`AI extraction — providers: ${providers.map((p) => `${p.provider}:${p.model}`).join(' + ')}`);
  log('Ensuring corpus is present (actions/cache or committed archive)…');
  ensureCorpus();

  const manifest = readJSON(MANIFEST_PATH, null);
  if (!manifest) throw new Error('No docs-manifest.json — run the harvester first.');
  const companies = readJSON(COMPANIES_PATH, []);
  const universe = readJSON(UNIVERSE_PATH, []);
  const nameBySlug = new Map();
  for (const c of companies) if (c && c.slug) nameBySlug.set(c.slug, c.name || c.slug);
  for (const c of universe) if (c && c.slug && !nameBySlug.has(c.slug)) nameBySlug.set(c.slug, c.name || c.slug);

  const order = orderedSlugs(manifest, universe);
  const slice = order.slice(cfg.startAt, cfg.startAt === Infinity ? undefined : cfg.startAt + cfg.maxCompanies);

  const providerTag = providers.map((p) => p.provider).join(', ');
  const out = readJSON(OUT_PATH, null) || { generated_at: '', companies: {} };
  // Never let a MOCK dry-run and a real run inherit each other's entries.
  const wasMock = out.dry_run === true || out.provider === 'mock';
  if (Object.keys(out.companies || {}).length && wasMock !== isMock) {
    log('Provider realness changed (mock↔real) — starting fresh.');
    out.companies = {};
  }
  out.provider = isMock ? 'mock' : providerTag;
  out.model = providers.map((p) => p.model).join(', ');
  out.input_max_chars = cfg.maxInputChars;
  out.dry_run = isMock;
  if (isMock) out.note = 'MOCK dry-run — verdicts are synthetic. Set GEMINI_API_KEY / GROQ_API_KEY for real extraction.';
  else delete out.note;

  const stats = { done: 0, withDocs: 0, noDocs: 0, failed: 0, transient: 0, charsIn: 0, estTokens: 0, actualTokens: 0, actualSeen: 0 };
  let rr = 0; // round-robin cursor
  const t0 = Date.now();

  log(`Companies with docs: ${order.length} | this run: [${cfg.startAt}, ${cfg.startAt + slice.length}) = ${slice.length}\n`);

  for (let i = 0; i < slice.length; i++) {
    const slug = slice[i];
    const idx = cfg.startAt + i;
    const name = nameBySlug.get(slug) || slug;

    if (!cfg.force && out.companies[slug]) {
      log(`[${idx}] ${slug} — already done, skip (FORCE=1 to redo)`);
      continue;
    }

    const docs = gatherDocs(manifest, slug);
    const { text, sourceQuarter, docsUsed, charsIn } = buildInput(docs, { maxChars: cfg.maxInputChars });

    if (!text) {
      out.companies[slug] = { name, params: naAllParams('No transcripts/PPT harvested'), meta: { docs_used: 0, chars_in: 0 } };
      stats.noDocs += 1;
      stats.done += 1;
      log(`[${idx}] ${slug} (${name}) — no usable docs → all NA`);
      writeOut(out);
      continue;
    }

    const est = estimateTokens(text);
    log(`[${idx}] ${slug} (${name}) — ${docsUsed} docs, ${charsIn} chars (~${est} tok in)`);

    // Try across providers (round-robin), failing over on quota/structural errors.
    const tried = new Set();
    let outcome = null;
    let usedProv = null;
    let fatalDetail = null;
    for (let t = 0; t < providers.length; t++) {
      const pick = nextProvider(providers, rr, tried);
      if (!pick) break;
      const prov = pick.provider;
      tried.add(prov.provider);
      const r = await attemptCompany(prov, name, text, sourceQuarter, cfg, log);
      if (r.kind === 'ok' || r.kind === 'failed') {
        prov.fails = 0;
        prov.done += 1;
        outcome = r;
        usedProv = prov;
        rr = (pick.index + 1) % providers.length; // next company starts on the other provider
        break;
      }
      if (r.kind === 'transient') {
        prov.fails += 1;
        if (r.cooldown || prov.fails >= cfg.stopAfter) {
          prov.exhausted = true;
          log(`    ${prov.provider} set aside for this run — ${r.cooldown ? r.detail : 'quota exhausted'}`);
        } else {
          log(`    ${prov.provider} transient — failing over`);
        }
        continue;
      }
      prov.disabled = true; // fatal/structural — drop this provider for the run
      fatalDetail = `${prov.provider}: ${r.detail}`;
      log(`    ✖ ${prov.provider} disabled (config/request error): ${r.detail}`);
    }

    if (outcome) {
      out.companies[slug] = { name, params: outcome.params, meta: { docs_used: docsUsed, chars_in: charsIn, est_tokens: est, source: sourceQuarter, provider: usedProv.provider } };
      stats.withDocs += 1;
      stats.charsIn += charsIn;
      stats.estTokens += est;
      stats.done += 1;
      if (outcome.kind === 'failed') stats.failed += 1;
      const u = outcome.usage;
      const tot = u && (u.totalTokenCount || u.total_tokens || ((u.input_tokens || 0) + (u.output_tokens || 0)));
      if (tot) { stats.actualTokens += tot; stats.actualSeen += 1; }
      writeOut(out); // incremental flush — crash-resumable
      continue;
    }

    // No provider produced a result for this company.
    const active = providers.filter((p) => !p.exhausted && !p.disabled);
    if (!active.length) {
      writeOut(out);
      log(`\n⚠ All providers stopped at index ${idx}; progress saved.`);
      if (providers.every((p) => p.disabled)) log(`    Structural error (not capacity): ${fatalDetail}. Fix the key/model, then re-run.`);
      else log('    Free-tier quota hit on every provider — re-run later (done companies skip, the rest retry).');
      return summarize(providers, stats, t0, idx);
    }
    // Active providers remain (none hit stopAfter yet) — leave this one for resume.
    stats.transient += 1;
    log(`    left ${slug} for a later run (transient on all tried providers)`);
  }

  return summarize(providers, stats, t0, cfg.startAt + slice.length);
}

function writeOut(out) {
  out.generated_at = new Date().toISOString();
  writeFileSync(OUT_PATH, `${JSON.stringify(out, null, 2)}\n`);
}

function summarize(providers, s, t0, nextIdx) {
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  const avgChars = s.withDocs ? Math.round(s.charsIn / s.withDocs) : 0;
  const avgEst = s.withDocs ? Math.round(s.estTokens / s.withDocs) : 0;
  const avgAct = s.actualSeen ? Math.round(s.actualTokens / s.actualSeen) : null;
  const provLine = providers
    .map((p) => `${p.provider} ${p.done}${p.exhausted ? ' (quota)' : ''}${p.disabled ? ' (disabled)' : ''}`)
    .join(' | ');
  console.log('\n──────── summary ────────');
  console.log(`providers      : ${provLine}`);
  console.log(`processed      : ${s.done} (with docs ${s.withDocs}, no docs ${s.noDocs}, failed ${s.failed})`);
  if (s.transient) console.log(`transient skips: ${s.transient} (left for a later run — not written)`);
  console.log(`input/company  : ${avgChars} chars (~${avgEst} tokens)${avgAct != null ? ` | model-reported ~${avgAct} tok/company` : ''}`);
  console.log(`cost           : ${costNote(providers)}`);
  console.log(`elapsed        : ${secs}s`);
  console.log(`output         : public/data/daksham-qualitative.json`);
  console.log(`next START_AT  : ${nextIdx}`);
  console.log('PARAMS         : ' + PARAMS.map((p) => p.key).join(', '));
}

main().catch((e) => {
  console.error(e.stack || e.message);
  process.exit(1);
});
