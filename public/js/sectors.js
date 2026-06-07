// Consistent, curated sector colour-coding (cohesive — not a rainbow).

import { esc } from './format.js';

const PALETTE = {
  'Financial Services': '#6366f1',
  'Information Technology': '#0ea5e9',
  Commodities: '#f59e0b',
  'Consumer Discretionary': '#a855f7',
  'Fast Moving Consumer Goods': '#10b981',
  Healthcare: '#ec4899',
  Utilities: '#06b6d4',
  Energy: '#f97316',
  Telecommunication: '#8b5cf6',
  Services: '#3b82f6',
  Industrials: '#14b8a6',
  Materials: '#eab308',
  'Consumer Staples': '#84cc16',
  Diversified: '#64748b',
  Realty: '#fb7185',
  Chemicals: '#22c55e',
  Textiles: '#f472b6',
};
const FALLBACK = '#64748b';

export const sectorHex = (s) => PALETTE[s] || FALLBACK;

export function sectorChip(s) {
  const c = sectorHex(s);
  return `<span class="chip" style="--c:${c}"><span class="chip-dot"></span>${esc(s || '—')}</span>`;
}
