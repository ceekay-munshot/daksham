// Industry / moat qualitative lens — the "Moat & Qualitative" factors. Pure core
// (no network/DOM/fs): pre-filter passages, build the prompt + schema, and shape a
// model answer into per-factor results. Two lenses share this: OWN (per company)
// and INDUSTRY-PEER (once per industry). The third-party-news lens is a later
// routine. Each factor is scored on a TREND, 0-5, higher = more FAVORABLE.

import { normalize } from './qualitative.mjs';

// ── Factors (8). `favorable` documents the client-ratified direction ─────────
export const FACTORS = [
  { key: 'competition', label: 'Competition', favorable: 'competition intensity decreasing' },
  { key: 'barriers_to_entry', label: 'Barriers to entry', favorable: 'barriers to entry rising' },
  { key: 'buyer_power', label: 'Buyer power', favorable: 'buyer bargaining power decreasing' },
  { key: 'supplier_power', label: 'Supplier power', favorable: 'supplier bargaining power decreasing' },
  { key: 'substitution_risk', label: 'Substitution risk', favorable: 'substitution threat decreasing' },
  { key: 'china_imports', label: 'China-import threat', favorable: 'import threat decreasing / protection rising' },
  { key: 'govt_regulation', label: 'Govt / regulation', favorable: 'regulation turning supportive' },
  { key: 'inventory_buildup', label: 'Inventory build-up', favorable: 'inventory stable / justified (not a glut)' },
];

export const FACTOR_KEYS = FACTORS.map((f) => f.key);
const TRENDS = ['improving', 'stable', 'worsening', 'NA'];
const CONFIDENCE = ['high', 'medium', 'low'];

// ── Tunable scoring (client method — ratified for competition, applied by
// analogy to the rest; adjust per-factor here when the client confirms). ─────
export const CONFIG = {
  trendToScore: { worsening: [0, 2], stable: [2, 3], improving: [4, 5] }, // trend → score band
  minPeers: 3, // industry lens is NA below this many peers
  maxInputChars: 24000, // per LLM call
  peer: { sampleCompanies: 12, charsPerCompany: 1800 }, // INDUSTRY-peer sampling
};

const bandMid = (t) => {
  const b = CONFIG.trendToScore[t];
  return b ? Math.round((b[0] + b[1]) / 2) : 3;
};
const clampToBand = (score, trend) => {
  const b = CONFIG.trendToScore[trend];
  if (!b) return Math.max(0, Math.min(5, score));
  return Math.max(b[0], Math.min(b[1], score)); // snap score into its trend's band
};

// ── Pre-filter — passages bearing on the moat factors ────────────────────────
const IND_KW =
  /(competit|rival|\bpeer|pricing|price war|capacity|utilis|utiliz|barrier|\bentry|moat|import|china|dumping|anti.?dumping|\bdut(y|ies)|tariff|regulat|\bpolicy|\bpli\b|govt|government|complian|inventor|de.?stock|re.?stock|channel|substitut|\bdemand|market share)/i;

// Skip the filing cover-letter preamble (which trips the regulation keyword on
// SEBI listing boilerplate) — start at the call/commentary opening when present.
const CALL_START = /(ladies and gentlemen|good (morning|afternoon|evening)|welcome (you )?to the|opening remarks|management\s*:|earnings (con(ference)?\s*call|call))/i;

