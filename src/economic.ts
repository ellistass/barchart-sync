// Fetches the full ForexFactory economic calendar for the current week.
// Stores ALL events (not just today) so the AI can see upcoming high-impact news.

export interface EconomicEvent {
  title: string
  country: string       // currency code e.g. "USD"
  date: string          // ISO datetime
  impact: 'High' | 'Medium' | 'Low' | 'Holiday'
  forecast: string | null
  previous: string | null
  actual: string | null
}

const FF_SUPPORTED = new Set([
  'USD', 'EUR', 'GBP', 'JPY', 'CAD', 'AUD', 'NZD', 'CHF', 'NOK', 'SEK',
])

export async function fetchEconomicCalendar(): Promise<EconomicEvent[]> {
  console.log('[economic] Fetching ForexFactory weekly calendar…')

  const res = await fetch('https://nfs.faireconomy.media/ff_calendar_thisweek.json', {
    headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0' },
  })

  if (!res.ok) {
    throw new Error(`ForexFactory fetch failed: ${res.status} ${res.statusText}`)
  }

  const raw: Array<{
    title: string
    country: string
    date: string
    impact: string
    forecast: string
    previous: string
    actual: string
  }> = await res.json()

  const events = raw
    .filter(e => FF_SUPPORTED.has(e.country))
    .map(e => ({
      title: e.title,
      country: e.country,
      date: e.date,
      impact: (['High', 'Medium', 'Low', 'Holiday'].includes(e.impact)
        ? e.impact
        : 'Low') as EconomicEvent['impact'],
      forecast: e.forecast || null,
      previous: e.previous || null,
      actual: e.actual || null,
    }))

  console.log(`[economic] Got ${events.length} events (${events.filter(e => e.impact === 'High').length} high-impact)`)
  return events
}
