import { test } from 'node:test';
import assert from 'node:assert/strict';

import { bseAnnUrl, bsePdfUrl, parseBseAnnouncements } from './lib/bse.mjs';

test('bseAnnUrl: scrip + date window in BSE params', () => {
  const u = bseAnnUrl('500084', { from: new Date('2025-01-01T00:00:00Z'), to: new Date('2026-06-18T00:00:00Z') });
  assert.match(u, /^https:\/\/api\.bseindia\.com\/BseIndiaAPI\/api\/AnnGetData\/w\?/);
  assert.match(u, /strScrip=500084/);
  assert.match(u, /strPrevDate=20250101/);
  assert.match(u, /strToDate=20260618/);
  assert.match(u, /strType=C/);
});

// A realistic AnnGetData payload: two transcripts (one a duplicate month) + a
// non-transcript results filing that must be excluded.
const ANN = {
  Table: [
    { NEWSSUB: 'Regulation 30 - Transcript of Q4 FY26 Earnings Conference Call', ATTACHMENTNAME: 'older-may.pdf', NEWS_DT: '2026-05-15T18:30:00' },
    { HEADLINE: 'Outcome of Board Meeting - Audited Financial Results', ATTACHMENTNAME: 'results.pdf', NEWS_DT: '2026-05-06T17:00:00' },
    { NEWSSUB: 'Transcript of the earnings call held on Feb 09, 2026', ATTACHMENTNAME: 'feb.pdf', NEWS_DT: '2026-02-10T12:00:00' },
    { NEWSSUB: 'Updated Transcript', ATTACHMENTNAME: 'newer-may.pdf', NEWS_DT: '2026-05-20T10:00:00' },
  ],
};

test('parseBseAnnouncements: transcripts only, newest-first, one per period', () => {
  const out = parseBseAnnouncements(ANN);
  assert.equal(out.length, 2); // May (deduped to newest) + Feb; results filing dropped
  assert.equal(out[0].period, '2026-05');
  assert.equal(out[0].type, 'transcript');
  assert.equal(out[0].url, bsePdfUrl('newer-may.pdf')); // May 20 beats May 15
  assert.equal(out[1].period, '2026-02');
  assert.ok(!out.some((d) => /results\.pdf/.test(d.url))); // non-transcript excluded
});

test('parseBseAnnouncements: empty / no transcripts → []', () => {
  assert.deepEqual(parseBseAnnouncements({ Table: [] }), []);
  assert.deepEqual(parseBseAnnouncements({ Table: [{ NEWSSUB: 'Financial Results', ATTACHMENTNAME: 'x.pdf', NEWS_DT: '2026-01-01' }] }), []);
  assert.deepEqual(parseBseAnnouncements(null), []);
});

test('parseBseAnnouncements: tolerant of field-name variants', () => {
  const out = parseBseAnnouncements({ table: [{ HEADLINE: 'Earnings Call Transcript', AttachmentName: 'v.pdf', DissemDT: '2026-04-01T00:00:00' }] });
  assert.equal(out.length, 1);
  assert.equal(out[0].url, bsePdfUrl('v.pdf'));
  assert.equal(out[0].period, '2026-04');
});
