import { test } from 'node:test';
import assert from 'node:assert/strict';

import { claimsFromParams, verifyPrompt, verifySchema, shapeVerification, verifyStats } from './lib/verify.mjs';

const params = {
  guidance_revenue: { key: 'guidance_revenue', label: 'Revenue guidance', verdict: 'DISCLOSED', value: '25% growth FY26', note: 'mgmt expects 25%' },
  order_book: { key: 'order_book', label: 'Order book', verdict: 'PASS', value: '', note: 'order book up' },
  mgmt_tone: { key: 'mgmt_tone', label: 'Tone', verdict: 'NA', note: 'not discussed' },
};

test('claimsFromParams: only non-NA verdicts become claims', () => {
  const c = claimsFromParams(params);
  assert.equal(c.length, 2);
  assert.deepEqual(c.map((x) => x.key).sort(), ['guidance_revenue', 'order_book']);
});

test('verifyPrompt + verifySchema carry the claim keys + source', () => {
  const claims = claimsFromParams(params);
  const p = verifyPrompt(claims, 'Management said we expect 25% growth in FY26.');
  assert.match(p, /SOURCE EXCERPTS/);
  assert.match(p, /guidance_revenue/);
  assert.match(p, /25% growth in FY26/);
  const s = verifySchema(claims);
  assert.deepEqual(s.required.sort(), ['guidance_revenue', 'order_book']);
  assert.equal(s.properties.order_book.properties.supported.type, 'boolean');
});

test('shapeVerification: verified ONLY with supported=true AND a quote', () => {
  const claims = claimsFromParams(params);
  const v = shapeVerification(
    {
      guidance_revenue: { supported: true, quote: 'We expect 25% growth in FY26.' },
      order_book: { supported: true, quote: '' }, // supported but no quote → not verified
    },
    claims
  );
  assert.equal(v.guidance_revenue.verified, true);
  assert.match(v.guidance_revenue.quote, /25% growth/);
  assert.equal(v.order_book.verified, false);
  assert.equal(v.order_book.quote, '');
  assert.deepEqual(verifyStats(v), { checked: 2, verified: 1 });
});

test('shapeVerification: unsupported / missing keys → not verified', () => {
  const claims = claimsFromParams(params);
  const v = shapeVerification({ guidance_revenue: { supported: false, quote: 'x' } }, claims);
  assert.equal(v.guidance_revenue.verified, false);
  assert.equal(v.order_book.verified, false); // key absent → not verified
});
