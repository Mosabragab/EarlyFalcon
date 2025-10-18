import { createClient } from '@supabase/supabase-js'
import { RSI, MACD, EMA, ATR } from 'technicalindicators'
import cron from 'node-cron'

console.log('🔍 Environment Variables Check:')
console.log('SUPABASE_URL:', process.env.SUPABASE_URL ? 'SET ✅' : 'MISSING ❌')
console.log('SUPABASE_SERVICE_KEY:', process.env.SUPABASE_SERVICE_KEY ? 'SET ✅' : 'MISSING ❌')
console.log('NODE_ENV:', process.env.NODE_ENV)

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
  console.error('❌ FATAL: Missing environment variables!')
  process.exit(1)
}

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
)

console.log('🦅 Early Falcon Indicator Service v1.0')

async function calculateIndicators() {
  console.log('⏰ Starting calculation...')
  try {
    const { data: symbols } = await supabase.from('symbols').select('*').eq('is_active', true)
    console.log('📊 Processing', symbols.length, 'symbols')
    console.log('✨ Done')
  } catch (error) {
    console.error('❌ Error:', error.message)
  }
}

cron.schedule('*/15 * * * *', calculateIndicators)
console.log('🚀 Service started!')
calculateIndicators()
