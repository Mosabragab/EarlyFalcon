import { createClient } from '@supabase/supabase-js'
import { RSI, MACD, EMA, ATR } from 'technicalindicators'
import fetch from 'node-fetch'

console.log('🔍 Environment Check:')
console.log('SUPABASE_URL:', process.env.SUPABASE_URL ? 'SET ✅' : 'MISSING ❌')
console.log('SUPABASE_SERVICE_KEY:', process.env.SUPABASE_SERVICE_KEY ? 'SET ✅' : 'MISSING ❌')

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
  console.error('❌ Missing environment variables!')
  process.exit(1)
}

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
)

console.log('🦅 Early Falcon Indicator Calculator v2.0 - Real-Time')
console.log('=' .repeat(60))

const SYMBOLS = [
  'AAVEUSD', 'ADAUSD', 'ALGOUSD', 'APTUSD', 'ARBUSD', 'ATOMUSD',
  'AVAXUSD', 'BNBUSD', 'CROUSD', 'DASHUSD', 'DOGEUSD', 'DOTUSD',
  'ETCUSD', 'ETHUSD', 'FILUSD', 'GRTUSD', 'HBARUSD', 'ICPUSD',
  'IMXUSD', 'INJUSD', 'LINKUSD', 'LTCUSD', 'MNTUSD', 'NEARUSD',
  'OPUSD', 'PEPEUSD', 'POLUSD', 'RENDERUSD', 'SEIUSD', 'SHIBUSD',
  'SOLUSD', 'SUIUSD', 'TONUSD', 'TRXUSD', 'UNIUSD', 'XBTUSD',
  'XLMUSD', 'XRPUSD', 'ZECUSD'
]

const KRAKEN_PAIRS = {
  'XBTUSD': 'XXBTZUSD',
  'ETHUSD': 'XETHZUSD',
  'DOGEUSD': 'XDGUSD',
  'LTCUSD': 'XLTCZUSD',
  'XRPUSD': 'XXRPZUSD',
  'XLMUSD': 'XXLMZUSD'
}

async function fetchLatestCandle(symbol) {
  try {
    const krakenPair = KRAKEN_PAIRS[symbol] || symbol
    const url = `https://api.kraken.com/0/public/OHLC?pair=${krakenPair}&interval=15`
    
    const response = await fetch(url)
    const data = await response.json()
    
    if (data.error?.length > 0) return null
    
    const pairKey = Object.keys(data.result).find(k => k !== 'last')
    if (!pairKey) return null
    
    const candles = data.result[pairKey]
    const latest = candles[candles.length - 1]
    
    return {
      symbol,
      timestamp: new Date(latest[0] * 1000).toISOString(),
      interval: '15min',
      open_price: parseFloat(latest[1]),
      high_price: parseFloat(latest[2]),
      low_price: parseFloat(latest[3]),
      close_price: parseFloat(latest[4]),
      volume: parseFloat(latest[6])
    }
  } catch (error) {
    return null
  }
}

async function updateCandles() {
  console.log(`\n📥 [${new Date().toLocaleTimeString()}] Fetching latest candles from Kraken...`)
  let updated = 0
  
  for (const symbol of SYMBOLS) {
    const candle = await fetchLatestCandle(symbol)
    if (!candle) continue
    
    const { error } = await supabase
      .from('market_data_ohlcv')
      .upsert([candle], { 
        onConflict: 'symbol,timestamp,interval',
        ignoreDuplicates: true 
      })
    
    if (!error) updated++
    await new Promise(r => setTimeout(r, 1100))
  }
  
  console.log(`✅ Updated ${updated}/${SYMBOLS.length} candles`)
}

async function calculateIndicators() {
  console.log(`\n🔢 [${new Date().toLocaleTimeString()}] Calculating indicators...`)

  try {
    let successCount = 0

    for (const symbol of SYMBOLS) {
      try {
        const { data: candles } = await supabase
          .from('market_data_ohlcv')
          .select('*')
          .eq('symbol', symbol)
          .eq('interval', '15min')
          .order('timestamp', { ascending: false })
          .limit(50)

        if (!candles || candles.length < 14) continue

        const orderedCandles = candles.reverse()
        const closes = orderedCandles.map(c => parseFloat(c.close_price))
        const highs = orderedCandles.map(c => parseFloat(c.high_price))
        const lows = orderedCandles.map(c => parseFloat(c.low_price))

        const rsiValues = RSI.calculate({ values: closes, period: 14 })
        const rsi = rsiValues[rsiValues.length - 1]

        const macdValues = MACD.calculate({
          values: closes,
          fastPeriod: 12,
          slowPeriod: 26,
          signalPeriod: 9
        })
        const macd = macdValues[macdValues.length - 1]

        const ema21Values = EMA.calculate({ values: closes, period: 20 })
        const ema21 = ema21Values[ema21Values.length - 1]

        const ema55Values = EMA.calculate({ values: closes, period: 50 })
        const ema55 = ema55Values[ema55Values.length - 1]

        const atrValues = ATR.calculate({
          high: highs,
          low: lows,
          close: closes,
          period: 14
        })
        const atr = atrValues[atrValues.length - 1]

        const latestCandle = orderedCandles[orderedCandles.length - 1]

        await supabase
          .from('technical_indicators')
          .upsert({
            symbol,
            timestamp: latestCandle.timestamp,
            interval: '15min',
            rsi: rsi || null,
            macd_histogram: macd?.histogram || null,
            macd_line: macd?.MACD || null,
            macd_signal: macd?.signal || null,
            ema_21: ema21 || null,
            ema_55: ema55 || null,
            atr: atr || null
          }, { onConflict: 'symbol,timestamp,interval' })

        console.log(`✅ ${symbol}: RSI=${rsi?.toFixed(2)} @ ${new Date(latestCandle.timestamp).toLocaleTimeString()}`)
        successCount++

      } catch (error) {
        console.error(`❌ ${symbol}: ${error.message}`)
      }
    }

    console.log(`✨ Calculated ${successCount}/${SYMBOLS.length} symbols`)

  } catch (error) {
    console.error('💥 Fatal error:', error.message)
  }
}

async function run() {
  await updateCandles()
  await calculateIndicators()
}

run()

setInterval(run, 900000)
