// W1 — DB helpers for risk gate state.
//
// Connects to SQLite at the path in RiskConfig.dbPath (default
// /var/lib/knoxis/knoxis-limitless.db). The risk_halts table is owned
// by W1 (db/migrations/0002_risk_state.sql). The positions, daily_pnl
// and trade_events tables are owned by W5 (db/migrations/0001_init.sql)
// and are not yet present at Pass 2 commit time.
//
// W5 must align table shapes with these consumed columns:
//
//   positions:
//     position_id   INTEGER PRIMARY KEY
//     strategy      TEXT NOT NULL
//     market_slug   TEXT NOT NULL
//     asset         TEXT NOT NULL
//     side          TEXT NOT NULL
//     size_usd      REAL NOT NULL
//     opened_at_ns  INTEGER NOT NULL
//     closed_at_ns  INTEGER NULL          -- NULL while open
//
//   daily_pnl:
//     date            TEXT PRIMARY KEY    -- YYYY-MM-DD UTC
//     realized_usd    REAL NOT NULL DEFAULT 0
//     unrealized_usd  REAL NOT NULL DEFAULT 0
//     peak_equity_usd REAL NOT NULL DEFAULT 0
//     equity_usd      REAL NOT NULL DEFAULT 0
//     updated_at_ns   INTEGER NOT NULL
//
//   trade_events:
//     event_id     INTEGER PRIMARY KEY AUTOINCREMENT
//     ts_ns        INTEGER NOT NULL
//     strategy     TEXT
//     order_id     TEXT
//     market_slug  TEXT
//     asset        TEXT
//     event_type   TEXT NOT NULL          -- submit | fill | cancel | resolve
//     outcome      TEXT                   -- win | loss | cancel  (only for resolve)
//     size_usd     REAL
//     price        REAL
//     pnl_usd      REAL
//     details_json TEXT
//
// Graceful-degradation rules:
//   - DB file missing                           -> permissive (no positions, no halts, pnl=0)
//   - Table missing (SQLITE_ERROR / no such table) -> permissive for that table
//   - Other open/query failure                  -> propagate (caller decides; usually block)

import Database from 'better-sqlite3';
import { existsSync } from 'node:fs';
import { pino, type Logger } from 'pino';
import type { ActiveHalt, Outcome, RiskState } from './types.js';

const NO_TABLE_RE = /no such table:/i;

export class SqliteRiskState implements RiskState {
  private db: Database.Database | null;
  private readonly log: Logger;

  constructor(dbPath: string, logger?: Logger) {
    this.log = logger ?? pino({
      level: process.env.LOG_LEVEL || 'info',
      name: 'risk:state',
    });
    if (!existsSync(dbPath)) {
      this.log.warn({ dbPath }, 'risk DB not present — operating in permissive mode');
      this.db = null;
      return;
    }
    try {
      this.db = new Database(dbPath, { readonly: false, fileMustExist: true });
      this.db.pragma('journal_mode = WAL');
      this.db.pragma('busy_timeout = 5000');
    } catch (err) {
      this.log.error({ dbPath, err: String(err) }, 'failed to open risk DB');
      this.db = null;
    }
  }

  private safeQuery<T>(label: string, fn: (db: Database.Database) => T, fallback: T): T {
    if (!this.db) return fallback;
    try {
      return fn(this.db);
    } catch (err) {
      const msg = String(err);
      if (NO_TABLE_RE.test(msg)) {
        this.log.debug({ label }, 'risk state: table missing — permissive');
        return fallback;
      }
      this.log.error({ label, err: msg }, 'risk state query failed');
      throw err;
    }
  }

  async getOpenPositionsSumUsd(asset?: string): Promise<number> {
    return this.safeQuery('positions_sum', (db) => {
      const stmt = asset
        ? db.prepare(
            'SELECT COALESCE(SUM(size_usd), 0) AS s FROM positions WHERE closed_at_ns IS NULL AND asset = ?',
          )
        : db.prepare(
            'SELECT COALESCE(SUM(size_usd), 0) AS s FROM positions WHERE closed_at_ns IS NULL',
          );
      const row = (asset ? stmt.get(asset) : stmt.get()) as { s: number } | undefined;
      return row?.s ?? 0;
    }, 0);
  }

