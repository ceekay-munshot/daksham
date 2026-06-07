import { test } from 'node:test';
import assert from 'node:assert/strict';

import { evaluate, parseSeries } from './evaluate.mjs';

// Evaluate a partial row and return its params map. Unset fields just become NA.
const P = (row) => evaluate(row).params;
const verdict = (row, key) => P(row)[key].verdict;
const note = (row, key) => P(row)[key].note;

test('parseSeries: pipe → number[], drops blanks', () => {
  assert.deepEqual(parseSeries('12.3|13.1|14.0'), [12.3, 13.1, 14]);
  assert.deepEqual(parseSeries('10||12'), [10, 12]); // mid-series blank dropped
  assert.deepEqual(parseSeries(''), []);
  assert.deepEqual(parseSeries(null), []);
});

// ── yoy_sales_growth_12q ────────────────────────────────────────────────────
test('yoy_sales_growth_12q', () => {
  const K = 'yoy_sales_growth_12q';
  // accelerating → YoY non-declining → PASS (linear growth would *decelerate* YoY)
  assert.equal(verdict({ sales_qtr_series: '100|100|100|100|110|111|112|113|130|133|136|139' }, K), 'PASS');
  // recent sustained drop → consecutive YoY declines + negative latest → FAIL
  assert.equal(verdict({ sales_qtr_series: '100|105|110|116|122|128|134|141|130|120|110|100' }, K), 'FAIL');
  // short series → NA(data)
  const na = P({ sales_qtr_series: '100|105|110' })[K];
  assert.equal(na.verdict, 'NA');
  assert.ok(na.note.startsWith('Insufficient history'));
});

// ── yoy_gross_margin_12q ────────────────────────────────────────────────────
test('yoy_gross_margin_12q', () => {
  const K = 'yoy_gross_margin_12q';
  // material cost falling → gross margin expanding → PASS
  assert.equal(verdict({ material_cost_pct_qtr_series: '50|49|48|47|46|45|44|43|42|41|40|39' }, K), 'PASS');
  // material cost rising → margin contracting → FAIL
  assert.equal(verdict({ material_cost_pct_qtr_series: '40|41|42|43|44|45|46|47|48|49|50|51' }, K), 'FAIL');
  // short non-empty → NA(data)
  assert.ok(note({ material_cost_pct_qtr_series: '50|49|48' }, K).startsWith('Insufficient history'));
  // empty → NA(sector), distinguishable by the note prefix
  const sec = P({ material_cost_pct_qtr_series: '' })[K];
  assert.equal(sec.verdict, 'NA');
  assert.ok(sec.note.startsWith('Not applicable'));
});

// ── cfo_rising_3y ───────────────────────────────────────────────────────────
test('cfo_rising_3y', () => {
  const K = 'cfo_rising_3y';
  assert.equal(verdict({ cfo_series: '50|100|150|200' }, K), 'PASS'); // last 3 strictly up
  assert.equal(verdict({ cfo_series: '100|200|150' }, K), 'FAIL'); // not strictly increasing
  assert.ok(note({ cfo_series: '100|200' }, K).startsWith('Insufficient history'));
});

// ── ebitda_gt_110_sales ─────────────────────────────────────────────────────
test('ebitda_gt_110_sales', () => {
  const K = 'ebitda_gt_110_sales';
  // sales +20%, EBITDA 10→18 (+80%) → operating leverage → PASS
  assert.equal(verdict({ revenue_series: '100|120', opm_series: '10|15' }, K), 'PASS');
  // sales +20%, EBITDA 10→12 (+20%) → not > 1.1× → FAIL
  assert.equal(verdict({ revenue_series: '100|120', opm_series: '10|10' }, K), 'FAIL');
  // one year only → NA(data)
  assert.ok(note({ revenue_series: '100', opm_series: '10' }, K).startsWith('Insufficient history'));
});

// ── sales_fa_below_0_8x ─────────────────────────────────────────────────────
test('sales_fa_below_0_8x', () => {
  const K = 'sales_fa_below_0_8x';
  // sfa 5,5,2.5 → latest 2.5 < 0.8 × mean(4.17)=3.33 → PASS
  assert.equal(verdict({ revenue_series: '100|100|100', net_block_series: '20|20|40' }, K), 'PASS');
  // sfa 5,5,5 → latest 5 not < 4 → FAIL
  assert.equal(verdict({ revenue_series: '100|100|100', net_block_series: '20|20|20' }, K), 'FAIL');
  assert.ok(note({ revenue_series: '100|100', net_block_series: '20|20' }, K).startsWith('Insufficient history'));
});

// ── promoter_trend_up ───────────────────────────────────────────────────────
test('promoter_trend_up', () => {
  const K = 'promoter_trend_up';
  assert.equal(verdict({ promoter_holding_series: '50|50|50|50|51' }, K), 'PASS'); // Δ +1.0 > 0.5
  assert.equal(verdict({ promoter_holding_series: '50|50|50|50|50' }, K), 'FAIL'); // Δ 0
  assert.ok(note({ promoter_holding_series: '50|50|50' }, K).startsWith('Insufficient history'));
});

// ── inst_trend_up ───────────────────────────────────────────────────────────
test('inst_trend_up', () => {
  const K = 'inst_trend_up';
  assert.equal(verdict({ fii_holding_series: '10|10|10|10|12', dii_holding_series: '5|5|5|5|6' }, K), 'PASS'); // Δ +3
  assert.equal(verdict({ fii_holding_series: '10|10|10|10|10', dii_holding_series: '5|5|5|5|5' }, K), 'FAIL'); // Δ 0
  assert.ok(note({ fii_holding_series: '10|10|10', dii_holding_series: '5|5|5' }, K).startsWith('Insufficient history'));
});

// ── gross-margin raw + sector NA ────────────────────────────────────────────
test('gross_margin raw values and naSector', () => {
  const ok = P({ material_cost_pct_annual_series: '40|41|42|43' });
  assert.equal(ok.gross_margin_latest.output_type, 'raw');
  assert.equal(ok.gross_margin_latest.verdict, null);
  assert.equal(ok.gross_margin_latest.value, 57); // 100 - 43
  assert.equal(ok.gross_margin_3y_increase.value, -3); // (100-43) - (100-40)

  const fin = P({ material_cost_pct_annual_series: '' });
  assert.equal(fin.gross_margin_latest.verdict, 'NA');
  assert.ok(fin.gross_margin_latest.note.startsWith('Not applicable'));
  assert.ok(fin.gross_margin_3y_increase.note.startsWith('Not applicable'));
});

// ── shape: raw / deferred / company ─────────────────────────────────────────
test('verdict shapes and evaluate envelope', () => {
  const e = evaluate({ name: 'Acme', slug: 'ACME', path: '/company/ACME/', market_cap: '1200', sector: 'X' });
  assert.equal(e.company.slug, 'ACME');

  const mc = e.params.market_cap;
  assert.deepEqual(
    { ot: mc.output_type, v: mc.verdict, val: mc.value },
    { ot: 'raw', v: null, val: 1200 }
  );

  const d = e.params.capital_allocation;
  assert.equal(d.output_type, 'deferred');
  assert.equal(d.verdict, null);
  assert.ok(d.note.startsWith('Deferred'));

  // every param carries the full verdict shape
  for (const p of Object.values(e.params)) {
    for (const f of ['key', 'label', 'value', 'verdict', 'output_type', 'note']) assert.ok(f in p);
  }
});
