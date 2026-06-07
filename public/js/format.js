// Formatting helpers + verdict-pill rendering. Pure (no DOM mutation).

export const esc = (s) =>
  String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const finite = (n) => {
  const v = Number(n);
  return Number.isFinite(v) ? v : null;
};

// ₹ Cr with Indian digit grouping.
export function inrCr(n) {
  const v = finite(n);
  if (v === null) return '—';
  return `₹${new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 }).format(Math.round(v))} Cr`;
}

// A share price.
export function price(n) {
  const v = finite(n);
  if (v === null) return '—';
  return `₹${new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2 }).format(v)}`;
}

export const mult = (n) => {
  const v = finite(n);
  return v === null ? '—' : `${v.toFixed(1)}x`;
};
export const pct = (n) => {
  const v = finite(n);
  return v === null ? '—' : `${v.toFixed(1)}%`;
};
export const dec = (n, d = 1) => {
  const v = finite(n);
  return v === null ? '—' : v.toFixed(d);
};

// Format a raw metric value by its key (units differ).
export function fmtMetric(key, value) {
  if (value === '' || value == null) return '—';
  switch (key) {
    case 'market_cap':
      return inrCr(value);
    case 'pe':
    case 'pb':
    case 'ev_ebitda':
    case 'mcap_to_sales':
      return mult(value);
    case 'roce':
    case 'roe':
    case 'promoter_holding':
    case 'institutional_holding':
    case 'sales_cagr_3y':
    case 'gross_margin_latest':
      return pct(value);
    case 'gross_margin_3y_increase': {
      const v = Number(value);
      return Number.isFinite(v) ? `${v >= 0 ? '+' : ''}${v.toFixed(1)}pp` : '—';
    }
    default:
      return esc(String(value));
  }
}

// Verdict pill HTML for a pass_fail / deferred param.
export function pill(p) {
  if (!p) return '';
  if (p.output_type === 'deferred') return `<span class="pill pill-soon" title="${esc(p.note)}">Coming soon</span>`;
  switch (p.verdict) {
    case 'PASS':
      return '<span class="pill pill-pass">PASS</span>';
    case 'FAIL':
      return '<span class="pill pill-fail">FAIL</span>';
    case 'NA':
      return p.note.startsWith('Not applicable')
        ? `<span class="pill pill-na" title="${esc(p.note)}">N/A</span>`
        : `<span class="pill pill-pending" title="${esc(p.note)}">Pending data</span>`;
    default:
      return '';
  }
}
