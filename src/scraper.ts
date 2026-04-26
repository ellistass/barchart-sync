import { chromium, Browser, Page, Response } from 'playwright'
import fs from 'fs'
import path from 'path'
import {
  BarchartRow,
  BarchartSnapshot,
  BarchartApiRow,
  PerformancePeriod,
  SurprisePeriod,
  MarketSnapshot,
} from './types'

// ─── Helpers ──────────────────────────────────────────────────────────────────

function toNum(v: unknown): number {
  if (typeof v === 'number') return v
  if (typeof v === 'string') {
    const n = parseFloat(v.replace(/[+%,]/g, '').trim())
    return isNaN(n) ? 0 : n
  }
  return 0
}

function parseRow(raw: BarchartApiRow): BarchartRow {
  const r = raw.raw ?? raw
  return {
    symbol: String(r.symbol ?? raw.symbol ?? '').replace(/^\^/, ''),
    name: String(r.symbolName ?? raw.symbolName ?? ''),
    latest: toNum(r.lastPrice ?? raw.lastPrice),
    change: toNum(r.priceChange ?? raw.priceChange),
    percentChange: toNum(r.percentChange ?? raw.percentChange),
    open: toNum(r.openPrice ?? raw.openPrice),
    high: toNum(r.highPrice ?? raw.highPrice),
    low: toNum(r.lowPrice ?? raw.lowPrice),
    standardDeviation: toNum(r.standardDeviation ?? raw.standardDeviation ?? (r as any).currentStandardDeviation ?? (raw as any).currentStandardDeviation),
    time: String(r.tradeTime ?? raw.tradeTime ?? ''),
  }
}

function parseApiResponse(json: { data?: BarchartApiRow[] }): BarchartRow[] {
  if (!json?.data || !Array.isArray(json.data)) return []
  return json.data.map(parseRow).filter(r => r.symbol)
}

// ─── Capture rows for ONE direction from a page load ─────────────────────────
//
// Barchart fires BOTH desc and asc API calls on every page load.
// We filter strictly by the orderDir we want so the two directions
// never bleed into each other.

async function captureDirection(
  page: Page,
  pageUrl: string,
  wantDir: 'desc' | 'asc',
  label: string,
): Promise<BarchartRow[]> {
  let rows: BarchartRow[] = []

  const handler = async (response: Response) => {
    if (!response.url().includes('/proxies/core-api/v1/quotes/get')) return
    if (response.status() !== 200) return
    if (rows.length > 0) return // already captured this direction
    try {
      const params = new URLSearchParams(new URL(response.url()).search)
      const dir = params.get('orderDir')
      if (dir !== wantDir) return // wrong direction — ignore
      const json = await response.json()
      const parsed = parseApiResponse(json)
      if (parsed.length > 0) {
        rows = parsed
        console.log(`  [${label}] orderDir=${dir} rows=${rows.length}`)
      }
    } catch {
      // ignore parse errors
    }
  }

  page.on('response', handler)
  try {
    await page.goto(pageUrl, { waitUntil: 'networkidle', timeout: 35_000 })
    await page.waitForTimeout(1500)

    // If bearish (asc) didn't load automatically, try clicking the Bearish tab
    if (wantDir === 'asc' && rows.length === 0) {
      try {
        const bearishBtn = page.locator('text=Bearish').first()
        await bearishBtn.click({ timeout: 5_000 })
        await page.waitForTimeout(2000)
      } catch {
        // Tab click failed — bearish data will be empty for this run
      }
    }
  } catch (err) {
    console.warn(`  [${label}] Navigation warning: ${err instanceof Error ? err.message : err}`)
  }
  page.off('response', handler)

  return rows
}

// ─── Scrape one market page (perf or surprises) → both bullish + bearish ──────

async function scrapeMarketPage(
  page: Page,
  perfUrl: string,
  label: string,
): Promise<{ bullish: BarchartRow[]; bearish: BarchartRow[] }> {
  // Navigate once for bullish (desc) — this is the default view
  const bullish = await captureDirection(page, perfUrl, 'desc', `${label}/bull`)

  // Navigate again for bearish (asc) — separate URL triggers the asc API call
  const bearishUrl = perfUrl.replace('orderDir=desc', 'orderDir=asc')
  const bearish = await captureDirection(page, bearishUrl, 'asc', `${label}/bear`)

  console.log(`  [${label}] final → bullish: ${bullish.length} rows, bearish: ${bearish.length} rows`)
  return { bullish, bearish }
}

// ─── Scrape one market (forex or futures) ─────────────────────────────────────

async function scrapeMarket(
  page: Page,
  market: 'forex' | 'futures',
): Promise<MarketSnapshot> {
  const basePerf = `https://www.barchart.com/${market}/performance-leaders`
  const baseSurp = `https://www.barchart.com/${market}/price-surprises`

  // Futures uses a different std dev field name than forex
  const stdDevField = market === 'futures' ? 'currentStandardDeviation' : 'standardDeviation'

  console.log(`\n[${market}] Fetching performance leaders…`)
  const perf = await scrapeMarketPage(
    page,
    `${basePerf}?viewName=main&orderBy=percentChange&orderDir=desc`,
    `${market}/perf`,
  )

  console.log(`[${market}] Fetching price surprises…`)
  const surp = await scrapeMarketPage(
    page,
    `${baseSurp}?viewName=main&orderBy=${stdDevField}&orderDir=desc`,
    `${market}/surp`,
  )

  const performance: { today: PerformancePeriod; fiveDay: PerformancePeriod | null } = {
    today: { bullish: perf.bullish, bearish: perf.bearish },
    fiveDay: null,
  }

  const surprises: SurprisePeriod = {
    bullish: surp.bullish,
    bearish: surp.bearish,
  }

  return { performance, surprises }
}

// ─── Main export ──────────────────────────────────────────────────────────────

export async function scrapeBarchart(): Promise<BarchartSnapshot> {
  const errors: string[] = []
  let browser: Browser | null = null

  try {
    console.log('[scraper] Launching Chromium…')
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    })

    const context = await browser.newContext({
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      viewport: { width: 1440, height: 900 },
    })

    const page = await context.newPage()

    // Warm up — establishes session cookies
    console.log('[scraper] Warming up session…')
    await page.goto('https://www.barchart.com', {
      waitUntil: 'domcontentloaded',
      timeout: 20_000,
    }).catch(() => {})

    const forex = await scrapeMarket(page, 'forex')
    const futures = await scrapeMarket(page, 'futures')

    await browser.close()
    browser = null

    const snapshot: BarchartSnapshot = {
      forex,
      futures,
      fetchedAt: new Date().toISOString(),
      errors,
    }

    // Write preview file for manual inspection + comparison with website
    const previewPath = path.join(process.cwd(), 'preview.json')
    fs.writeFileSync(previewPath, JSON.stringify(snapshot, null, 2))
    console.log(`\n[scraper] Preview written → ${previewPath}`)
    console.log('[scraper] Done.')

    return snapshot
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    errors.push(`Fatal scraper error: ${msg}`)
    console.error('[scraper] Fatal error:', msg)

    const empty: MarketSnapshot = {
      performance: { today: { bullish: [], bearish: [] }, fiveDay: null },
      surprises: { bullish: [], bearish: [] },
    }
    return {
      forex: empty,
      futures: empty,
      fetchedAt: new Date().toISOString(),
      errors,
    }
  } finally {
    if (browser) await browser.close().catch(() => {})
  }
}
