// ============================================
// CHECK EXITS - TP/SL/Time with HIGH/LOW checks
// Runs every 1 minute
// Uses candle HIGH/LOW for accurate SL detection
// ============================================

import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createSupabaseClient } from '../_shared/supabase-client.ts'
import { KrakenClient } from '../_shared/kraken-client.ts'
import { SLIPPAGE_EXIT, KRAKEN_COMMISSION } from '../_shared/symbols.ts'

serve(async (req) => {
  try {
    const supabase = createSupabaseClient()
    
    // Get all active positions with latest candle data
    const { data: positions } = await supabase
      .from('positions')
      .select(`
        *,
        users!inner(
          id,
          email,
          trade_mode,
          default_order_type,
          kraken_api_key,
          kraken_api_secret,
          max_daily_loss_pct
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
    
    console.log(`🚪 Checking exits for ${positions.length} positions...`)
    
    const exits = []
    
    for (const position of positions) {
      try {
        // Get latest candle with HIGH/LOW data
        const { data: candle } = await supabase
          .from('market_data_ohlcv')
          .select('close_price, high_price, low_price, timestamp')
          .eq('symbol', position.symbol)
          .eq('interval', '15m')
          .order('timestamp', { ascending: false })
          .limit(1)
          .single()
        
        if (!candle) {
          console.error(`No candle data for ${position.symbol}`)
          continue
        }
        
        const currentPrice = candle.close_price
        const candleHigh = candle.high_price
        const candleLow = candle.low_price
        
        let exitReason = null
        let exitPrice = currentPrice
        
        // CHECK STOP LOSS using HIGH/LOW
        if (position.side === 'LONG') {
          // LONG SL: Check if candle LOW touched stop loss
          if (candleLow <= position.stop_loss) {
            exitReason = 'STOP_LOSS'
            exitPrice = position.stop_loss
          }
        } else {
          // SHORT SL: Check if candle HIGH touched stop loss
          if (candleHigh >= position.stop_loss) {
            exitReason = 'STOP_LOSS'
            exitPrice = position.stop_loss
          }
        }
        
        // CHECK TAKE PROFIT using current price
        if (!exitReason) {
          if (position.side === 'LONG') {
            if (currentPrice >= position.take_profit) {
              exitReason = 'TAKE_PROFIT'
              exitPrice = position.take_profit
            }
          } else {
            if (currentPrice <= position.take_profit) {
              exitReason = 'TAKE_PROFIT'
              exitPrice = position.take_profit
            }
          }
        }
        
        // CHECK TIME EXIT (6 hours)
        if (!exitReason) {
          const openedAt = new Date(position.opened_at)
          const now = new Date()
          const hoursOpen = (now.getTime() - openedAt.getTime()) / (1000 * 60 * 60)
          
          if (hoursOpen >= 6) {
            exitReason = 'TIME_BASED'
            exitPrice = currentPrice
          }
        }
        
        // If exit triggered, close position
        if (exitReason) {
          const exitResult = await closePosition(
            supabase,
            position,
            exitPrice,
            exitReason
          )
          
          exits.push(exitResult)
        }
        
      } catch (error) {
        console.error(`Error checking exit for ${position.symbol}:`, error.message)
      }
    }
    
    console.log(`✅ Closed ${exits.length} positions`)
    
    return new Response(
      JSON.stringify({
        success: true,
        exits_processed: exits.length,
        exits
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

// ============================================
// CLOSE POSITION (Paper or Live)
// ============================================
async function closePosition(supabase, position, exitPrice, exitReason) {
  const user = position.users
  const startTime = Date.now()
  
  // Apply exit slippage
  const slippageAdjustedExit = exitPrice * (1 - SLIPPAGE_EXIT)
  
  // Calculate P&L
  const grossPnl = position.side === 'LONG'
    ? (slippageAdjustedExit - position.entry_price) * position.quantity
    : (position.entry_price - slippageAdjustedExit) * position.quantity
  
  const commission = user.trade_mode === 'live'
    ? position.quantity * slippageAdjustedExit * KRAKEN_COMMISSION + (position.entry_commission || 0)
    : 0
  
  const netPnl = grossPnl - commission
  const pnlPct = (netPnl / position.entry_value) * 100
  
  const exitValue = position.quantity * slippageAdjustedExit
  const holdDuration = Math.floor((Date.now() - new Date(position.opened_at).getTime()) / 60000)
  
  // Execute exit order if live
  let krakenExitOrderId = null
  
  if (user.trade_mode === 'live') {
    try {
      const kraken = new KrakenClient({
        apiKey: user.kraken_api_key,
        apiSecret: user.kraken_api_secret
      })
      
      const exitOrder = await kraken.addOrder({
        pair: position.symbol,
        type: position.side === 'LONG' ? 'sell' : 'buy',
        ordertype: 'market',
        volume: position.quantity.toFixed(8)
      })
      
      if (exitOrder.result && exitOrder.result.txid) {
        krakenExitOrderId = exitOrder.result.txid[0]
      }
    } catch (error) {
      console.error('Kraken exit error:', error.message)
    }
  }
  
  // Create exit order record
  await supabase
    .from('orders')
    .insert({
      user_id: user.id,
      portfolio_id: position.portfolio_id,
      position_id: position.id,
      symbol: position.symbol,
      order_type: 'market',
      side: position.side === 'LONG' ? 'sell' : 'buy',
      quantity: position.quantity,
      status: 'filled',
      filled_price: slippageAdjustedExit,
      filled_quantity: position.quantity,
      commission: user.trade_mode === 'live' ? commission : 0,
      kraken_order_id: krakenExitOrderId,
      api_response_ms: Date.now() - startTime,
      filled_at: new Date().toISOString()
    })
  
  // Move to trades table
  await supabase
    .from('trades')
    .insert({
      user_id: user.id,
      portfolio_id: position.portfolio_id,
      symbol: position.symbol,
      side: position.side,
      entry_price: position.entry_price,
      quantity: position.quantity,
      entry_value: position.entry_value,
      entry_time: position.opened_at,
      exit_price: slippageAdjustedExit,
      exit_value: exitValue,
      exit_time: new Date().toISOString(),
      exit_reason: exitReason,
      gross_pnl: grossPnl,
      commission: commission,
      net_pnl: netPnl,
      pnl_pct: pnlPct,
      hold_duration_minutes: holdDuration,
      expected_entry: position.expected_entry_price,
      entry_slippage_pct: position.entry_slippage_pct,
      expected_exit: exitPrice,
      exit_slippage_pct: SLIPPAGE_EXIT * 100,
      kraken_entry_order_id: position.kraken_order_id,
      kraken_exit_order_id: krakenExitOrderId,
      entry_api_response_ms: null,
      exit_api_response_ms: Date.now() - startTime,
      confidence_score: position.confidence_score,
      signal_reason: position.signal_reason
    })
  
  // Mark position as closed
  await supabase
    .from('positions')
    .update({
      is_active: false,
      closed_at: new Date().toISOString(),
      unrealized_pnl: netPnl,
      exit_commission: commission
    })
    .eq('id', position.id)
  
  // Get portfolio
  const { data: portfolio } = await supabase
    .from('portfolios')
    .select('*')
    .eq('id', position.portfolio_id)
    .single()
  
  // Update portfolio
  const newAvailable = portfolio.available_capital + exitValue
  const newInvested = portfolio.invested_capital - position.entry_value
  const newRealized = portfolio.realized_pnl + netPnl
  const newDailyPnl = portfolio.daily_pnl + netPnl
  
  await supabase
    .from('portfolios')
    .update({
      available_capital: newAvailable,
      invested_capital: newInvested,
      realized_pnl: newRealized,
      active_positions: portfolio.active_positions - 1,
      total_trades: portfolio.total_trades + 1,
      winning_trades: netPnl > 0 ? portfolio.winning_trades + 1 : portfolio.winning_trades,
      losing_trades: netPnl <= 0 ? portfolio.losing_trades + 1 : portfolio.losing_trades,
      daily_pnl: newDailyPnl,
      daily_trades: portfolio.daily_trades + 1
    })
    .eq('id', portfolio.id)
  
  // Check daily loss limit (-5%)
  const dailyLossPct = (newDailyPnl / portfolio.starting_capital) * 100
  
  if (dailyLossPct <= -user.max_daily_loss_pct) {
    await supabase
      .from('system_controls')
      .update({
        daily_loss_limit_hit: true,
        trading_enabled: false
      })
      .eq('user_id', user.id)
    
    console.log(`⚠️  Daily loss limit hit: ${dailyLossPct.toFixed(2)}%`)
    await sendEmailAlert(user.email, position, 'DAILY_LOSS_LIMIT', netPnl)
  }
  
  // Send email alert
  await sendEmailAlert(user.email, position, exitReason, netPnl)
  
  // Audit log
  await supabase
    .from('audit_log')
    .insert({
      user_id: user.id,
      action_type: 'trade',
      action_description: `Position closed: ${exitReason} ${position.symbol}`,
      position_id: position.id,
      old_values: { position },
      new_values: { netPnl, exitPrice: slippageAdjustedExit }
    })
  
  console.log(`✅ Closed: ${position.side} ${position.symbol} @ ${slippageAdjustedExit.toFixed(2)} (${exitReason}) P&L: $${netPnl.toFixed(2)}`)
  
  return {
    position_id: position.id,
    symbol: position.symbol,
    side: position.side,
    exit_reason: exitReason,
    exit_price: slippageAdjustedExit,
    pnl: netPnl,
    pnl_pct: pnlPct.toFixed(2)
  }
}

async function sendEmailAlert(email: string, position: any, type: string, pnl: number) {
  console.log(`📧 Email: ${type} - ${position.symbol} to ${email} (P&L: $${pnl.toFixed(2)})`)
  // TODO: Implement SendGrid
}
