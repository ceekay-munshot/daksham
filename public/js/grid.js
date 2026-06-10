// Master grid: sortable header, company rows with sector chip, valuation cluster,
// and a compact "green signals" visual.

import { CHECK_KEYS } from './evaluate.mjs';
import { esc, inrCr, mult } from './format.js';
import { sectorChip } from './sectors.js';

export const COLS = [
  { key: 'name', label: 'Company', type: 'str', cls: '' },
  { key: 'mcap', label: 'Market Cap', type: 'num', cls: 'num' },
  { key: 'pe', label: 'P/E', type: 'num', cls: 'num' },
  { key: 'pb', label: 'P/B', type: 'num', cls: 'num' },
  { key: 'evEbitda', label: 'EV/EBITDA', type: 'num', cls: 'num' },
  { key: 'mcapSales', label: 'M-Cap/Sales', type: 'num', cls: 'num hide-sm' },
  { key: 'passCount', label: 'Signals', type: 'num', cls: 'num' },
];

const muted = '<span class="cell-muted">—</span>';

export function headHtml(sort) {
  return `<tr>${COLS.map((c) => {
    const sorted = sort.key === c.key;
    const ic = sorted ? (sort.dir === 'asc' ? 'chevron-up' : 'chevron-down') : 'chevrons-up-down';
    return `<th class="${c.cls}${sorted ? ' sorted' : ''}" data-key="${c.key}" title="Sort by ${esc(c.label)}">
      <span class="th-inner">${esc(c.label)}<i data-lucide="${ic}" class="sort-ic"></i></span></th>`;
  }).join('')}</tr>`;
}

function signalsCell(rec) {
  if (rec.pending) {
    return `<span class="pill pill-pending" title="Newly liquid — full metrics refresh on the next weekly crawl">Pending</span>`;
  }
  const params = rec.params;
  let pass = 0;
  let applicable = 0;
  const dots = CHECK_KEYS.map((k) => {
    const v = params[k].verdict;
    if (v === 'PASS') {
      pass += 1;
      applicable += 1;
      return '<span class="sdot dot-pass"></span>';
    }
    if (v === 'FAIL') {
      applicable += 1;
      return '<span class="sdot dot-fail"></span>';
    }
    return '<span class="sdot dot-na"></span>';
  }).join('');
  return `<div class="signals" title="${pass} of ${applicable} applicable checks passed">
    <span class="signals-count">${pass}<span class="signals-den">/${applicable}</span></span>
    <span class="signals-dots">${dots}</span></div>`;
}

function rowHtml(rec, i) {
  const n = (v, f) => (v == null ? muted : f(v));
  return `<tr data-slug="${esc(rec.slug)}" style="animation-delay:${Math.min(i, 24) * 12}ms">
    <td>
      <div class="co-cell">
        <span class="co-rank hide-sm">${i + 1}</span>
        <div>
          <div class="co-name">${esc(rec.name)}${rec.qualReal ? `<span class="ai-badge" title="${rec.qualReal}/8 AI qualitative signals from management commentary">AI</span>` : ''}</div>
          <div class="co-meta">${sectorChip(rec.sector)}<span class="co-slug">${esc(rec.slug)}</span></div>
        </div>
      </div>
    </td>
    <td class="cell-num">${n(rec.mcap, inrCr)}</td>
    <td class="cell-num">${n(rec.pe, mult)}</td>
    <td class="cell-num">${n(rec.pb, mult)}</td>
    <td class="cell-num">${n(rec.evEbitda, mult)}</td>
    <td class="cell-num hide-sm">${n(rec.mcapSales, mult)}</td>
    <td class="num">${signalsCell(rec)}</td>
  </tr>`;
}

export function bodyHtml(records) {
  return records.map(rowHtml).join('');
}

export function sortRecords(records, key, dir) {
  const col = COLS.find((c) => c.key === key) || { type: 'num' };
  const out = [...records];
  out.sort((a, b) => {
    if (col.type === 'str') {
      const r = String(a[key] || '').localeCompare(String(b[key] || ''));
      return dir === 'asc' ? r : -r;
    }
    const av = a[key];
    const bv = b[key];
    const an = av == null || Number.isNaN(av);
    const bn = bv == null || Number.isNaN(bv);
    if (an && bn) return 0;
    if (an) return 1; // missing values always sort last
    if (bn) return -1;
    return dir === 'asc' ? av - bv : bv - av;
  });
  return out;
}
