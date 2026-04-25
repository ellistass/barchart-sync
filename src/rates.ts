// Central bank interest rates.
//
// Strategy:
// - USD: fetched live from Alpha Vantage (FEDERAL_FUNDS_RATE series)
// - All others: read from CENTRAL_BANK_RATES env var (JSON config)
//
// Why env var for non-USD? Central bank rates change ~4-8x per year.
// When a bank meets, update the Railway env var. More reliable than
// any free-tier API that might disappear or rate-limit.
//
// Default rates are seeded below — verify and update as needed.

export interface CentralBankRate {
  currency: string        // e.g. "USD"
  country: string         // e.g. "United States"
  bankName: string        // e.g. "Federal Reserve"
  currentRate: number     // e.g. 5.25
  previousRate: number | null
  source: 'live' | 'config'
  lastUpdated: string     // ISO date
}

// ─── Default rates (update when central banks meet) ───────────────────────────
// These are loaded from CENTRAL_BANK_RATES env var if set,
// otherwise fall back to these defaults.
const DEFAULT_RATES: Omit<CentralBankRate, 'source'>[] = [
  { currency: 'EUR', country: 'Euro Area',    bankName: 'ECB',          currentRate: 3.15, previousRate: 3.40, lastUpdated: '2025-01-30' },
  { currency: 'GBP', country: 'United Kingdom', bankName: 'Bank of England', currentRate: 4.75, previousRate: 5.00, lastUpdated: '2025-02-06' },
  { currency: 'JPY', country: 'Japan',         bankName: 'Bank of Japan',   currentRate: 0.50, previousRate: 0.25, lastUpdated: '2025-01-24' },
  { currency: 'CAD', country: 'Canada',        bankName: 'Bank of Canada',  currentRate: 3.00, previousRate: 3.25, lastUpdated: '2025-01-29' },
  { currency: 'AUD', country: 'Australia',     bankName: 'RBA',             currentRate: 4.10, previousRate: 4.35, lastUpdated: '2025-02-18' },
  { currency: 'NZD', country: 'New Zealand',   bankName: 'RBNZ',            currentRate: 3.75, previousRate: 4.25, lastUpdated: '2025-02-19' },
  { currency: 'CHF', country: 'Switzerland',   bankName: 'SNB',             currentRate: 0.50, previousRate: 1.00, lastUpdated: '2025-03-20' },
  { currency: 'NOK', country: 'Norway',        bankName: 'Norges Bank',     currentRate: 4.50, previousRate: 4.50, lastUpdated: '2025-01-23' },
  { currency: 'SEK', country: 'Sweden',        bankName: 'Riksbank',        currentRate: 2.25, previousRate: 2.50, lastUpdated: '2025-02-05' },
]

// ─── USD: fetch live from Alpha Vantage ───────────────────────────────────────

async function fetchFedRate(): Promise<Omit<CentralBankRate, 'source'> | null> {
  const apiKey = process.env.ALPHA_VANTAGE_API_KEY
  if (!apiKey || apiKey === 'your-key-here') {
    console.warn('[rates] ALPHA_VANTAGE_API_KEY not set — skipping live USD rate')
    return null
  }

  try {
    const url = `https://www.alphavantage.co/query?function=FEDERAL_FUNDS_RATE&interval=monthly&apikey=${apiKey}`
    const res = await fetch(url, { headers: { Accept: 'application/json' } })
    if (!res.ok) throw new Error(`Alpha Vantage ${res.status}`)

    const json = await res.json()
    const series: Array<{ date: string; value: string }> = json.data ?? []
    if (series.length < 2) throw new Error('Insufficient data from Alpha Vantage')

    const latest = series[0]
    const previous = series[1]

    return {
      currency: 'USD',
      country: 'United States',
      bankName: 'Federal Reserve',
      currentRate: parseFloat(latest.value),
      previousRate: parseFloat(previous.value),
      lastUpdated: latest.date,
    }
  } catch (err) {
    console.warn('[rates] Failed to fetch live USD rate:', err instanceof Error ? err.message : err)
    return null
  }
}

// ─── Main export ──────────────────────────────────────────────────────────────

export async function fetchCentralBankRates(): Promise<CentralBankRate[]> {
  console.log('[rates] Loading central bank rates…')

  // Load config rates — from env var override or defaults
  let configRates = DEFAULT_RATES
  const envOverride = process.env.CENTRAL_BANK_RATES
  if (envOverride) {
    try {
      configRates = JSON.parse(envOverride)
      console.log('[rates] Loaded rates from CENTRAL_BANK_RATES env var')
    } catch {
      console.warn('[rates] Failed to parse CENTRAL_BANK_RATES env var — using defaults')
    }
  }

  // Fetch live USD rate
  const usdRate = await fetchFedRate()

  const rates: CentralBankRate[] = [
    // USD: live if available, config fallback
    usdRate
      ? { ...usdRate, source: 'live' as const }
      : { currency: 'USD', country: 'United States', bankName: 'Federal Reserve', currentRate: 4.25, previousRate: 4.50, lastUpdated: '2025-01-29', source: 'config' as const },
    // All others from config
    ...configRates.map(r => ({ ...r, source: 'config' as const })),
  ]

  rates.forEach(r =>
    console.log(`  [rates] ${r.currency}: ${r.currentRate}% (${r.source === 'live' ? '🟢 live' : '📋 config'})`)
  )

  return rates
}
