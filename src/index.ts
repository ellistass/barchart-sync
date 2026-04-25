import 'dotenv/config'
import crypto from 'crypto'
import cron from 'node-cron'
import { createClient } from '@supabase/supabase-js'
import { scrapeBarchart } from './scraper'
import { fetchEconomicCalendar } from './economic'
import { fetchCentralBankRates } from './rates'

// ─── Supabase client ──────────────────────────────────────────────────────────

const supabaseUrl = process.env.SUPABASE_URL
const supabaseKey = process.env.SUPABASE_SERVICE_KEY

if (!supabaseUrl || !supabaseKey) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY')
  process.exit(1)
}

const supabase = createClient(supabaseUrl, supabaseKey)

// ─── Helpers ──────────────────────────────────────────────────────────────────

function newId() {
  return crypto.randomUUID()
}

async function saveToTable(table: string, payload: Record<string, unknown>) {
  const { error } = await supabase.from(table).insert({ id: newId(), ...payload })
  if (error) {
    console.error(`[sync] Failed to save to ${table}:`, error.message)
  } else {
    console.log(`[sync] ✓ Saved to ${table}`)
  }
}

// ─── Main sync job ────────────────────────────────────────────────────────────

async function runSync(): Promise<void> {
  console.log(`\n${'─'.repeat(60)}`)
  console.log(`[sync] Starting at ${new Date().toISOString()}`)
  console.log(`${'─'.repeat(60)}`)

  // Run all three fetches in parallel
  const [barchartResult, calendarResult, ratesResult] = await Promise.allSettled([
    scrapeBarchart(),
    fetchEconomicCalendar(),
    fetchCentralBankRates(),
  ])

  // ── Barchart snapshot ───────────────────────────────────────────────────
  if (barchartResult.status === 'fulfilled') {
    const snap = barchartResult.value
    if (snap.errors.length > 0) console.warn('[sync] Barchart errors:', snap.errors)

    console.log('\n[sync] Barchart results:')
    console.log(`  Forex  perf   bullish: ${snap.forex.performance.today.bullish.length} rows`)
    console.log(`  Forex  perf   bearish: ${snap.forex.performance.today.bearish.length} rows`)
    console.log(`  Forex  surp   bullish: ${snap.forex.surprises.bullish.length} rows`)
    console.log(`  Forex  surp   bearish: ${snap.forex.surprises.bearish.length} rows`)
    console.log(`  Futures perf  bullish: ${snap.futures.performance.today.bullish.length} rows`)
    console.log(`  Futures perf  bearish: ${snap.futures.performance.today.bearish.length} rows`)
    console.log(`  Futures surp  bullish: ${snap.futures.surprises.bullish.length} rows`)
    console.log(`  Futures surp  bearish: ${snap.futures.surprises.bearish.length} rows`)

    await saveToTable('barchart_snapshots', {
      data: snap,
      errors: snap.errors,
    })
  } else {
    console.error('[sync] Barchart scrape failed:', barchartResult.reason)
  }

  // ── Economic calendar ───────────────────────────────────────────────────
  if (calendarResult.status === 'fulfilled') {
    const events = calendarResult.value
    const highImpact = events.filter(e => e.impact === 'High')
    console.log(`\n[sync] Economic calendar: ${events.length} events (${highImpact.length} high-impact)`)

    await saveToTable('economic_snapshots', { events })
  } else {
    console.error('[sync] Economic calendar failed:', calendarResult.reason)
  }

  // ── Central bank rates ──────────────────────────────────────────────────
  if (ratesResult.status === 'fulfilled') {
    const rates = ratesResult.value
    console.log(`\n[sync] Central bank rates: ${rates.length} currencies`)
    rates.forEach(r => console.log(`  ${r.currency} (${r.country}): ${r.currentRate}%`))

    await saveToTable('rates_snapshots', { rates })
  } else {
    console.error('[sync] Rates fetch failed:', ratesResult.reason)
  }

  console.log(`\n[sync] Run complete at ${new Date().toISOString()}`)
}

// ─── Entry point ─────────────────────────────────────────────────────────────

const runOnce = process.argv.includes('--once')

if (runOnce) {
  runSync()
    .then(() => {
      console.log('[sync] Exiting.')
      process.exit(0)
    })
    .catch(err => {
      console.error('[sync] Fatal error:', err)
      process.exit(1)
    })
} else {
  const schedule = process.env.CRON_SCHEDULE ?? '0 * * * *'
  console.log(`[sync] Scheduler starting. Cron: "${schedule}"`)

  // Run immediately on startup
  runSync().catch(console.error)

  cron.schedule(schedule, () => {
    runSync().catch(console.error)
  })
}