// Filing / disclaimer boilerplate that the keywords (esp. "regulat") otherwise
// catch — dropped so the model reads commentary, not legal text.
const BOILERPLATE =
  /sebi\s*\(?listing|listing obligations|pursuant to regulation|forward.?looking statement|safe harbou?r|this presentation|neither the information|dalal street|jeejeebhoy|scrip code|disclosure requirements/i;

export function indSentences(text) {
  const norm = normalize(text);
  const i = norm.search(CALL_START);
  return (i > 0 ? norm.slice(i) : norm)
    .split(/(?<=[.?!])\s+(?=["'(]?[A-Z0-9])/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 30 && s.length <= 600 && IND_KW.test(s) && !BOILERPLATE.test(s));
}

const dedupKey = (s) => s.slice(0, 120).toLowerCase().replace(/[^a-z0-9]+/g, '');

// Concatenate relevant passages from a set of docs (newest first, deduped, capped).
//   docs: [{ period, text }]
export function buildIndustryInput(docs, { maxChars = CONFIG.maxInputChars } = {}) {
  const usable = (docs || []).filter((d) => d && d.text && d.text.trim());
  usable.sort((a, b) => String(b.period || '').localeCompare(String(a.period || '')));
  const seen = new Set();
  const parts = [];
  let budget = maxChars;
  const periods = [];
  for (const d of usable) {
    if (budget <= 0) break;
    const kept = [];
    for (const s of indSentences(d.text)) {
      const k = dedupKey(s);
      if (!k || seen.has(k)) continue;
      seen.add(k);
      const slice = s.length > budget ? s.slice(0, budget) : s;
      kept.push(slice);
      budget -= slice.length + 1;
      if (budget <= 0) break;
    }
    if (kept.length) {
      parts.push(`[${d.period || ''}]\n${kept.join('\n')}`);
      if (d.period) periods.push(d.period);
    }
  }
  let text = parts.join('\n\n');
  if (text.length > maxChars) text = text.slice(0, maxChars);
  return { text, charsIn: text.length, sourceQuarter: periods.sort().slice(-1)[0] || '' };
}

// ── Prompt + schema ──────────────────────────────────────────────────────────
export const SYSTEM_PROMPT =
  "You are an equity-research analyst assessing a company's competitive position (a Porter-style " +
  'moat read) from earnings-call commentary ONLY. For each factor, judge the TREND over the recent ' +
  'quarters shown — not a point-in-time level — and score it so HIGHER = MORE FAVORABLE for the ' +
  'business. Use only the excerpts. CRITICAL: if a factor is not actually discussed, set trend "NA" ' +
  'and do NOT invent a score — absence of discussion is "NA", never "improving" or favorable. Scores ' +
  'are comparable only within the same industry. Return ONLY a JSON object matching the schema.';

const FIELD_RULES =
  `Factors (score the TREND, higher = more favorable):\n${FACTORS.map((f) => `- ${f.key}: improving = ${f.favorable}; worsening = the opposite.`).join('\n')}\n\n` +
  'Map trend → score: worsening → 0–2, stable → 2–3, improving → 4–5. Each factor returns ' +
  '{score "0".."5", trend, note (one sentence citing the evidence), confidence}. If the excerpts do ' +
  'not actually address a factor, return trend "NA" — never score a factor from the absence of discussion.';

function jsonSkeleton() {
  return `{\n${FACTORS.map(
    (f) => `  "${f.key}": {"score": "0".."5", "trend": "improving"|"stable"|"worsening"|"NA", "note": "string", "confidence": "high"|"medium"|"low"}`
  ).join(',\n')}\n}`;
}

export function ownPrompt(companyName, industry, inputText) {
  return (
    `Company: ${companyName}\nIndustry: ${industry}\n\n${FIELD_RULES}\n\n` +
    `--- EXCERPTS (this company's own transcripts) ---\n${inputText}\n--- END ---\n\n` +
    `Return ONLY this JSON shape, all 8 keys:\n${jsonSkeleton()}`
  );
}

export function industryPrompt(industry, inputText) {
  return (
    `Industry: ${industry}\n\nAssess the INDUSTRY overall from the peer commentary below — not any single company.\n\n${FIELD_RULES}\n\n` +
    `--- EXCERPTS (multiple peers in this industry) ---\n${inputText}\n--- END ---\n\n` +
    `Return ONLY this JSON shape, all 8 keys:\n${jsonSkeleton()}`
  );
}

const factorSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['score', 'trend', 'note', 'confidence'],
  properties: {
    score: { type: 'string', enum: ['0', '1', '2', '3', '4', '5'] },
    trend: { type: 'string', enum: TRENDS },
    note: { type: 'string' },
    confidence: { type: 'string', enum: CONFIDENCE },
  },
};

export const RESPONSE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: FACTOR_KEYS,
  properties: Object.fromEntries(FACTOR_KEYS.map((k) => [k, factorSchema])),
};

// ── Shaping ──────────────────────────────────────────────────────────────────
const clampStr = (v, n) => String(v == null ? '' : v).trim().slice(0, n);
const clampConf = (c) => (CONFIDENCE.includes(String(c)) ? String(c) : 'low');

export function naFactor(reason) {
  return { score: null, trend: 'NA', note: reason, confidence: 'low' };
}

// Model answer → per-factor results; snap score into the trend band so score/trend
// stay consistent with the client mapping. Missing / out-of-enum → NA.
export function shapeFactors(modelObj) {
  const obj = modelObj && typeof modelObj === 'object' ? modelObj : {};
  const out = {};
  for (const f of FACTORS) {
    const raw = obj[f.key];
    if (!raw || typeof raw !== 'object' || !TRENDS.includes(String(raw.trend))) {
      out[f.key] = naFactor('Field not returned by model');
      continue;
    }
    const trend = String(raw.trend);
    if (trend === 'NA') {
      out[f.key] = naFactor(clampStr(raw.note, 400) || 'Not discussed');
      continue;
    }
    let score = Math.round(Number(raw.score));
    if (!Number.isFinite(score)) score = bandMid(trend);
    out[f.key] = { score: clampToBand(score, trend), trend, note: clampStr(raw.note, 500), confidence: clampConf(raw.confidence) };
  }
  return out;
}

export function naAllFactors(reason) {
  return Object.fromEntries(FACTOR_KEYS.map((k) => [k, naFactor(reason)]));
}

// Per-company, per-factor output the UI merges (own + inherited industry lens).
export function combineCompany(industryName, ownFactors, industryFactors) {
  const out = {};
  for (const f of FACTORS) {
    out[f.key] = {
      key: f.key,
      label: f.label,
      output_type: 'scale_0_5',
      industry_name: industryName,
      own: ownFactors ? ownFactors[f.key] : naFactor('No transcripts'),
      industry: industryFactors ? industryFactors[f.key] : naFactor(`too few peers (<${CONFIG.minPeers})`),
      third_party: null, // pending — next routine
    };
  }
  return out;
}
