import { createClient } from '@supabase/supabase-js'
import { RSI, MACD, EMA, ATR } from 'technicalindicators'
import cron from 'node-cron'

// Debug: Log environment variables
console.log('🔍 Environment Variables Check:')
console.log('SUPABASE_URL:', process.env.SUPABASE_URL ? 'SET ✅' : 'MISSING ❌')
console.log('SUPABASE_SERVICE_KEY:', process.env.SUPABASE_SERVICE_KEY ? 'SET ✅' : 'MISSING ❌')
console.log('NODE_ENV:', process.env.NODE_ENV)

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
  console.error('❌ FATAL: Missing environment variables!')
  console.error('Please set SUPABASE_URL and SUPABASE_SERVICE_KEY')
  process.exit(1)
}

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
)

console.log('🦅 Early Falcon Indicator Service v1.0')
console.log('='.repeat(50))
