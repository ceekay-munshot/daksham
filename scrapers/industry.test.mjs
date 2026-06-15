import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  indSentences,
  buildIndustryInput,
  shapeFactors,
  naAllFactors,
  combineCompany,
  FACTORS,
  FACTOR_KEYS,
  RESPONSE_SCHEMA,
} from './lib/industry.mjs';
import { mockFromSchema } from './lib/llm.mjs';

const TXT = [
  'Competition in the sector has intensified with new entrants pressuring pricing.',
  'We raised prices and our capacity utilisation improved through the year.',
  'Cheap Chinese imports remain a threat though anti-dumping duties were imposed.',
  'The weather was pleasant and entirely unrelated to the business.',
  'Inventory levels are elevated due to a deliberate pre-monsoon build-up.',
].join('\n');

test('indSentences: keeps moat-relevant lines, drops noise', () => {
  const s = indSentences(TXT).join(' | ');
  assert.match(s, /Competition in the sector/);
  assert.match(s, /Chinese imports/);
  assert.doesNotMatch(s, /weather was pleasant/);
});

test('buildIndustryInput: newest-first, deduped, capped; empty when nothing usable', () => {
  const r = buildIndustryInput(
    [
      { period: '2025-05', text: TXT },
      { period: '2026-02', text: TXT },
    ],
    { maxChars: 24000 }
  );
  // identical text → the older doc dedups to nothing
  assert.equal(r.text.split('Competition in the sector').length - 1, 1);
  assert.ok(r.charsIn > 0 && r.charsIn <= 24000);
  assert.equal(buildIndustryInput([{ period: '2026-02', text: '   ' }]).text, '');
});

test('buildIndustryInput respects the char cap', () => {
  const big = 'Competition is rising and pricing is under pressure. '.repeat(5000);
  const r = buildIndustryInput([{ period: '2026-02', text: big }], { maxChars: 2000 });
  assert.ok(r.charsIn <= 2000, `charsIn ${r.charsIn} <= 2000`);
});

test('shapeFactors: score snaps into the trend band', () => {
  const model = Object.fromEntries(FACTORS.map((f) => [f.key, { score: '5', trend: 'worsening', note: 'x', confidence: 'high' }]));
  const v = shapeFactors(model);
  for (const f of FACTORS) {
    assert.equal(v[f.key].trend, 'worsening');
    assert.ok(v[f.key].score >= 0 && v[f.key].score <= 2, `${f.key} score ${v[f.key].score} in [0,2]`); // worsening band
  }
});

test('shapeFactors: trend NA and missing fields → NA', () => {
  const v = shapeFactors({ competition: { score: '4', trend: 'NA', note: 'not discussed', confidence: 'low' } });
  assert.equal(v.competition.trend, 'NA');
  assert.equal(v.competition.score, null);
  assert.equal(v.barriers_to_entry.trend, 'NA'); // missing → NA
  assert.equal(Object.keys(v).length, FACTOR_KEYS.length);
});

test('combineCompany: own + inherited industry + third_party null', () => {
  const own = shapeFactors(Object.fromEntries(FACTORS.map((f) => [f.key, { score: '4', trend: 'improving', note: 'good', confidence: 'high' }])));
  const ind = naAllFactors('too few peers (<3)');
  const c = combineCompany('Private Sector Bank', own, ind);
  assert.equal(c.competition.output_type, 'scale_0_5');
  assert.equal(c.competition.industry_name, 'Private Sector Bank');
  assert.equal(c.competition.own.score, 4); // improving band [4,5]
  assert.equal(c.competition.industry.trend, 'NA');
  assert.equal(c.competition.third_party, null);
});

test('mockFromSchema fits the industry schema', () => {
  const ans = mockFromSchema(RESPONSE_SCHEMA, 2);
  for (const k of FACTOR_KEYS) {
    assert.ok(['improving', 'stable', 'worsening'].includes(ans[k].trend)); // non-NA picked
    assert.match(String(ans[k].score), /^[0-5]$/);
  }
});
