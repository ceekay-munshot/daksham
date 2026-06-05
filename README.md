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
