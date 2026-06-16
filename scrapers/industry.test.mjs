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
  resolvePeerLevel,
  peerHasSignal,
  inheritedAllNA,
  extractOwn,
  lensKey,
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

test('resolvePeerLevel: narrowest grouping with >= minPeers, falls back outward', () => {
  const counts = {
    industry: { 'Bearings': 2 },          // too thin
    sector: { 'Auto Components': 9 },      // qualifies
    broad_sector: { 'Manufacturing': 40 },
  };
  const tags = { industry: 'Bearings', sector: 'Auto Components', broad_sector: 'Manufacturing' };
  assert.deepEqual(resolvePeerLevel(tags, counts, 3), { level: 'sector', name: 'Auto Components' });
  // industry itself qualifies → prefer it
  counts.industry.Bearings = 5;
  assert.deepEqual(resolvePeerLevel(tags, counts, 3), { level: 'industry', name: 'Bearings' });
  // nothing qualifies → null
  assert.equal(resolvePeerLevel({ industry: 'X', sector: 'Y', broad_sector: 'Z' }, counts, 3), null);
});

test('lensKey: industry un-prefixed, wider levels namespaced', () => {
  assert.equal(lensKey('industry', 'Bearings'), 'Bearings');
  assert.equal(lensKey('sector', 'Auto Components'), 'sector::Auto Components');
  assert.equal(lensKey('broad_sector', 'Manufacturing'), 'broad_sector::Manufacturing');
});

test('peerHasSignal / inheritedAllNA / extractOwn round-trip', () => {
  const own = shapeFactors(Object.fromEntries(FACTORS.map((f) => [f.key, { score: '4', trend: 'improving', note: 'g', confidence: 'high' }])));
  const real = shapeFactors(Object.fromEntries(FACTORS.map((f) => [f.key, { score: '2', trend: 'stable', note: 'p', confidence: 'medium' }])));
  const na = naAllFactors('too few peers (<3)');
  assert.equal(peerHasSignal(real), true);
  assert.equal(peerHasSignal(na), false);

  // a company combined with an NA peer read is the upgrade trigger…
  const cNA = combineCompany('Bearings', own, na);
  assert.equal(inheritedAllNA(cNA), true);
  // …and once a real peer read is attached, it isn't anymore
  const cReal = combineCompany('Auto Components', own, real);
  assert.equal(inheritedAllNA(cReal), false);
  // extractOwn recovers the stored own factors (improving band) for re-combine
  const recovered = extractOwn(cNA);
  for (const k of FACTOR_KEYS) assert.equal(recovered[k].trend, 'improving');
});
