// BSE corporate-announcements fallback for the doc harvester.
//
// When Screener lists no concall TRANSCRIPT for a company, look on BSE directly:
// query the announcements API for the scrip code and keep filings whose subject
// says "transcript". Pure core (no network) — build the API URL and parse the
// JSON into the same doc shape selectDocs() produces. The fetch lives in the
// harvester (logged-in browser context, for headers/cookies). BSE can't be
// reached from the dev sandbox, so this is verified by a smoke-test run in CI.

const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;

// Announcement API for one scrip over a date window (default: the last ~2 years).
export function bseAnnUrl(scrip, { from, to, days = 730 } = {}) {
  const toD = to || new Date();
  const fromD = from || new Date(toD.getTime() - days * 86400000);
  const q = new URLSearchParams({
    pageno: '1',
    strCat: '-1',
    subcategory: '-1',
    strType: 'C',
    strSearch: 'P',
    strScrip: String(scrip || '').trim(),
    strPrevDate: ymd(fromD),
    strToDate: ymd(toD),
  });
  return `https://api.bseindia.com/BseIndiaAPI/api/AnnGetData/w?${q.toString()}`;
}

export const bsePdfUrl = (attachment) =>
  `https://www.bseindia.com/stockinfo/AnnPdfOpen.aspx?Pname=${String(attachment || '').trim()}`;

const TRANSCRIPT_RE = /transcript/i;
// BSE uses different field names across endpoints — check them all.
const subjectOf = (r) => [r.NEWSSUB, r.HEADLINE, r.NEWSSUBSTART, r.MORE, r.SUBJECT].filter(Boolean).join(' • ');
const attachmentOf = (r) => r.ATTACHMENTNAME || r.Attachmentname || r.AttachmentName || r.ATTACHMENT || '';
const dateOf = (r) => r.NEWS_DT || r.News_dt || r.DissemDT || r.DT_TM || '';
const periodOf = (dt) => {
  const d = new Date(dt);
  return Number.isNaN(d.getTime()) ? '' : `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
};

// Parse the AnnGetData JSON → transcript doc entries (newest first, one per
// period, capped). Tolerant of BSE's field-name variants and response wrapping.
export function parseBseAnnouncements(json, { max = 4 } = {}) {
  const rows = (json && (json.Table || json.table)) || (Array.isArray(json) ? json : []);
  const ranked = (rows || [])
    .filter((r) => r && TRANSCRIPT_RE.test(subjectOf(r)) && attachmentOf(r))
    .sort((a, b) => String(dateOf(b)).localeCompare(String(dateOf(a))));

  const out = [];
  const seen = new Set();
  for (const r of ranked) {
    const period = periodOf(dateOf(r));
    if (!period || seen.has(period)) continue;
    seen.add(period);
    out.push({ type: 'transcript', period, url: bsePdfUrl(attachmentOf(r)) });
    if (out.length >= max) break;
  }
  return out;
}
