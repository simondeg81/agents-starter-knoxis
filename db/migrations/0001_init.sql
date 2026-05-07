PRAGMA foreign_keys = ON;

-- Trade events (lifecycle: submit, fill, cancel, reject, risk_block, resolve)
CREATE TABLE trade_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp_ns INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    strategy TEXT NOT NULL,           -- 'oracle-arb' | 'maker-complement' | 'cross-platform-arb' | 'council'
    market_slug TEXT NOT NULL,
    asset TEXT NOT NULL,              -- 'BTC' | 'ETH' | 'SOL' | 'XRP' | 'DOGE'
    timeframe TEXT NOT NULL,          -- '5m' | '15m' | '1h'
    event_type TEXT NOT NULL,         -- 'submit' | 'fill' | 'cancel' | 'reject' | 'risk_block' | 'resolve'
    side TEXT,                        -- 'yes_buy' | 'no_buy' | 'yes_sell' | 'no_sell'
    price REAL,                       -- 0 < price < 1 (probability)
    size_usd REAL,
    order_id TEXT,
    pyth_price REAL,
    pyth_confidence REAL,
    outcome TEXT,                     -- 'win' | 'loss' | 'cancel' (set on event_type='resolve')
    realized_pnl_usd REAL,            -- set on event_type='resolve'
    risk_block_reason TEXT,           -- set on event_type='risk_block'
    is_dry_run INTEGER NOT NULL DEFAULT 1,
    raw_payload TEXT                  -- JSON of full event for debugging
);

-- Positions (current open positions, one row per market+strategy combo)
CREATE TABLE positions (
    market_slug TEXT NOT NULL,
    strategy TEXT NOT NULL,
    asset TEXT NOT NULL,
    side TEXT NOT NULL,
    entry_price REAL NOT NULL,
    size_usd REAL NOT NULL,
    opened_at_ns INTEGER NOT NULL,
    is_dry_run INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (market_slug, strategy)
);

-- Daily PnL aggregates (one row per UTC date per strategy)
CREATE TABLE daily_pnl (
    utc_date TEXT NOT NULL,           -- 'YYYY-MM-DD'
    strategy TEXT NOT NULL DEFAULT 'all',  -- 'all' | 'oracle-arb' | 'maker-complement' | etc.
    realized_pnl_usd REAL NOT NULL DEFAULT 0,
    fees_paid_usd REAL NOT NULL DEFAULT 0,
    rebates_received_usd REAL NOT NULL DEFAULT 0,
    n_trades INTEGER NOT NULL DEFAULT 0,
    n_wins INTEGER NOT NULL DEFAULT 0,
    n_losses INTEGER NOT NULL DEFAULT 0,
    n_risk_blocks INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (utc_date, strategy)
);

-- risk_halts table moved to 0002_risk_state.sql (owned by W1 / risk engine)
-- v_active_halts view also defined in 0002

-- Council proposals (AI Council parameter suggestions awaiting Simon approval)
CREATE TABLE council_proposals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    proposed_at_ns INTEGER NOT NULL,
    parameter TEXT NOT NULL,          -- 'ORACLE_MIN_EDGE' | 'CORRELATION_GROUP_CAP' | etc.
    current_value TEXT NOT NULL,
    proposed_value TEXT NOT NULL,
    reasoning TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',  -- 'pending' | 'approved' | 'rejected' | 'expired'
    decided_at_ns INTEGER,
    decided_by TEXT                   -- 'simon' | 'auto-expire'
);


-- Indices
CREATE INDEX idx_trade_events_timestamp ON trade_events(timestamp_ns);
CREATE INDEX idx_trade_events_strategy_time ON trade_events(strategy, timestamp_ns);
CREATE INDEX idx_trade_events_market ON trade_events(market_slug);
CREATE INDEX idx_trade_events_outcome ON trade_events(strategy, outcome) WHERE outcome IS NOT NULL;
CREATE INDEX idx_positions_strategy ON positions(strategy);
CREATE INDEX idx_daily_pnl_date ON daily_pnl(utc_date);
CREATE INDEX idx_council_proposals_status ON council_proposals(status, proposed_at_ns);
