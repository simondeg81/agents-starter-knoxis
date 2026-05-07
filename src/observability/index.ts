// W5 — observability bootstrap. Owns: opening the SQLite DB, applying
// migrations 0001 + 0002 idempotently, wiring sqlite-writer to the bus.
//
// Usage:
//   import { initialize, eventBus } from './observability/index.js';
//   await initialize({ dbPath: process.env.RISK_DB_PATH ?? '/var/lib/knoxis/knoxis-limitless.db' });
//   // ...strategies emit on `eventBus`...

import Database from 'better-sqlite3';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pino } from 'pino';

import { eventBus, TypedEventBus } from './event-bus.js';
import { SqliteWriter } from './sqlite-writer.js';

export { eventBus, TypedEventBus } from './event-bus.js';
export { SqliteWriter } from './sqlite-writer.js';
export type {
  EventMap,
  EventName,
  StrategyName,
  Asset,
  Timeframe,
  Side,
  Outcome,
  StrategySubmitEvent,
  StrategyFillEvent,
  StrategyCancelEvent,
  StrategyRiskBlockEvent,
  StrategyDryRunEvent,
  StrategyResolveEvent,
  RiskHaltEvent,
  RiskUnhaltEvent,
  CouncilProposalEvent,
} from './event-bus.js';

const logger = pino({ level: process.env.LOG_LEVEL || 'info', name: 'observability' });

// Migrations: list in apply order. Each is a path relative to the repo root.
const MIGRATIONS: ReadonlyArray<{ id: number; relPath: string }> = [
  { id: 1, relPath: 'db/migrations/0001_init.sql' },
  { id: 2, relPath: 'db/migrations/0002_risk_state.sql' },
];

function ensureMigrationsTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
}

function alreadyApplied(db: Database.Database, id: number): boolean {
  const row = db.prepare('SELECT 1 FROM _migrations WHERE id = ?').get(id);
  return row !== undefined;
}

function markApplied(db: Database.Database, id: number): void {
  db.prepare('INSERT INTO _migrations (id) VALUES (?)').run(id);
}

// Migrations live at <repoRoot>/db/migrations. From this compiled file we
// can't assume a fixed offset (src/observability/index.ts vs dist/...), so
// walk up until we find db/migrations or hit /.
function findRepoRoot(startDir: string): string | null {
  let dir = startDir;
  for (let i = 0; i < 8; i++) {
    if (existsSync(resolve(dir, 'db/migrations'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

function loadMigration(repoRoot: string, relPath: string): string | null {
  const fp = resolve(repoRoot, relPath);
  if (!existsSync(fp)) return null;
  const sql = readFileSync(fp, 'utf8').trim();
  return sql.length > 0 ? sql : null;
}

function applyMigrations(db: Database.Database, repoRoot: string): { applied: number[]; skippedEmpty: number[] } {
  ensureMigrationsTable(db);
  const applied: number[] = [];
  const skippedEmpty: number[] = [];

  for (const m of MIGRATIONS) {
    if (alreadyApplied(db, m.id)) continue;

    const sql = loadMigration(repoRoot, m.relPath);
    if (sql === null) {
      // Placeholder file with only comments (current 0002) — record as
      // applied so we don't keep retrying, but flag for the caller.
      logger.info({ id: m.id, relPath: m.relPath }, 'migration is placeholder/empty — marking applied');
      markApplied(db, m.id);
      skippedEmpty.push(m.id);
      continue;
    }

    db.transaction(() => {
      db.exec(sql);
      markApplied(db, m.id);
    })();
    applied.push(m.id);
    logger.info({ id: m.id, relPath: m.relPath }, 'migration applied');
  }

  return { applied, skippedEmpty };
}

export interface InitializeOptions {
  /** Filesystem path to the SQLite db. Use ':memory:' for tests. */
  dbPath: string;
  /** Optional explicit bus to wire (defaults to the singleton). */
  bus?: TypedEventBus;
  /** Override repo root if the auto-walk can't find db/migrations. */
  repoRoot?: string;
}

export interface InitializeResult {
  db: Database.Database;
  bus: TypedEventBus;
  writer: SqliteWriter;
  appliedMigrations: number[];
  skippedEmptyMigrations: number[];
}

export function initialize(opts: InitializeOptions): InitializeResult {
  const dbPath = opts.dbPath;
  if (dbPath !== ':memory:') {
    const dir = dirname(dbPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }

  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  const here = dirname(fileURLToPath(import.meta.url));
  const repoRoot = opts.repoRoot ?? findRepoRoot(here) ?? process.cwd();

  const { applied, skippedEmpty } = applyMigrations(db, repoRoot);

  const bus = opts.bus ?? eventBus;
  const writer = new SqliteWriter(db);
  writer.attach(bus);

  logger.info(
    { dbPath, applied, skippedEmpty, repoRoot },
    'observability initialized'
  );

  return { db, bus, writer, appliedMigrations: applied, skippedEmptyMigrations: skippedEmpty };
}
