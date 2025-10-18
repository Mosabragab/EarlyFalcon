// ============================================
// FETCH MARKET DATA - 40 SYMBOLS
// Runs every 15 minutes
// ============================================

import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createSupabaseClient } from '../_shared/supabase-client.ts'
import { ALL_SYMBOLS } from '../_shared/symbols.ts'

interface OHLCCandle {
  symbol: string
  timestamp: Date
  interval: string
  open: number
  high: number
  low: number
  close: number
  volume: number
}

serve(async (req) => {
  try {
    const supabase = createSupabaseClient()
    const results = []
    const errors = []
    
    console.log(`📊 Fetching 15m data for ${ALL_SYMBOLS.length} symbols...`)
    
    for (const symbol of ALL_SYMBOLS) {
      try {
        // Fetch from Kraken
        const response = await fetch(
          `https://api.kraken.com/0/public/OHLC?pair=${symbol}&interval=15`
        )
        const data = await response.json()
        
        if (data.error && data.error.length > 0) {
          errors.push({ symbol, error: data.error.join(', ') })
          continue
        }
        
        // Get the result key (Kraken returns dynamic keys)
        const resultKey = Object.keys(data.result).find(k => k !== 'last')
        if (!resultKey) {
          errors.push({ symbol, error: 'No data returned' })
          continue
        }
        
        const ohlcData = data.result[resultKey]
        
        // Get last 100 candles (for indicators calculation)
        const candles = ohlcData.slice(-100).map((candle: any) => ({
          symbol,
          timestamp: new Date(candle[0] * 1000),
          interval: '15m',
          open: parseFloat(candle[1]),
          high: parseFloat(candle[2]),
          low: parseFloat(candle[3]),
          close: parseFloat(candle[4]),
          volume: parseFloat(candle[6])
        }))
        
        // Insert into database (upsert to handle duplicates)
        for (const candle of candles) {
          const { error: insertError } = await supabase
            .from('market_data_ohlcv')
            .upsert({
              symbol: candle.symbol,
              timestamp: candle.timestamp.toISOString(),
              interval: candle.interval,
              open_price: candle.open,
              high_price: candle.high,
              low_price: candle.low,
              close_price: candle.close,
              volume: candle.volume
            }, {
              onConflict: 'symbol,timestamp,interval'
            })
          
          if (insertError) {
            console.error(`Error inserting ${symbol}:`, insertError)
          }
        }
        
        results.push({
          symbol,
          candles: candles.length,
          latest_price: candles[candles.length - 1].close,
          status: 'success'
        })
        
      } catch (error) {
        errors.push({
          symbol,
          error: error.message
        })
      }
      
      // Small delay to avoid rate limits
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    
    console.log(`✅ Success: ${results.length}/${ALL_SYMBOLS.length} symbols`)
    if (errors.length > 0) {
      console.error(`❌ Errors: ${errors.length} symbols failed`)
    }
    
    return new Response(
      JSON.stringify({
        success: true,
        total_symbols: ALL_SYMBOLS.length,
        successful: results.length,
        failed: errors.length,
        results,
        errors: errors.length > 0 ? errors : undefined
      }),
      { 
        headers: { "Content-Type": "application/json" },
        status: 200
      }
    )
    
  } catch (error) {
    console.error('Fatal error:', error)
    return new Response(
      JSON.stringify({ 
        success: false,
        error: error.message 
      }),
      { 
        headers: { "Content-Type": "application/json" },
        status: 500
      }
    )
  }
})
