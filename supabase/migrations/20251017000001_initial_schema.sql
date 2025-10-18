-- ============================================
-- EARLY FALCON - INITIAL DATABASE SCHEMA
-- Version: 1.0.0
-- Date: October 17, 2025
-- ============================================

-- Enable necessary extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ============================================
-- USERS & LICENSE MANAGEMENT
-- ============================================

CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  email TEXT UNIQUE NOT NULL,
  full_name TEXT,
  
  -- License info
  license_key TEXT UNIQUE DEFAULT encode(gen_random_bytes(16), 'hex'),
  license_tier TEXT DEFAULT 'pro' CHECK (license_tier IN ('trial', 'starter', 'pro', 'elite')),
  license_status TEXT DEFAULT 'active' CHECK (license_status IN ('active', 'expired', 'cancelled', 'trial')),
  license_started_at TIMESTAMPTZ DEFAULT NOW(),
  license_expires_at TIMESTAMPTZ DEFAULT NOW() + INTERVAL '3 months',
  
  -- Kraken API (will be encrypted)
  kraken_api_key TEXT,
  kraken_api_secret TEXT,
  kraken_api_verified BOOLEAN DEFAULT FALSE,
  
  -- Settings
  email_alerts_enabled BOOLEAN DEFAULT TRUE,
  trade_mode TEXT DEFAULT 'paper' CHECK (trade_mode IN ('paper', 'live', 'trial')),
  
  -- Risk limits
  max_daily_loss_pct NUMERIC DEFAULT 5.0,
  max_position_size_pct NUMERIC DEFAULT 10.0,
  max_exposure_pct NUMERIC DEFAULT 95.0,
  
  -- Position sizing
  position_sizing_mode TEXT DEFAULT 'fixed' CHECK (position_sizing_mode IN ('fixed', 'percentage', 'risk_based', 'confidence_weighted')),
  fixed_position_size NUMERIC DEFAULT 500.00,
  
  -- Order settings
  default_order_type TEXT DEFAULT 'market' CHECK (default_order_type IN ('market', 'limit')),
  limit_order_offset_pct NUMERIC DEFAULT 0.1,
  
  -- Metadata
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  last_login_at TIMESTAMPTZ
);

-- Enable RLS
ALTER TABLE users ENABLE ROW LEVEL SECURITY;

-- Users can only see their own data
CREATE POLICY user_self_access ON users
  FOR ALL TO authenticated
  USING (id = auth.uid());

-- Create index
CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_users_license ON users(license_key);


-- ============================================
-- PORTFOLIOS (Paper + Live)
-- ============================================

CREATE TABLE portfolios (
  id SERIAL PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_type TEXT NOT NULL CHECK (account_type IN ('paper', 'live')),
  
  starting_capital NUMERIC(15,2) NOT NULL DEFAULT 10000.00,
  current_capital NUMERIC(15,2) NOT NULL DEFAULT 10000.00,
  available_capital NUMERIC(15,2) NOT NULL DEFAULT 10000.00,
  invested_capital NUMERIC(15,2) NOT NULL DEFAULT 0.00,
  
  realized_pnl NUMERIC(15,2) DEFAULT 0.00,
  unrealized_pnl NUMERIC(15,2) DEFAULT 0.00,
  total_pnl NUMERIC(15,2) GENERATED ALWAYS AS (realized_pnl + unrealized_pnl) STORED,
  
  total_trades INTEGER DEFAULT 0,
  winning_trades INTEGER DEFAULT 0,
  losing_trades INTEGER DEFAULT 0,
  active_positions INTEGER DEFAULT 0,
  
  -- Daily tracking
  daily_pnl NUMERIC(15,2) DEFAULT 0.00,
  daily_trades INTEGER DEFAULT 0,
  daily_reset_at TIMESTAMPTZ DEFAULT DATE_TRUNC('day', NOW()),
  
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  
  UNIQUE(user_id, account_type)
);

