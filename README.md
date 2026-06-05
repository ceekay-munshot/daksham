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
