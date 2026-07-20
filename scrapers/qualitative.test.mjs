import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildInput,
  openingRemarks,
  keywordSentences,
  pptSentences,
  shapeVerdicts,
  naAllParams,
  pickProvider,
  availableProviders,
  nextProvider,
  isStaleSource,
  estimateTokens,
  toGeminiSchema,
  RESPONSE_SCHEMA,
  PARAMS,
  renormalizeFields,
} from './lib/qualitative.mjs';
import { mockFromSchema } from './lib/llm.mjs';

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

test('keywordSentences / pptSentences: drop financial-table rows + safe-harbor boilerplate', () => {
  const table = 'Operating EBITDA6966066702 and Revenue from Operations4,0964,0053,877 are reported here.';
  const boiler = 'Important factors that could make a difference include demand supply conditions; the cautionary statement applies.';
  const kwSent = 'We expect EBITDA margin to expand as fuel and power procurement costs decline next year.';
  const narrative = 'Purvah Green won two new renewable projects this quarter, a 300 MW hybrid and a 250 MW wind project.';
  const doc = [table, boiler, kwSent, narrative].join(' ');

  // keyword path: keeps the clean relevant sentence, drops the table + boilerplate
  const kw = keywordSentences(doc).join(' | ');
  assert.match(kw, /margin to expand/);
  assert.doesNotMatch(kw, /6966066702/);
  assert.doesNotMatch(kw, /cautionary statement/i);

  // PPT path: keeps narrative even with no keyword, still drops the junk
  const ppt = pptSentences(doc).join(' | ');
  assert.match(ppt, /two new renewable projects/);
  assert.match(ppt, /margin to expand/);
  assert.doesNotMatch(ppt, /6966066702/);
  assert.doesNotMatch(ppt, /Important factors that could/);
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

  // Q&A / body sentences repeated across quarters are still deduped on content...
  assert.equal(r.text.split('commission the new plant').length - 1, 1);
  // ...but each of the newest two concalls keeps its OWN opening remarks (keyed by
  // period, not content), so a shared boilerplate intro can't collapse the prior
  // quarter's guidance into the latest. Both concall tags are present.
  assert.equal(r.text.split('[Concall ').length - 1, 2);

  assert.deepEqual(buildInput([{ type: 'transcript', period: '2026-02', text: '   ' }]), {
    text: '', sourceQuarter: '', usedPeriods: [], charsIn: 0, docsUsed: 0,
  });
});

test('buildInput: reserves the prior concall guidance against a budget-eating latest call', () => {
  // A latest call whose Q&A alone overflows the budget — naive newest-first packing
  // would fill it entirely and starve the previous quarter (making vs-prior blank).
  const bigQA = Array.from(
    { length: 200 },
    (_, i) => `On demand, segment ${i} revenue and margin outlook stays strong with a healthy order book.`
  ).join('\n');
  const newest = [
    'Management: welcome to the Q4 earnings call.',
    'We expect revenue growth of about 15% next year.',
    'Ladies and gentlemen, we will now begin the question-and-answer session.',
    bigQA,
  ].join('\n');
  // The prior quarter guided a DIFFERENT number, stated only in its opening remarks.
  const prior = [
    'Management: welcome to the Q3 earnings call.',
    'We expect revenue growth of about 8% next year as demand normalises.',
    'Ladies and gentlemen, we will now begin the question-and-answer session.',
    'On capacity, the new southern line ramps up over the year.',
  ].join('\n');

  const r = buildInput(
    [
      { type: 'transcript', period: '2026-05', text: newest },
      { type: 'transcript', period: '2026-02', text: prior },
    ],
    { maxChars: 6000 }
  );

  // Both quarters make it in, and the prior quarter's guidance number survives so the
  // model can actually compare them for rev_vs_prior.
  assert.match(r.text, /\[Concall 2026-05\]/);
  assert.match(r.text, /\[Concall 2026-02\]/);
  assert.match(r.text, /growth of about 8%/);
  assert.match(r.text, /growth of about 15%/);
  assert.ok(r.usedPeriods.includes('2026-02'), 'prior quarter must be present');
});