ALTER TABLE portfolios ENABLE ROW LEVEL SECURITY;

CREATE POLICY portfolio_user_access ON portfolios
  FOR ALL TO authenticated
  USING (user_id = auth.uid());

CREATE INDEX idx_portfolios_user ON portfolios(user_id);


-- ============================================
-- POSITIONS (Active trades)
-- ============================================

CREATE TABLE positions (
  id SERIAL PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  portfolio_id INTEGER NOT NULL REFERENCES portfolios(id) ON DELETE CASCADE,
  
  symbol TEXT NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('LONG', 'SHORT')),
  
  -- Entry
  entry_price NUMERIC(15,8) NOT NULL,
  quantity NUMERIC(15,8) NOT NULL,
  entry_value NUMERIC(15,2) NOT NULL,
  
  -- Exit targets
  stop_loss NUMERIC(15,8) NOT NULL,
  take_profit NUMERIC(15,8) NOT NULL,
  
  -- P&L
  current_price NUMERIC(15,8),
  unrealized_pnl NUMERIC(15,2) DEFAULT 0.00,
  unrealized_pnl_pct NUMERIC(10,4) DEFAULT 0.00,
  
  -- Metadata
  confidence_score INTEGER,
  signal_reason TEXT,
  
  -- Kraken integration
  kraken_order_id TEXT,
  kraken_txid TEXT,
  
  -- Tracking
  is_active BOOLEAN DEFAULT TRUE,
  opened_at TIMESTAMPTZ DEFAULT NOW(),
  closed_at TIMESTAMPTZ,
  
  -- Commission tracking
  entry_commission NUMERIC(15,8) DEFAULT 0.00,
  exit_commission NUMERIC(15,8) DEFAULT 0.00,
  
  -- Slippage tracking
  expected_entry_price NUMERIC(15,8),
  entry_slippage_pct NUMERIC(10,4),
  
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE positions ENABLE ROW LEVEL SECURITY;

CREATE POLICY position_user_access ON positions
  FOR ALL TO authenticated
  USING (user_id = auth.uid());

-- Indexes
CREATE INDEX idx_positions_user_active ON positions(user_id, is_active);
CREATE INDEX idx_positions_symbol ON positions(symbol);
CREATE INDEX idx_positions_portfolio ON positions(portfolio_id);


-- ============================================
-- TRADES (Completed history)
-- ============================================

CREATE TABLE trades (
  id SERIAL PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  portfolio_id INTEGER NOT NULL REFERENCES portfolios(id),
  
  symbol TEXT NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('LONG', 'SHORT')),
  
  -- Entry
  entry_price NUMERIC(15,8) NOT NULL,
  quantity NUMERIC(15,8) NOT NULL,
  entry_value NUMERIC(15,2) NOT NULL,
  entry_time TIMESTAMPTZ NOT NULL,
  
  -- Exit
  exit_price NUMERIC(15,8) NOT NULL,
  exit_value NUMERIC(15,2) NOT NULL,
  exit_time TIMESTAMPTZ NOT NULL,
  exit_reason TEXT CHECK (exit_reason IN ('TAKE_PROFIT', 'STOP_LOSS', 'TIME_BASED', 'MANUAL', 'EMERGENCY')),
  
  -- P&L
  gross_pnl NUMERIC(15,2) NOT NULL,
  commission NUMERIC(15,8) DEFAULT 0.00,
  net_pnl NUMERIC(15,2) NOT NULL,
  pnl_pct NUMERIC(10,4) NOT NULL,
  
  -- Duration
  hold_duration_minutes INTEGER,
  
  -- Slippage analysis
  expected_entry NUMERIC(15,8),
  entry_slippage_pct NUMERIC(10,4),
  expected_exit NUMERIC(15,8),
  exit_slippage_pct NUMERIC(10,4),
  
  -- Kraken tracking
  kraken_entry_order_id TEXT,
  kraken_exit_order_id TEXT,
  kraken_entry_txid TEXT,
  kraken_exit_txid TEXT,
  
  -- API response times
  entry_api_response_ms INTEGER,
  exit_api_response_ms INTEGER,
  
  -- Metadata
  confidence_score INTEGER,
  signal_reason TEXT,
  
  created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE trades ENABLE ROW LEVEL SECURITY;

