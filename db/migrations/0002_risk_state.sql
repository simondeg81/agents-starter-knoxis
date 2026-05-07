-- W1 (feature/risk-engine) owns this file.
-- Risk-engine state. risk_halts is the source of truth for whether the
-- system should reject all new orders. The halted gate (gate 1) reads this.
--
-- Cross-reference: db/migrations/0001_init.sql is owned by W5 and defines
-- positions, daily_pnl, trade_events, council_proposals — see
-- src/risk/state.ts comments for the columns this module consumes.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS risk_halts (
    halt_id        INTEGER PRIMARY KEY AUTOINCREMENT,
    halted_at_ns   INTEGER NOT NULL,
    cleared_at_ns  INTEGER,
    reason         TEXT NOT NULL,
    blocking_gate  TEXT NOT NULL,
    details_json   TEXT,
    cleared_reason TEXT,
    cleared_by     TEXT
);

CREATE INDEX IF NOT EXISTS idx_risk_halts_halted_at  ON risk_halts(halted_at_ns);
CREATE INDEX IF NOT EXISTS idx_risk_halts_cleared_at ON risk_halts(cleared_at_ns);

-- Convenience view: currently-active halts (cleared_at_ns IS NULL).
CREATE VIEW IF NOT EXISTS v_active_halts AS
    SELECT halt_id, halted_at_ns, reason, blocking_gate, details_json
    FROM risk_halts
    WHERE cleared_at_ns IS NULL
    ORDER BY halted_at_ns ASC;