test('buildInput: a shared boilerplate intro does not collapse the prior opening', () => {
  // Consecutive concalls routinely open with an identical >140-char moderator/
  // safe-harbour intro, then diverge on guidance. A content dedupe keyed on the
  // first 140 chars would treat the prior opening as a duplicate and drop it — so
  // openings must dedupe on period, keeping BOTH quarters' guidance.
  const intro =
    'Ladies and gentlemen, good day and welcome to the earnings conference call of Example Industries Limited, ' +
    'hosted by the management team; as a reminder all participant lines are in the listen-only mode. Management:';
  const newest = `${intro} we now expect revenue growth of about 18% next year as demand accelerates. ` +
    'Ladies and gentlemen, we will now begin the question-and-answer session.';
  const prior = `${intro} we expect revenue growth of about 9% next year as demand stays steady. ` +
    'Ladies and gentlemen, we will now begin the question-and-answer session.';

  const r = buildInput(
    [
      { type: 'transcript', period: '2026-05', text: newest },
      { type: 'transcript', period: '2026-02', text: prior },
    ],
    { maxChars: 24000 }
  );

  assert.match(r.text, /growth of about 18%/); // newest guidance
  assert.match(r.text, /growth of about 9%/); // prior guidance survives despite shared intro
  assert.ok(r.usedPeriods.includes('2026-02'), 'prior quarter must be present');
});

