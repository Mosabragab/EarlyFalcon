import { createClient } from '@supabase/supabase-js'
import { RSI, MACD, EMA, ATR } from 'technicalindicators'
import cron from 'node-cron'
import dotenv from 'dotenv'

dotenv.config()

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
)

console.log('🦅 Early Falcon Indicator Service v1.0')
console.log('=' .repeat(50))

// Calculate indicators for all symbols
async function calculateIndicators() {
  const startTime = Date.now()
  const now = new Date()
  const currentTimestamp = new Date(Math.floor(now.getTime() / 900000) * 900000).toISOString()
  
  console.log(`\n📈 Starting calculation at ${currentTimestamp}`)
  
  try {
    // Get unique symbols
    const { data: symbolsData, error: symbolsError } = await supabase
      .rpc('get_unique_symbols_15m')
    
    if (symbolsError) throw symbolsError
    if (!symbolsData || symbolsData.length === 0) {
      throw new Error('No symbols found')
    }
    
    const symbols = symbolsData.map(s => s.symbol)
    console.log(`📊 Processing ${symbols.length} symbols...`)
    
    let successCount = 0
    let errorCount = 0
    
    for (const symbol of symbols) {
      try {
        // Fetch last 100 candles
        const { data: candles, error: candlesError } = await supabase
          .from('market_data_ohlcv')
          .select('close_price, high_price, low_price, volume')
          .eq('symbol', symbol)
          .eq('interval', '15m')
          .order('timestamp', { ascending: true })
          .limit(100)
        
        if (candlesError) throw candlesError
        
        if (!candles || candles.length < 55) {
          console.log(`⏭️  ${symbol}: Not enough data (${candles?.length || 0}/55)`)
          errorCount++
          continue
        }
        
        // Convert to numbers
        const closes = candles.map(c => Number(c.close_price))
        const highs = candles.map(c => Number(c.high_price))
        const lows = candles.map(c => Number(c.low_price))
        const volumes = candles.map(c => Number(c.volume))
        
        // Calculate indicators
        const rsiValues = RSI.calculate({ values: closes, period: 14 })
        const macdValues = MACD.calculate({
          values: closes,
          fastPeriod: 12,
          slowPeriod: 26,
          signalPeriod: 9,
          SimpleMAOscillator: false,
          SimpleMASignal: false
        })
        const ema21Values = EMA.calculate({ values: closes, period: 21 })
        const ema55Values = EMA.calculate({ values: closes, period: 55 })
        const atrValues = ATR.calculate({ high: highs, low: lows, close: closes, period: 14 })
        
        const volumeSMA = volumes.slice(-20).reduce((a, b) => a + b, 0) / 20
        
        // Get latest values
        const latestRSI = rsiValues[rsiValues.length - 1]
        const latestMACD = macdValues[macdValues.length - 1]
        const latestEMA21 = ema21Values[ema21Values.length - 1]
        const latestEMA55 = ema55Values[ema55Values.length - 1]
        const latestATR = atrValues[atrValues.length - 1]
        
        // Insert using the SQL function we created
        const { error: insertError } = await supabase.rpc('upsert_indicator', {
          p_symbol: symbol,
          p_timestamp: currentTimestamp,
          p_interval: '15m',
          p_rsi: latestRSI,
          p_macd_histogram: latestMACD?.histogram || 0,
          p_macd_line: latestMACD?.MACD || 0,
          p_macd_signal: latestMACD?.signal || 0,
          p_ema_21: latestEMA21,
          p_ema_55: latestEMA55,
          p_atr: latestATR,
          p_volume_sma: volumeSMA
        })
        
        if (insertError) {
          console.log(`❌ ${symbol}: ${insertError.message}`)
          errorCount++
        } else {
          successCount++
          const trend = latestEMA21 > latestEMA55 ? '🟢' : '🔴'
          console.log(`${trend} ${symbol}: RSI=${latestRSI.toFixed(1)} EMA21=${latestEMA21.toFixed(2)}`)
        }
        
      } catch (err) {
        console.log(`❌ ${symbol}: ${err.message}`)
        errorCount++
      }
    }
    
    const duration = ((Date.now() - startTime) / 1000).toFixed(2)
    console.log(`\n✅ Complete: ${successCount}/${symbols.length} success, ${errorCount} errors`)
    console.log(`⏱️  Duration: ${duration}s`)
    
  } catch (error) {
    console.error('❌ Fatal error:', error.message)
  }
}

// Run immediately on start
console.log('🚀 Running initial calculation...')
calculateIndicators()

// Schedule to run every 15 minutes
cron.schedule('*/15 * * * *', () => {
  console.log('\n' + '='.repeat(50))
  calculateIndicators()
})

console.log('⏰ Scheduled: Every 15 minutes')
console.log('🎯 Waiting for next cycle...\n')
