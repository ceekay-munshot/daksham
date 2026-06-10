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
  pickProvider,
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
  const { provider, model, apiKey } = pickProvider(env);
  return {
    provider,
    model,
    apiKey,
    startAt: Math.max(0, parseInt(env.START_AT || '0', 10) || 0),
    maxCompanies: env.MAX_COMPANIES ? Math.max(1, parseInt(env.MAX_COMPANIES, 10)) : Infinity,
    rpm: env.RPM ? Math.max(1, parseInt(env.RPM, 10)) : 15, // Gemini free tier
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
  const minInterval = rpm > 0 ? Math.ceil(60000 / rpm) : 0;
  let last = 0;
  return {
    async wait() {
      if (!minInterval) return;
      const dt = Date.now() - last;
      if (dt < minInterval) await sleep(minInterval - dt);
      last = Date.now();
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

// One company: throttle -> call -> shape. Outcomes:
//   { kind:'ok' }      — success
//   { kind:'failed' }  — model replied but JSON stayed malformed (terminal NA)
//   throws transient   — 429/5xx/network exhausted; caller leaves it for resume
//   throws fatal       — 4xx structural (key/model/schema); caller stops the run
async function extractCompany(cfg, name, inputText, sourceQuarter, rl, log) {
  const system = SYSTEM_PROMPT;
  const user = userPrompt(name, inputText);
  let parseRetried = false;
  let attempt = 0;
  for (;;) {
    await rl.wait();
    try {
      const { parsed, usage } = await callLLM({ provider: cfg.provider, model: cfg.model, apiKey: cfg.apiKey, system, user });
      return { kind: 'ok', params: shapeVerdicts(parsed, { sourceQuarter }), usage };
    } catch (e) {
      if (e.retryable) {
        attempt += 1;
        if (attempt > cfg.maxBackoff) {
          const err = new Error('transient');
          err.transient = true;
          err.lastMsg = `${e.status || 'net'} ${String(e.body || e.message).slice(0, 200)}`;
          throw err;
        }
        const delay = Math.min(32000, 1000 * 2 ** attempt);
        log(`    ${e.status || 'net'} retryable — backoff ${delay}ms [${attempt}/${cfg.maxBackoff}]: ${String(e.body || e.message).slice(0, 140)}`);
        await sleep(delay + Math.floor(Math.random() * 250));
        continue;
      }
      if (e.parse && !parseRetried) {
        parseRetried = true;
        log('    malformed JSON — retrying once');
        continue;
      }
      if (e.parse) {
        log(`    malformed JSON again — marking NA: ${String(e.message).slice(0, 140)}`);
        return { kind: 'failed', params: naAllParams('Extraction failed (malformed model output)') };
      }
      const err = new Error('fatal');
      err.fatal = true;
      err.detail = `${e.status || ''} ${String(e.body || e.message).slice(0, 300)}`.trim();
      throw err;
    }
  }
}

function costNote(provider) {
  if (provider === 'mock') return '$0 (offline mock — no API call)';
  if (provider === 'gemini') return '$0 (Gemini free tier, within RPM/RPD)';
  return 'billable (paid provider) — check your dashboard';
}

async function main() {
  const cfg = readConfig();
  const log = (...a) => console.log(...a);

  log(`AI extraction — provider=${cfg.provider} model=${cfg.model}`);
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

  const out = readJSON(OUT_PATH, null) || { generated_at: '', provider: cfg.provider, model: cfg.model, input_max_chars: cfg.maxInputChars, companies: {} };
  // Never let a MOCK dry-run and a real run inherit each other's entries: a mock
  // placeholder must not block (skip) a real extraction, nor clobber real data.
  const wasMock = out.dry_run === true || out.provider === 'mock';
  if (Object.keys(out.companies || {}).length && wasMock !== (cfg.provider === 'mock')) {
    console.log('Provider realness changed (mock↔real) — starting fresh.');
    out.companies = {};
  }
  out.provider = cfg.provider;
  out.model = cfg.model;
  out.input_max_chars = cfg.maxInputChars;
  out.dry_run = cfg.provider === 'mock';
  if (out.dry_run) out.note = 'MOCK dry-run — verdicts are synthetic. Run with GEMINI_API_KEY (or OPENAI/ANTHROPIC) for real extraction.';
  else delete out.note;

  const rl = rateLimiter(cfg.provider === 'mock' ? 0 : cfg.rpm);
  const stats = { done: 0, withDocs: 0, noDocs: 0, failed: 0, transient: 0, charsIn: 0, estTokens: 0, actualTokens: 0, actualSeen: 0 };
  let consecutiveTransient = 0;
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
      log(`[${idx}] ${slug} (${name}) — no usable docs → all NA`);
    } else {
      const est = estimateTokens(text);
      log(`[${idx}] ${slug} (${name}) — ${docsUsed} docs, ${charsIn} chars (~${est} tok in) → ${cfg.provider}`);
      let res;
      try {
        res = await extractCompany(cfg, name, text, sourceQuarter, rl, log);
      } catch (e) {
        if (e.fatal) {
          writeOut(out);
          log(`\n✖ Fatal API error at index ${idx} — stopping (config/request problem, NOT capacity):`);
          log(`    ${e.detail}`);
          log('    Check the API key, the model id (try MODEL=gemini-2.5-flash-lite), or the schema, then re-run.');
          return summarize(cfg, stats, t0, idx);
        }
        if (e.transient) {
          consecutiveTransient += 1;
          stats.transient += 1;
          log(`    transient (${e.lastMsg}) — leaving ${slug} for a later run [${consecutiveTransient}/${cfg.stopAfter} in a row]`);
          if (consecutiveTransient >= cfg.stopAfter) {
            writeOut(out);
            const resumeIdx = Math.max(0, idx - consecutiveTransient + 1);
            log(`\n⚠ ${consecutiveTransient} companies in a row hit service-unavailable — the provider is overloaded. Stopping; progress saved.`);
            log('    Re-run later (defaults are fine — done companies are skipped, skipped ones retried).');
            log(`    Or jump with START_AT=${resumeIdx}. If 503s persist, set MODEL=gemini-2.5-flash-lite (more free headroom).`);
            return summarize(cfg, stats, t0, resumeIdx);
          }
          continue; // leave this company unwritten so a resume retries it
        }
        throw e;
      }
      consecutiveTransient = 0; // a response came back (success or terminal NA)
      out.companies[slug] = { name, params: res.params, meta: { docs_used: docsUsed, chars_in: charsIn, est_tokens: est, source: sourceQuarter } };
      stats.withDocs += 1;
      stats.charsIn += charsIn;
      stats.estTokens += est;
      if (res.kind === 'failed') stats.failed += 1;
      const tot = res.usage && (res.usage.totalTokenCount || res.usage.total_tokens || ((res.usage.input_tokens || 0) + (res.usage.output_tokens || 0)));
      if (tot) {
        stats.actualTokens += tot;
        stats.actualSeen += 1;
      }
    }

    stats.done += 1;
    writeOut(out); // incremental flush — crash-resumable
  }

  return summarize(cfg, stats, t0, cfg.startAt + slice.length);
}

function writeOut(out) {
  out.generated_at = new Date().toISOString();
  writeFileSync(OUT_PATH, `${JSON.stringify(out, null, 2)}\n`);
}

function summarize(cfg, s, t0, nextIdx) {
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  const avgChars = s.withDocs ? Math.round(s.charsIn / s.withDocs) : 0;
  const avgEst = s.withDocs ? Math.round(s.estTokens / s.withDocs) : 0;
  const avgAct = s.actualSeen ? Math.round(s.actualTokens / s.actualSeen) : null;
  console.log('\n──────── summary ────────');
  console.log(`provider/model : ${cfg.provider} / ${cfg.model}`);
  console.log(`processed      : ${s.done} (with docs ${s.withDocs}, no docs ${s.noDocs}, failed ${s.failed})`);
  if (s.transient) console.log(`transient skips: ${s.transient} (left for a later run — not written)`);
  console.log(`input/company  : ${avgChars} chars (~${avgEst} tokens)${avgAct != null ? ` | model-reported ~${avgAct} tok/company` : ''}`);
  console.log(`cost           : ${costNote(cfg.provider)}`);
  console.log(`elapsed        : ${secs}s`);
  console.log(`output         : public/data/daksham-qualitative.json`);
  console.log(`next START_AT  : ${nextIdx}`);
  console.log('PARAMS         : ' + PARAMS.map((p) => p.key).join(', '));
}

main().catch((e) => {
  console.error(e.stack || e.message);
  process.exit(1);
});
