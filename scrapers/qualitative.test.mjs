import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildInput,
  openingRemarks,
  keywordSentences,
  shapeVerdicts,
  naAllParams,
  pickProvider,
  availableProviders,
  nextProvider,
  estimateTokens,
  toGeminiSchema,
  RESPONSE_SCHEMA,
  PARAMS,
} from './lib/qualitative.mjs';
import { mockAnswer } from './lib/llm.mjs';

const TRANSCRIPT = [
  'Management: Good morning everyone and welcome to the Q3 earnings call.',
  'We expect revenue growth of about 15% next year as demand stays strong.',
  'Our order book grew 20% year on year to 5000 crore.',
  'Some unrelated boilerplate about the weather and logistics.',
  'We are guiding for EBITDA margin of around 18% for the full year.',
  'Ladies and gentlemen, we will now begin the question-and-answer session.',
  'On capacity, we expect to commission the new plant and raise demand visibility.',
].join('\n');

test('openingRemarks: captures management commentary up to the Q&A marker', () => {
  const op = openingRemarks(TRANSCRIPT);
  assert.match(op, /welcome to the Q3 earnings call/);
  assert.match(op, /revenue growth of about 15%/);
  assert.doesNotMatch(op, /question-and-answer/);
});

test('keywordSentences: keeps relevant sentences, drops noise', () => {
  const s = keywordSentences(TRANSCRIPT);
  const joined = s.join(' | ');
  assert.match(joined, /order book grew 20%/);
  assert.match(joined, /EBITDA margin/);
  assert.doesNotMatch(joined, /weather and logistics/);
});

test('buildInput: newest-first, tagged, deduped, capped; empty when no usable docs', () => {
  const docs = [
    // Older quarter shares most text (deduped away) but has one unique sentence,
    // so its tag still appears — lets us assert newest-first ordering.
    { type: 'transcript', period: '2025-05', text: `${TRANSCRIPT}\nWe expanded capacity at the southern plant this quarter.` },
    { type: 'transcript', period: '2026-02', text: TRANSCRIPT },
    { type: 'ppt', period: '2026-01', text: 'Investor deck: we target market share gains and capacity expansion.' },
  ];
  const r = buildInput(docs, { maxChars: 24000 });
  assert.equal(r.sourceQuarter, '2026-02'); // latest transcript
  assert.ok(r.text.indexOf('[Concall 2026-02]') < r.text.indexOf('[Concall 2025-05]')); // newest first
  assert.match(r.text, /\[Investor PPT 2026-01\]/);
  assert.ok(r.charsIn > 0 && r.charsIn <= 24000);

  // Identical text across both quarters must be deduped (no doubled sentences).
  const occurrences = r.text.split('order book grew 20%').length - 1;
  assert.equal(occurrences, 1);

  assert.deepEqual(buildInput([{ type: 'transcript', period: '2026-02', text: '   ' }]), {
    text: '', sourceQuarter: '', usedPeriods: [], charsIn: 0, docsUsed: 0,
  });
});

test('buildInput: respects the char cap', () => {
  const big = 'We expect strong demand and margin expansion. '.repeat(5000);
  const r = buildInput([{ type: 'transcript', period: '2026-02', text: big }], { maxChars: 3000 });
  assert.ok(r.charsIn <= 3000, `charsIn ${r.charsIn} should be <= 3000`);
});

test('shapeVerdicts: valid answer → verdict objects with label/output_type/source', () => {
  const model = {
    guidance_revenue: { verdict: 'DISCLOSED', value: '15%', note: 'mgmt guided 15%', confidence: 'high' },
    guidance_margin: { verdict: 'DISCLOSED', value: '18%', note: 'around 18%', confidence: 'medium' },
    order_book: { verdict: 'PASS', value: '5000 cr, +20%', note: 'growing', confidence: 'high' },
    mgmt_tone: { verdict: 'PASS', value: '', note: 'confident', confidence: 'medium' },
    strategic_stocking: { verdict: 'Neutral', value: '', note: 'no signal', confidence: 'low' },
    market_share: { verdict: 'PASS', value: '', note: 'gaining', confidence: 'medium' },
    demand_anticipation: { verdict: '2', value: 'strong', note: 'demand strong', confidence: 'high' },
    capital_raised: { verdict: 'NA', value: '', note: 'none', confidence: 'low' },
  };
  const v = shapeVerdicts(model, { sourceQuarter: '2026-02' });
  assert.equal(v.guidance_revenue.output_type, 'implied');
  assert.equal(v.guidance_revenue.verdict, 'DISCLOSED');
  assert.equal(v.guidance_revenue.source, '2026-02');
  assert.equal(v.order_book.value, '5000 cr, +20%');
  assert.equal(v.demand_anticipation.output_type, 'scale_1_5');
  assert.equal(v.capital_raised.verdict, 'NA');
  assert.equal(v.capital_raised.source, ''); // NA carries no source
});

