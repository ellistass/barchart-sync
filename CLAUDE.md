# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

---

## What This Is

**barchart-sync** — A standalone Node.js service that scrapes Barchart.com for forex and futures market data, fetches the ForexFactory economic calendar, and fetches central bank interest rates. Writes everything to Supabase so the `elistas-dashboard` can read it without hitting external APIs directly.

Runs as a **GitHub Actions workflow** — not Railway. Fires hourly Mon–Fri and on Sunday 10pm–midnight WAT (UTC 21:00–23:00) for market open coverage.

---

## Commands

```bash
npm run sync:now     # run one sync immediately (ts-node, no cron)
npm run dev          # run with cron scheduler (runs immediately then on schedule)
npm run build        # compile TypeScript to dist/
npm start            # run compiled output (production)
```

**For local testing**, always use `npm run sync:now`. It runs once and exits.

**Playwright browsers** must be installed before the scraper will work:
```bash
npx playwright install chromium
```
This only needs to be done once per machine. GitHub Actions installs it automatically via `npx playwright install chromium --with-deps`.

---

## Architecture

### Source files

| File | Purpose |
|---|---|
| `src/index.ts` | Entry point — runs all three fetches in parallel via `Promise.allSettled`, saves results to Supabase, handles `--once` flag vs cron mode |
| `src/scraper.ts` | Playwright-based Barchart scraper — intercepts Barchart's internal `/proxies/core-api/v1/quotes/get` XHR responses |
| `src/economic.ts` | Fetches ForexFactory weekly calendar from `nfs.faireconomy.media/ff_calendar_thisweek.json` |
| `src/rates.ts` | Central bank rates — USD live from Alpha Vantage, all others from `CENTRAL_BANK_RATES` env var or hardcoded defaults |
| `src/types.ts` | Shared TypeScript interfaces: `BarchartRow`, `BarchartSnapshot`, `MarketSnapshot`, `BarchartApiRow` |

### Scraper approach (`src/scraper.ts`)

Barchart.com loads table data via internal XHR requests. The scraper uses Playwright to:
1. Launch headless Chromium
2. Navigate to each Barchart performance/surprises page
3. Intercept network responses matching `/proxies/core-api/v1/quotes/get`
4. Parse the JSON payload using `parseApiResponse()`

The response shape from Barchart uses either a flat `{ data: BarchartApiRow[] }` or a nested `row.raw` structure — `parseRow()` handles both variants.

**Key normalisation in `parseRow()`**: `standardDeviation` may also come as `currentStandardDeviation` in older API responses. Both are checked.

### Supabase table names

The service writes directly to Supabase using the JS client (bypasses Prisma). Table names:

| Data | Table |
|---|---|
| Barchart snapshot | `barchart_snapshots` |
| Economic calendar | `economic_snapshots` |
| Central bank rates | `rates_snapshots` |

Each insert is a new row with a UUID — the dashboard reads the latest row by `fetchedAt DESC`. Old rows accumulate (no cleanup yet).

### Central bank rates update pattern

Non-USD rates **do not auto-update** — they are hardcoded in `src/rates.ts` `DEFAULT_RATES`. When a central bank meets and changes rates:

1. Update the `DEFAULT_RATES` array in `src/rates.ts`, OR
2. Set `CENTRAL_BANK_RATES` env var in GitHub Actions secrets as a JSON array (same shape as `DEFAULT_RATES`)

Option 2 (env var) avoids a code deploy. Option 1 is preferred for permanent changes.

USD rate is fetched live from Alpha Vantage `FEDERAL_FUNDS_RATE` monthly series on every sync run.

---

## Output shape saved to Supabase

The full `BarchartSnapshot` written to `barchart_snapshots.data`:

```typescript
{
  forex: {
    performance: {
      today: { bullish: BarchartRow[], bearish: BarchartRow[] },
      fiveDay: { bullish: BarchartRow[], bearish: BarchartRow[] } | null
    },
    surprises: { bullish: BarchartRow[], bearish: BarchartRow[] }
  },
  futures: {
    performance: {
      today: { bullish: BarchartRow[], bearish: BarchartRow[] },
      fiveDay: null
    },
    surprises: { bullish: BarchartRow[], bearish: BarchartRow[] }
  },
  fetchedAt: string,   // ISO timestamp
  errors: string[]
}
```

**Important**: The `elistas-dashboard` consumes ALL rows from `bullish` and `bearish` arrays — no slicing. Ensure the scraper captures the full table, not just the visible viewport.

---

## Environment variables

```
SUPABASE_URL          https://hjlnhkwxsicwpaetaiul.supabase.co
SUPABASE_SERVICE_KEY  Service role key — bypasses RLS for direct inserts
ALPHA_VANTAGE_API_KEY IOYLDCU5X7SNXGCL — for live USD Federal Funds Rate
CRON_SCHEDULE         Optional override, default "0 * * * *"
CENTRAL_BANK_RATES    Optional JSON array to override hardcoded non-USD rates
```

All secrets live in GitHub Actions → Settings → Secrets and variables → Actions.

---

## GitHub Actions schedule

```yaml
# Monday–Friday: every hour
- cron: '0 * * * 1-5'
# Sunday: 21:00–23:00 UTC (market open)
- cron: '0 21-23 * * 0'
```

Manual trigger available via `workflow_dispatch` in the GitHub Actions UI.

---

## Debugging a failed sync

1. Check GitHub Actions run logs — each section (`[scraper]`, `[economic]`, `[rates]`) logs row counts
2. Look for `[sync] Barchart errors:` in the log — errors are non-fatal (still saves partial data)
3. Run locally: `npm run sync:now` — console shows row counts per table section
4. Check `barchart_snapshots` in Supabase Table Editor — confirm a new row was inserted
5. Hit `https://elistas-dashboard.vercel.app/api/market-data/raw` to see exactly what the dashboard reads
