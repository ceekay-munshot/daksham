import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as cheerio from 'cheerio';

import { parseCompanyPage, parseSectionTable, toCsv } from './lib/company.mjs';

// A trimmed Screener company page, as it looks AFTER the Expenses / Other Assets
// schedules have been expanded (so the "Material Cost %" and "Inventories"
// sub-rows are present). Values carry Screener's ₹ / commas / % so the cleaners
// are exercised. #profit-loss has a trailing TTM column that must be dropped.
const FIXTURE = `<!doctype html><html><body>
  <h1>Acme Industries</h1>
  <p class="sub">
    <a title="Broad Sector" href="#">Manufacturing</a>
    <a title="Sector" href="#">Automobile</a>
    <a title="Industry" href="#">Auto Components</a>
  </p>
  <p class="company-info">Consolidated Figures in Rs. Cr.</p>

  <ul id="top-ratios">
    <li><span class="name">Market Cap</span><span class="value">₹ <span class="number">2,400</span> Cr.</span></li>
    <li><span class="name">Current Price</span><span class="value">₹ <span class="number">200</span></span></li>
    <li><span class="name">Stock P/E</span><span class="value"><span class="number">25.0</span></span></li>
    <li><span class="name">Book Value</span><span class="value">₹ <span class="number">50.0</span></span></li>
    <li><span class="name">ROCE</span><span class="value"><span class="number">18.5</span> %</span></li>
    <li><span class="name">ROE</span><span class="value"><span class="number">15.2</span> %</span></li>
  </ul>

  <table class="ranges-table"><tbody>
    <tr><th>Compounded Sales Growth</th></tr>
    <tr><td>5 Years:</td><td>15%</td></tr>
    <tr><td>3 Years:</td><td>18%</td></tr>
    <tr><td>TTM:</td><td>20%</td></tr>
  </tbody></table>

  <section id="quarters"><table class="data-table"><tbody>
    <tr><th></th><th>Dec 2023</th><th>Mar 2024</th><th>Jun 2024</th></tr>
    <tr><td class="text">Sales&nbsp;+</td><td>100</td><td>110</td><td>120</td></tr>
    <tr><td class="text">Expenses&nbsp;-</td><td>80</td><td>87</td><td>94</td></tr>
    <tr><td class="text">Material Cost %</td><td>40%</td><td>41%</td><td>42%</td></tr>
    <tr><td class="text">OPM %</td><td>20</td><td>21</td><td>22</td></tr>
  </tbody></table></section>

  <section id="profit-loss"><table class="data-table"><tbody>
    <tr><th></th><th>Mar 2022</th><th>Mar 2023</th><th>Mar 2024</th><th>TTM</th></tr>
    <tr><td class="text">Sales&nbsp;+</td><td>1,000</td><td>1,100</td><td>1,200</td><td>1,250</td></tr>
    <tr><td class="text">Expenses&nbsp;-</td><td>820</td><td>891</td><td>960</td><td>988</td></tr>
    <tr><td class="text">Material Cost %</td><td>45%</td><td>44%</td><td>43%</td><td>42%</td></tr>
    <tr><td class="text">OPM %</td><td>18</td><td>19</td><td>20</td><td>21</td></tr>
  </tbody></table></section>

  <section id="cash-flow"><table class="data-table"><tbody>
    <tr><th></th><th>Mar 2022</th><th>Mar 2023</th><th>Mar 2024</th></tr>
    <tr><td class="text">Cash from Operating Activity&nbsp;+</td><td>200</td><td>210</td><td>220</td></tr>
    <tr><td class="text">Net Cash Flow</td><td>10</td><td>12</td><td>15</td></tr>
  </tbody></table></section>

  <section id="balance-sheet"><table class="data-table"><tbody>
    <tr><th></th><th>Mar 2022</th><th>Mar 2023</th><th>Mar 2024</th></tr>
    <tr><td class="text">Fixed Assets&nbsp;+</td><td>500</td><td>520</td><td>540</td></tr>
    <tr><td class="text">Inventories</td><td>80</td><td>85</td><td>90</td></tr>
  </tbody></table></section>

  <section id="shareholding"><table class="data-table"><tbody>
    <tr><th></th><th>Sep 2023</th><th>Dec 2023</th><th>Mar 2024</th></tr>
    <tr><td class="text">Promoters&nbsp;+</td><td>50.00</td><td>50.00</td><td>51.00</td></tr>
    <tr><td class="text">FIIs&nbsp;+</td><td>20.00</td><td>21.00</td><td>22.00</td></tr>
    <tr><td class="text">DIIs&nbsp;+</td><td>10.00</td><td>11.00</td><td>12.00</td></tr>
    <tr><td class="text">Public</td><td>20.00</td><td>18.00</td><td>15.00</td></tr>
  </tbody></table></section>
</body></html>`;

