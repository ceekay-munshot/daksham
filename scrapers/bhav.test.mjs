import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseBhavcopy,
  parseBseBhavcopy,
  isNumericSlug,
  buildTurnoverIndex,
  buildBseTurnoverIndex,
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

// BSE bhavcopy: current UDiFF format (FinInstrmId / TtlTrfVal, ₹) and the legacy
// SC_CODE / NET_TURNOV format. Value in ₹ -> Cr is /1e7.
const BSE_UDIFF = [
  'TradDt,Sgmt,FinInstrmId,ISIN,TckrSymb,SctySrs,ClsPric,TtlTradgVol,TtlTrfVal',
  '2026-07-13,CM,500325,INE002A01018,RELIANCE,EQ,1400,1000,750000000', // 75 Cr
  '2026-07-13,CM,590003,INE123A01011,SMALLBSE,B,50,100,30000000', // 3 Cr
  '2026-07-13,CM,XYZ,INE999,BADCODE,EQ,1,1,1', // non-numeric scrip -> ignored
].join('\n');

const BSE_LEGACY = [
  'SC_CODE,SC_NAME,SC_GROUP,SC_TYPE,CLOSE,NO_OF_SHRS,NET_TURNOV,ISIN_CODE',
  '532540,TCS,A,Q,3800,1000,300000000,INE467B01029', // 30 Cr
].join('\n');

test('parseBseBhavcopy: UDiFF + legacy formats, numeric scrip only, ₹->Cr', () => {
  assert.deepEqual(parseBseBhavcopy(BSE_UDIFF), [
    { scrip: '500325', turnoverCr: 75 },
    { scrip: '590003', turnoverCr: 3 },
  ]);
  assert.deepEqual(parseBseBhavcopy(BSE_LEGACY), [{ scrip: '532540', turnoverCr: 30 }]);
});

test('parseBseBhavcopy: throws on an unexpected header', () => {
  assert.throws(() => parseBseBhavcopy('A,B,C\n1,2,3'), /unexpected BSE bhavcopy header/);
});

test('buildBseTurnoverIndex sums by scrip across days', () => {
  const idx = buildBseTurnoverIndex([parseBseBhavcopy(BSE_UDIFF), parseBseBhavcopy(BSE_UDIFF)]);
  assert.equal(idx.get('500325'), 150); // 75 + 75
  assert.equal(idx.get('590003'), 6); // 3 + 3
});

test('computeLiquidUniverse: BSE-only names gated when a BSE index is supplied', () => {
  const turnoverIndex = buildTurnoverIndex([parseBhavcopy(DAY1)]);
  const bseTurnoverIndex = buildBseTurnoverIndex([parseBseBhavcopy(BSE_UDIFF), parseBseBhavcopy(BSE_UDIFF)]);
  const daysUsed = ['2026-07-13', '2026-07-12']; // 2-day window
  const universe = [
    { name: 'Reliance NSE', slug: 'RELIANCE' }, // NSE 500 Cr/day -> pass
    { name: 'Reliance BSE', slug: '500325' }, // BSE 150/2 = 75 -> pass (bse)
    { name: 'Small BSE', slug: '590003' }, // BSE 6/2 = 3 -> fail (< 4)
    { name: 'No BSE data', slug: '999999' }, // absent -> 0 -> fail
  ];

  const { liquid, debug } = computeLiquidUniverse({ universe, turnoverIndex, bseTurnoverIndex, daysUsed, threshold: 4 });

  assert.deepEqual(liquid.map((r) => [r.slug, r.liquidity_source]), [
    ['RELIANCE', 'nse'],
    ['500325', 'bse'],
  ]);
  assert.equal(debug.bse_included, true);
  assert.equal(debug.bse_passed, 1);
  assert.equal(debug.bse_failed, 2); // 590003 + 999999
  assert.equal(debug.bse_only_excluded, 0); // nothing excluded when BSE data is present
});

test('computeLiquidUniverse: BSE ADTV averages over BSE days collected, not the wider NSE window', () => {
  const turnoverIndex = buildTurnoverIndex([parseBhavcopy(DAY1)]);
  // 150 Cr for 500325 summed over 2 BSE days, but the NSE window is 3 days (one BSE
  // fetch failed). ADTV must be 150/2 = 75, not 150/3 = 50 (the old full-window bug).
  const bseTurnoverIndex = buildBseTurnoverIndex([parseBseBhavcopy(BSE_UDIFF), parseBseBhavcopy(BSE_UDIFF)]);
  const daysUsed = ['2026-07-13', '2026-07-12', '2026-07-11'];
  const universe = [{ name: 'Reliance BSE', slug: '500325' }];

  const { liquid } = computeLiquidUniverse({ universe, turnoverIndex, bseTurnoverIndex, daysUsed, bseDaysCount: 2, threshold: 4 });
  assert.equal(liquid.length, 1);
  assert.equal(liquid[0].adtv_30d_cr, 75);
  assert.equal(liquid[0].days_counted, 2);
});

test('computeLiquidUniverse: without a BSE index, BSE-only names stay excluded', () => {
  const turnoverIndex = buildTurnoverIndex([parseBhavcopy(DAY1)]);
  const universe = [{ slug: 'RELIANCE' }, { slug: '500325' }];
  const { liquid, debug } = computeLiquidUniverse({ universe, turnoverIndex, daysUsed: ['2026-07-13'], threshold: 4 });
  assert.deepEqual(liquid.map((r) => r.slug), ['RELIANCE']);
  assert.equal(debug.bse_included, false);
  assert.equal(debug.bse_only_excluded, 1);
  assert.deepEqual(debug.bse_only_slugs, ['500325']);
});

test('round2 helper', () => {
  assert.equal(round2(1 / 3), 0.33);
  assert.equal(round2(10 / 3), 3.33);
  assert.equal(round2(4), 4);
});
