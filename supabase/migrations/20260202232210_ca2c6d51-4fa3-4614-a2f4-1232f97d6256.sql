-- Create enums for trade statuses and chains
CREATE TYPE public.trade_status AS ENUM (
  'pending_sigma',
  'pending_buy', 
  'bought',
  'pending_sell',
  'sold',
  'failed',
  'cancelled'
);

CREATE TYPE public.chain_type AS ENUM ('solana', 'base');

CREATE TYPE public.channel_category AS ENUM (
  'alpha_calls',
  'whale_tracking',
  'insider_alerts',
  'degen_plays',
  'verified_callers',
  'custom'
);

-- Channels table - stores Discord/Telegram channels to monitor
CREATE TABLE public.channels (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  platform TEXT NOT NULL CHECK (platform IN ('discord', 'telegram')),
  channel_id TEXT NOT NULL,
  category channel_category NOT NULL DEFAULT 'custom',
  chain chain_type NOT NULL DEFAULT 'solana',
  enabled BOOLEAN NOT NULL DEFAULT true,
  allocation_sol NUMERIC(20, 9) DEFAULT 0.1,
  auto_buy BOOLEAN NOT NULL DEFAULT false,
  take_profit_pct NUMERIC(8, 2) DEFAULT 50,
  stop_loss_pct NUMERIC(8, 2) DEFAULT 25,
  max_hold_minutes INTEGER DEFAULT 60,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(platform, channel_id)
);

-- Trades table - main trading records
CREATE TABLE public.trades (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_address TEXT NOT NULL,
  token_symbol TEXT,
  token_name TEXT,
  chain chain_type NOT NULL DEFAULT 'solana',
  channel_id UUID REFERENCES public.channels(id) ON DELETE SET NULL,
  channel_category channel_category,
  status trade_status NOT NULL DEFAULT 'pending_sigma',
  
  -- Allocation
  allocation_sol NUMERIC(20, 9) NOT NULL,
  
  -- Buy info
  buy_tx_signature TEXT,
  buy_price NUMERIC(30, 18),
  tokens_received NUMERIC(30, 9),
  buy_slippage_pct NUMERIC(8, 2),
  bought_at TIMESTAMPTZ,
  
  -- Sell info
  sell_tx_signature TEXT,
  sell_price NUMERIC(30, 18),
  tokens_sold NUMERIC(30, 9),
  realized_sol NUMERIC(20, 9),
  sold_at TIMESTAMPTZ,
  sell_reason TEXT,
  
  -- PnL
  pnl_sol NUMERIC(20, 9),
  pnl_pct NUMERIC(10, 4),
  
  -- Meta
  source_message TEXT,
  error_message TEXT,
  metadata JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Positions table - active monitored positions
CREATE TABLE public.positions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trade_id UUID REFERENCES public.trades(id) ON DELETE CASCADE NOT NULL,
  contract_address TEXT NOT NULL,
  token_symbol TEXT,
  chain chain_type NOT NULL DEFAULT 'solana',
  
  -- Position info
  tokens_held NUMERIC(30, 9) NOT NULL,
  entry_price NUMERIC(30, 18) NOT NULL,
  current_price NUMERIC(30, 18),
  
  -- PnL tracking
  unrealized_pnl_sol NUMERIC(20, 9),
  unrealized_pnl_pct NUMERIC(10, 4),
  highest_price NUMERIC(30, 18),
  lowest_price NUMERIC(30, 18),
  
  -- Auto-sell triggers
  take_profit_pct NUMERIC(8, 2) DEFAULT 50,
  stop_loss_pct NUMERIC(8, 2) DEFAULT 25,
  trailing_stop_pct NUMERIC(8, 2),
  max_hold_until TIMESTAMPTZ,
  
  -- State
  is_active BOOLEAN NOT NULL DEFAULT true,
  last_price_check TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Sell orders table - pending sell operations
CREATE TABLE public.sell_orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  position_id UUID REFERENCES public.positions(id) ON DELETE CASCADE NOT NULL,
  trade_id UUID REFERENCES public.trades(id) ON DELETE CASCADE NOT NULL,
  contract_address TEXT NOT NULL,
  chain chain_type NOT NULL DEFAULT 'solana',
  
  tokens_to_sell NUMERIC(30, 9) NOT NULL,
  sell_pct NUMERIC(8, 2) NOT NULL DEFAULT 100,
  reason TEXT NOT NULL,
  
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'executing', 'executed', 'failed')),
  tx_signature TEXT,
  realized_sol NUMERIC(20, 9),
  error_message TEXT,
  
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  executed_at TIMESTAMPTZ
);