test('parseCompanyPage: ribbon, view, computed pb', () => {
  const c = parseCompanyPage(FIXTURE);
  assert.equal(c.financials_view, 'consolidated');
  assert.equal(c.stock_pe, '25.0');
  assert.equal(c.roce, '18.5');
  assert.equal(c.roe, '15.2');
  assert.equal(c.book_value, '50.0');
  assert.equal(c.current_price, '200');
  assert.equal(c.market_cap, '2400');
  assert.equal(c.pb, 4); // 200 / 50
});

test('parseCompanyPage: sector tags', () => {
  const c = parseCompanyPage(FIXTURE);
  assert.equal(c.broad_sector, 'Manufacturing');
  assert.equal(c.sector, 'Automobile');
  assert.equal(c.industry, 'Auto Components');
});

test('parseCompanyPage: compounded sales growth', () => {
  const c = parseCompanyPage(FIXTURE);
  assert.equal(c.sales_cagr_3y, '18');
  assert.equal(c.sales_cagr_5y, '15');
  assert.equal(c.sales_cagr_ttm, '20');
});

test('parseCompanyPage: quarterly series + expanded Material Cost %', () => {
  const c = parseCompanyPage(FIXTURE);
  assert.equal(c.sales_qtr_series, '100|110|120');
  assert.equal(c.material_cost_pct_qtr_series, '40|41|42'); // % stripped, from expanded row
});

test('parseCompanyPage: annual P&L series drop the TTM column', () => {
  const c = parseCompanyPage(FIXTURE);
  assert.equal(c.revenue_series, '1000|1100|1200'); // commas stripped, TTM dropped
  assert.equal(c.opm_series, '18|19|20');
  assert.equal(c.material_cost_pct_annual_series, '45|44|43'); // expanded sub-row, TTM dropped
});

test('parseCompanyPage: cash flow + balance sheet series', () => {
  const c = parseCompanyPage(FIXTURE);
  assert.equal(c.cfo_series, '200|210|220');
  assert.equal(c.net_block_series, '500|520|540'); // matched "Fixed Assets"
  assert.equal(c.inventory_series, '80|85|90');
});

test('parseCompanyPage: shareholding series, latest, and institutional sum', () => {
  const c = parseCompanyPage(FIXTURE);
  assert.equal(c.promoter_holding_series, '50.00|50.00|51.00');
  assert.equal(c.fii_holding_series, '20.00|21.00|22.00');
  assert.equal(c.dii_holding_series, '10.00|11.00|12.00');
  assert.equal(c.promoter_holding, '51.00');
  assert.equal(c.fii_holding, '22.00');
  assert.equal(c.dii_holding, '12.00');
  assert.equal(c.institutional_holding, 34); // 22 + 12
});

test('parseCompanyPage: mcap_to_sales uses latest revenue', () => {
  const c = parseCompanyPage(FIXTURE);
  assert.equal(c.mcap_to_sales, 2); // 2400 / 1200
});

test('parseSectionTable: periods + row labels (expand indicator stripped)', () => {
  const $ = cheerio.load(FIXTURE);
  const pl = parseSectionTable($, '#profit-loss');
  assert.deepEqual(pl.periods, ['Mar 2022', 'Mar 2023', 'Mar 2024', 'TTM']);
  const sales = pl.rows.find((r) => r.label === 'Sales'); // "+" indicator stripped
  assert.ok(sales);
  assert.deepEqual(sales.values, ['1000', '1100', '1200', '1250']);
});

test('parseCompanyPage: missing sections never crash, fields default to ""', () => {
  const c = parseCompanyPage('<html><body><div>nothing here</div></body></html>');
  assert.equal(c.revenue_series, '');
  assert.equal(c.sales_qtr_series, '');
  assert.equal(c.cfo_series, '');
  assert.equal(c.promoter_holding, '');
  assert.equal(c.pb, '');
  assert.equal(c.mcap_to_sales, '');
  assert.equal(c.broad_sector, '');
});

test('toCsv: union header, series stay pipe-delimited', () => {
  const c = parseCompanyPage(FIXTURE);
  const rows = [{ slug: 'ACME', name: 'Acme', ...c }];
  const csv = toCsv(rows);
  const [header, row] = csv.trimEnd().split('\n');
  assert.ok(header.startsWith('slug,name,'));
  assert.ok(header.includes('revenue_series'));
  assert.ok(row.includes('1000|1100|1200'));
});