test('shapeVerdicts: out-of-enum / missing fields degrade to NA, confidence clamps', () => {
  const v = shapeVerdicts(
    {
      order_book: { verdict: 'MAYBE', value: 'x', note: 'bad enum', confidence: 'high' },
      mgmt_tone: { verdict: 'PASS', value: '', note: 'ok', confidence: 'bogus' },
      // others missing entirely
    },
    { sourceQuarter: '2026-02' }
  );
  assert.equal(v.order_book.verdict, 'NA'); // invalid enum → NA
  assert.equal(v.mgmt_tone.confidence, 'low'); // invalid confidence → low
  assert.equal(v.guidance_revenue.verdict, 'NA'); // missing → NA
  assert.equal(Object.keys(v).length, PARAMS.length);
});

test('naAllParams: every param NA with native output_type', () => {
  const na = naAllParams('No transcripts/PPT harvested');
  assert.equal(Object.keys(na).length, PARAMS.length);
  for (const p of PARAMS) {
    assert.equal(na[p.key].verdict, 'NA');
    assert.equal(na[p.key].output_type, p.output_type);
    assert.equal(na[p.key].note, 'No transcripts/PPT harvested');
  }
});

test('pickProvider: key priority, overrides, and the no-key error', () => {
  assert.equal(pickProvider({ GEMINI_API_KEY: 'g' }).provider, 'gemini');
  assert.equal(pickProvider({ GEMINI_API_KEY: 'g' }).model, 'gemini-2.5-flash-lite');
  // Groq only → its free Llama model
  assert.equal(pickProvider({ GROQ_API_KEY: 'gq' }).provider, 'groq');
  assert.equal(pickProvider({ GROQ_API_KEY: 'gq' }).model, 'llama-3.3-70b-versatile');
  // Gemini still wins over Groq when both are set (Groq is opt-in via PROVIDER=groq)
  assert.equal(pickProvider({ GEMINI_API_KEY: 'g', GROQ_API_KEY: 'gq' }).provider, 'gemini');
  // OpenAI only
  assert.equal(pickProvider({ OPENAI_API_KEY: 'o' }).provider, 'openai');
  // Gemini wins when several are set
  assert.equal(pickProvider({ GEMINI_API_KEY: 'g', ANTHROPIC_API_KEY: 'a' }).provider, 'gemini');
  // explicit override + custom model
  const ov = pickProvider({ PROVIDER: 'anthropic', MODEL: 'claude-x', ANTHROPIC_API_KEY: 'a' });
  assert.equal(ov.provider, 'anthropic');
  assert.equal(ov.model, 'claude-x');
  // mock needs no key
  assert.equal(pickProvider({ PROVIDER: 'mock' }).provider, 'mock');
  // override without its key → error
  assert.throws(() => pickProvider({ PROVIDER: 'gemini' }), /GEMINI_API_KEY is not set/);
  // nothing set → helpful error
  assert.throws(() => pickProvider({}), /No LLM API key set/);
});

test('availableProviders: pool of every key set; single when PROVIDER forced', () => {
  const both = availableProviders({ GEMINI_API_KEY: 'g', GROQ_API_KEY: 'gq' });
  assert.deepEqual(both.map((p) => p.provider), ['gemini', 'groq']);
  assert.equal(both[0].model, 'gemini-2.5-flash-lite');
  assert.equal(both[1].model, 'llama-3.3-70b-versatile');
  assert.deepEqual(availableProviders({ PROVIDER: 'groq', GROQ_API_KEY: 'gq' }).map((p) => p.provider), ['groq']);
  assert.throws(() => availableProviders({}), /No LLM API key set/);
});

test('nextProvider: rotates, wraps, and skips exhausted/disabled/tried', () => {
  const ps = [{ provider: 'gemini' }, { provider: 'groq' }];
  assert.equal(nextProvider(ps, 0).provider.provider, 'gemini');
  assert.equal(nextProvider(ps, 1).provider.provider, 'groq');
  assert.equal(nextProvider(ps, 2).provider.provider, 'gemini'); // wraps
  assert.equal(nextProvider(ps, 0, new Set(['gemini'])).provider.provider, 'groq'); // skip tried
  const ps2 = [{ provider: 'gemini', exhausted: true }, { provider: 'groq' }];
  assert.equal(nextProvider(ps2, 0).provider.provider, 'groq'); // skip exhausted
  assert.equal(nextProvider([{ provider: 'gemini', disabled: true }], 0), null); // none → null
});

test('toGeminiSchema strips additionalProperties but keeps enums/required', () => {
  const g = toGeminiSchema(RESPONSE_SCHEMA);
  const json = JSON.stringify(g);
  assert.doesNotMatch(json, /additionalProperties/);
  assert.match(json, /"enum"/);
  assert.ok(g.properties.order_book.required.includes('verdict'));
});

test('mockAnswer is schema-valid (verdicts within each param enum)', () => {
  const ans = mockAnswer('Company: Test\nexcerpts');
  for (const p of PARAMS) {
    assert.ok(p.verdicts.includes(ans[p.key].verdict), `${p.key} verdict ${ans[p.key].verdict} in enum`);
    assert.ok(['high', 'medium', 'low'].includes(ans[p.key].confidence));
  }
});

test('estimateTokens ~ chars/4', () => {
  assert.equal(estimateTokens('abcd'.repeat(10)), 10);
});
