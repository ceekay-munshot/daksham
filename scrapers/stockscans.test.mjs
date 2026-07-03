import { test } from 'node:test';
import assert from 'node:assert/strict';

import { extractIndustry, normSymbol, companyUrl } from './stockscans-classify.mjs';

test('normSymbol: trims + uppercases', () => {
  assert.equal(normSymbol('  grindwell '), 'GRINDWELL');
  assert.equal(normSymbol('RELIANCE'), 'RELIANCE');
  assert.equal(normSymbol(null), '');
});

test('companyUrl: builds the NSE company page URL', () => {
  assert.equal(companyUrl('https://www.stockscans.in', 'RELIANCE'), 'https://www.stockscans.in/company/NSE:RELIANCE');
  assert.equal(companyUrl('https://www.stockscans.in/', 'grindwell'), 'https://www.stockscans.in/company/NSE:GRINDWELL');
});

test('extractIndustry: reads the industry scan link (anchor text, not the mangled href)', () => {
  // The real page shape: label span + a link to /scans/new?industry=… whose href
  // mangles "&" to "_", but the anchor text is clean.
  const html =
    '<span class="companyHeaderDesktop_metaLinkLabel__x">Industry:</span>' +
    '<a class="companyHeaderDesktop_metaLinkValue__y" href="/scans/new?industry=Abrasives _ Grinding Wheels&amp;filters=">Abrasives &amp; Grinding Wheels</a>';
  assert.equal(extractIndustry(html), 'Abrasives & Grinding Wheels');
});

test('extractIndustry: label-adjacent fallback when the scan link class changes', () => {
  const html = '<div><span>Industry:</span><a href="/x">Banks - Private</a></div>';
  assert.equal(extractIndustry(html), 'Banks - Private');
});

test('extractIndustry: no industry present -> null, never throws', () => {
  assert.equal(extractIndustry('<div>no classification here</div>'), null);
  assert.equal(extractIndustry(''), null);
});
