import { test } from 'node:test';
import assert from 'node:assert/strict';

import { makeReport, checkCompanies, checkQualitative, checkMoat, runChecks } from './data-doctor.mjs';

const errs = (R) => R.items.filter((i) => i.level === 'error').map((i) => i.code);
const FK = ['competition', 'barriers_to_entry', 'buyer_power', 'supplier_power', 'substitution_risk', 'china_imports', 'govt_regulation', 'inventory_buildup'];

test('checkCompanies: flags NaN cap, bad holding, dup slug; allows negative P/E', () => {
  const R = makeReport();
  checkCompanies(
    [
      { slug: 'A', name: 'A', path: '/c/A/', market_cap: 'NaN', promoter_holding: 150 },
      { slug: 'A', name: 'A2', path: '/c/A2/', market_cap: 100, stock_pe: -5 }, // dup slug; negative P/E is legit
      { slug: 'B', name: 'B', path: '/c/B/', market_cap: 200, promoter_holding: 50, institutional_holding: 30, fii_holding: 10, dii_holding: 20 },
    ],
    R
  );
  const e = errs(R);
  assert.ok(e.includes('value.invalid'), 'NaN market cap → invalid');
  assert.ok(e.includes('holding.range'), 'holding 150 → range error');
  assert.ok(e.includes('companies.dup_slug'), 'duplicate slug → error');
  assert.ok(!R.items.some((i) => i.code === 'value.negative'), 'negative P/E is NOT flagged');
});

test('checkCompanies: a non-numeric series cell is an error; a clean row is silent', () => {
  const R = makeReport();
  checkCompanies([{ slug: 'C', name: 'C', path: '/c/C/', market_cap: 1, sales_qtr_series: '100|oops|120' }], R);
  assert.ok(errs(R).includes('series.nonnumeric'));
  const R2 = makeReport();
  checkCompanies([{ slug: 'D', name: 'D', path: '/c/D/', market_cap: 1, sales_qtr_series: '100|110|120' }], R2);
  assert.equal(errs(R2).length, 0);
});

test('checkQualitative: verdict must match its output_type vocabulary', () => {
  const R = makeReport();
  checkQualitative(
    { companies: { X: { params: {
      a: { key: 'a', output_type: 'pos_neu_neg', verdict: 'Positive' }, // ok
      b: { key: 'b', output_type: 'scale_1_5', verdict: '9' },          // 9 not in 1..5
      c: { key: 'c', output_type: 'mystery', verdict: 'NA' },           // unknown type
    }, meta: { docs_used: 2 } } } },
    new Set(['X']),
    R
  );
  const e = errs(R);
  assert.ok(e.includes('qual.bad_verdict'));
  assert.ok(e.includes('qual.bad_output_type'));
});

test('checkMoat: validates own/peer per factor (no false "missing"), catches band mismatch', () => {
  const ok = { score: 5, trend: 'improving', note: 'x', confidence: 'high' };
  const na = { score: null, trend: 'NA', note: 'n', confidence: 'low' };
  const factors = Object.fromEntries(FK.map((k) => [k, { key: k, own: ok, industry: na, third_party: null }]));
  const R = makeReport();
  checkMoat({ companies: { Z: { peer_level: 'sector', factors } } }, new Set(['Z']), R);
  assert.equal(R.items.filter((i) => i.code === 'factor.missing').length, 0, 'no false missing');
  assert.equal(errs(R).length, 0);

  const bad = JSON.parse(JSON.stringify(factors));
  bad.competition.own = { score: 1, trend: 'improving', note: 'x', confidence: 'high' }; // improving but score 1
  const R2 = makeReport();
  checkMoat({ companies: { Z: { factors: bad } } }, new Set(['Z']), R2);
  assert.ok(R2.items.some((i) => i.code === 'factor.band_mismatch'));
});

test('checkQualitative / checkMoat: entry for an unknown slug → orphan', () => {
  const R = makeReport();
  checkQualitative({ companies: { GHOST: { params: {}, meta: {} } } }, new Set(['REAL']), R);
  assert.ok(R.items.some((i) => i.code === 'lens.orphan'));
});

test('runChecks: minimal valid dataset yields zero errors', () => {
  const R = makeReport();
  runChecks(
    { companies: [{ slug: 'A', name: 'A', path: '/c/A/', market_cap: 100 }], universe: [{ slug: 'A' }], companiesMeta: { generated_at: new Date().toISOString() } },
    R
  );
  assert.equal(R.items.filter((i) => i.level === 'error').length, 0);
});