  async getDailyPnlUsd(): Promise<number> {
    return this.safeQuery('daily_pnl', (db) => {
      const today = todayUtc();
      const row = db
        .prepare('SELECT realized_usd + unrealized_usd AS p FROM daily_pnl WHERE date = ?')
        .get(today) as { p: number } | undefined;
      return row?.p ?? 0;
    }, 0);
  }

  async getDailyPeakEquityUsd(): Promise<number> {
    return this.safeQuery('daily_peak', (db) => {
      const today = todayUtc();
      const row = db
        .prepare('SELECT peak_equity_usd AS p FROM daily_pnl WHERE date = ?')
        .get(today) as { p: number } | undefined;
      return row?.p ?? 0;
    }, 0);
  }

  async getCurrentEquityUsd(): Promise<number> {
    return this.safeQuery('current_equity', (db) => {
      const today = todayUtc();
      const row = db
        .prepare('SELECT equity_usd AS e FROM daily_pnl WHERE date = ?')
        .get(today) as { e: number } | undefined;
      return row?.e ?? 0;
    }, 0);
  }

  async getLastOutcomes(n: number): Promise<Outcome[]> {
    return this.safeQuery('last_outcomes', (db) => {
      const rows = db
        .prepare(
          `SELECT outcome FROM trade_events
           WHERE event_type = 'resolve' AND outcome IS NOT NULL
           ORDER BY ts_ns DESC LIMIT ?`,
        )
        .all(n) as { outcome: string }[];
      return rows
        .map((r) => r.outcome)
        .filter((o): o is Outcome => o === 'win' || o === 'loss' || o === 'cancel');
    }, [] as Outcome[]);
  }

  async getActiveHalts(): Promise<ActiveHalt[]> {
    return this.safeQuery('active_halts', (db) => {
      const rows = db
        .prepare(
          `SELECT halt_id, halted_at_ns, reason, blocking_gate, details_json
           FROM risk_halts WHERE cleared_at_ns IS NULL ORDER BY halted_at_ns ASC`,
        )
        .all() as Array<{
          halt_id: number;
          halted_at_ns: number;
          reason: string;
          blocking_gate: string;
          details_json: string | null;
        }>;
      return rows.map((r) => ({
        haltId: r.halt_id,
        haltedAtNs: r.halted_at_ns,
        reason: r.reason,
        blockingGate: r.blocking_gate,
        detailsJson: r.details_json ?? undefined,
      }));
    }, [] as ActiveHalt[]);
  }

  async insertHalt(reason: string, blockingGate: string, details?: object): Promise<void> {
    if (!this.db) {
      this.log.warn({ reason, blockingGate }, 'cannot insert halt — DB unavailable');
      return;
    }
    try {
      this.db
        .prepare(
          `INSERT INTO risk_halts (halted_at_ns, reason, blocking_gate, details_json)
           VALUES (?, ?, ?, ?)`,
        )
        .run(Date.now() * 1_000_000, reason, blockingGate, details ? JSON.stringify(details) : null);
    } catch (err) {
      this.log.error({ err: String(err) }, 'insertHalt failed');
    }
  }

  async recordTradeOutcome(orderId: string, outcome: Outcome): Promise<void> {
    if (!this.db) {
      this.log.warn({ orderId, outcome }, 'cannot record outcome — DB unavailable');
      return;
    }
    try {
      this.db
        .prepare(
          `INSERT INTO trade_events (ts_ns, order_id, event_type, outcome)
           VALUES (?, ?, 'resolve', ?)`,
        )
        .run(Date.now() * 1_000_000, orderId, outcome);
    } catch (err) {
      const msg = String(err);
      if (NO_TABLE_RE.test(msg)) {
        this.log.debug({ orderId }, 'trade_events table missing — outcome dropped');
        return;
      }
      this.log.error({ err: msg }, 'recordTradeOutcome failed');
    }
  }

  close(): void {
    try {
      this.db?.close();
    } catch {
      // ignore
    }
  }
}

function todayUtc(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}
