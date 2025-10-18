// ============================================
// GENERATE SIGNALS - EARLY BIRD v8.2
// Now supports LONG/SHORT trade type controls
// ============================================

import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createSupabaseClient } from '../_shared/supabase-client.ts'
import { SLIPPAGE_ENTRY } from '../_shared/symbols.ts'

serve(async (req) => {
  try {
    const supabase = createSupabaseClient()
    
    // Check system controls for all users
    const { data: users } = await supabase
      .from('users')
      .select('id, system_controls(*)')
      .eq('system_controls.signal_generation_enabled', true)
      .eq('system_controls.emergency_stop_active', false)
    
    if (!users || users.length === 0) {
      return new Response(
        JSON.stringify({ 
          success: true,
          message: 'Signal generation disabled or emergency stop active'
        }),
        { headers: { "Content-Type": "application/json" } }
      )
    }
    
    const signalsGenerated = []
    
    for (const user of users) {
      const controls = user.system_controls
      
      // Check which trade types are enabled
      const longEnabled = controls.long_trades_enabled !== false
      const shortEnabled = controls.short_trades_enabled !== false
      
      if (!longEnabled && !shortEnabled) {
        console.log(`Both trade types disabled for user ${user.id}`)
        continue
      }
      
      // Query for signal candidates (v8.2 filters)
      const { data: candidates, error: queryError } = await supabase.rpc(
        'find_signal_candidates_v82'
      )
      
      if (queryError) {
        console.error('Query error:', queryError)
        continue
      }
      
      if (!candidates || candidates.length === 0) {
        console.log('No signal candidates found')
        continue
      }
      
      console.log(`🎯 Found ${candidates.length} signal candidates`)
      
      for (const candidate of candidates) {
        // Filter by enabled trade types
        if (candidate.signal_type === 'BUY' && !longEnabled) {
          console.log(`⏭️  Skipping LONG signal for ${candidate.symbol} - LONG trades disabled`)
          continue
        }
        
        if (candidate.signal_type === 'SELL' && !shortEnabled) {
          console.log(`⏭️  Skipping SHORT signal for ${candidate.symbol} - SHORT trades disabled`)
          continue
        }
        
        // Check for duplicate signals (within 1 hour)
        const { data: recentSignals } = await supabase
          .from('trading_signals')
          .select('id')
          .eq('user_id', user.id)
          .eq('symbol', candidate.symbol)
          .eq('signal_type', candidate.signal_type)
          .gte('generated_at', new Date(Date.now() - 3600000).toISOString())
        
        if (recentSignals && recentSignals.length > 0) {
          console.log(`⏭️  Skipping ${candidate.symbol} - signal generated <1h ago`)
          continue
        }
        
        // Calculate confidence score (v8.2: base 70%)
        let confidence = 70
        
        if (candidate.strong_trend) confidence += 5
        if (candidate.optimal_zone) confidence += 10
        if (candidate.tight_macd) confidence += 5
        if (candidate.quality_volume) confidence += 5
        if (candidate.near_ema) confidence += 5
        
        // Apply entry slippage
        const entryPrice = candidate.current_price * (1 + SLIPPAGE_ENTRY)
        
        // Calculate stop loss and take profit
        const stopLoss = candidate.signal_type === 'BUY'
          ? entryPrice * 0.992  // -0.8%
          : entryPrice * 1.008  // +0.8%
        
        const takeProfit = candidate.signal_type === 'BUY'
          ? entryPrice * 1.015  // +1.5%
          : entryPrice * 0.985  // -1.5%
        
        // Insert signal
        const { data: signal, error: insertError } = await supabase
          .from('trading_signals')
          .insert({
            user_id: user.id,
            symbol: candidate.symbol,
            signal_type: candidate.signal_type,
            entry_price: entryPrice,
            stop_loss: stopLoss,
            take_profit: takeProfit,
            confidence_score: confidence,
            signal_reason: candidate.reason,
            status: 'PENDING',
            rsi: candidate.rsi,
            macd_histogram: candidate.macd,
            ema_21: candidate.ema21,
            ema_55: candidate.ema55,
            atr: candidate.atr,
            volume_ratio: candidate.volume_ratio
          })
          .select()
          .single()
        
        if (insertError) {
          console.error('Insert error:', insertError)
          continue
        }
        
        signalsGenerated.push({
          symbol: candidate.symbol,
          type: candidate.signal_type,
          entry: entryPrice,
          confidence: confidence
        })
        
        console.log(`✅ Signal: ${candidate.signal_type} ${candidate.symbol} @ ${entryPrice.toFixed(2)} (${confidence}%)`)
      }
    }
    
    return new Response(
      JSON.stringify({
        success: true,
        signals_generated: signalsGenerated.length,
        signals: signalsGenerated
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