-- Bot settings table - runtime configuration
CREATE TABLE public.bot_settings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  setting_key TEXT UNIQUE NOT NULL,
  setting_value JSONB NOT NULL,
  description TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Worker heartbeat table - track external bot status
CREATE TABLE public.worker_heartbeats (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  worker_name TEXT NOT NULL,
  last_heartbeat TIMESTAMPTZ NOT NULL DEFAULT now(),
  status TEXT NOT NULL DEFAULT 'online',
  metadata JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Trade history/audit log
CREATE TABLE public.trade_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trade_id UUID REFERENCES public.trades(id) ON DELETE CASCADE NOT NULL,
  event_type TEXT NOT NULL,
  event_data JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Create indexes for performance
CREATE INDEX idx_trades_status ON public.trades(status);
CREATE INDEX idx_trades_chain ON public.trades(chain);
CREATE INDEX idx_trades_created_at ON public.trades(created_at DESC);
CREATE INDEX idx_trades_contract ON public.trades(contract_address);
CREATE INDEX idx_positions_active ON public.positions(is_active) WHERE is_active = true;
CREATE INDEX idx_positions_trade ON public.positions(trade_id);
CREATE INDEX idx_sell_orders_status ON public.sell_orders(status) WHERE status = 'pending';
CREATE INDEX idx_channels_enabled ON public.channels(enabled) WHERE enabled = true;

-- Enable Row Level Security
ALTER TABLE public.channels ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.trades ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.positions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sell_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bot_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.worker_heartbeats ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.trade_events ENABLE ROW LEVEL SECURITY;

-- For now, create open policies (single-user bot - will add auth later if needed)
-- These allow the edge function (service role) full access
CREATE POLICY "Allow all for authenticated" ON public.channels FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all for authenticated" ON public.trades FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all for authenticated" ON public.positions FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all for authenticated" ON public.sell_orders FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all for authenticated" ON public.bot_settings FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all for authenticated" ON public.worker_heartbeats FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all for authenticated" ON public.trade_events FOR ALL USING (true) WITH CHECK (true);

-- Create updated_at trigger function
CREATE OR REPLACE FUNCTION public.update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public;

-- Apply updated_at triggers
CREATE TRIGGER update_channels_updated_at BEFORE UPDATE ON public.channels FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
CREATE TRIGGER update_trades_updated_at BEFORE UPDATE ON public.trades FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
CREATE TRIGGER update_positions_updated_at BEFORE UPDATE ON public.positions FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
CREATE TRIGGER update_bot_settings_updated_at BEFORE UPDATE ON public.bot_settings FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Insert default bot settings
INSERT INTO public.bot_settings (setting_key, setting_value, description) VALUES
  ('trading_enabled', 'true', 'Master switch for automated trading'),
  ('default_allocation_sol', '0.1', 'Default SOL allocation per trade'),
  ('default_take_profit_pct', '50', 'Default take profit percentage'),
  ('default_stop_loss_pct', '25', 'Default stop loss percentage'),
  ('default_max_hold_minutes', '60', 'Default max hold time in minutes'),
  ('max_concurrent_positions', '10', 'Maximum number of concurrent positions'),
  ('slippage_bps', '300', 'Default slippage in basis points (300 = 3%)'),
  ('priority_fee_lamports', '100000', 'Priority fee for transactions');
