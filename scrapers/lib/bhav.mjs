// Pure parsing + liquidity computation for the NSE bhavcopy volume gate.
//
// No network or filesystem here, so the CSV parsing and the avg-daily-traded-value
// math are unit-testable against fixtures.

// Round to 2 decimals.
export function round2(n) {
  return Math.round(n * 100) / 100;
}

// A Screener slug is a BSE-only company when it is purely numeric (a BSE scrip
// code); otherwise it is treated as an NSE symbol.
export function isNumericSlug(slug) {
  return /^\d+$/.test(String(slug ?? '').trim());
}

// Parse an NSE "sec_bhavdata_full" CSV. Returns EQ-series rows as
// { symbol, turnoverCr }. Headers and values are trimmed (NSE pads with spaces).
// turnoverCr = TURNOVER_LACS / 100 (lakhs -> crore).
export function parseBhavcopy(csvText) {
  const lines = String(csvText ?? '').split(/\r?\n/);

  let h = 0;
  while (h < lines.length && lines[h].trim() === '') h++;
  if (h >= lines.length) return [];

  const header = lines[h].split(',').map((c) => c.trim());
  const iSym = header.indexOf('SYMBOL');
  const iSer = header.indexOf('SERIES');
  const iTurn = header.indexOf('TURNOVER_LACS');
  if (iSym < 0 || iSer < 0 || iTurn < 0) {
    throw new Error(`unexpected bhavcopy header: ${header.join(',')}`);
  }
  const maxIdx = Math.max(iSym, iSer, iTurn);

  const rows = [];
  for (let i = h + 1; i < lines.length; i++) {
    if (lines[i].trim() === '') continue;
    const cells = lines[i].split(',');
    if (cells.length <= maxIdx) continue;
    if ((cells[iSer] || '').trim() !== 'EQ') continue; // EQ series only

    const symbol = (cells[iSym] || '').trim().toUpperCase();
    const turnoverLacs = Number((cells[iTurn] || '').trim().replace(/,/g, ''));
    if (!symbol || !Number.isFinite(turnoverLacs)) continue;

    rows.push({ symbol, turnoverCr: turnoverLacs / 100 });
  }
  return rows;
}

// Sum turnover (₹ Cr) per symbol across all collected days. `days` is an array of
// row arrays (one per trading day). A symbol absent from a day simply does not
// add to its sum — i.e. it counts as 0 turnover for that day.
export function buildTurnoverIndex(days) {
  const sums = new Map();
  for (const rows of days) {
    for (const { symbol, turnoverCr } of rows) {
      sums.set(symbol, (sums.get(symbol) || 0) + turnoverCr);
    }
  }
  return sums;
}

// Apply the volume gate to the universe.
//
// adtv_30d_cr = (sum of the symbol's turnover across ALL collected days) /
//               (number of collected days)
// The denominator is the full window, so a day the symbol did not trade counts
// as 0 — the faithful "average over the last N days".
//
// Returns { liquid, debug }.
export function computeLiquidUniverse({ universe, turnoverIndex, daysUsed, threshold = 4 }) {
  const daysCounted = daysUsed.length;
  const liquid = [];
  const failedSamples = [];
  const bseSlugs = [];
  let passed = 0;
  let failed = 0;

  for (const row of universe) {
    const slug = String(row.slug ?? '').trim();

    if (isNumericSlug(slug)) {
      bseSlugs.push(slug); // BSE-only: no NSE turnover, excluded for now
      continue;
    }

    const symbol = slug.toUpperCase();
    const sum = turnoverIndex.get(symbol) || 0;
    const adtv = round2(daysCounted ? sum / daysCounted : 0);

    if (adtv >= threshold) {
      liquid.push({ ...row, adtv_30d_cr: adtv, days_counted: daysCounted, liquidity_source: 'nse' });
      passed++;
    } else {
      failed++;
      failedSamples.push({ slug, adtv_30d_cr: adtv });
    }
  }

  failedSamples.sort((a, b) => b.adtv_30d_cr - a.adtv_30d_cr); // near-misses first

  const debug = {
    generated_at: new Date().toISOString(),
    threshold_cr: threshold,
    days_used: daysUsed,
    universe_in: universe.length,
    passed,
    failed,
    bse_only_excluded: bseSlugs.length,
    bse_only_slugs: bseSlugs,
    sample_failed: failedSamples.slice(0, 20),
  };

  return { liquid, debug };
}
