import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseScreenTable,
  canonicalKey,
  cleanValue,
  collapse,
  normalizeHeader,
  dedupeByPath,
  CANONICAL_KEYS,
} from './lib/parse.mjs';
import { toCsv, unionColumns, dataColumns } from './lib/output.mjs';

// A fixture shaped like a Screener saved-screen results page: a serial column, a
// name column with a /company/ link, the ratio columns (with the abbreviated
// labels Screener actually renders), one extra/unknown column, a row with blank
// cells, a numeric (BSE) slug, and a non-company separator row.
const FIXTURE = `<!doctype html><html><body>
<table class="data-table">
  <thead><tr>
    <th class="text">S.No.</th>
    <th class="text">Name</th>
    <th>CMP Rs.</th>
    <th>P/E</th>
    <th>Mar Cap Rs.Cr.</th>
    <th>EV / EBITDA</th>
    <th>P/B</th>
    <th>ROCE %</th>
    <th>ROE %</th>
    <th>Prom. Hold. %</th>
    <th>Sales var 3Yrs %</th>
    <th>Div Yld %</th>
  </tr></thead>
  <tbody>
    <tr>
      <td class="text">1</td>
      <td class="text"><a href="/company/RELIANCE/">Reliance Industr</a></td>
      <td>₹ 1,234.50</td>
      <td>22.50</td>
      <td>16,78,900</td>
      <td>12.3</td>
      <td>2.10</td>
      <td>9.80</td>
      <td>8.50</td>
      <td>50.30</td>
      <td>15.20</td>
      <td>0.35</td>
    </tr>
    <tr>
      <td class="text">2</td>
      <td class="text"><a href="/company/500325/">Some Co Ltd</a></td>
      <td>2,000</td>
      <td></td>
      <td>1,00,000</td>
      <td></td>
      <td>3.00</td>
      <td>11.00</td>
      <td>12.00</td>
      <td>40.00</td>
      <td>9.00</td>
      <td></td>
    </tr>
    <tr><td colspan="12">Showing results — not a company row</td></tr>
  </tbody>
</table>
<div class="pagination">Page 1 of 6</div>
</body></html>`;

test('parseScreenTable: structure, pagination, and non-company rows', () => {
  const { hasTable, totalPages, rows, warnings } = parseScreenTable(FIXTURE);
  assert.equal(hasTable, true);
  assert.equal(totalPages, 6);
  assert.equal(rows.length, 2, 'separator row without a /company/ link is skipped');
  assert.equal(warnings.length, 0);
});

test('parseScreenTable: identity fields + mapped ratio columns', () => {
  const [r0] = parseScreenTable(FIXTURE).rows;
  assert.equal(r0.name, 'Reliance Industr');
  assert.equal(r0.path, '/company/RELIANCE/');
  assert.equal(r0.slug, 'RELIANCE');

  assert.equal(r0.cmp, '1234.50'); // rupee sign + comma stripped
  assert.equal(r0.pe, '22.50');
  assert.equal(r0.mkt_cap, '1678900'); // Indian-format commas stripped
  assert.equal(r0.ev_ebitda, '12.3');
  assert.equal(r0.pb, '2.10');
  assert.equal(r0.roce, '9.80');
  assert.equal(r0.roe, '8.50');
  assert.equal(r0.promoter_holding, '50.30');
  assert.equal(r0.sales_growth_3y, '15.20');

  // Unknown column kept under its raw header label, not dropped.
  assert.equal(r0['Div Yld %'], '0.35');
});

test('parseScreenTable: numeric slug and blank cells', () => {
  const [, r1] = parseScreenTable(FIXTURE).rows;
  assert.equal(r1.slug, '500325'); // BSE numeric code
  assert.equal(r1.pe, ''); // blank cell preserved as ""
  assert.equal(r1.ev_ebitda, '');
  // Every canonical key is always present, even when blank.
  for (const k of CANONICAL_KEYS) assert.ok(k in r1);
});

test('canonicalKey maps the screen labels and ignores non-data headers', () => {
  assert.equal(canonicalKey('EV / EBITDA'), 'ev_ebitda');
  assert.equal(canonicalKey('P/E'), 'pe');
  assert.equal(canonicalKey('P/B'), 'pb');
  assert.equal(canonicalKey('P/B (Price to book value)'), 'pb');
  assert.equal(canonicalKey('ROCE %'), 'roce');
  assert.equal(canonicalKey('ROE %'), 'roe');
  assert.equal(canonicalKey('Prom. Hold. %'), 'promoter_holding');
  assert.equal(canonicalKey('Promoter holding'), 'promoter_holding');
  assert.equal(canonicalKey('Sales var 3Yrs %'), 'sales_growth_3y');
  assert.equal(canonicalKey('Sales growth 3Years'), 'sales_growth_3y');
  assert.equal(canonicalKey('Mar Cap Rs.Cr.'), 'mkt_cap');
  assert.equal(canonicalKey('Mkt Cap'), 'mkt_cap');
  assert.equal(canonicalKey('CMP Rs.'), 'cmp');
  assert.equal(canonicalKey('S.No.'), null);
  assert.equal(canonicalKey('Name'), null);
  assert.equal(canonicalKey('Div Yld %'), null);
});

test('cleanValue strips currency, separators, percent and whitespace', () => {
  assert.equal(cleanValue('₹ 1,234.50'), '1234.50');
  assert.equal(cleanValue('12.5%'), '12.5');
  assert.equal(cleanValue('1,00,000'), '100000');
  assert.equal(cleanValue('   '), '');
  assert.equal(cleanValue(''), '');
});

test('collapse / normalizeHeader helpers', () => {
  assert.equal(collapse('  a\n  b '), 'a b');
  assert.equal(normalizeHeader('Mar Cap Rs.Cr.'), 'marcaprscr');
});

test('dedupeByPath removes repeats across a shared seen set', () => {
  const seen = new Set();
  const a = dedupeByPath(
    [{ path: '/company/A/' }, { path: '/company/B/' }, { path: '/company/A/' }],
    seen
  );
  assert.equal(a.length, 2);
  const b = dedupeByPath([{ path: '/company/B/' }, { path: '/company/C/' }], seen);
  assert.equal(b.length, 1); // B already seen on the previous page
});

test('output: column union + CSV', () => {
  const { rows } = parseScreenTable(FIXTURE);
  const cols = unionColumns(rows);
  assert.deepEqual(cols.slice(0, 3), ['name', 'path', 'slug']);
  for (const k of CANONICAL_KEYS) assert.ok(cols.includes(k));
  assert.ok(cols.includes('Div Yld %')); // extra column present in the union
  assert.ok(!dataColumns(rows).includes('name')); // identity fields excluded

  const csv = toCsv(rows);
  const lines = csv.trimEnd().split('\n');
  assert.equal(lines.length, 1 + rows.length); // header + 2 data rows
  assert.ok(lines[0].startsWith('name,path,slug,'));
});
