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

// ─── Capture the first matching API response for a page load ──────────────────

async function capturePageData(page: Page, url: string, label: string): Promise<BarchartRow[]> {
  return new Promise(async (resolve) => {
    let resolved = false
    const captured: BarchartRow[] = []

    const handler = async (response: Response) => {
      if (!response.url().includes('/proxies/core-api/v1/quotes/get')) return
      if (response.status() !== 200) return
      try {
        const json = await response.json()
        const rows = parseApiResponse(json)
        const params = new URLSearchParams(new URL(response.url()).search)
        console.log(`  [capture:${label}] orderBy=${params.get('orderBy')} orderDir=${params.get('orderDir')} lists=${params.get('lists')} rows=${rows.length}`)
        if (rows.length > 0 && !resolved) {
          captured.push(...rows)
        }
      } catch {
        // ignore
      }
    }

    page.on('response', handler)

    try {
      await page.goto(url, { waitUntil: 'networkidle', timeout: 30_000 })
      await page.waitForTimeout(2000)
    } catch (err) {
      console.warn(`  [capture:${label}] Navigation warning: ${err instanceof Error ? err.message : err}`)
    }

    page.off('response', handler)

    if (!resolved) {
      resolved = true
      resolve(captured.slice(0, 10))
    }
  })
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

  console.log(`\n[${market}] Fetching performance leaders — bullish…`)
  const bullishPerf = await capturePageData(
    page,
    `${basePerf}?viewName=main&orderBy=percentChange&orderDir=desc`,
    `${market}/perf/bull`,
  )

  console.log(`[${market}] Fetching performance leaders — bearish…`)
  const bearishPerf = await capturePageData(
    page,
    `${basePerf}?viewName=main&orderBy=percentChange&orderDir=asc`,
    `${market}/perf/bear`,
  )

  console.log(`[${market}] Fetching price surprises — bullish…`)
  const bullishSurp = await capturePageData(
    page,
    `${baseSurp}?viewName=main&orderBy=${stdDevField}&orderDir=desc`,
    `${market}/surp/bull`,
  )

  console.log(`[${market}] Fetching price surprises — bearish…`)
  const bearishSurp = await capturePageData(
    page,
    `${baseSurp}?viewName=main&orderBy=${stdDevField}&orderDir=asc`,
    `${market}/surp/bear`,
  )

  const performance: { today: PerformancePeriod; fiveDay: PerformancePeriod | null } = {
    today: { bullish: bullishPerf, bearish: bearishPerf },
    fiveDay: null, // Phase 2
  }

  const surprises: SurprisePeriod = {
    bullish: bullishSurp,
    bearish: bearishSurp,
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
