# daksham

Data pipeline for an Indian-equities dashboard.

## Screener universe scraper

`scrapers/screener-universe.mjs` logs in to [Screener.in](https://www.screener.in),
reads a **saved screen**, paginates through it, and writes the candidate universe
— the company list plus the current-value ratio columns shown on the screen — to
`public/data/`.

It stops at the screen list. It does **not** crawl individual company pages; the
per-company crawl and the ₹4 Cr bhavcopy volume gate are separate, later steps
that consume `daksham-universe.json`.

### Outputs

| File | Contents |
| --- | --- |
| `public/data/daksham-universe.json` | Array of `{ name, path, slug, ev_ebitda, pe, pb, roce, roe, promoter_holding, sales_growth_3y, mkt_cap, cmp, … }` |
| `public/data/daksham-universe.csv` | Same rows; headers are the union of all keys |
| `public/data/universe-metadata.json` | `{ generated_at, source, company_count, columns }` |

Files are flushed after every page, so an interrupted run can be resumed with
`START_AT`.

### Environment / secrets

The two secrets are **required** — Screener login is needed to see the saved
screen and its columns.

| Variable | Required | Default | Purpose |
| --- | :---: | --- | --- |
| `SCREENER_EMAIL` | ✅ | — | Screener.in login email |
| `SCREENER_PASSWORD` | ✅ | — | Screener.in login password |
| `SCREEN_URL` | — | `https://www.screener.in/screens/3706521/daksham-universe-mcap-25000/` | Saved screen to read |
| `MAX_PAGES` | — | `250` | Safety cap on pages to paginate (the default screen is ~201 pages; the "page X of Y" stop ends the run earlier) |
| `START_AT` | — | `0` | Resume from this page number (`0`/`1` = start fresh) |

In CI, set `SCREENER_EMAIL` and `SCREENER_PASSWORD` as **GitHub Actions secrets**
and expose them to the job via `env:`.

### Setup

```bash
npm install
npx playwright install chromium   # one-time: download the headless browser
```

### Run locally

```bash
SCREENER_EMAIL=you@example.com SCREENER_PASSWORD=secret node scrapers/screener-universe.mjs
```

(`npm run scrape:universe` runs the same command. `npm test` runs the parser unit
tests, which need no browser or network.)

## Bhavcopy volume gate

`scrapers/bhavcopy-liquidity.mjs` reads `daksham-universe.json`, computes each
NSE-listed company's **30-trading-day average daily traded value** from NSE
"full" bhavcopy (`TURNOVER_LACS / 100 = ₹ Cr`, EQ series only), and writes the
subset with avg **≥ ₹4 Cr** to `liquid-universe.json`. A day a symbol did not
trade counts as 0 (the denominator is the full window). BSE-only names (numeric
Screener slugs) have no NSE turnover and are excluded for now (counted + listed
in the debug file).

It primes an NSE session (homepage GET for cookies, then cookie + UA + Referer on
each archive fetch) and caches CSVs under `.cache/bhav/` so re-runs don't
re-download. Needs **≥ 20** valid trading days or it fails with a clear message.

### Outputs

| File | Contents |
| --- | --- |
| `public/data/liquid-universe.json` | Passing rows = original universe row + `{ adtv_30d_cr, days_counted, liquidity_source: "nse" }` |
| `public/data/liquidity-debug.json` | `{ generated_at, threshold_cr, days_used, universe_in, passed, failed, bse_only_excluded, bse_only_slugs, sample_failed }` |

### Environment / secrets

| Variable | Required | Default | Purpose |
| --- | :---: | --- | --- |
| `FIRECRAWL_API_KEY` | — | — | Optional fallback fetch if NSE blocks direct requests |
| `ADTV_THRESHOLD_CR` | — | `4` | Pass threshold (₹ Cr) |
| `BHAV_DAYS` | — | `30` | Trading days to average over |
| `BHAV_MIN_DAYS` | — | `20` | Minimum valid days or the run fails |
| `BHAV_MAX_LOOKBACK` | — | `60` | Calendar days to walk back while collecting |

### Run locally

```bash
node scrapers/bhavcopy-liquidity.mjs
```

(`npm run scrape:liquidity` runs the same command. NSE blocks many datacenter
IPs — if you get 0 valid days locally, run it via the **Bhavcopy volume gate**
GitHub Action, or set `FIRECRAWL_API_KEY`.)

## Per-company metrics crawler

`scrapers/company-metrics.mjs` reads `liquid-universe.json` (the volume-pass
names) and, for each, opens `https://www.screener.in/company/<slug>/` in
Screener's **default view** (consolidated when available, else standalone —
recorded under `financials_view`). It expands the Expenses / Other Assets
schedules and extracts the raw fundamentals + multi-period series Daksham needs.
It runs ONLY on the liquid set, not the full universe. Pure extraction — no
PASS/FAIL or scoring (that's a later evaluation layer).

Per company it captures: the ribbon (`stock_pe, roce, roe, book_value,
current_price, market_cap`, computed `pb`), sector tags, `sales_cagr_3y` (+5Y/TTM),
and oldest→newest pipe-delimited series — quarterly sales + material-cost %,
annual revenue / OPM % / material-cost % (TTM dropped), CFO, net block,
inventories, and promoter/FII/DII holding — plus latest holdings,
`institutional_holding`, and `mcap_to_sales`.

### Outputs

| File | Contents |
| --- | --- |
| `public/data/daksham-companies.json` | Array; each = the `liquid-universe` row + every extracted field |
| `public/data/daksham-companies.csv` | Flat; series stay pipe-delimited |
| `public/data/companies-metadata.json` | `{ generated_at, financials_view_counts, company_count, failures }` |

Flushed after every company, so a crash is resumable.

### Environment / secrets

Same `SCREENER_EMAIL` / `SCREENER_PASSWORD` as the universe scraper, plus:

| Variable | Required | Default | Purpose |
| --- | :---: | --- | --- |
| `START_AT` | — | `0` | Resume offset (index into `liquid-universe.json`) |
| `MAX_COMPANIES` | — | _(all)_ | Cap per run — set `3`–`5` for a smoke test, or batch a full run |

### Run locally

```bash
SCREENER_EMAIL=you@example.com SCREENER_PASSWORD=secret MAX_COMPANIES=3 node scrapers/company-metrics.mjs
```

(`npm run scrape:companies` runs the same command. A full ~947 run takes a couple
of hours — smoke-test first, then run the rest, optionally in batches via
`START_AT` + `MAX_COMPANIES`.)

## Evaluation layer

`eval/evaluate.mjs` is **pure ESM (browser + Node, no DOM deps)**. `evaluate(companyRow)`
turns a `daksham-companies.json` row into a verdict per parameter:

```js
{ key, label, value, verdict, output_type, note }
// output_type ∈ "raw" | "pass_fail" | "deferred"
// verdict     → "PASS" | "FAIL" | "NA" (pass_fail); null (raw / deferred)
```

Two NA flavours keep "structurally absent" apart from "data missing" — and a
company is **never failed for a line its sector lacks**:

- `naSector` → `note: "Not applicable — …"` (e.g. a bank/IT firm has no material-cost line)
- `naData` → `note: "Insufficient history — …"` (series missing or too short)

Every tunable (the 0.8× turnover factor, +0.5 / +1.0 holding deltas, the 1.10
EBITDA ratio, the trend definitions) lives in the `CONFIG` block at the top of
`evaluate.mjs`. The dashboard can import `evaluate.mjs` and compute verdicts
client-side from `daksham-companies.json`, or read the pre-computed file below.

### Batch

```bash
node eval/run.mjs            # or: npm run evaluate
```

Reads `daksham-companies.json`, writes `public/data/daksham-evaluated.json`
(array of `{ company, params }`, minified), and prints a per-check summary
(PASS / FAIL / NA-sector / NA-data).

## Dashboard

`public/index.html` is a static, **CDN-only** research dashboard (Tailwind +
Lucide + Google Fonts). It fetches `public/data/*.json`, imports
`eval/evaluate.mjs`, and computes every verdict **client-side** — bright/airy UI
with one signature dark hero, a sortable / searchable / sector- & check-filterable
947-company grid, a **shortlist** control (min green signals), and a per-company
**dossier** slide-over (valuation · growth & margins · cash & capital · ownership ·
moat) with inline-SVG sparklines.

Serve from the **repo root** so both `public/` and `eval/` are reachable:

```bash
python3 -m http.server 8000
# then open http://localhost:8000/public/
```

The dashboard also reads a vendored copy at `public/js/evaluate.mjs` (kept in
sync via `npm run sync:eval` + a unit-test guard) so `public/` is self-contained
for static hosting (Cloudflare Pages, GitHub Pages, etc.).

## Scheduled refresh (GitHub Actions)

Two tiered workflows keep `public/data/` fresh. Eval is **client-side**, so
neither runs an eval step — they only refresh data files. Both commit to the
default branch with a fetch + rebase retry loop and skip when there's no diff
(`permissions: contents: write`). Actions pinned to `@v5`.

| Workflow | File | Schedule (IST) | Cron (UTC) | What it does |
| --- | --- | --- | --- | --- |
| **Daily liquidity** | `.github/workflows/daily-liquidity.yml` | ~06:47, Tue–Sat | `17 1 * * 2-6` | Re-runs the ₹4 Cr bhavcopy gate against the current `daksham-universe.json` → refreshes `liquid-universe.json` + `liquidity-debug.json`. Best-effort crawl of *new entrants* only. |
| **Weekly full** | `.github/workflows/weekly-refresh.yml` | ~23:53, Sun | `23 18 * * 0` | In order: universe scraper → bhavcopy gate → per-company crawler (≈2.5–3h, `timeout-minutes: 330`). Uploads all data as an artifact, even on a partial run. |

The cron is deliberately off the `:00/:15/:30/:45` marks (GitHub queues those) and
the daily one runs *after* the prior session's NSE bhavcopy is final. Both also
support manual `workflow_dispatch`. The per-stage manual workflows
(`universe-scraper`, `bhavcopy-liquidity`, `company-metrics`) remain for ad-hoc /
debug runs (batching, HTML dumps, thresholds).

### Secrets

| Secret | Daily | Weekly | Purpose |
| --- | :-: | :-: | --- |
| `SCREENER_EMAIL` / `SCREENER_PASSWORD` | optional | required | Screener login — weekly crawl; daily only for the new-entrant nicety |
| `FIRECRAWL_API_KEY` | optional | optional | Fallback fetch if NSE blocks the runner |

Requires repo **Workflow permissions → Read and write** (Settings → Actions →
General) so the bot can commit.

### Metrics-pending

A daily run can add a name to `liquid-universe.json` before the weekly crawl has
its fundamentals. The dashboard shows such names with a **"Pending"** signal in
the grid and a **"Metrics pending"** dossier until the next crawl fills them in.

> `daksham-evaluated.json` is an optional batch snapshot (`npm run evaluate`) — the
> dashboard computes verdicts client-side and does not require it, so CI doesn't
> refresh it.
