export interface BarchartRow {
  symbol: string
  name: string
  latest: number
  change: number
  percentChange: number
  open: number
  high: number
  low: number
  standardDeviation?: number
  time: string
}

export interface PerformancePeriod {
  bullish: BarchartRow[]  // top 10 gainers
  bearish: BarchartRow[]  // top 10 losers
}

export interface SurprisePeriod {
  bullish: BarchartRow[]  // top 10 highest positive std dev
  bearish: BarchartRow[]  // top 10 highest negative std dev
}

export interface MarketSnapshot {
  performance: {
    today: PerformancePeriod
    fiveDay: PerformancePeriod | null
  }
  surprises: SurprisePeriod
}

export interface BarchartSnapshot {
  forex: MarketSnapshot
  futures: MarketSnapshot
  fetchedAt: string
  errors: string[]
}

// Raw shape returned by Barchart's internal API
export interface BarchartApiRow {
  symbol?: string
  symbolName?: string
  lastPrice?: number | string
  priceChange?: number | string
  percentChange?: number | string
  openPrice?: number | string
  highPrice?: number | string
  lowPrice?: number | string
  standardDeviation?: number | string
  tradeTime?: string
  raw?: {
    symbol?: string
    symbolName?: string
    lastPrice?: number
    priceChange?: number
    percentChange?: number
    openPrice?: number
    highPrice?: number
    lowPrice?: number
    standardDeviation?: number
    tradeTime?: string
  }
}
