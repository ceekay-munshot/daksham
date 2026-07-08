# Industry Mapping — Handoff for the `orderbook` project

**Repo:** `ceekay-munshot/daksham` (public) · **Default branch:** `main`
**Investigated:** 2026-07-07 · **Constraint honoured:** no pipeline code changed; this doc + the `handoff/` exports are the only new files.

> **TL;DR for orderbook**
> - The "Stock Scan" industry label lives in **`public/data/stockscans-classification.json`**, keyed by **NSE symbol** (nothing else).
> - **It stores NO BSE scrip code and NO ISIN.** orderbook is BSE-centric, so orderbook must convert its BSE code / ISIN → **NSE symbol** on its own side, then join.
> - Coverage is **NSE-listed liquid names only (~951)**. BSE-only scrips are absent → they must fall back to a default label.
> - Live source (no token, public repo): `https://raw.githubusercontent.com/ceekay-munshot/daksham/main/public/data/stockscans-classification.json`
> - Jump to the paste-ready block: [§10 Integration Prompt](#10-ready-to-paste-integration-prompt).

---

## 0. There are TWO industry taxonomies — pick the "Stock Scan" one

| | **A. Stockscans (the "Stock Scan" mapping)** | **B. Screener sector/industry** |
|---|---|---|
| File | `public/data/stockscans-classification.json` | `public/data/daksham-companies.json` |
| Purpose | The classification the **Stock Scan** feature uses ("client wants sector/peer grouping to follow Stockscans") | Screener.in's own 3-level sector tags, used for the dashboard's fundamentals |
| Levels | 1 flat level: `industry` (**256** labels) | 3 levels: `broad_sector` (13) / `sector` (23) / `industry` (159) |
| Rows | 951 | 958 |
| Join key | **NSE symbol** | **NSE symbol** (Screener slug) |
| Freshness | 2026-07-03 (manual refresh) | 2026-07-07 (weekly cron) |

Your task says the mapping was **"built for a Stock Scan feature"** and you want a **"Target Industry"** — that is **mapping A (Stockscans)**. Use A as the primary. Mapping B is documented too because it's a cleaner, more stable hierarchy (broad_sector → sector → industry) if you ever want grouping; it is a bonus, not the target.

Everything below leads with **A** and notes **B** where it differs.

---

## 1. WHAT the mapping is

**Source of truth (A):** `public/data/stockscans-classification.json`, produced by `scrapers/stockscans-classify.mjs`, which fetches each liquid company's **public** Stockscans page `https://www.stockscans.in/company/NSE:<SYMBOL>` and reads the text of the `Industry:` link.

- **Taxonomy:** a single flat `industry` label per company. **256 distinct labels.** No sub-industry level.
- Example label strings: `Abrasives & Grinding Wheels`, `Pharma - API & CRAMS`, `Auto - Bus/LCVs`, `Finance & Investments - Microfinance`, `Gas Distribution`, `Speciality Chemicals`, `Power - Generation/Distribution`.
- Full list: **`handoff/stockscans-industries.txt`** (256 lines) and **`handoff/industry-labels.json`** (`stockscans_industry.labels`).

**Source of truth (B):** `public/data/daksham-companies.json`, produced by `scrapers/lib/company.mjs` → `parseCompanyPage()`, reading Screener's three anchor tags `a[title="Broad Sector"]`, `a[title="Sector"]`, `a[title="Industry"]`.

- **broad_sector (13):** Consumer Discretionary, Industrials, Commodities, Healthcare, Financial Services, Fast Moving Consumer Goods, Information Technology, Services, Utilities, Energy, Telecommunication, Diversified, (one empty).
- **sector (23):** Capital Goods, Healthcare, Financial Services, Chemicals, Consumer Durables, Fast Moving Consumer Goods, Automobile and Auto Components, Information Technology, Consumer Services, Construction, Services, Textiles, Realty, Metals & Mining, Oil Gas & Consumable Fuels, Media Entertainment & Publication, Power, Construction Materials, Utilities, Telecommunication, Forest Materials, Diversified, (one empty).
- **industry (159 non-empty):** e.g. Pharmaceuticals, Auto Components & Equipments, Civil Construction, Iron & Steel Products, Industrial Products, Specialty Chemicals… Full list in `handoff/industry-labels.json` (`screener_industry.labels`).

---

## 2. WHERE it lives and its shape

Both are **static JSON files committed to git** (no DB, no server-side function). Served three ways: (a) via git/raw GitHub, (b) as static assets by a Cloudflare Worker (`wrangler.jsonc`, `assets.directory = public`) — deployed URL not in the repo, so **don't rely on it**; use raw GitHub.

### A. `public/data/stockscans-classification.json`
```jsonc
{
  "generated_at": "2026-07-03T11:23:36.765Z",
  "source": "https://www.stockscans.in",
  "count": 951,
  "companies": {
    "GRINDWELL": { "slug": "GRINDWELL", "symbol": "GRINDWELL",
                   "industry": "Abrasives & Grinding Wheels",
                   "url": "https://www.stockscans.in/company/NSE:GRINDWELL" },
    "AWL":       { "slug": "AWL", "symbol": "AWL",
                   "industry": "Edible Oils, Agro Processing",
                   "url": "https://www.stockscans.in/company/NSE:AWL" }
    // …951 entries
  }
}
```
| Field | Type | Notes |
|---|---|---|
| `companies` | object | **Primary key = the object key = the NSE symbol** (uppercase). |
| `companies[SYM].symbol` | string | NSE symbol, uppercase. Equals the key. |
| `companies[SYM].slug` | string | Screener slug. **Identical to `symbol` for every row** (verified: 0 differences). |
| `companies[SYM].industry` | string \| null | The Target Industry label. **0 nulls** in the current file (all 951 classified). |
| `companies[SYM].url` | string | Stockscans source page. |

### B. `public/data/daksham-companies.json`
An **array** of 958 objects. Relevant fields only:
| Field | Type | Notes |
|---|---|---|
| `slug` | string | **Primary key = NSE symbol** (e.g. `TATAELXSI`). |
| `name` | string | **Truncated/abbreviated** Screener display name (`"CreditAcc. Gram."`, `"AWL Agri Busine."`) — do **not** join on this. |
| `path` | string | `"/company/<SLUG>/"` or `"/company/<SLUG>/consolidated/"`. |
| `broad_sector` / `sector` / `industry` | string | The 3-level tags. Any can be `""` (one row is empty). |

There is no primary-key column named `id`; the key is `slug`/`symbol` (the NSE symbol) in both files.

---

## 3. JOIN KEYS  ⭐ (the important part)

**Both mappings are keyed ONLY by NSE symbol.** Confirmed by reading every scraper and every data file:

- ✅ **NSE symbol** — present in both (`symbol`/`slug`). Uppercase, e.g. `TATAELXSI`, `AWL`, `CREDITACC`. **This is the only reliable exact join key.**
- ❌ **BSE scrip code** — **NOT stored anywhere.** (`scrapers/lib/docs.mjs` has `parseBseCode()`, but it's used transiently to fetch BSE announcements during doc-harvesting and is **never written to any output file**.)
- ❌ **ISIN** — **NOT stored anywhere** (grep across the repo: no ISIN field).
- ⚠️ **Company name** — only in mapping B, and it's **truncated** ("Neuland Labs.", "MTAR Technologie"). Mapping A has **no name field at all**. Name-matching is unreliable; treat as last resort only.

### What this means for orderbook (BSE-centric)
orderbook knows: **company NAME, BSE scrip code, often ISIN, sometimes NSE symbol.** daksham keys on **NSE symbol**. So:

1. **If orderbook already has the NSE symbol → join directly** (uppercase it first). Best path.
2. **If orderbook only has BSE code / ISIN → it must translate to NSE symbol on its own side**, because daksham has no BSE↔NSE bridge. The robust bridge is **ISIN** (both exchanges publish it). Build/refresh a symbol master in orderbook from a public list, e.g.:
   - NSE: `https://nsearchives.nseindia.com/content/equities/EQUITY_L.csv` (columns `SYMBOL`, `ISIN NUMBER`, `NAME OF COMPANY`).
   - BSE: `ListOfScrips` (columns `Security Code` = scrip code, `ISIN No`, `Security Id`).
   - Join BSE `ISIN No` → NSE `ISIN NUMBER` → NSE `SYMBOL`, then key into daksham.
3. **If still unresolved (BSE-only name, or symbol not in the file) → fallback label.**

> daksham cannot resolve BSE code/ISIN for you. That translation is orderbook's responsibility; daksham's contract is strictly **NSE symbol → industry**.

---

## 4. LOOKUP method

There is no lookup API — it's a dictionary read. Given an **NSE symbol**:

```js
// A) Stockscans "Target Industry" — the primary mapping.
// symbolKey mirrors the scraper's normSymbol(): trim + UPPERCASE.
const symbolKey = (s) => String(s || '').trim().toUpperCase();

const doc = await (await fetch(
  'https://raw.githubusercontent.com/ceekay-munshot/daksham/main/public/data/stockscans-classification.json'
)).json();

function targetIndustry(nseSymbol) {
  const rec = doc.companies[symbolKey(nseSymbol)];
  return rec && rec.industry ? rec.industry : null;   // null → apply fallback
}

targetIndustry('grindwell'); // "Abrasives & Grinding Wheels"
targetIndustry('AWL');       // "Edible Oils, Agro Processing"
```

```js
// B) Screener hierarchy (optional grouping). Array → index by slug once.
const rows = await (await fetch(
  'https://raw.githubusercontent.com/ceekay-munshot/daksham/main/public/data/daksham-companies.json'
)).json();
const bySymbol = new Map(rows.map((r) => [r.slug.toUpperCase(), r]));
const r = bySymbol.get('TATAELXSI');
// r.broad_sector="Information Technology", r.sector="Information Technology", r.industry="Computers - Software & Consulting"
```

The scraper's own extraction reference (`scrapers/stockscans-classify.mjs`): key = `normSymbol(row.slug)` = `String(slug).trim().toUpperCase()`; value = anchor text of `a[href*="/scans/new?industry="]`.

---

## 5. SAMPLE (real rows) — `NSE symbol → Target Industry (Stockscans)  ‖  Screener industry`

```
20MICRONS   -> Mining/Minerals                         ‖ Industrial Minerals
AADHARHFC   -> Finance - Housing                        ‖ Housing Finance Company
AARTIDRUGS  -> Pharma - API                             ‖ Pharmaceuticals
ASAHIINDIA  -> Glass & Glass Products                   ‖ Auto Components & Equipments
AWL         -> Edible Oils, Agro Processing             ‖ Edible Oil
CESC        -> Power - Generation/Distribution          ‖ Integrated Power Utilities
CRAFTSMAN   -> Auto & Auto Ancl - CV                    ‖ Auto Components & Equipments
CREDITACC   -> Finance & Investments - Microfinance     ‖ Microfinance Institutions
CUPID       -> Contraceptives/Protectives               ‖ (not in Screener set)
EMMVEE      -> Electric Equipment - General             ‖ Other Electrical Equipment
FORCEMOT    -> Auto - Bus/LCVs                           ‖ Passenger Cars & Utility Vehicles
GRINDWELL   -> Abrasives & Grinding Wheels               ‖ Abrasives & Bearings
HBLENGINE   -> Railways - Kavach/Springs                 ‖ Other Industrial Products
IGL         -> Gas Distribution                          ‖ LPG/CNG/PNG/LNG Supplier
KIOCL       -> Mining/Minerals                           ‖ Sponge Iron
KPIL        -> Infra - Power - Generation/Distribution   ‖ Civil Construction
MTARTECH    -> Aerospace & Defence - Equipments          ‖ Other Electrical Equipment
NEULANDLAB  -> Pharma - API & CRAMS                      ‖ Pharmaceuticals
REDINGTON   -> Computer - Hardware                        ‖ Trading & Distributors
TENNIND     -> Auto Ancillaries - Others                 ‖ Auto Components & Equipments
```

Note how the two taxonomies differ in granularity and wording (e.g. `Abrasives & Grinding Wheels` vs `Abrasives & Bearings`). Pick one taxonomy and stick to it — the Target Industry you want is the **left** (Stockscans) column.

---

## 6. EDGE CASES

- **Unmatched companies:** if the NSE symbol isn't a key in `companies`, there is **no entry** → orderbook must apply its own default (recommend the literal string **`"Unclassified"`**). Never guess.
- **BSE-only names:** the universe was filtered to NSE-listed liquid names; the wider Screener universe has ~2,364 BSE-only (numeric-slug) scrips that are **deliberately excluded** and will never appear here. These are the most likely misses for a BSE feed.
- **Nulls:** Stockscans file currently has **0 null industries** (all 951 classified). A future re-scrape can add `industry: null` / `status:"not_found"` for a symbol not on Stockscans — treat null the same as "not found".
- **No fuzzy matching, no normalization beyond case.** The scraper only does `trim().toUpperCase()` on the symbol. There is no alias table, no name cleaning, no fuzzy join anywhere. Match exact, uppercased symbols.
- **Duplicates:** none. Both files are keyed by unique symbol; `slug === symbol` for every Stockscans row.
- **Drift between A and B:** of the union of 966 symbols, **943 are in both**, **8 are Stockscans-only**, **15 are Screener-only** — because the two files refresh on different schedules (see §7). Join each independently by symbol; don't assume a symbol in one is in the other.
- **Truncated names** (mapping B) — never use as a key.

---

## 7. HOW IT UPDATES (so orderbook knows the re-sync cadence)

| Mapping | Workflow | Trigger | Realistic change frequency |
|---|---|---|---|
| **A. Stockscans** | `.github/workflows/stockscans-classification.yml` → `scrapers/stockscans-classify.mjs` | **Manual only** (`workflow_dispatch`). Commits `stockscans-classification.json` to `main`. | Rarely — only when someone runs it (e.g. after the liquid universe shifts). Effectively **static between manual runs**. |
| **B. Screener** | `.github/workflows/weekly-refresh.yml` → `scrapers/company-metrics.mjs` | **Cron `23 18 * * 0`** (Sun 18:23 UTC / 23:53 IST) + manual. Commits `daksham-companies.json` to `main`. | **Weekly.** Industry tags themselves change very seldom; the row set tracks the universe. |

**Re-sync recommendation for orderbook:** fetch the raw file(s) **once per orderbook run** (or cache for up to 24h). Both files are small (A ≈ 130 KB, B ≈ 1.7 MB). Because you always read the file at `main`, any manual/weekly refresh **flows to orderbook automatically on its next run** — that satisfies the "live, not one-time copy" requirement. Watch `generated_at` to detect staleness.

---

## 8. LIVE ACCESS (preferred) — read the mapping live, no token

**The repo is PUBLIC**, so the simplest reliable option is **raw GitHub over HTTPS, unauthenticated**:

- **Primary (Target Industry):**
  `https://raw.githubusercontent.com/ceekay-munshot/daksham/main/public/data/stockscans-classification.json`
- **Secondary (Screener hierarchy, optional):**
  `https://raw.githubusercontent.com/ceekay-munshot/daksham/main/public/data/daksham-companies.json`

Details: method `GET`, no auth header, no API key. Content-Type is JSON. Pin to branch **`main`** (always latest committed). Raw GitHub has a CDN cache (~5 min) — fine for a per-run fetch. If you prefer the versioned API (higher rate limits with a token, returns base64), use `GET https://api.github.com/repos/ceekay-munshot/daksham/contents/public/data/stockscans-classification.json?ref=main` — but for a public repo the raw URL is simpler and needs nothing.

*(There is also a Cloudflare Worker serving `public/` as static assets, but its deployed hostname is not committed anywhere in the repo, so it isn't a reliable contract. Use raw GitHub.)*

**Recommended:** raw GitHub URL, fetched each run, with the static CSV below vendored into orderbook as an offline fallback.

---

## 9. STATIC EXPORT (fallback) — copy into orderbook

Generated from the two source files, keyed by NSE symbol, in `handoff/`:

| File | Path | Contents |
|---|---|---|
| CSV | `handoff/orderbook-target-industry.csv` | 966 rows. Columns: `nse_symbol, company_name, target_industry, screener_broad_sector, screener_sector, screener_industry, in_stockscans, in_screener`. `target_industry` = the Stockscans label (primary). |
| JSON | `handoff/orderbook-target-industry.json` | Same data as `{ by_nse_symbol: { "<SYMBOL>": {…} } }` for O(1) lookup. |
| Labels | `handoff/industry-labels.json` | The complete allowed label sets: `stockscans_industry` (256), `screener_broad_sector` (13), `screener_sector` (23), `screener_industry` (159). |
| Labels (txt) | `handoff/stockscans-industries.txt` | The 256 Stockscans labels, one per line. |

CSV shape:
```
nse_symbol,company_name,target_industry,screener_broad_sector,screener_sector,screener_industry,in_stockscans,in_screener
AADHARHFC,Aadhar Hsg. Fin.,Finance - Housing,Financial Services,Financial Services,Housing Finance Company,1,1
AARTIIND,Aarti Industries,Speciality Chemicals,Commodities,Chemicals,Specialty Chemicals,1,1
```

Use the static file only when the live fetch fails; otherwise prefer live so edits flow through.

---

## 10. READY-TO-PASTE "INTEGRATION PROMPT"

Paste everything in the block below into the `orderbook` project.

````text
TASK: Populate the "Target Industry" column for each company in the orderbook
dashboard by consuming the daksham repo's industry mapping LIVE.

SOURCE OF TRUTH (live, public, no auth token needed — daksham is a public repo):
  PRIMARY (this is the "Target Industry"):
    GET https://raw.githubusercontent.com/ceekay-munshot/daksham/main/public/data/stockscans-classification.json
  OPTIONAL (only if you also want a coarse sector grouping):
    GET https://raw.githubusercontent.com/ceekay-munshot/daksham/main/public/data/daksham-companies.json

REFRESH MODEL (keeps it live, not a one-time copy):
  - Fetch the PRIMARY file once per run (cache up to 24h; it's ~130 KB).
  - Because you read branch `main`, any upstream refresh flows in automatically
    on your next run. Read `generated_at` to log/detect staleness.
  - Vendor handoff/orderbook-target-industry.csv into orderbook as an OFFLINE
    FALLBACK; use it only if the live GET fails.

PRIMARY FILE SHAPE:
  { "generated_at","source","count",
    "companies": { "<NSE_SYMBOL>": { "slug","symbol","industry","url" } } }
  - Object key AND `symbol` = the NSE symbol, UPPERCASE.
  - `industry` (string) = the Target Industry label. May be null/absent → treat as not found.

JOIN KEY — READ CAREFULLY:
  daksham is keyed ONLY by NSE symbol. It stores NO BSE scrip code and NO ISIN.
  orderbook knows companies by NAME, BSE scrip code, often ISIN, sometimes NSE symbol.
  So resolve the NSE symbol on the orderbook side, in this exact fallback order:
    1. If you already have the NSE symbol → uppercase it and use it directly.
    2. Else translate to an NSE symbol using YOUR OWN exchange master:
         ISIN  -> NSE SYMBOL      (most reliable; both exchanges publish ISIN)
         BSE scrip code -> ISIN -> NSE SYMBOL
       (Build that master from NSE EQUITY_L.csv [SYMBOL, ISIN NUMBER] and
        BSE ListOfScrips [Security Code, ISIN No]. daksham cannot do this for you.)
    3. Company NAME is the LAST resort only — daksham names are truncated and the
       primary file has no name field. Avoid unless nothing else resolves.
  Look up: industry = companies[UPPERCASE(nse_symbol)]?.industry

FALLBACK WHEN NOT FOUND (any of: no NSE symbol resolvable, symbol absent from file,
industry null):
  Set Target Industry = "Unclassified". Never guess or fuzzy-match a label.
  Expect misses mainly for BSE-only scrips — daksham covers ~951 NSE-listed
  liquid names only.

MATCHING RULES:
  - Exact, UPPERCASE symbol match only. No fuzzy matching. Normalization is just
    String(sym).trim().toUpperCase() (matches how daksham keys the file).

ALLOWED INDUSTRY LABELS (the "Target Industry" domain):
  The complete set is the 256 distinct `industry` strings in the primary file
  (shipped verbatim as handoff/stockscans-industries.txt and in
  handoff/industry-labels.json -> stockscans_industry.labels). Treat the allowed
  set as "whatever distinct `industry` values are in the live file" (it can grow
  on a re-scrape), plus your own "Unclassified" sentinel for misses. Examples:
    "Abrasives & Grinding Wheels", "Pharma - API & CRAMS", "Auto - Bus/LCVs",
    "Finance & Investments - Microfinance", "Gas Distribution",
    "Speciality Chemicals", "Power - Generation/Distribution",
    "Computer - Hardware", "Glass & Glass Products".

MINIMAL REFERENCE IMPLEMENTATION (JS):
  const symbolKey = (s) => String(s || '').trim().toUpperCase();
  const doc = await (await fetch(PRIMARY_URL)).json();
  function targetIndustry(nseSymbol) {
    const rec = doc.companies[symbolKey(nseSymbol)];
    return (rec && rec.industry) ? rec.industry : "Unclassified";
  }

DO NOT:
  - Do not join on BSE scrip code or ISIN against daksham (those fields don't exist there).
  - Do not join on company name except as a last resort.
  - Do not mix the Stockscans labels with Screener labels in one column — pick one
    taxonomy (use Stockscans for "Target Industry").
````

---

### Provenance / where I looked
- Mapping A scraper + key logic: `scrapers/stockscans-classify.mjs` (`normSymbol`, `companyUrl`, `extractIndustry`), workflow `.github/workflows/stockscans-classification.yml`.
- Mapping B extraction: `scrapers/lib/company.mjs` (`parseCompanyPage` → `broad_sector/sector/industry`), workflow `.github/workflows/weekly-refresh.yml`.
- BSE-code handling (transient, not persisted): `scrapers/lib/docs.mjs` (`parseBseCode`), `scrapers/doc-harvester.mjs`.
- Data verified against `public/data/stockscans-classification.json`, `daksham-companies.json`, `daksham-universe.json`, and the `*-metadata.json` / `*-debug.json` files.
- Repo visibility (`public`) via the GitHub API.
