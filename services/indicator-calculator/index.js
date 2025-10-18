import { createClient } from '@supabase/supabase-js'
import { RSI, MACD, EMA, ATR } from 'technicalindicators'

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

console.log('🦅 Early Falcon Indicator Calculator v1.0')
console.log('=' .repeat(60))

async function calculateIndicators() {
  const startTime = Date.now()
  console.log(`\n⏰ [${new Date().toLocaleTimeString()}] Starting calculation...`)

  try {
    // Get all symbols from market_data_ohlcv
    const { data: symbolsData, error: symError } = await supabase
      .from('market_data_ohlcv')
      .select('symbol')
      .order('symbol')
    
    if (symError) throw symError
    
    const symbols = [...new Set(symbolsData.map(s => s.symbol))]
    console.log(`📊 Found ${symbols.length} symbols in database`)

    let successCount = 0
    let errorCount = 0

    for (const symbol of symbols) {
      try {
        // Get last 50 candles for this symbol
        const { data: candles, error: candleError } = await supabase
          .from('market_data_ohlcv')
          .select('*')
          .eq('symbol', symbol)
          .eq('interval', '15min')
          .order('timestamp', { ascending: false })
          .limit(50)

        if (candleError) throw candleError
        if (!candles || candles.length < 14) {
          console.log(`⚠️  ${symbol}: Not enough data (${candles?.length || 0} candles)`)
          continue
        }

        // Reverse for chronological order
        const orderedCandles = candles.reverse()
        
        const closes = orderedCandles.map(c => parseFloat(c.close_price))
        const highs = orderedCandles.map(c => parseFloat(c.high_price))
        const lows = orderedCandles.map(c => parseFloat(c.low_price))

        // Calculate indicators
        const rsiValues = RSI.calculate({ values: closes, period: 14 })
        const rsi = rsiValues[rsiValues.length - 1]

        const macdValues = MACD.calculate({
          values: closes,
          fastPeriod: 12,
          slowPeriod: 26,
          signalPeriod: 9
        })
        const macd = macdValues[macdValues.length - 1]

        const ema20Values = EMA.calculate({ values: closes, period: 20 })
        const ema21 = ema20Values[ema20Values.length - 1]

        const ema55Values = EMA.calculate({ values: closes, period: 50 })
        const ema55 = ema55Values[ema55Values.length - 1]

        const atrValues = ATR.calculate({
          high: highs,
          low: lows,
          close: closes,
          period: 14
        })
        const atr = atrValues[atrValues.length - 1]

        // Get latest candle timestamp
        const latestCandle = orderedCandles[orderedCandles.length - 1]

        // Insert into technical_indicators table
        const { error: insertError } = await supabase
          .from('technical_indicators')
          .upsert({
            symbol: symbol,
            timestamp: latestCandle.timestamp,
            interval: '15min',
            rsi: rsi || null,
            macd_histogram: macd?.histogram || null,
            macd_line: macd?.MACD || null,
            macd_signal: macd?.signal || null,
            ema_21: ema21 || null,
            ema_55: ema55 || null,
            atr: atr || null
          }, { 
            onConflict: 'symbol,timestamp,interval',
            ignoreDuplicates: false 
          })

        if (insertError) throw insertError

        console.log(`✅ ${symbol}: RSI=${rsi?.toFixed(2)} MACD=${macd?.histogram?.toFixed(4)} EMA21=${ema21?.toFixed(2)}`)
        successCount++

      } catch (error) {
        console.error(`❌ ${symbol}: ${error.message}`)
        errorCount++
      }
    }

    const duration = ((Date.now() - startTime) / 1000).toFixed(2)
    console.log(`\n✨ Complete in ${duration}s`)
    console.log(`✅ Success: ${successCount}/${symbols.length}`)
    if (errorCount > 0) console.log(`❌ Errors: ${errorCount}`)

  } catch (error) {
    console.error('💥 Fatal error:', error.message)
  }
}

// Run immediately
calculateIndicators()

// Keep process alive for scheduled runs (Railway will restart if it exits)
setInterval(() => {
  console.log(`\n💓 [${new Date().toLocaleTimeString()}] Running indicators...`)
  calculateIndicators()
}, 900000) // Every 15 minutes
