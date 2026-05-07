import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';

export interface PositionRow {
  asset: string;
  marketSlug: string;
  side: 'yes' | 'no';
  sizeUsd: number;
}

export interface OutcomeRow {
  outcome: 'win' | 'loss' | 'cancel';
  ts: number;
}

export interface DailyPnlRow {
  day: string;
  pnlUsd: number;
}

/**
 * Read-only access to the KNOXis state DB.
 *
 * EXTENSIONS_DESIGN.md mandates SQLITE_OPEN_READONLY semantics.
 * better-sqlite3 is not yet a dep -- W5 owns dep additions and the
 * 0001_init.sql migration. Until W5 lands, this wrapper shells out
 * to `sqlite3 -readonly` which has the same OS-level guarantee:
 * the DB file is opened with O_RDONLY at the syscall layer, and any
 * write attempt errors at the engine. The interface below is shaped
 * so a future better-sqlite3 swap is local to this file.
 *
 * All methods return [] / null on missing DB or sqlite3-CLI failure
 * so the Council tick can proceed on a freshly-set-up host.
 */
export class ReadOnlyState {
  private static readonly SEP = '\x1f'; // ASCII Unit Separator

  constructor(private readonly dbPath: string) {}

  private query(sql: string): string[][] {
    if (!existsSync(this.dbPath)) return [];
    try {
      const out = execFileSync(
        'sqlite3',
        ['-readonly', '-separator', ReadOnlyState.SEP, this.dbPath, sql],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
      );
      return out
        .split('\n')
        .filter((line: string) => line.length > 0)
        .map((line: string) => line.split(ReadOnlyState.SEP));
    } catch {
      return [];
    }
  }

  getOpenPositions(): PositionRow[] {
    const rows = this.query(
      "SELECT asset, market_slug, side, size_usd FROM positions WHERE status='open'"
    );
    return rows
      .map((r) => ({
        asset: r[0] ?? '',
        marketSlug: r[1] ?? '',
        side: (r[2] as 'yes' | 'no') ?? 'yes',
        sizeUsd: Number(r[3]),
      }))
      .filter((p) => Number.isFinite(p.sizeUsd) && p.asset !== '');
  }

  getRecentOutcomes(limit: number): OutcomeRow[] {
    const safeLimit = Math.max(1, Math.min(1000, Math.floor(limit)));
    const rows = this.query(
      "SELECT outcome, ts FROM trade_events WHERE outcome IN ('win','loss','cancel') " +
      `ORDER BY ts DESC LIMIT ${safeLimit}`
    );
    return rows
      .map((r) => ({
        outcome: r[0] as 'win' | 'loss' | 'cancel',
        ts: Number(r[1]),
      }))
      .filter((o) => Number.isFinite(o.ts));
  }

  getDailyPnlToday(): DailyPnlRow | null {
    const rows = this.query(
      "SELECT day, pnl_usd FROM daily_pnl WHERE day = date('now') LIMIT 1"
    );
    if (rows.length === 0 || rows[0].length < 2) return null;
    const pnl = Number(rows[0][1]);
    if (!Number.isFinite(pnl)) return null;
    return { day: rows[0][0], pnlUsd: pnl };
  }
}
