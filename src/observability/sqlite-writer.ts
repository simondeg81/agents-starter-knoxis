// W5 — sqlite writer. Subscribes to the typed event bus and persists each
// event to the schema in db/migrations/0001_init.sql. All inserts go through
// here so other windows never write SQL directly.

import type Database from 'better-sqlite3';
import type {
  TypedEventBus,
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

type Stmt = Database.Statement;

// ── Helpers ──────────────────────────────────────────────────────────────────

function nsToBigInt(ns: bigint | number): bigint {
  return typeof ns === 'bigint' ? ns : BigInt(ns);
}

// SQLite INTEGER is signed 64-bit; better-sqlite3 round-trips bigint with
// `safeIntegers(true)` per-statement. Easier and lossless to store the ns
// timestamp as text — we sort lexicographically because all values are the
// same width once zero-padded by the caller's clock. To avoid sorting
// surprises, store as INTEGER via Number when the value fits, and keep a
// helper that converts safely.
function nsForSqlite(ns: bigint): number | bigint {
  // bigint up to 2^53 fits in a JS number losslessly. ~285k years from 1970
  // in nanoseconds is the Number.MAX_SAFE_INTEGER ceiling, so this is fine
  // for any real-world timestamp.
  if (ns <= BigInt(Number.MAX_SAFE_INTEGER)) return Number(ns);
  return ns;
}

function utcDateOf(timestampNs: bigint): string {
  const ms = Number(timestampNs / 1_000_000n);
  return new Date(ms).toISOString().slice(0, 10);
}

// JSON.stringify can't serialize bigint by default. Event payloads carry
// `timestampNs: bigint`, so the raw_payload column needs a replacer.
function stringifyWithBigInt(value: unknown): string {
  return JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
}

// ── Writer ───────────────────────────────────────────────────────────────────

export class SqliteWriter {
  private insertEvent!: Stmt;
  private upsertPosition!: Stmt;
  private deletePosition!: Stmt;
  private bumpDailyPnl!: Stmt;
  // DEPRECATED Pass 4: bus-path risk_halts WRITE removed. Direct-SQL in
  // src/risk/state.ts is canonical; bus subscription is kept for
  // notification observers (Telegram, dashboard) only.
  private insertProposal!: Stmt;
  private detached: Array<() => void> = [];

  constructor(private db: Database.Database) {
    this.prepareStatements();
  }

  private prepareStatements(): void {
    this.insertEvent = this.db.prepare(`
      INSERT INTO trade_events (
        timestamp_ns, strategy, market_slug, asset, timeframe, event_type,
        side, price, size_usd, order_id, pyth_price, pyth_confidence,
        outcome, realized_pnl_usd, risk_block_reason, is_dry_run, raw_payload
      ) VALUES (
        @timestampNs, @strategy, @marketSlug, @asset, @timeframe, @eventType,
        @side, @price, @sizeUsd, @orderId, @pythPrice, @pythConfidence,
        @outcome, @realizedPnlUsd, @riskBlockReason, @isDryRun, @rawPayload
      )
    `);

    this.upsertPosition = this.db.prepare(`
      INSERT INTO positions (
        market_slug, strategy, asset, side, entry_price, size_usd,
        opened_at_ns, is_dry_run
      ) VALUES (
        @marketSlug, @strategy, @asset, @side, @entryPrice, @sizeUsd,
        @openedAtNs, @isDryRun
      )
      ON CONFLICT(market_slug, strategy) DO UPDATE SET
        side         = excluded.side,
        entry_price  = excluded.entry_price,
        size_usd     = excluded.size_usd,
        opened_at_ns = excluded.opened_at_ns,
        is_dry_run   = excluded.is_dry_run
    `);

    this.deletePosition = this.db.prepare(`
      DELETE FROM positions WHERE market_slug = ? AND strategy = ?
    `);

    // Aggregate counter bump. All increments are zero unless caller passes them.
    this.bumpDailyPnl = this.db.prepare(`
      INSERT INTO daily_pnl (
        utc_date, strategy, realized_pnl_usd, fees_paid_usd,
        rebates_received_usd, n_trades, n_wins, n_losses, n_risk_blocks
      ) VALUES (
        @utcDate, @strategy, @realizedPnlUsd, 0, 0, @nTrades, @nWins, @nLosses, @nRiskBlocks
      )
      ON CONFLICT(utc_date, strategy) DO UPDATE SET
        realized_pnl_usd = realized_pnl_usd + excluded.realized_pnl_usd,
        n_trades         = n_trades         + excluded.n_trades,
        n_wins           = n_wins           + excluded.n_wins,
        n_losses         = n_losses         + excluded.n_losses,
        n_risk_blocks    = n_risk_blocks    + excluded.n_risk_blocks
    `);

    // DEPRECATED Pass 4: prepares for risk_halts WRITE removed.
    // Canonical writer is src/risk/state.ts (direct SQL).

    this.insertProposal = this.db.prepare(`
      INSERT INTO council_proposals (
        proposed_at_ns, parameter, current_value, proposed_value,
        reasoning, status
      ) VALUES (
        @proposedAtNs, @parameter, @currentValue, @proposedValue,
        @reasoning, 'pending'
      )
    `);
  }

  // ── Subscribe / detach ─────────────────────────────────────────────────────

  attach(bus: TypedEventBus): void {
    const onSubmit    = (e: StrategySubmitEvent)    => this.handleSubmit(e);
    const onFill      = (e: StrategyFillEvent)      => this.handleFill(e);
    const onCancel    = (e: StrategyCancelEvent)    => this.handleCancel(e);
    const onRiskBlock = (e: StrategyRiskBlockEvent) => this.handleRiskBlock(e);
    const onDryRun    = (e: StrategyDryRunEvent)    => this.handleDryRun(e);
    const onResolve   = (e: StrategyResolveEvent)   => this.handleResolve(e);
    const onHalt      = (e: RiskHaltEvent)          => this.handleHalt(e);
    const onUnhalt    = (e: RiskUnhaltEvent)        => this.handleUnhalt(e);
    const onProposal  = (e: CouncilProposalEvent)   => this.handleProposal(e);

    bus.on('strategy.submit',     onSubmit);
    bus.on('strategy.fill',       onFill);
    bus.on('strategy.cancel',     onCancel);
    bus.on('strategy.risk_block', onRiskBlock);
    bus.on('strategy.dry_run',    onDryRun);
    bus.on('strategy.resolve',    onResolve);
    bus.on('risk.halt',           onHalt);
    bus.on('risk.unhalt',         onUnhalt);
    bus.on('council.proposal',    onProposal);

    this.detached.push(() => {
      bus.off('strategy.submit',     onSubmit);
      bus.off('strategy.fill',       onFill);
      bus.off('strategy.cancel',     onCancel);
      bus.off('strategy.risk_block', onRiskBlock);
      bus.off('strategy.dry_run',    onDryRun);
      bus.off('strategy.resolve',    onResolve);
      bus.off('risk.halt',           onHalt);
      bus.off('risk.unhalt',         onUnhalt);
      bus.off('council.proposal',    onProposal);
    });
  }

  detach(): void {
    for (const off of this.detached) off();
    this.detached = [];
  }

  // ── Handlers ───────────────────────────────────────────────────────────────

  private writeEvent(row: {
    timestampNs: bigint;
    strategy: string;
    marketSlug: string;
    asset: string;
    timeframe: string;
    eventType: string;
    side: string | null;
    price: number | null;
    sizeUsd: number | null;
    orderId: string | null;
    pythPrice: number | null;
    pythConfidence: number | null;
    outcome: string | null;
    realizedPnlUsd: number | null;
    riskBlockReason: string | null;
    isDryRun: 0 | 1;
    rawPayload: unknown;
  }): void {
    this.insertEvent.run({
      timestampNs:    nsForSqlite(row.timestampNs),
      strategy:       row.strategy,
      marketSlug:     row.marketSlug,
      asset:          row.asset,
      timeframe:      row.timeframe,
      eventType:      row.eventType,
      side:           row.side,
      price:          row.price,
      sizeUsd:        row.sizeUsd,
      orderId:        row.orderId,
      pythPrice:      row.pythPrice,
      pythConfidence: row.pythConfidence,
      outcome:        row.outcome,
      realizedPnlUsd: row.realizedPnlUsd,
      riskBlockReason: row.riskBlockReason,
      isDryRun:       row.isDryRun,
      rawPayload:     row.rawPayload === undefined ? null : stringifyWithBigInt(row.rawPayload),
    });
  }

  private handleSubmit(e: StrategySubmitEvent): void {
    const ts = nsToBigInt(e.timestampNs);
    this.writeEvent({
      timestampNs: ts,
      strategy: e.strategy,
      marketSlug: e.marketSlug,
      asset: e.asset,
      timeframe: e.timeframe,
      eventType: 'submit',
      side: e.side,
      price: e.price,
      sizeUsd: e.sizeUsd,
      orderId: e.orderId ?? null,
      pythPrice: e.pythPrice ?? null,
      pythConfidence: e.pythConfidence ?? null,
      outcome: null,
      realizedPnlUsd: null,
      riskBlockReason: null,
      isDryRun: e.isDryRun ? 1 : 0,
      rawPayload: e,
    });
  }

  private handleFill(e: StrategyFillEvent): void {
    const ts = nsToBigInt(e.timestampNs);
    this.writeEvent({
      timestampNs: ts,
      strategy: e.strategy,
      marketSlug: e.marketSlug,
      asset: e.asset,
      timeframe: e.timeframe,
      eventType: 'fill',
      side: e.side,
      price: e.price,
      sizeUsd: e.sizeUsd,
      orderId: e.orderId,
      pythPrice: null,
      pythConfidence: null,
      outcome: null,
      realizedPnlUsd: null,
      riskBlockReason: null,
      isDryRun: e.isDryRun ? 1 : 0,
      rawPayload: e,
    });

    this.upsertPosition.run({
      marketSlug: e.marketSlug,
      strategy:   e.strategy,
      asset:      e.asset,
      side:       e.side,
      entryPrice: e.price,
      sizeUsd:    e.sizeUsd,
      openedAtNs: nsForSqlite(ts),
      isDryRun:   e.isDryRun ? 1 : 0,
    });

    this.bumpDailyPnl.run({
      utcDate: utcDateOf(ts),
      strategy: e.strategy,
      realizedPnlUsd: 0,
      nTrades: 1,
      nWins: 0,
      nLosses: 0,
      nRiskBlocks: 0,
    });
  }

  private handleCancel(e: StrategyCancelEvent): void {
    const ts = nsToBigInt(e.timestampNs);
    this.writeEvent({
      timestampNs: ts,
      strategy: e.strategy,
      marketSlug: e.marketSlug,
      asset: e.asset,
      timeframe: e.timeframe,
      eventType: 'cancel',
      side: e.side ?? null,
      price: e.price ?? null,
      sizeUsd: e.sizeUsd ?? null,
      orderId: e.orderId,
      pythPrice: null,
      pythConfidence: null,
      outcome: null,
      realizedPnlUsd: null,
      riskBlockReason: null,
      isDryRun: e.isDryRun ? 1 : 0,
      rawPayload: e,
    });
  }

  private handleRiskBlock(e: StrategyRiskBlockEvent): void {
    const ts = nsToBigInt(e.timestampNs);
    this.writeEvent({
      timestampNs: ts,
      strategy: e.strategy,
      marketSlug: e.marketSlug,
      asset: e.asset,
      timeframe: e.timeframe,
      eventType: 'risk_block',
      side: e.side,
      price: e.price,
      sizeUsd: e.sizeUsd,
      orderId: null,
      pythPrice: null,
      pythConfidence: null,
      outcome: null,
      realizedPnlUsd: null,
      riskBlockReason: e.riskBlockReason,
      isDryRun: e.isDryRun ? 1 : 0,
      rawPayload: e,
    });

    this.bumpDailyPnl.run({
      utcDate: utcDateOf(ts),
      strategy: e.strategy,
      realizedPnlUsd: 0,
      nTrades: 0,
      nWins: 0,
      nLosses: 0,
      nRiskBlocks: 1,
    });
  }

  private handleDryRun(e: StrategyDryRunEvent): void {
    // Treat as a 'submit' row with is_dry_run=1 — keeps querying simple.
    const ts = nsToBigInt(e.timestampNs);
    this.writeEvent({
      timestampNs: ts,
      strategy: e.strategy,
      marketSlug: e.marketSlug,
      asset: e.asset,
      timeframe: e.timeframe,
      eventType: 'submit',
      side: e.side,
      price: e.price,
      sizeUsd: e.sizeUsd,
      orderId: null,
      pythPrice: e.pythPrice ?? null,
      pythConfidence: e.pythConfidence ?? null,
      outcome: null,
      realizedPnlUsd: null,
      riskBlockReason: null,
      isDryRun: 1,
      rawPayload: e,
    });
  }

  private handleResolve(e: StrategyResolveEvent): void {
    const ts = nsToBigInt(e.timestampNs);
    this.writeEvent({
      timestampNs: ts,
      strategy: e.strategy,
      marketSlug: e.marketSlug,
      asset: e.asset,
      timeframe: e.timeframe,
      eventType: 'resolve',
      side: e.side ?? null,
      price: e.price ?? null,
      sizeUsd: e.sizeUsd ?? null,
      orderId: e.orderId,
      pythPrice: null,
      pythConfidence: null,
      outcome: e.outcome,
      realizedPnlUsd: e.realizedPnlUsd,
      riskBlockReason: null,
      isDryRun: e.isDryRun ? 1 : 0,
      rawPayload: e,
    });

    // Position closed → remove. (If a partial-resolve model is added later,
    // change this to subtract size_usd instead of delete.)
    this.deletePosition.run(e.marketSlug, e.strategy);

    this.bumpDailyPnl.run({
      utcDate: utcDateOf(ts),
      strategy: e.strategy,
      realizedPnlUsd: e.realizedPnlUsd,
      nTrades: 0,
      nWins:   e.outcome === 'win'  ? 1 : 0,
      nLosses: e.outcome === 'loss' ? 1 : 0,
      nRiskBlocks: 0,
    });
  }

  private handleHalt(e: RiskHaltEvent): void {
    // DEPRECATED Pass 4: halt WRITE is canonical via direct-SQL in
    // src/risk/state.ts. Bus subscription kept for notification
    // observers (Telegram, dashboard) that still consume the event.
    console.log('[observability] risk.halt event observed (write handled by risk engine):', e.reason);
  }

  private handleUnhalt(e: RiskUnhaltEvent): void {
    // DEPRECATED Pass 4: see handleHalt above. Bus subscription kept;
    // unhalt WRITE is canonical via direct-SQL in src/risk/state.ts.
    console.log('[observability] risk.unhalt event observed (write handled by risk engine):', e.clearedBy);
  }

  private handleProposal(e: CouncilProposalEvent): void {
    const ts = nsToBigInt(e.timestampNs);
    this.insertProposal.run({
      proposedAtNs: nsForSqlite(ts),
      parameter:    e.parameter,
      currentValue: e.currentValue,
      proposedValue: e.proposedValue,
      reasoning:    e.reasoning,
    });
  }
}