CREATE POLICY trade_user_access ON trades
  FOR ALL TO authenticated
  USING (user_id = auth.uid());

-- Indexes for analytics
CREATE INDEX idx_trades_user_time ON trades(user_id, entry_time DESC);
CREATE INDEX idx_trades_symbol ON trades(symbol);
CREATE INDEX idx_trades_side ON trades(side);
CREATE INDEX idx_trades_portfolio ON trades(portfolio_id);


-- ============================================
-- TRADING SIGNALS (System-generated)
-- ============================================

CREATE TABLE trading_signals (
  id SERIAL PRIMARY KEY,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  
  symbol TEXT NOT NULL,
  signal_type TEXT NOT NULL CHECK (signal_type IN ('BUY', 'SELL')),
  
  entry_price NUMERIC(15,8) NOT NULL,
  stop_loss NUMERIC(15,8) NOT NULL,
  take_profit NUMERIC(15,8) NOT NULL,
  
  confidence_score INTEGER NOT NULL,
  signal_reason TEXT,
  
  status TEXT DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'EXECUTED', 'EXPIRED', 'CANCELLED', 'ARCHIVED')),
  
  generated_at TIMESTAMPTZ DEFAULT NOW(),
  executed_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ DEFAULT NOW() + INTERVAL '5 minutes',
  
  -- Market conditions
  rsi NUMERIC(10,4),
  macd_histogram NUMERIC(15,8),
  ema_21 NUMERIC(15,8),
  ema_55 NUMERIC(15,8),
  atr NUMERIC(15,8),
  volume_ratio NUMERIC(10,4)
);

ALTER TABLE trading_signals ENABLE ROW LEVEL SECURITY;

CREATE POLICY signal_user_access ON trading_signals
  FOR ALL TO authenticated
  USING (user_id = auth.uid() OR user_id IS NULL);

CREATE INDEX idx_signals_user_status ON trading_signals(user_id, status);
CREATE INDEX idx_signals_generated ON trading_signals(generated_at DESC);


-- ============================================
-- ORDERS (Execution log)
-- ============================================

CREATE TABLE orders (
  id SERIAL PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  portfolio_id INTEGER NOT NULL REFERENCES portfolios(id),
  position_id INTEGER REFERENCES positions(id),
  
  symbol TEXT NOT NULL,
  order_type TEXT NOT NULL CHECK (order_type IN ('market', 'limit')),
  side TEXT NOT NULL CHECK (side IN ('buy', 'sell')),
  
  quantity NUMERIC(15,8) NOT NULL,
  limit_price NUMERIC(15,8),
  
  -- Execution
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'filled', 'cancelled', 'rejected', 'expired')),
  filled_price NUMERIC(15,8),
  filled_quantity NUMERIC(15,8),
  commission NUMERIC(15,8) DEFAULT 0.00,
  
  -- Kraken tracking
  kraken_order_id TEXT,
  kraken_txid TEXT,
  kraken_status TEXT,
  kraken_error TEXT,
  
  -- Timing
  api_request_at TIMESTAMPTZ,
  api_response_at TIMESTAMPTZ,
  api_response_ms INTEGER,
  filled_at TIMESTAMPTZ,
  
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE orders ENABLE ROW LEVEL SECURITY;

CREATE POLICY order_user_access ON orders
  FOR ALL TO authenticated
  USING (user_id = auth.uid());

