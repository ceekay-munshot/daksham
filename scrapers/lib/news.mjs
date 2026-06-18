// Third-party NEWS lens — scores the SAME 8 moat factors as the own/peer lenses,
// but from EXTERNAL news headlines (Google News RSS), to fill the `third_party`
// slot with an independent, outside-in read. Pure core (no network/DOM/fs): parse
// the RSS, build the prompt input, build the query/URL. The fetch + LLM call live
// in the orchestrator. Factor definitions, schema and shaping are reused from the
// moat lens so all three perspectives stay directly comparable.

import { FACTORS, FACTOR_KEYS, CONFIG, RESPONSE_SCHEMA, shapeFactors, naAllFactors, naFactor } from './industry.mjs';

export { FACTORS, FACTOR_KEYS, RESPONSE_SCHEMA, shapeFactors, naAllFactors, naFactor };

// News is independent coverage, not the company's own words — a distinct system
// prompt, and a HARDER NA bar (headlines rarely address every Porter factor).
export const NEWS_SYSTEM_PROMPT =
  'You are an equity-research analyst reading EXTERNAL NEWS HEADLINES about a company to assess its ' +
  'competitive position (a Porter-style moat read) from an independent, outside-in view. For each factor, ' +
  'judge the TREND implied by recent coverage and score it so HIGHER = MORE FAVORABLE for the business. ' +
  'Use ONLY the headlines provided. CRITICAL: news rarely touches every factor — if a factor is not ' +
  'actually evidenced by the headlines, set trend "NA" and do NOT invent a score. Absence of coverage is ' +
  '"NA", never favorable. Ignore headlines about unrelated namesakes. Return ONLY a JSON object matching the schema.';

const FIELD_RULES =
  `Factors (score the TREND implied by the news, higher = more favorable):\n${FACTORS.map((f) => `- ${f.key}: improving = ${f.favorable}; worsening = the opposite.`).join('\n')}\n\n` +
  'Map trend → score: worsening → 0–2, stable → 2–3, improving → 4–5. Each factor returns ' +
  '{score "0".."5", trend, note (one sentence citing the headline evidence), confidence}. Most factors ' +
  'will be "NA" from headlines alone — that is expected; only score a factor the news actually evidences.';

function jsonSkeleton() {
  return `{\n${FACTORS.map(
    (f) => `  "${f.key}": {"score": "0".."5", "trend": "improving"|"stable"|"worsening"|"NA", "note": "string", "confidence": "high"|"medium"|"low"}`
  ).join(',\n')}\n}`;
}

export function newsPrompt(companyName, industry, inputText) {
  return (
    `Company: ${companyName}\nIndustry: ${industry || 'n/a'}\n\n${FIELD_RULES}\n\n` +
    `--- RECENT NEWS HEADLINES (external media, newest first) ---\n${inputText}\n--- END ---\n\n` +
    `Return ONLY this JSON shape, all 8 keys:\n${jsonSkeleton()}`
  );
}

// ── Google News RSS query + URL ──────────────────────────────────────────────
// Quote the registered name for precision; the `when:Nd` operator bounds recency.
// India English locale keeps coverage to Indian-market sources.
export function newsQuery(name, { days = 60 } = {}) {
  const n = String(name || '').trim();
  return `"${n}" when:${days}d`;
}

export function newsRssUrl(name, opts) {
  return `https://news.google.com/rss/search?q=${encodeURIComponent(newsQuery(name, opts))}&hl=en-IN&gl=IN&ceid=IN:en`;
}

// ── RSS parsing (self-contained, no XML dep) ─────────────────────────────────
const stripTags = (t) =>
  String(t || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'").replace(/&apos;/g, "'").replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();

const tagText = (block, tag) => {
  const m = block.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, 'i'));
  return m ? stripTags(m[1]) : '';
};

// Parse Google News RSS into [{ title, source, date 'YYYY-MM-DD', link }], newest
// items as they appear. Google News titles are "Headline - Source"; the trailing
// source is stripped so the model reads the headline cleanly.
export function parseNewsRss(xml) {
  const out = [];
  for (const m of String(xml || '').matchAll(/<item>([\s\S]*?)<\/item>/gi)) {
    const block = m[1];
    const source = tagText(block, 'source');
    let title = tagText(block, 'title');
    if (source && title.endsWith(`- ${source}`)) title = title.slice(0, -(source.length + 2)).trim();
    const pub = tagText(block, 'pubDate');
    const d = pub ? new Date(pub) : null;
    const date = d && !Number.isNaN(d.getTime()) ? d.toISOString().slice(0, 10) : '';
    const link = tagText(block, 'link');
    if (title) out.push({ title, source, date, link });
  }
  return out;
}

// Build the model input from news items: newest-first, deduped by headline, capped
// by count and chars. Returns { text, count, latest } ('' text when nothing usable).
export function buildNewsInput(items, { maxChars = CONFIG.maxInputChars, maxItems = 40 } = {}) {
  const sorted = [...(items || [])]
    .filter((it) => it && it.title)
    .sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
  const seen = new Set();
  const rows = [];
  const kept = [];
  for (const it of sorted) {
    if (rows.length >= maxItems) break;
    const key = String(it.title).slice(0, 90).toLowerCase().replace(/[^a-z0-9]+/g, '');
    if (!key || seen.has(key)) continue;
    seen.add(key);
    rows.push(`${it.date || '????-??-??'} · ${it.source || 'news'} — ${it.title}`);
    kept.push(it);
  }
  let text = rows.join('\n');
  if (text.length > maxChars) text = text.slice(0, maxChars);
  return { text, count: rows.length, latest: (sorted.find((x) => x.date) || {}).date || '', items: kept };
}