test('buildInput: assembled text never exceeds the char cap (tags/joiners budgeted)', () => {
  // Many docs with real tags + joiners must not push the output past maxChars — the
  // reserved prior guidance is emitted last and would otherwise be truncated off.
  const mk = (n) =>
    [`Management: welcome to the ${n} call.`, `We expect revenue growth of about ${n}% next year.`,
     'Ladies and gentlemen, we will now begin the question-and-answer session.',
     Array.from({ length: 80 }, (_, i) => `On demand, segment ${i} revenue outlook stays strong.`).join('\n')].join('\n');
  const docs = [
    { type: 'transcript', period: '2026-05', text: mk(20) },
    { type: 'transcript', period: '2026-02', text: mk(15) },
    { type: 'transcript', period: '2025-11', text: mk(12) },
    { type: 'ppt', period: '2026-05', text: 'Investor deck: capacity expansion and market share gains continue.' },
  ];
  const r = buildInput(docs, { maxChars: 5000 });
  assert.ok(r.text.length <= 5000, `text length ${r.text.length} must be <= 5000`);
  assert.equal(r.charsIn, r.text.length);
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

test('shapeVerdicts: on NA, keeps a no-signal category but never a positive one', () => {
  const v = shapeVerdicts(
    {
      // NA order book, model says "Not applicable" (no order-book business) → kept
      order_book: { verdict: 'NA', value: '', note: 'consumer co', confidence: 'high', ob_trend: 'Not applicable' },
      // NA but a contradictory positive category → must NOT survive
      market_share: { verdict: 'NA', value: '', note: 'x', confidence: 'low', ms_trend: 'Gaining' },
      // NA capital, model says "None" (no raise) → kept
      capital_raised: { verdict: 'NA', value: '', note: 'x', confidence: 'low', cap_purpose: 'None' },
    },
    { sourceQuarter: '2026-02' }
  );
  assert.equal(v.order_book.fields.ob_trend, 'Not applicable'); // no-signal category preserved
  assert.equal(v.market_share.fields.ms_trend, 'Not disclosed'); // positive category dropped on NA
  assert.equal(v.capital_raised.fields.cap_purpose, 'None'); // "None" preserved
});

test('shapeVerdicts: "Not applicable" is rejected on a non-NA order-book read', () => {
  // PASS/FAIL means the order book exists — "Not applicable" (no order book) contradicts it.
  const v = shapeVerdicts(
    { order_book: { verdict: 'PASS', value: '', note: 'growing', confidence: 'high', ob_trend: 'Not applicable' } },
    { sourceQuarter: '2026-02' }
  );
  assert.equal(v.order_book.fields.ob_trend, 'Not disclosed'); // coerced away from the NA-only category
});

test('shapeVerdicts: guarded revenue backfill from value (metric-aware, period-stripped)', () => {
  const rev = (value) =>
    shapeVerdicts(
      { guidance_revenue: { verdict: 'DISCLOSED', value, note: '', confidence: 'high', rev_low_pct: '', rev_high_pct: '', rev_vs_prior: 'Not disclosed' } },
      { sourceQuarter: '2026-02' }
    ).guidance_revenue.fields;

  // Clean revenue-growth value → backfilled low/high.
  assert.deepEqual([rev('revenue growth of 15-20%').rev_low_pct, rev('revenue growth of 15-20%').rev_high_pct], [15, 20]);
  // A margin / EBITDA value must NOT bleed into revenue columns.
  assert.equal(rev('22-23% EBITDA margin; revenue growth strong').rev_high_pct, null);
  assert.equal(rev('INR550-600 cr EBITDA FY26').rev_low_pct, null);
  // Period tokens are stripped so "…in FY27" is not read as 27%.
  assert.equal(rev('revenue growth 15% in FY27').rev_high_pct, 15);
  // Absolute ₹ amounts alongside a % must NOT be read as a growth %.
  assert.deepEqual(
    [rev('revenue growth of 15-20% to INR 1,000 crore').rev_low_pct, rev('revenue growth of 15-20% to INR 1,000 crore').rev_high_pct],
    [15, 20]
  );
  // Ambiguous "CAGR" with no revenue/sales word → left blank (not guessed).
  assert.equal(rev('16.5% CAGR vs 15% guidance').rev_high_pct, null);
});

test('shapeVerdicts: revenue guidance splits into a growth-% pair and a ₹-crore target pair', () => {
  const rev = (value, over = {}) =>
    shapeVerdicts(
      { guidance_revenue: { verdict: 'DISCLOSED', value, note: `FY27 revenue guidance: ${value}`, confidence: 'high', rev_low_pct: '', rev_high_pct: '', rev_target_low_cr: '', rev_target_high_cr: '', rev_vs_prior: 'Not disclosed', ...over } },
      { sourceQuarter: '2026-05' }
    ).guidance_revenue.fields;

  // Absolute ₹ target → the CR pair (backfilled from value), % pair stays blank.
  let f = rev('INR3,400-3,500 cr FY27');
  assert.deepEqual([f.rev_target_low_cr, f.rev_target_high_cr], [3400, 3500]);
  assert.deepEqual([f.rev_low_pct, f.rev_high_pct], [null, null]);
  // mn/bn normalise to crore.
  assert.equal(rev('revenue of INR 26,000 mn for FY27').rev_target_high_cr, 2600);
  // A % outlook → the % pair, CR pair blank.
  f = rev('revenue growth of 15-20% next year');
  assert.deepEqual([f.rev_low_pct, f.rev_high_pct], [15, 20]);
  assert.deepEqual([f.rev_target_low_cr, f.rev_target_high_cr], [null, null]);
  // Both shapes given → both pairs fill.
  f = rev('15-20% growth to INR 1,000 crore in revenue');
  assert.deepEqual([f.rev_low_pct, f.rev_high_pct], [15, 20]);
  assert.equal(f.rev_target_high_cr, 1000);
  // A model that returns the CR fields directly is honoured (no unit in value needed).
  assert.equal(rev('FY27 target', { rev_target_high_cr: '750' }).rev_target_high_cr, 750);
  // …but a directly-returned ₹-target that mis-scales its own text is reconciled: a clean
  // 10× unit slip is corrected, and a USD-only figure we can't FX-convert is blanked.
  assert.equal(rev('₹3,500 cr FY27', { rev_target_high_cr: '35000' }).rev_target_high_cr, 3500);
  assert.equal(rev('FY28 US target $400 million', { rev_target_high_cr: '40000' }).rev_target_high_cr, null);
});

test('shapeVerdicts: an absolute ₹ target dropped into a growth-% subfield is rejected', () => {
  const rev = (value, lo, hi) =>
    shapeVerdicts(
      { guidance_revenue: { verdict: 'DISCLOSED', value, note: value, confidence: 'high', rev_low_pct: lo, rev_high_pct: hi, rev_vs_prior: 'Not disclosed' } },
      { sourceQuarter: '2026-05' }
    ).guidance_revenue.fields;

  // Rupee-crore revenue TARGETs mis-placed in the % columns → blanked, not "3500%".
  assert.deepEqual([rev('INR3,400-3,500 cr FY27', '3400', '3500').rev_low_pct, rev('INR3,400-3,500 cr FY27', '3400', '3500').rev_high_pct], [null, null]);
  assert.equal(rev('INR11,200 cr sales FY27', '', '11200').rev_high_pct, null);
  assert.equal(rev('Top line to cross INR 6,000 cr in FY27', '', '6000').rev_high_pct, null);
  // Above the sane ceiling even without a unit adjacency (e.g. 565 cr ±5% → 593.25).
  assert.equal(rev('FY27 revenue guidance 565 crore', '', '593.25').rev_high_pct, null);
  // Genuine high-growth percentages are KEPT (must not over-clamp real data).
  assert.equal(rev('103% YoY growth for FY26', '', '103').rev_high_pct, 103);
  assert.equal(rev('double revenue 550 to 1200 Cr by FY29', '', '118').rev_high_pct, 118);
  assert.deepEqual([rev('revenue growth of 15-20% next year', '15', '20').rev_low_pct, rev('revenue growth of 15-20% next year', '15', '20').rev_high_pct], [15, 20]);
});

test('shapeVerdicts: a mis-scaled ₹-crore order-book / capital headline is reconciled to its own text', () => {
  const ob = (value, size, note = value) =>
    shapeVerdicts(
      { order_book: { verdict: 'PASS', value, note, confidence: 'high', ob_trend: 'Growing', ob_size_cr: size, ob_book_to_bill: '' } },
      { sourceQuarter: '2026-05' }
    ).order_book.fields.ob_size_cr;
  const cap = (value, amt, note = value) =>
    shapeVerdicts(
      { capital_raised: { verdict: 'PASS', value, note, confidence: 'high', cap_amount_cr: amt, cap_purpose: 'Capex', cap_dilution_pct: '' } },
      { sourceQuarter: '2026-05' }
    ).capital_raised.fields.cap_amount_cr;

  // Unit slips: the model kept the raw number, so the crore figure is 10×–100× too big.
  assert.equal(ob('Order book ₹21,096 cr as of Mar 31', '210963'), 21096); // dropped decimal / 10×
  assert.equal(ob('INR 34,000 Mn order book; growing', '34000'), 3400); // mn → cr (÷10)
  assert.equal(ob('₹172 Bn order book', '172000'), 17200); // bn → cr (172 × 100)
  assert.equal(ob('Order book of ₹21,685 lacs', '21685'), 216.85); // lacs → cr (÷100)
  assert.equal(cap('₹331.53 cr strategic investment', '33153'), 331.53); // ×100 slip
  // Foreign-currency amounts we can't FX-convert → blanked, never a mis-scaled ₹ number.
  assert.equal(ob('Order backlog $800 mn; ~$1.3-1.4 bn by FY27', '8000'), null);
  assert.equal(cap('$136 million acquisition funding', '1360'), null);
  // A number that already agrees with its text is kept; a genuine large ₹ book too.
  assert.equal(ob('Order book of ₹5,000 cr', '5000'), 5000);
  assert.equal(ob('Consolidated order book INR 83,004 cr', '83004'), 83004);
  // Two figures in the text (the raise + an unrelated, larger MOU): the model already
  // matches the raise, so it's kept — not bumped up to the bigger number.
  assert.equal(cap('₹30.40 crore raise; separate ₹800 crore acquisition MOU', '30.4'), 30.4);
  // Model gave no number → the cell stays blank; we never fabricate a figure from the text.
  assert.equal(ob('Order book ₹1,200 cr and growing', ''), null);
  // No ₹ figure in the text to check against → the model's number passes through.
  assert.equal(ob('order book healthy and growing', '450'), 450);
});

test('renormalizeFields: heals a stored mis-scaled ₹-crore / over-ceiling field, idempotently', () => {
  // A param already shaped (as in the committed JSON) carrying a mis-scaled ob_size_cr —
  // renormalize corrects it from the param's own text, leaving enums alone.
  const ob = {
    key: 'order_book', output_type: 'pass_fail', value: 'Order book ₹21,096 cr', note: '',
    fields: { ob_trend: 'Growing', ob_size_cr: 210963, ob_book_to_bill: null },
  };
  const fixed = renormalizeFields(ob);
  assert.equal(fixed.ob_size_cr, 21096);
  assert.equal(fixed.ob_trend, 'Growing');
  assert.deepEqual(renormalizeFields({ ...ob, fields: fixed }), fixed); // idempotent
  // An over-ceiling margin % is blanked.
  const mg = { key: 'guidance_margin', output_type: 'implied', value: 'margins ~18%', note: '', fields: { margin_direction: 'Expanding', margin_level_pct: 113 } };
  assert.equal(renormalizeFields(mg).margin_level_pct, null);
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
  // Cerebras / Mistral — more free OpenAI-compatible providers
  assert.equal(pickProvider({ CEREBRAS_API_KEY: 'c' }).provider, 'cerebras');
  assert.equal(pickProvider({ MISTRAL_API_KEY: 'm' }).model, 'mistral-small-latest');
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
  assert.deepEqual(
    availableProviders({ GROQ_API_KEY: 'x', CEREBRAS_API_KEY: 'y', MISTRAL_API_KEY: 'z' }).map((p) => p.provider),
    ['groq', 'cerebras', 'mistral']
  );
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

test('mockFromSchema is schema-valid (verdicts within each param enum)', () => {
  const ans = mockFromSchema(RESPONSE_SCHEMA, 1);
  for (const p of PARAMS) {
    assert.ok(p.verdicts.includes(ans[p.key].verdict), `${p.key} verdict ${ans[p.key].verdict} in enum`);
    assert.ok(['high', 'medium', 'low'].includes(ans[p.key].confidence));
  }
});

test('estimateTokens ~ chars/4', () => {
  assert.equal(estimateTokens('abcd'.repeat(10)), 10);
});

test('isStaleSource: true only when a newer transcript exists', () => {
  assert.equal(isStaleSource('2025-08', '2026-02'), true); // newer concall → refresh
  assert.equal(isStaleSource('2026-02', '2026-02'), false); // same quarter
  assert.equal(isStaleSource('2026-05', '2026-02'), false); // manifest not newer
  assert.equal(isStaleSource('', '2026-02'), false); // no recorded source
  assert.equal(isStaleSource('2026-02', ''), false); // no transcripts
});
