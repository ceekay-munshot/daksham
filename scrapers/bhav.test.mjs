import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseBhavcopy,
  isNumericSlug,
  buildTurnoverIndex,
  computeLiquidUniverse,
  round2,
} from './lib/bhav.mjs';

// NSE "sec_bhavdata_full" CSVs pad cells with spaces after each comma; the parser
// must trim and keep only EQ rows. TURNOVER_LACS -> Cr is /100.
const HEADER =
  'SYMBOL, SERIES, DATE1, PREV_CLOSE, OPEN_PRICE, HIGH_PRICE, LOW_PRICE, LAST_PRICE, ' +
  'CLOSE_PRICE, AVG_PRICE, TTL_TRD_QNTY, TURNOVER_LACS, NO_OF_TRADES, DELIV_QTY, DELIV_PER';

const row = (sym, series, turnoverLacs) =>
  `${sym}, ${series}, 02-Jun-2025, 1, 1, 1, 1, 1, 1, 1, 100, ${turnoverLacs}, 10, 50, 50`;

const DAY1 = [
  HEADER,
  row('RELIANCE', 'EQ', '50000.00'), // 500 Cr
  row('TCS', 'EQ', '30000.00'), // 300 Cr
  row('SMALLCO', 'EQ', '200.00'), // 2 Cr
  row('SOMEBOND', 'N2', '99999.00'), // non-EQ -> ignored
  '', // blank line tolerated
].join('\n');

const DAY2 = [
  HEADER,
  row('RELIANCE', 'EQ', '50000.00'), // 500 Cr
  row('TCS', 'EQ', '30000.00'), // 300 Cr
  // SMALLCO absent today -> counts as 0
].join('\n');

test('parseBhavcopy: trims, keeps EQ only, converts lakhs->Cr', () => {
  const rows = parseBhavcopy(DAY1);
  assert.deepEqual(rows, [
    { symbol: 'RELIANCE', turnoverCr: 500 },
    { symbol: 'TCS', turnoverCr: 300 },
    { symbol: 'SMALLCO', turnoverCr: 2 },
  ]);
});

test('parseBhavcopy: throws on an unexpected header', () => {
  assert.throws(() => parseBhavcopy('A,B,C\n1,2,3'), /unexpected bhavcopy header/);
});

test('isNumericSlug distinguishes BSE codes from NSE symbols', () => {
  assert.equal(isNumericSlug('500325'), true);
  assert.equal(isNumericSlug('RELIANCE'), false);
  assert.equal(isNumericSlug('M&M'), false);
  assert.equal(isNumericSlug('BAJAJ-AUTO'), false);
  assert.equal(isNumericSlug(''), false);
});

test('buildTurnoverIndex sums across days; absent day adds nothing', () => {
  const idx = buildTurnoverIndex([parseBhavcopy(DAY1), parseBhavcopy(DAY2)]);
  assert.equal(idx.get('RELIANCE'), 1000); // 500 + 500
  assert.equal(idx.get('TCS'), 600); // 300 + 300
  assert.equal(idx.get('SMALLCO'), 2); // 2 + (absent)
});

test('computeLiquidUniverse: gate, full-window denominator, BSE exclusion', () => {
  const turnoverIndex = buildTurnoverIndex([parseBhavcopy(DAY1), parseBhavcopy(DAY2)]);
  const daysUsed = ['2025-06-02', '2025-05-30']; // 2-day window
  const universe = [
    { name: 'Reliance', slug: 'RELIANCE', cmp: '1' },
    { name: 'TCS', slug: 'tcs' }, // lowercase slug -> matched uppercased
    { name: 'Small', slug: 'SMALLCO' }, // traded only 1 of 2 days
    { name: 'BSEonly', slug: '500325' }, // numeric -> excluded
    { name: 'Ghost', slug: 'GHOST' }, // never traded -> 0
  ];

  const { liquid, debug } = computeLiquidUniverse({ universe, turnoverIndex, daysUsed, threshold: 4 });

  // Pass set
  assert.deepEqual(
    liquid.map((r) => r.slug),
    ['RELIANCE', 'tcs']
  );
  // Faithful average: SMALLCO = (2 + 0) / 2 = 1, NOT 2/1
  const small = debug.sample_failed.find((s) => s.slug === 'SMALLCO');
  assert.equal(small.adtv_30d_cr, 1);

  // Passing row shape
  assert.deepEqual(liquid[0], {
    name: 'Reliance',
    slug: 'RELIANCE',
    cmp: '1',
    adtv_30d_cr: 500,
    days_counted: 2,
    liquidity_source: 'nse',
  });

  // Debug tallies
  assert.equal(debug.universe_in, 5);
  assert.equal(debug.passed, 2);
  assert.equal(debug.failed, 2); // SMALLCO + Ghost
  assert.equal(debug.bse_only_excluded, 1);
  assert.deepEqual(debug.bse_only_slugs, ['500325']);
  assert.deepEqual(debug.days_used, daysUsed);
  // sample_failed sorted by adtv desc (near-misses first); reports the raw slug
  assert.deepEqual(
    debug.sample_failed.map((s) => s.slug),
    ['SMALLCO', 'GHOST']
  );
});

test('round2 helper', () => {
  assert.equal(round2(1 / 3), 0.33);
  assert.equal(round2(10 / 3), 3.33);
  assert.equal(round2(4), 4);
});
