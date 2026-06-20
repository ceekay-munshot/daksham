// Source-verifier — a fact-check pass over the qualitative reads.
//
// Given the SAME source excerpts the extractor saw and the CLAIMS it produced, an
// independent model must cite the exact supporting sentence for each claim. Claims
// it can't ground in the text are flagged (likely hallucination / wrong-quarter),
// and the verbatim quotes it returns double as evidence. Pure core: prompt, the
// per-company schema, and shaping. The fetch/LLM lives in the orchestrator.

const MAX_QUOTE = 300;
const clampQuote = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, MAX_QUOTE);

export const VERIFY_SYSTEM =
  'You are a meticulous fact-checker. You receive SOURCE EXCERPTS from a company document and a set of CLAIMS an analyst extracted from them. For each claim decide whether it is DIRECTLY supported by the excerpts — a specific sentence must back it, and any number/guidance figure in the claim must actually appear in the text. Use ONLY the excerpts, never outside knowledge or assumptions. Return, per claim: supported (true ONLY with clear textual support) and quote (the exact sentence from the excerpts that supports it, copied verbatim, or "" when unsupported). Return ONLY a JSON object.';

// Non-NA claims worth verifying, pulled from a company's qualitative params.
export function claimsFromParams(params) {
  return Object.values(params || {})
    .filter((p) => p && p.verdict && p.verdict !== 'NA')
    .map((p) => ({ key: p.key, label: p.label, verdict: p.verdict, value: p.value, note: p.note }));
}

// claims: [{ key, label, verdict, value, note }]
export function verifyPrompt(claims, sourceText) {
  const lines = claims
    .map((c) => `- ${c.key} (${c.label}): "${c.verdict}"${c.value ? ` — ${c.value}` : ''}${c.note ? ` [analyst note: ${c.note}]` : ''}`)
    .join('\n');
  const skel = `{\n${claims.map((c) => `  "${c.key}": {"supported": true|false, "quote": "exact sentence from EXCERPTS, or empty"}`).join(',\n')}\n}`;
  return `--- SOURCE EXCERPTS ---\n${sourceText}\n--- END EXCERPTS ---\n\nCLAIMS to verify against the excerpts above:\n${lines}\n\nReturn ONLY this JSON — one entry per claim, quote copied verbatim from the excerpts:\n${skel}`;
}

// Keys vary per company, so the schema is built from this run's claims.
export function verifySchema(claims) {
  const props = {};
  for (const c of claims) {
    props[c.key] = {
      type: 'object',
      additionalProperties: false,
      required: ['supported', 'quote'],
      properties: { supported: { type: 'boolean' }, quote: { type: 'string' } },
    };
  }
  return { type: 'object', additionalProperties: false, required: claims.map((c) => c.key), properties: props };
}

// Model answer → per-key { verified, quote }. A claim is verified only when the
// model says supported AND returns a non-empty quote; anything else is unverified.
export function shapeVerification(modelObj, claims) {
  const obj = modelObj && typeof modelObj === 'object' ? modelObj : {};
  const out = {};
  for (const c of claims) {
    const r = obj[c.key];
    const quote = clampQuote(r && r.quote);
    const verified = !!(r && r.supported === true && quote);
    out[c.key] = { verified, quote: verified ? quote : '' };
  }
  return out;
}

// Roll the per-key result into a small summary (for logs / a coverage badge).
export function verifyStats(shaped) {
  const vals = Object.values(shaped || {});
  return { checked: vals.length, verified: vals.filter((v) => v.verified).length };
}
