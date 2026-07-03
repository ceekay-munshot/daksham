import { test } from 'node:test';
import assert from 'node:assert/strict';

import { bankRatioSeries, extractBankMetrics, isFinancial } from './bank-metrics.mjs';

// A minimal Screener-shaped ratios table: a label cell + year-value cells.
const ROW = (label, ...vals) =>
  `<tr><td class="text">${label}</td>` + vals.map((v, i) => `<td class="${i === 0 ? 'highlight-cell' : ''}">${v}</td>`).join('') + '</tr>';
const TABLE = `<table>${ROW('Gross NPA %', '4.37%', '4.91%', '4.66%')}${ROW('Net NPA %', '2.36%', '2.51%')}${ROW(
  'Financing Margin %',
  '5%',
  '6%'
)}${ROW('Deposits', '24,115', '27,158')}</table>`;

test('bankRatioSeries: reads a ratio row as a newest-first number series', () => {
  assert.deepEqual(bankRatioSeries(TABLE, 'Gross NPA %'), [4.37, 4.91, 4.66]);
  assert.deepEqual(bankRatioSeries(TABLE, 'Deposits'), [24115, 27158]); // strips commas
  assert.equal(bankRatioSeries(TABLE, 'Gross NPA %')[0], 4.37); // [0] = oldest (Screener prints oldest→newest)
});

test('bankRatioSeries: case-insensitive label, missing row -> null', () => {
  assert.deepEqual(bankRatioSeries(TABLE, 'gross npa %'), [4.37, 4.91, 4.66]);
  assert.equal(bankRatioSeries(TABLE, 'Return on Equity'), null);
  assert.equal(bankRatioSeries('', 'Gross NPA %'), null);
});

test('extractBankMetrics: latest (last, newest) values + oldest→newest series', () => {
  const m = extractBankMetrics(TABLE);
  assert.equal(m.gross_npa_pct, 4.66); // last = newest period
  assert.equal(m.net_npa_pct, 2.51);
  assert.equal(m.financing_margin_pct, 6);
  assert.deepEqual(m.gross_npa_series, [4.37, 4.91, 4.66]);
});

test('extractBankMetrics: no bank rows -> nulls, never throws', () => {
  const m = extractBankMetrics('<table><tr><td class="text">Sales</td><td>100</td></tr></table>');
  assert.equal(m.gross_npa_pct, null);
  assert.equal(m.financing_margin_pct, null);
});

test('isFinancial: matches banks / NBFCs / insurers, not manufacturers', () => {
  assert.ok(isFinancial({ broad_sector: 'Financial Services', industry: 'Private Sector Bank' }));
  assert.ok(isFinancial({ industry: 'NBFC' }));
  assert.ok(!isFinancial({ broad_sector: 'Consumer', industry: 'Abrasives & Grinding Wheels' }));
});
