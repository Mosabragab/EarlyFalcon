// ============================================
// EXECUTE TRADE - Paper & Live with Kraken
// Runs every 1 minute
// Supports: Market orders, Limit orders, Trial mode
// ============================================

import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createSupabaseClient } from '../_shared/supabase-client.ts'
import { KrakenClient } from '../_shared/kraken-client.ts'
import { SLIPPAGE_ENTRY, KRAKEN_COMMISSION } from '../_shared/symbols.ts'

serve(async (req) => {
  try {
    const supabase = createSupabaseClient()
    
    // Get pending signals (not expired)
    const { data: signals } = await supabase
      .from('trading_signals')
      .select(`
        *,
        users!inner(*)
      `)
      .eq('status', 'PENDING')
      .gt('expires_at', new Date().toISOString())
    
    if (!signals || signals.length === 0) {
      return new Response(
        JSON.stringify({ 
          success: true,
          message: 'No pending signals'
        }),
        { headers: { "Content-Type": "application/json" } }
      )
    }
    
    console.log(`⚡ Processing ${signals.length} pending signals...`)
    
    const results = []
    
    for (const signal of signals) {
      const user = signal.users
      
      try {
        // Check system controls
        const { data: controls } = await supabase
          .from('system_controls')
          .select('*')
          .eq('user_id', user.id)
          .single()
        
        if (!controls.trading_enabled || controls.emergency_stop_active) {
          console.log(`⏭️  Trading disabled for user ${user.email}`)
          continue
        }
        
        // Get portfolio
        const { data: portfolio } = await supabase
          .from('portfolios')
          .select('*')
          .eq('user_id', user.id)
          .eq('account_type', user.trade_mode)
          .single()
        
        if (!portfolio) {
          console.error('Portfolio not found')
          continue
        }
        
        // Check daily loss limit
        if (controls.daily_loss_limit_hit) {
          console.log(`⚠️  Daily loss limit hit for ${user.email}`)
          continue
        }
        
        // Calculate position size
        let positionSize = 0
        
        if (user.position_sizing_mode === 'fixed') {
          positionSize = user.fixed_position_size
        } else if (user.position_sizing_mode === 'confidence_weighted') {
          if (signal.confidence_score <= 80) positionSize = 400
          else if (signal.confidence_score <= 90) positionSize = 600
          else positionSize = 800
        } else if (user.position_sizing_mode === 'percentage') {
          positionSize = portfolio.current_capital * (user.max_position_size_pct / 100)
        } else if (user.position_sizing_mode === 'risk_based') {
          const riskAmount = portfolio.current_capital * 0.02
          const stopDistance = Math.abs(signal.entry_price - signal.stop_loss) / signal.entry_price
          positionSize = riskAmount / stopDistance
        }
        
        // Trial mode limit
        if (user.trade_mode === 'trial') {
          positionSize = Math.min(positionSize, 100)
          
          // Check max 5 positions
          if (portfolio.active_positions >= 5) {
            console.log(`⚠️  Trial mode: Max 5 positions reached`)
            continue
          }
        }
        
        // Check position size limit
        const maxPositionSize = portfolio.current_capital * (user.max_position_size_pct / 100)
        if (positionSize > maxPositionSize) {
          positionSize = maxPositionSize
        }
        
        // Check available capital
        if (positionSize > portfolio.available_capital) {
          console.log(`⚠️  Insufficient capital: ${positionSize} > ${portfolio.available_capital}`)
          continue
        }
        
        // Check total exposure
        const newExposure = (portfolio.invested_capital + positionSize) / portfolio.current_capital
        if (newExposure > (user.max_exposure_pct / 100)) {
          console.log(`⚠️  Exposure limit: ${(newExposure * 100).toFixed(1)}% > ${user.max_exposure_pct}%`)
          continue
        }
        
        // Verify price hasn't moved too much (>0.5%)
        const { data: currentPriceData } = await supabase
          .from('market_data_ohlcv')
          .select('close_price')
          .eq('symbol', signal.symbol)
          .eq('interval', '15m')
          .order('timestamp', { ascending: false })
          .limit(1)
          .single()
        
        if (currentPriceData) {
          const priceChange = Math.abs(currentPriceData.close_price - signal.entry_price) / signal.entry_price
          if (priceChange > 0.005) {
            console.log(`⚠️  Price moved >0.5%, skipping entry for ${signal.symbol}`)
            
            await supabase
              .from('trading_signals')
              .update({ status: 'CANCELLED' })
              .eq('id', signal.id)
            
            continue
          }
        }
        
        // Calculate quantity
        const quantity = positionSize / signal.entry_price
        
        // Execute based on trade mode
        let executionResult
        
        if (user.trade_mode === 'paper' || user.trade_mode === 'trial') {
          // PAPER TRADING
          executionResult = await executePaperTrade(
            supabase,
            user,
            portfolio,
            signal,
            quantity,
            positionSize
          )
        } else {
          // LIVE TRADING with Kraken
          executionResult = await executeLiveTrade(
            supabase,
            user,
            portfolio,
            signal,
            quantity,
            positionSize
          )
        }
        
        results.push(executionResult)
        
      } catch (error) {
        console.error(`Error processing signal ${signal.id}:`, error)
        results.push({
          signal_id: signal.id,
          symbol: signal.symbol,
          status: 'error',
          error: error.message
        })
      }
    }
    
    return new Response(
      JSON.stringify({
        success: true,
        processed: signals.length,
        executed: results.filter(r => r.status === 'success').length,
        failed: results.filter(r => r.status === 'error').length,
        results
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
// PAPER TRADING EXECUTION
// ============================================
async function executePaperTrade(supabase, user, portfolio, signal, quantity, positionSize) {
  const startTime = Date.now()
  
  // Create order record
  const { data: order } = await supabase
    .from('orders')
    .insert({
      user_id: user.id,
      portfolio_id: portfolio.id,
      symbol: signal.symbol,
      order_type: user.default_order_type,
      side: signal.signal_type === 'BUY' ? 'buy' : 'sell',
      quantity,
      limit_price: user.default_order_type === 'limit' ? signal.entry_price : null,
      status: 'filled',
      filled_price: signal.entry_price,
      filled_quantity: quantity,
      api_response_ms: Date.now() - startTime,
      filled_at: new Date().toISOString()
    })
    .select()
    .single()
  
  // Create position
  const { data: position } = await supabase
    .from('positions')
    .insert({
      user_id: user.id,
      portfolio_id: portfolio.id,
      symbol: signal.symbol,
      side: signal.signal_type === 'BUY' ? 'LONG' : 'SHORT',
      entry_price: signal.entry_price,
      quantity,
      entry_value: positionSize,
      stop_loss: signal.stop_loss,
      take_profit: signal.take_profit,
      confidence_score: signal.confidence_score,
      signal_reason: signal.signal_reason,
      expected_entry_price: signal.entry_price / (1 + SLIPPAGE_ENTRY),
      entry_slippage_pct: SLIPPAGE_ENTRY * 100,
      current_price: signal.entry_price
    })
    .select()
    .single()
  
  // Update portfolio
  await supabase
    .from('portfolios')
    .update({
      available_capital: portfolio.available_capital - positionSize,
      invested_capital: portfolio.invested_capital + positionSize,
      active_positions: portfolio.active_positions + 1
    })
    .eq('id', portfolio.id)
  
  // Mark signal as executed
  await supabase
    .from('trading_signals')
    .update({
      status: 'EXECUTED',
      executed_at: new Date().toISOString()
    })
    .eq('id', signal.id)
  
  // Send email alert
  await sendEmailAlert(user.email, signal, 'FILLED', positionSize)
  
  // Audit log
  await supabase
    .from('audit_log')
    .insert({
      user_id: user.id,
      action_type: 'trade',
      action_description: `Paper trade executed: ${signal.signal_type} ${signal.symbol}`,
      position_id: position.id,
      new_values: { signal, position }
    })
  
  console.log(`✅ Paper trade: ${signal.signal_type} ${signal.symbol} @ ${signal.entry_price}`)
  
  return {
    signal_id: signal.id,
    symbol: signal.symbol,
    type: signal.signal_type,
    mode: 'paper',
    status: 'success',
    position_id: position.id
  }
}

// ============================================
// LIVE TRADING EXECUTION with Kraken
// ============================================
async function executeLiveTrade(supabase, user, portfolio, signal, quantity, positionSize) {
  const startTime = Date.now()
  
  const kraken = new KrakenClient({
    apiKey: user.kraken_api_key,
    apiSecret: user.kraken_api_secret
  })
  
  // Prepare order parameters
  const orderParams: any = {
    pair: signal.symbol,
    type: signal.signal_type === 'BUY' ? 'buy' : 'sell',
    ordertype: user.default_order_type,
    volume: quantity.toFixed(8)
  }
  
  // Add limit price if limit order
  if (user.default_order_type === 'limit') {
    const offset = user.limit_order_offset_pct / 100
    orderParams.price = signal.signal_type === 'BUY'
      ? (signal.entry_price * (1 - offset)).toFixed(2)
      : (signal.entry_price * (1 + offset)).toFixed(2)
  }
  
  try {
    // Place order on Kraken
    const result = await kraken.addOrder(orderParams)
    const responseTime = Date.now() - startTime
    
    if (result.error && result.error.length > 0) {
      throw new Error(result.error.join(', '))
    }
    
    const krakenOrderId = result.result.txid[0]
    
    // Create order record
    const { data: order } = await supabase
      .from('orders')
      .insert({
        user_id: user.id,
        portfolio_id: portfolio.id,
        symbol: signal.symbol,
        order_type: user.default_order_type,
        side: signal.signal_type === 'BUY' ? 'buy' : 'sell',
        quantity,
        limit_price: orderParams.price,
        status: user.default_order_type === 'market' ? 'filled' : 'pending',
        filled_price: signal.entry_price,
        filled_quantity: quantity,
        commission: quantity * signal.entry_price * KRAKEN_COMMISSION,
        kraken_order_id: krakenOrderId,
        kraken_status: 'submitted',
        api_response_ms: responseTime,
        filled_at: user.default_order_type === 'market' ? new Date().toISOString() : null
      })
      .select()
      .single()
    
    // For market orders, create position immediately
    if (user.default_order_type === 'market') {
      const { data: position } = await supabase
        .from('positions')
        .insert({
          user_id: user.id,
          portfolio_id: portfolio.id,
          symbol: signal.symbol,
          side: signal.signal_type === 'BUY' ? 'LONG' : 'SHORT',
          entry_price: signal.entry_price,
          quantity,
          entry_value: positionSize,
          stop_loss: signal.stop_loss,
          take_profit: signal.take_profit,
          confidence_score: signal.confidence_score,
          signal_reason: signal.signal_reason,
          kraken_order_id: krakenOrderId,
          entry_commission: quantity * signal.entry_price * KRAKEN_COMMISSION,
          expected_entry_price: signal.entry_price / (1 + SLIPPAGE_ENTRY),
          entry_slippage_pct: SLIPPAGE_ENTRY * 100,
          current_price: signal.entry_price
        })
        .select()
        .single()
      
      // Update portfolio
      await supabase
        .from('portfolios')
        .update({
          available_capital: portfolio.available_capital - positionSize,
          invested_capital: portfolio.invested_capital + positionSize,
          active_positions: portfolio.active_positions + 1
        })
        .eq('id', portfolio.id)
      
      console.log(`✅ Live trade: ${signal.signal_type} ${signal.symbol} @ ${signal.entry_price}`)
    } else {
      console.log(`📋 Limit order placed: ${signal.signal_type} ${signal.symbol} @ ${orderParams.price}`)
    }
    
    // Mark signal as executed
    await supabase
      .from('trading_signals')
      .update({
        status: 'EXECUTED',
        executed_at: new Date().toISOString()
      })
      .eq('id', signal.id)
    
    // Send email alert
    await sendEmailAlert(user.email, signal, user.default_order_type === 'market' ? 'FILLED' : 'PENDING', positionSize)
    
    return {
      signal_id: signal.id,
      symbol: signal.symbol,
      type: signal.signal_type,
      mode: 'live',
      order_type: user.default_order_type,
      status: 'success',
      kraken_order_id: krakenOrderId
    }
    
  } catch (error) {
    // Log failed order
    await supabase
      .from('orders')
      .insert({
        user_id: user.id,
        portfolio_id: portfolio.id,
        symbol: signal.symbol,
        order_type: user.default_order_type,
        side: signal.signal_type === 'BUY' ? 'buy' : 'sell',
        quantity,
        status: 'rejected',
        kraken_error: error.message,
        api_response_ms: Date.now() - startTime
      })
    
    throw error
  }
}

// ============================================
// EMAIL ALERT (Placeholder)
// ============================================
async function sendEmailAlert(email: string, signal: any, status: string, positionSize: number) {
  console.log(`📧 Email alert: ${status} - ${signal.signal_type} ${signal.symbol} to ${email}`)
  // TODO: Implement SendGrid integration
}
