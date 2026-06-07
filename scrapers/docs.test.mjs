import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseDocuments,
  selectDocs,
  parseMonthYear,
  manifestEntry,
  cachePath,
  slugSafe,
  absolutize,
} from './lib/docs.mjs';

// A Screener "Concalls" block: dated rows with Transcript / Notes / PPT links.
// 5 transcripts (one relative href), 2 PPTs, and a raw-transcript link to ignore.
const FIXTURE = `<!doctype html><html><body>
  <div class="concalls">
    <h3>Concalls</h3>
    <ul class="list-links">
      <li><div class="ink-600">Aug 2024</div>
        <a href="https://nsearchives.nseindia.com/t-aug24.pdf">Transcript</a>
        <a href="https://x/notes.pdf">Notes</a>
        <a href="https://x/p-aug24.pdf">PPT</a></li>
      <li><div class="ink-600">May 2024</div>
        <a href="/company/source/t-may24.pdf">Transcript</a></li>
      <li><div class="ink-600">Feb 2024</div>
        <a href="https://x/t-feb24.pdf">Transcript</a>
        <a href="https://x/p-feb24.pdf">PPT</a>
        <a href="https://x/raw.pdf">Raw Transcript</a></li>
      <li><div class="ink-600">Nov 2023</div>
        <a href="https://x/t-nov23.pdf">Transcript</a></li>
      <li><div class="ink-600">Aug 2023</div>
        <a href="https://x/t-aug23.pdf">Transcript</a></li>
    </ul>
  </div>
</body></html>`;

test('parseMonthYear', () => {
  assert.deepEqual(parseMonthYear('Aug 2024'), { y: 2024, m: 8, period: '2024-08' });
  assert.deepEqual(parseMonthYear('Sept. 2023'), { y: 2023, m: 9, period: '2023-09' });
  assert.equal(parseMonthYear('no date here'), null);
});

test('absolutize', () => {
  assert.equal(absolutize('https://x/a.pdf'), 'https://x/a.pdf');
  assert.equal(absolutize('/y/b.pdf'), 'https://www.screener.in/y/b.pdf');
  assert.equal(absolutize('//z/c.pdf'), 'https://z/c.pdf');
});

test('parseDocuments: dated transcripts + ppts, newest first, raw ignored', () => {
  const { transcripts, ppts } = parseDocuments(FIXTURE);
  assert.deepEqual(transcripts.map((t) => t.period), ['2024-08', '2024-05', '2024-02', '2023-11', '2023-08']);
  assert.deepEqual(ppts.map((p) => p.period), ['2024-08', '2024-02']);
});

test('selectDocs: last 4 transcripts + latest ppt, absolutized', () => {
  const docs = selectDocs(parseDocuments(FIXTURE));
  const ts = docs.filter((d) => d.type === 'transcript');
  const pp = docs.filter((d) => d.type === 'ppt');
  assert.deepEqual(ts.map((d) => d.period), ['2024-08', '2024-05', '2024-02', '2023-11']); // 4, drops oldest
  assert.equal(pp.length, 1);
  assert.equal(pp[0].period, '2024-08');
  // relative transcript href was absolutized
  assert.equal(ts.find((d) => d.period === '2024-05').url, 'https://www.screener.in/company/source/t-may24.pdf');
});

test('parseDocuments: no concalls → empty', () => {
  const { transcripts, ppts } = parseDocuments('<html><body><p>nothing</p></body></html>');
  assert.equal(transcripts.length, 0);
  assert.equal(ppts.length, 0);
  assert.deepEqual(selectDocs({ transcripts, ppts }), []);
});

test('cachePath + slugSafe', () => {
  assert.equal(cachePath('RELIANCE', 'transcript', '2024-08'), 'cache/docs/RELIANCE/transcript-2024-08.txt');
  assert.equal(cachePath('M&M', 'ppt', '2024-03'), 'cache/docs/M_M/ppt-2024-03.txt');
  assert.equal(slugSafe('BAJAJ-AUTO'), 'BAJAJ-AUTO');
});

test('manifestEntry: chars + ocr_needed flag', () => {
  const doc = { type: 'transcript', period: '2024-08', url: 'https://x/t.pdf' };
  const ok = manifestEntry(doc, '  hello world  ', 'ACME');
  assert.deepEqual(ok, {
    type: 'transcript',
    period: '2024-08',
    source: 'https://x/t.pdf',
    cached_path: 'cache/docs/ACME/transcript-2024-08.txt',
    chars: 11,
    ocr_needed: false,
  });
  // empty text (scanned/image PDF) → ocr_needed
  const img = manifestEntry(doc, '', 'ACME');
  assert.equal(img.chars, 0);
  assert.equal(img.ocr_needed, true);
});
