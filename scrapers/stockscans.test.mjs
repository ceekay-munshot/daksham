import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseSitemap, symbolFromUrl, normSymbol, extractClassification } from './stockscans-classify.mjs';

test('parseSitemap: pulls every <loc> URL', () => {
  const xml = `<?xml version="1.0"?><urlset>
    <url><loc>https://www.stockscans.in/company/NSE:RELIANCE</loc></url>
    <url><loc>https://www.stockscans.in/company/NSE:TCS</loc></url>
  </urlset>`;
  const urls = parseSitemap(xml);
  assert.equal(urls.length, 2);
  assert.ok(urls[0].endsWith('NSE:RELIANCE'));
});

test('parseSitemap: empty / garbage is safe', () => {
  assert.deepEqual(parseSitemap(''), []);
  assert.deepEqual(parseSitemap('<urlset></urlset>'), []);
});

test('symbolFromUrl: parses NSE / BSE symbols', () => {
  assert.deepEqual(symbolFromUrl('https://www.stockscans.in/company/NSE:RELIANCE'), { exchange: 'NSE', symbol: 'RELIANCE' });
  assert.deepEqual(symbolFromUrl('https://www.stockscans.in/index/BSE:BSAUTO'), { exchange: 'BSE', symbol: 'BSAUTO' });
  assert.deepEqual(symbolFromUrl('/company/nse:awl'), { exchange: 'NSE', symbol: 'AWL' });
});

test('symbolFromUrl: null when no exchange:symbol token', () => {
  assert.equal(symbolFromUrl('https://www.stockscans.in/pricing'), null);
  assert.equal(symbolFromUrl(''), null);
});

test('normSymbol: trims + uppercases', () => {
  assert.equal(normSymbol('  reliance '), 'RELIANCE');
  assert.equal(normSymbol('GRINDWELL'), 'GRINDWELL');
  assert.equal(normSymbol(null), '');
});

test('extractClassification: reads a label/value layout', () => {
  const html = `<div class="row"><span class="k">Sector</span><span class="v">Financial Services</span></div>
    <div class="row"><span class="k">Industry</span><span class="v">Private Sector Bank</span></div>`;
  const cls = extractClassification(html);
  assert.equal(cls.sector, 'Financial Services');
  assert.equal(cls.industry, 'Private Sector Bank');
});

test('extractClassification: missing labels -> nulls, never throws', () => {
  const cls = extractClassification('<div>no classification here</div>');
  assert.equal(cls.industry, null);
  assert.equal(cls.sector, null);
});