CREATE INDEX idx_orders_user ON orders(user_id, created_at DESC);
CREATE INDEX idx_orders_portfolio ON orders(portfolio_id);


-- ============================================
-- SYSTEM CONTROLS (Emergency, toggles)
-- ============================================

CREATE TABLE system_controls (
  id SERIAL PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  
  -- Trading controls
  trading_enabled BOOLEAN DEFAULT TRUE,
  signal_generation_enabled BOOLEAN DEFAULT TRUE,
  
  -- Emergency flags
  emergency_stop_active BOOLEAN DEFAULT FALSE,
  emergency_stop_triggered_at TIMESTAMPTZ,
  emergency_stop_reason TEXT,
  
  -- Daily limits hit
  daily_loss_limit_hit BOOLEAN DEFAULT FALSE,
  
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  
  UNIQUE(user_id)
);

ALTER TABLE system_controls ENABLE ROW LEVEL SECURITY;

CREATE POLICY control_user_access ON system_controls
  FOR ALL TO authenticated
  USING (user_id = auth.uid());


-- ============================================
-- AUDIT LOG (All actions tracked)
-- ============================================

CREATE TABLE audit_log (
  id SERIAL PRIMARY KEY,
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  
  action_type TEXT NOT NULL,
  action_description TEXT,
  
  -- Related entities
  position_id INTEGER,
  trade_id INTEGER,
  order_id INTEGER,
  
  -- Changes (JSON)
  old_values JSONB,
  new_values JSONB,
  
  ip_address INET,
  user_agent TEXT,
  
  created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY audit_log_user_access ON audit_log
  FOR SELECT TO authenticated
  USING (user_id = auth.uid());

CREATE INDEX idx_audit_user_time ON audit_log(user_id, created_at DESC);


-- ============================================
-- SHARED TABLES (from existing system)
-- ============================================

-- Note: These should already exist from your current system
-- If not, uncomment and run:

/*
CREATE TABLE IF NOT EXISTS market_data_ohlcv (
  id SERIAL PRIMARY KEY,
  symbol TEXT NOT NULL,
  timestamp TIMESTAMPTZ NOT NULL,
  interval TEXT NOT NULL,
  open_price NUMERIC(15,8),
  high_price NUMERIC(15,8),
  low_price NUMERIC(15,8),
  close_price NUMERIC(15,8),
  volume NUMERIC(20,8),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(symbol, timestamp, interval)
);

CREATE TABLE IF NOT EXISTS technical_indicators (
  id SERIAL PRIMARY KEY,
  symbol TEXT NOT NULL,
  timestamp TIMESTAMPTZ NOT NULL,
  interval TEXT NOT NULL,
  rsi NUMERIC(10,4),
  macd_histogram NUMERIC(15,8),
  macd_line NUMERIC(15,8),
  macd_signal NUMERIC(15,8),
  ema_21 NUMERIC(15,8),
  ema_55 NUMERIC(15,8),
  atr NUMERIC(15,8),
  volume_sma NUMERIC(20,8),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(symbol, timestamp, interval)
);
*/


-- ============================================
-- INITIAL SEED DATA
-- ============================================

-- Create your user account
-- Note: In production, this will be created via Supabase Auth
-- This is just for reference

COMMENT ON TABLE users IS 'User accounts with license and trading settings';
COMMENT ON TABLE portfolios IS 'Paper and Live trading portfolios';
COMMENT ON TABLE positions IS 'Active open positions';
COMMENT ON TABLE trades IS 'Historical completed trades';
COMMENT ON TABLE trading_signals IS 'Generated trading signals';
COMMENT ON TABLE orders IS 'Order execution log';
COMMENT ON TABLE system_controls IS 'Trading controls and emergency stops';
COMMENT ON TABLE audit_log IS 'Complete audit trail of all actions';

-- ============================================
-- SUCCESS!
-- ============================================

SELECT '✅ Early Falcon database schema created successfully!' as message;
