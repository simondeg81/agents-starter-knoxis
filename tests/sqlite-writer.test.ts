// W5 — sqlite-writer integration test against an in-memory DB.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import Database from 'better-sqlite3';
import { TypedEventBus } from '../src/observability/event-bus.js';
import { SqliteWriter } from '../src/observability/sqlite-writer.js';

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = MEMORY');
  db.pragma('foreign_keys = ON');
  const sql0001 = readFileSync(resolve(process.cwd(), 'db/migrations/0001_init.sql'), 'utf8');
  const sql0002 = readFileSync(resolve(process.cwd(), 'db/migrations/0002_risk_state.sql'), 'utf8');
  db.exec(sql0001);
  db.exec(sql0002);
  return db;
}

test('strategy.submit writes a trade_events row', () => {
  const db = makeDb();
  const bus = new TypedEventBus();
  new SqliteWriter(db).attach(bus);

  bus.emit('strategy.submit', {
    timestampNs: 1_700_000_000_000_000_000n,
    strategy: 'oracle-arb',
    marketSlug: 'btc-up-or-down-1-hour-1700000003600',
    asset: 'BTC',
    timeframe: '1h',
    isDryRun: false,
    side: 'yes_buy',
    price: 0.45,
    sizeUsd: 5,
    pythPrice: 60000,
    pythConfidence: 0.001,
  });

  const row = db.prepare(`SELECT * FROM trade_events WHERE strategy = 'oracle-arb'`).get() as any;
  assert.ok(row);
  assert.equal(row.event_type, 'submit');
  assert.equal(row.market_slug, 'btc-up-or-down-1-hour-1700000003600');
  assert.equal(row.asset, 'BTC');
  assert.equal(row.timeframe, '1h');
  assert.equal(row.side, 'yes_buy');
  assert.equal(row.price, 0.45);
  assert.equal(row.size_usd, 5);
  assert.equal(row.is_dry_run, 0);
});

test('strategy.fill upserts a position and bumps daily_pnl n_trades', () => {
  const db = makeDb();
  const bus = new TypedEventBus();
  new SqliteWriter(db).attach(bus);

  bus.emit('strategy.fill', {
    timestampNs: 1_700_000_000_000_000_000n,
    strategy: 'oracle-arb',
    marketSlug: 'btc-up-or-down-1-hour-1700000003600',
    asset: 'BTC',
    timeframe: '1h',
    isDryRun: false,
    side: 'yes_buy',
    price: 0.42,
    sizeUsd: 5,
    orderId: 'ord_1',
  });

  const events = db.prepare(`SELECT count(*) AS n FROM trade_events WHERE event_type = 'fill'`).get() as any;
  assert.equal(events.n, 1);

  const pos = db.prepare(`SELECT * FROM positions WHERE market_slug = ?`)
    .get('btc-up-or-down-1-hour-1700000003600') as any;
  assert.ok(pos);
  assert.equal(pos.strategy, 'oracle-arb');
  assert.equal(pos.entry_price, 0.42);
  assert.equal(pos.size_usd, 5);

  const pnl = db.prepare(`SELECT * FROM daily_pnl WHERE strategy = 'oracle-arb'`).get() as any;
  assert.ok(pnl);
  assert.equal(pnl.n_trades, 1);
  assert.equal(pnl.realized_pnl_usd, 0);
});

test('strategy.resolve updates daily_pnl and removes position', () => {
  const db = makeDb();
  const bus = new TypedEventBus();
  new SqliteWriter(db).attach(bus);

  // Open
  bus.emit('strategy.fill', {
    timestampNs: 1_700_000_000_000_000_000n,
    strategy: 'oracle-arb',
    marketSlug: 'eth-up-or-down-1-hour-x',
    asset: 'ETH',
    timeframe: '1h',
    isDryRun: false,
    side: 'no_buy',
    price: 0.55,
    sizeUsd: 4,
    orderId: 'ord_2',
  });

  // Win
  bus.emit('strategy.resolve', {
    timestampNs: 1_700_000_003_600_000_000n,
    strategy: 'oracle-arb',
    marketSlug: 'eth-up-or-down-1-hour-x',
    asset: 'ETH',
    timeframe: '1h',
    isDryRun: false,
    orderId: 'ord_2',
    outcome: 'win',
    realizedPnlUsd: 3.27,
  });

  const pos = db.prepare(`SELECT * FROM positions WHERE market_slug = 'eth-up-or-down-1-hour-x'`).get();
  assert.equal(pos, undefined, 'position must be deleted on resolve');

  const pnl = db.prepare(`SELECT * FROM daily_pnl WHERE strategy = 'oracle-arb'`).get() as any;
  assert.equal(pnl.n_trades, 1);
  assert.equal(pnl.n_wins, 1);
  assert.equal(pnl.n_losses, 0);
  assert.ok(Math.abs(pnl.realized_pnl_usd - 3.27) < 1e-9);
});

test('strategy.risk_block writes event row with reason and bumps n_risk_blocks', () => {
  const db = makeDb();
  const bus = new TypedEventBus();
  new SqliteWriter(db).attach(bus);

  bus.emit('strategy.risk_block', {
    timestampNs: 1_700_000_000_000_000_000n,
    strategy: 'oracle-arb',
    marketSlug: 'sol-up-or-down-1-hour-x',
    asset: 'SOL',
    timeframe: '1h',
    isDryRun: false,
    side: 'yes_buy',
    price: 0.30,
    sizeUsd: 5,
    riskBlockReason: 'daily_loss_cap',
  });

  const ev = db.prepare(`SELECT * FROM trade_events WHERE event_type = 'risk_block'`).get() as any;
  assert.ok(ev);
  assert.equal(ev.risk_block_reason, 'daily_loss_cap');

  const pnl = db.prepare(`SELECT * FROM daily_pnl WHERE strategy = 'oracle-arb'`).get() as any;
  assert.equal(pnl.n_risk_blocks, 1);
  assert.equal(pnl.n_trades, 0);
});

test('strategy.dry_run writes a submit row with is_dry_run=1', () => {
  const db = makeDb();
  const bus = new TypedEventBus();
  new SqliteWriter(db).attach(bus);

  bus.emit('strategy.dry_run', {
    timestampNs: 1_700_000_000_000_000_000n,
    strategy: 'oracle-arb',
    marketSlug: 'btc-up-or-down-1-hour-1700000003600',
    asset: 'BTC',
    timeframe: '1h',
    isDryRun: true,
    side: 'yes_buy',
    price: 0.45,
    sizeUsd: 5,
  });

  const row = db.prepare(`SELECT * FROM trade_events WHERE event_type = 'submit'`).get() as any;
  assert.ok(row);
  assert.equal(row.is_dry_run, 1);
});


test('council.proposal inserts a pending proposal', () => {
  const db = makeDb();
  const bus = new TypedEventBus();
  new SqliteWriter(db).attach(bus);

  bus.emit('council.proposal', {
    timestampNs: 1_700_000_000_000_000_000n,
    parameter: 'ORACLE_MIN_EDGE',
    currentValue: '0.10',
    proposedValue: '0.12',
    reasoning: 'recent fills clustered above 0.12',
  });

  const row = db.prepare(`SELECT * FROM council_proposals WHERE parameter = 'ORACLE_MIN_EDGE'`).get() as any;
  assert.ok(row);
  assert.equal(row.status, 'pending');
  assert.equal(row.proposed_value, '0.12');
});
