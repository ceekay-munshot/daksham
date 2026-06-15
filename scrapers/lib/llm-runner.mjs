// Shared free-provider round-robin runner — reuses the LLM client (callLLM) and
// provider selection (availableProviders / nextProvider). Builds a stateful pool
// from whatever API keys are set and runs one prompt across it with failover:
// 429/5xx → next provider; a structural 4xx → disable that provider; all out →
// stop. Used by the industry lens (and ready for the own-document routine).

import { availableProviders, nextProvider } from './qualitative.mjs';
import { callLLM } from './llm.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function rateLimiter(rpm) {
  let minInterval = rpm > 0 ? Math.ceil(60000 / rpm) : 0;
  let last = 0;
  return {
    async wait() {
      if (!minInterval) return;
      const dt = Date.now() - last;
      if (dt < minInterval) await sleep(minInterval - dt);
      last = Date.now();
    },
    slowDown() {
      if (minInterval) minInterval = Math.min(Math.ceil(minInterval * 1.5), 15000);
    },
  };
}

export function createPool(env, { rpm = 10 } = {}) {
  const providers = availableProviders(env).map((s) => ({
    ...s,
    rl: rateLimiter(s.provider === 'mock' ? 0 : rpm),
    fails: 0,
    exhausted: false,
    disabled: false,
    done: 0,
  }));
  const isMock = providers.length === 1 && providers[0].provider === 'mock';
  return { providers, isMock, rr: 0 };
}

export const poolLabel = (pool) => pool.providers.map((p) => `${p.provider}:${p.model}`).join(' + ');
export const poolSummary = (pool) =>
  pool.providers.map((p) => `${p.provider} ${p.done}${p.exhausted ? ' (quota)' : ''}${p.disabled ? ' (disabled)' : ''}`).join(' | ');

// One attempt with one provider — tagged outcome, never throws.
async function attempt(prov, { system, user, schema }, cfg, log) {
  let parseRetried = false;
  let n = 0;
  for (;;) {
    await prov.rl.wait();
    try {
      const { parsed, usage } = await callLLM({ provider: prov.provider, model: prov.model, apiKey: prov.apiKey, system, user, schema });
      return { kind: 'ok', parsed, usage };
    } catch (e) {
      if (e.retryable) {
        if (e.retryAfterMs > 120000) return { kind: 'transient', cooldown: true, detail: `rate-limited (~${Math.round(e.retryAfterMs / 1000)}s)` };
        n += 1;
        if (n > cfg.maxBackoff) return { kind: 'transient', detail: `${e.status || 'net'}` };
        const delay = e.retryAfterMs
          ? Math.min(e.retryAfterMs, 60000)
          : e.status === 429
            ? Math.min(60000, 10000 * 2 ** (n - 1))
            : Math.min(32000, 1000 * 2 ** n);
        if (e.status === 429) prov.rl.slowDown();
        log(`    ${prov.provider} ${e.status || 'net'} retry ${n}/${cfg.maxBackoff} (${delay}ms): ${String(e.body || e.message).slice(0, 90)}`);
        await sleep(delay + Math.floor(Math.random() * 250));
        continue;
      }
      if (e.parse && !parseRetried) {
        parseRetried = true;
        continue;
      }
      if (e.parse) return { kind: 'failed' };
      return { kind: 'fatal', detail: `${e.status || ''} ${String(e.body || e.message).slice(0, 180)}`.trim() };
    }
  }
}

// Run one item across the pool. Returns:
//   { kind:'ok', parsed, provider } | { kind:'failed', provider }
//   { kind:'transient' }    — active providers remain; caller leaves item for resume
//   { kind:'stop', detail } — all providers exhausted/disabled
export async function runItem(pool, req, cfg, log) {
  const { providers } = pool;
  const tried = new Set();
  let fatal = null;
  for (let t = 0; t < providers.length; t++) {
    const pick = nextProvider(providers, pool.rr, tried);
    if (!pick) break;
    const prov = pick.provider;
    tried.add(prov.provider);
    const r = await attempt(prov, req, cfg, log);
    if (r.kind === 'ok' || r.kind === 'failed') {
      prov.fails = 0;
      prov.done += 1;
      pool.rr = (pick.index + 1) % providers.length;
      return { kind: r.kind, parsed: r.parsed, usage: r.usage, provider: prov.provider };
    }
    if (r.kind === 'transient') {
      prov.fails += 1;
      if (r.cooldown || prov.fails >= cfg.stopAfter) {
        prov.exhausted = true;
        log(`    ${prov.provider} set aside — ${r.cooldown ? r.detail : 'quota'}`);
      } else {
        log(`    ${prov.provider} transient — failing over`);
      }
      continue;
    }
    prov.disabled = true;
    fatal = `${prov.provider}: ${r.detail}`;
    log(`    ✖ ${prov.provider} disabled: ${r.detail}`);
  }
  if (providers.some((p) => !p.exhausted && !p.disabled)) return { kind: 'transient' };
  return { kind: 'stop', detail: fatal };
}
