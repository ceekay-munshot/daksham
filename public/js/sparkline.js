// Lightweight inline-SVG sparkline (no chart library). Trend-coloured by default
// (last >= first → emerald, else rose), with a soft gradient fill.

let uid = 0;

export function sparkline(values, { w = 96, h = 30, stroke, fill = true, trendColor = true } = {}) {
  const v = (values || []).filter((n) => Number.isFinite(n));
  if (v.length < 2) return `<svg class="spark" width="${w}" height="${h}"></svg>`;

  const min = Math.min(...v);
  const max = Math.max(...v);
  const range = max - min || 1;
  const stepX = w / (v.length - 1);
  const pad = 3;
  const pts = v.map((y, i) => [i * stepX, h - pad - ((y - min) / range) * (h - pad * 2)]);
  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(' ');

  const up = v[v.length - 1] >= v[0];
  const col = stroke || (trendColor ? (up ? '#10b981' : '#f43f5e') : '#6366f1');
  const id = `sp${uid++}`;
  const last = pts[pts.length - 1];

  return `<svg class="spark" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" preserveAspectRatio="none" aria-hidden="true">
    ${
      fill
        ? `<defs><linearGradient id="${id}" x1="0" x2="0" y1="0" y2="1">
             <stop offset="0" stop-color="${col}" stop-opacity="0.22"/>
             <stop offset="1" stop-color="${col}" stop-opacity="0"/>
           </linearGradient></defs>
           <path d="${line} L ${w} ${h} L 0 ${h} Z" fill="url(#${id})"/>`
        : ''
    }
    <path d="${line}" fill="none" stroke="${col}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
    <circle cx="${last[0].toFixed(1)}" cy="${last[1].toFixed(1)}" r="2.6" fill="${col}"/>
  </svg>`;
}
