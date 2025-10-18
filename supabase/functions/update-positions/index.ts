// ============================================
// UPDATE POSITIONS - Real-time P&L
// Runs every 1 minute
// ============================================

import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createSupabaseClient } from '../_shared/supabase-client.ts'
import { KrakenClient } from '../_shared/kraken-client.ts'

serve(async (req) => {
  try {
    const supabase = createSupabaseClient()
    
    // Get all active positions
    const { data: positions } = await supabase
      .from('positions')
      .select(`
        *,
        users!inner(
          trade_mode,
          kraken_api_key,
          kraken_api_secret
        )
      `)
      .eq('is_active', true)
    
    if (!positions || positions.length === 0) {
      return new Response(
        JSON.stringify({ 
          success: true,
          message: 'No active positions'
        }),
        { headers: { "Content-Type": "application/json" } }
      )
    }
    
    console.log(`🔄 Updating ${positions.length} positions...`)
    
    // Group by symbol to minimize API calls
    const symbolMap = new Map()
    positions.forEach(pos => {
      if (!symbolMap.has(pos.symbol)) {
        symbolMap.set(pos.symbol, [])
      }
      symbolMap.get(pos.symbol).push(pos)
    })
    
    const updates = []
    
    for (const [symbol, symbolPositions] of symbolMap) {
      try {
        let currentPrice
        
        // Get current price based on trade mode
        const samplePosition = symbolPositions[0]
        
        if (samplePosition.users.trade_mode === 'live') {
          // LIVE: Get real-time price from Kraken
          const kraken = new KrakenClient({
            apiKey: samplePosition.users.kraken_api_key,
            apiSecret: samplePosition.users.kraken_api_secret
          })
          
          const ticker = await kraken.getTicker(symbol)
          if (ticker.error && ticker.error.length > 0) {
            console.error(`Kraken error for ${symbol}:`, ticker.error)
            continue
          }
          
          const tickerData = ticker.result[Object.keys(ticker.result)[0]]
          currentPrice = parseFloat(tickerData.c[0]) // Last trade price
          
        } else {
          // PAPER: Use our stored data
          const { data: marketData } = await supabase
            .from('market_data_ohlcv')
            .select('close_price')
            .eq('symbol', symbol)
            .eq('interval', '15m')
            .order('timestamp', { ascending: false })
            .limit(1)
            .single()
          
          if (!marketData) {
            console.error(`No market data for ${symbol}`)
            continue
          }
          
          currentPrice = marketData.close_price
        }
        
        // Update each position for this symbol
        for (const position of symbolPositions) {
          const unrealizedPnl = position.side === 'LONG'
            ? (currentPrice - position.entry_price) * position.quantity
            : (position.entry_price - currentPrice) * position.quantity
          
          const unrealizedPnlPct = (unrealizedPnl / position.entry_value) * 100
          
          await supabase
            .from('positions')
            .update({
              current_price: currentPrice,
              unrealized_pnl: unrealizedPnl,
              unrealized_pnl_pct: unrealizedPnlPct,
              updated_at: new Date().toISOString()
            })
            .eq('id', position.id)
          
          updates.push({
            position_id: position.id,
            symbol,
            current_price: currentPrice,
            pnl: unrealizedPnl.toFixed(2)
          })
        }
        
      } catch (error) {
        console.error(`Error updating ${symbol}:`, error.message)
      }
    }
    
    // Update portfolio unrealized P&L
    const { data: portfolios } = await supabase
      .from('portfolios')
      .select('id, user_id')
    
    for (const portfolio of portfolios || []) {
      const { data: portfolioPositions } = await supabase
        .from('positions')
        .select('unrealized_pnl')
        .eq('portfolio_id', portfolio.id)
        .eq('is_active', true)
      
      const totalUnrealizedPnl = portfolioPositions
        ?.reduce((sum, pos) => sum + (pos.unrealized_pnl || 0), 0) || 0
      
      await supabase
        .from('portfolios')
        .update({ unrealized_pnl: totalUnrealizedPnl })
        .eq('id', portfolio.id)
    }
    
    console.log(`✅ Updated ${updates.length} positions`)
    
    return new Response(
      JSON.stringify({
        success: true,
        positions_updated: updates.length,
        updates
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
