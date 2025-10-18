import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createSupabaseClient } from '../_shared/supabase-client.ts'
import { RSI, MACD, EMA, ATR } from 'https://esm.sh/technicalindicators@3.1.0'

serve(async (req) => {
  try {
    const supabase = createSupabaseClient()
    const now = new Date()
    const currentTimestamp = new Date(Math.floor(now.getTime() / 900000) * 900000).toISOString()
    
    console.log(`📈 Calculating at ${currentTimestamp}`)
    
    const { data: symbolsData } = await supabase.rpc('get_unique_symbols_15m')
    
    if (!symbolsData || symbolsData.length === 0) {
      throw new Error('No symbols found')
    }
    
    const uniqueSymbols = symbolsData.map(s => s.symbol)
    const results = []
    const errors = []
    
    for (const symbol of uniqueSymbols) {
      try {
        const { data: candles } = await supabase
          .from('market_data_ohlcv')
          .select('close_price, high_price, low_price, volume')
          .eq('symbol', symbol)
          .eq('interval', '15m')
          .order('timestamp', { ascending: true })
          .limit(100)
        
        if (!candles || candles.length < 55) continue
        
        const closes = candles.map(c => Number(c.close_price))
        const highs = candles.map(c => Number(c.high_price))
        const lows = candles.map(c => Number(c.low_price))
        const volumes = candles.map(c => Number(c.volume))
        
        const rsi = RSI.calculate({ values: closes, period: 14 })
        const macd = MACD.calculate({ values: closes, fastPeriod: 12, slowPeriod: 26, signalPeriod: 9, SimpleMAOscillator: false, SimpleMASignal: false })
        const ema21 = EMA.calculate({ values: closes, period: 21 })
        const ema55 = EMA.calculate({ values: closes, period: 55 })
        const atr = ATR.calculate({ high: highs, low: lows, close: closes, period: 14 })
        
        const volSMA = volumes.slice(-20).reduce((a, b) => a + b, 0) / 20
        
        const data = {
          symbol,
          timestamp: currentTimestamp,
          interval: '15m',
          rsi: rsi[rsi.length - 1],
          macd_histogram: macd[macd.length - 1]?.histogram || 0,
          macd_line: macd[macd.length - 1]?.MACD || 0,
          macd_signal: macd[macd.length - 1]?.signal || 0,
          ema_21: ema21[ema21.length - 1],
          ema_55: ema55[ema55.length - 1],
          atr: atr[atr.length - 1],
          volume_sma: volSMA
        }
        
        // Use raw SQL for guaranteed upsert
        const { error } = await supabase.rpc('upsert_indicator', data)
        
        if (error) {
          errors.push({ symbol, error: error.message })
        } else {
          results.push(symbol)
        }
      } catch (err) {
        errors.push({ symbol, error: err.message })
      }
    }
    
    console.log(`✅ ${results.length}/${uniqueSymbols.length} updated`)
    
    return new Response(JSON.stringify({ success: true, processed: results.length, total: uniqueSymbols.length }), { 
      headers: { "Content-Type": "application/json" } 
    })
  } catch (error) {
    console.error('Fatal:', error)
    return new Response(JSON.stringify({ success: false, error: error.message }), { 
      headers: { "Content-Type": "application/json" }, status: 500 
    })
  }
})
