// Pure parsing for Screener's "Documents / Concalls" section + manifest helpers.
// cheerio-only (no network/fs), so link extraction and selection are unit-testable.

import * as cheerio from 'cheerio';

const collapse = (s) => (s || '').replace(/\s+/g, ' ').trim();

const MONTHS = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

// Parse a "Mon YYYY" (e.g. "Aug 2024", "Sept. 2023") into { y, m, period:"YYYY-MM" }.
export function parseMonthYear(text) {
  const m = String(text || '').match(
    /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{4})\b/i
  );
  if (!m) return null;
  const mon = MONTHS[m[1].toLowerCase().slice(0, 3)];
  return { y: Number(m[2]), m: mon, period: `${m[2]}-${String(mon).padStart(2, '0')}` };
}

export function absolutize(url) {
  const u = String(url || '').trim();
  if (!u) return '';
  if (/^https?:\/\//i.test(u)) return u;
  if (u.startsWith('//')) return `https:${u}`;
  if (u.startsWith('/')) return `https://www.screener.in${u}`;
  return u;
}

// Locate the concall rows on a company page, tolerating layout variants.
function concallRows($) {
  const explicit = $('.concalls ul li, .concalls .list-links li');
  if (explicit.length) return explicit;

  // A heading mentioning "Concall" followed by a list.
  let found = $();
  $('h2, h3, h4, .sub, strong').each((_, h) => {
    if (found.length) return;
    if (/concall/i.test($(h).text())) {
      const ul = $(h).nextAll('ul').first();
      if (ul.length) found = ul.find('li');
    }
  });
  if (found.length) return found;

  // Last resort: any list item that links a Transcript / PPT.
  return $('li').filter((_, li) => /transcript|ppt/i.test($(li).text()));
}

// Parse the documents section into dated transcript + ppt links (newest first).
export function parseDocuments(html) {
  const $ = cheerio.load(html);
  $('script, style, noscript').remove();

  const transcripts = [];
  const ppts = [];

  concallRows($).each((_, li) => {
    const $li = $(li);
    const date = parseMonthYear(collapse($li.text()));
    if (!date) return;
    $li.find('a, button').each((__, el) => {
      const label = collapse($(el).text()).toLowerCase();
      const href = $(el).attr('href') || $(el).attr('data-href') || '';
      if (!href) return;
      if (/transcript/.test(label) && !/raw/.test(label)) {
        transcripts.push({ ...date, url: href });
      } else if (/^ppt\b|presentation/.test(label)) {
        ppts.push({ ...date, url: href });
      }
    });
  });

  const newestFirst = (a, b) => b.y - a.y || b.m - a.m;
  transcripts.sort(newestFirst);
  ppts.sort(newestFirst);
  return { transcripts, ppts };
}

// Pick the last `maxTranscripts` transcripts (one per period) + the latest PPT.
export function selectDocs(parsed, { maxTranscripts = 4 } = {}) {
  const out = [];
  const seen = new Set();
  for (const t of parsed.transcripts) {
    if (seen.has(t.period)) continue;
    seen.add(t.period);
    out.push({ type: 'transcript', period: t.period, url: absolutize(t.url) });
    if (seen.size >= maxTranscripts) break;
  }
  if (parsed.ppts.length) {
    const p = parsed.ppts[0];
    out.push({ type: 'ppt', period: p.period, url: absolutize(p.url) });
  }
  return out;
}

// Filesystem-safe slug for the cache path.
export const slugSafe = (slug) => String(slug || '').replace(/[^A-Za-z0-9._-]/g, '_');

export const cachePath = (slug, type, period) => `cache/docs/${slugSafe(slug)}/${type}-${period}.txt`;

// Build a manifest entry. ocr_needed flags a scanned/image PDF (no text extracted).
export function manifestEntry(doc, text, slug) {
  const chars = String(text || '').trim().length;
  return {
    type: doc.type,
    period: doc.period,
    source: doc.url,
    cached_path: cachePath(slug, doc.type, doc.period),
    chars,
    ocr_needed: chars === 0,
  };
}
