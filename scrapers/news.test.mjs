import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseNewsRss,
  buildNewsInput,
  newsQuery,
  newsRssUrl,
  newsPrompt,
  shapeFactors,
  shapePulse,
  NEWS_SCHEMA,
  FACTOR_KEYS,
} from './lib/news.mjs';

test('shapePulse: clean summary, clamped sentiment + events, null when empty', () => {
  const p = shapePulse({ summary: '  Won a big order; expanding capacity.  ', sentiment: 'positive', events: ['order_win', 'expansion', 'bogus', 'expansion'] });
  assert.equal(p.summary, 'Won a big order; expanding capacity.');
  assert.equal(p.sentiment, 'positive');
  assert.deepEqual(p.events, ['order_win', 'expansion']); // unknown dropped, deduped, capped
  assert.equal(shapePulse({ summary: '' }), null); // no summary → no pulse
  assert.equal(shapePulse({ summary: 'x', sentiment: 'wat' }).sentiment, 'neutral'); // bad enum → neutral
});

test('NEWS_SCHEMA: the 8 factors plus a pulse', () => {
  assert.ok(NEWS_SCHEMA.required.includes('pulse'));
  assert.ok(NEWS_SCHEMA.required.includes('competition'));
  assert.equal(NEWS_SCHEMA.properties.pulse.properties.sentiment.enum.length, 3);
});

// A trimmed Google News RSS feed: "Headline - Source" titles, RFC-822 dates, a
// <source> element, and a duplicate item (same headline) to exercise dedup.
const FIXTURE = `<?xml version="1.0"?>
<rss version="2.0"><channel>
  <title>"Acme Industries" - Google News</title>
  <item>
    <title>Acme Industries wins large export order amid anti-dumping duty on Chinese imports - Business Standard</title>
    <link>https://news.google.com/rss/articles/AAA</link>
    <pubDate>Mon, 15 Jun 2026 06:30:00 GMT</pubDate>
    <description><![CDATA[<a href="x">Acme Industries wins large export order</a>]]></description>
    <source url="https://business-standard.com">Business Standard</source>
  </item>
  <item>
    <title>SEBI issues show-cause notice to Acme Industries promoters - Moneycontrol</title>
    <link>https://news.google.com/rss/articles/BBB</link>
    <pubDate>Wed, 10 Jun 2026 09:00:00 GMT</pubDate>
    <source url="https://moneycontrol.com">Moneycontrol</source>
  </item>
  <item>
    <title>Acme Industries wins large export order amid anti-dumping duty on Chinese imports - Business Standard</title>
    <link>https://news.google.com/rss/articles/CCC</link>
    <pubDate>Sun, 14 Jun 2026 06:30:00 GMT</pubDate>
    <source url="https://business-standard.com">Business Standard</source>
  </item>
</channel></rss>`;

test('parseNewsRss: items, source stripped from title, ISO date', () => {
  const items = parseNewsRss(FIXTURE);
  assert.equal(items.length, 3);
  assert.equal(items[0].title, 'Acme Industries wins large export order amid anti-dumping duty on Chinese imports');
  assert.equal(items[0].source, 'Business Standard');
  assert.equal(items[0].date, '2026-06-15');
  assert.equal(items[1].title, 'SEBI issues show-cause notice to Acme Industries promoters');
  assert.equal(items[1].date, '2026-06-10');
});

test('parseNewsRss: empty / junk input → []', () => {
  assert.deepEqual(parseNewsRss(''), []);
  assert.deepEqual(parseNewsRss('<rss></rss>'), []);
});

test('buildNewsInput: newest-first, deduped, latest date', () => {
  const r = buildNewsInput(parseNewsRss(FIXTURE));
  assert.equal(r.count, 2); // the duplicate headline collapses
  assert.equal(r.latest, '2026-06-15');
  // newest line first
  assert.match(r.text.split('\n')[0], /2026-06-15 · Business Standard — Acme Industries wins/);
  assert.match(r.text, /SEBI issues show-cause/);
});

test('buildNewsInput: respects the char cap', () => {
  const many = Array.from({ length: 100 }, (_, i) => ({ title: `Headline number ${i} about Acme`, source: 'X', date: '2026-06-01' }));
  const r = buildNewsInput(many, { maxChars: 300 });
  assert.ok(r.text.length <= 300, `len ${r.text.length} <= 300`);
});

test('newsQuery / newsRssUrl: quoted name, recency window, India locale', () => {
  assert.equal(newsQuery('Acme Industries Ltd', { days: 90 }), '"Acme Industries Ltd" when:90d');
  const u = newsRssUrl('Acme Industries Ltd');
  assert.match(u, /^https:\/\/news\.google\.com\/rss\/search\?q=/);
  assert.match(u, /gl=IN/);
  assert.match(u, /when%3A60d/); // default 60d, url-encoded
});

test('newsPrompt: carries all 8 factor keys + the headlines', () => {
  const { text } = buildNewsInput(parseNewsRss(FIXTURE));
  const p = newsPrompt('Acme Industries', 'Auto Components', text);
  for (const k of FACTOR_KEYS) assert.ok(p.includes(k), `prompt mentions ${k}`);
  assert.match(p, /anti-dumping duty/);
});

test('shapeFactors (reused) still snaps news scores into the trend band', () => {
  const model = Object.fromEntries(FACTOR_KEYS.map((k) => [k, { score: '5', trend: 'worsening', note: 'x', confidence: 'low' }]));
  const v = shapeFactors(model);
  for (const k of FACTOR_KEYS) assert.ok(v[k].score >= 0 && v[k].score <= 2, `${k} in worsening band`);
});
