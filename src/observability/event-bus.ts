// W5 — observability event bus.
// All strategies emit lifecycle events here. Subscribers (sqlite-writer,
// telegram, dashboard) react. Singleton — exported as `eventBus`.

import { EventEmitter } from 'node:events';

// ── Event payload types ─────────────────────────────────────────────────────

export type StrategyName =
  | 'oracle-arb'
  | 'maker-complement'
  | 'cross-platform-arb'
  | 'council'
  | string; // open for future strategies; kept loose to avoid cross-window edits

export type Asset = 'BTC' | 'ETH' | 'SOL' | 'XRP' | 'DOGE' | string;
export type Timeframe = '5m' | '15m' | '1h';
export type Side = 'yes_buy' | 'no_buy' | 'yes_sell' | 'no_sell';
export type Outcome = 'win' | 'loss' | 'cancel';

interface BaseStrategyEvent {
  timestampNs: bigint;
  strategy: StrategyName;
  marketSlug: string;
  asset: Asset;
  timeframe: Timeframe;
  isDryRun: boolean;
}

export interface StrategySubmitEvent extends BaseStrategyEvent {
  side: Side;
  price: number;
  sizeUsd: number;
  orderId?: string;
  pythPrice?: number;
  pythConfidence?: number;
}

export interface StrategyFillEvent extends BaseStrategyEvent {
  side: Side;
  price: number;
  sizeUsd: number;
  orderId: string;
}

export interface StrategyCancelEvent extends BaseStrategyEvent {
  orderId: string;
  side?: Side;
  price?: number;
  sizeUsd?: number;
}

export interface StrategyRiskBlockEvent extends BaseStrategyEvent {
  side: Side;
  price: number;
  sizeUsd: number;
  riskBlockReason: string; // e.g. 'daily_loss_cap'
}

// Distinct from `strategy.submit`+isDryRun=true so callers can filter cleanly.
// Mirror of submit shape; sqlite-writer treats these as event_type='submit' with is_dry_run=1.
export interface StrategyDryRunEvent extends BaseStrategyEvent {
  side: Side;
  price: number;
  sizeUsd: number;
  pythPrice?: number;
  pythConfidence?: number;
}

export interface StrategyResolveEvent extends BaseStrategyEvent {
  orderId: string;
  outcome: Outcome;
  realizedPnlUsd: number;
  side?: Side;
  price?: number;
  sizeUsd?: number;
}

export interface RiskHaltEvent {
  timestampNs: bigint;
  reason: string;            // 'daily_loss_cap' | 'drawdown' | 'adverse_selection' | 'manual' | ...
  details?: Record<string, unknown>;
}

export interface RiskUnhaltEvent {
  timestampNs: bigint;
  haltId?: number;            // optional — clear by id; if omitted, sqlite-writer clears all active
  clearedBy: string;          // 'manual' | 'auto-utc-rollover' | ...
  clearedReason?: string;
}

export interface CouncilProposalEvent {
  timestampNs: bigint;
  parameter: string;          // 'ORACLE_MIN_EDGE' | 'CORRELATION_GROUP_CAP' | ...
  currentValue: string;
  proposedValue: string;
  reasoning: string;
}

export interface EventMap {
  'strategy.submit':     StrategySubmitEvent;
  'strategy.fill':       StrategyFillEvent;
  'strategy.cancel':     StrategyCancelEvent;
  'strategy.risk_block': StrategyRiskBlockEvent;
  'strategy.dry_run':    StrategyDryRunEvent;
  'strategy.resolve':    StrategyResolveEvent;
  'risk.halt':           RiskHaltEvent;
  'risk.unhalt':         RiskUnhaltEvent;
  'council.proposal':    CouncilProposalEvent;
}

export type EventName = keyof EventMap;

// Typed wrapper around node:events.EventEmitter. Falls back to untyped emit
// for forward compatibility, but the public surface above is strict.
export class TypedEventBus {
  private emitter = new EventEmitter();

  constructor() {
    // Many subscribers expected (sqlite-writer + telegram + dashboard + future).
    // Default 10-listener cap would warn under normal use.
    this.emitter.setMaxListeners(50);
  }

  on<K extends EventName>(event: K, listener: (payload: EventMap[K]) => void): this {
    this.emitter.on(event, listener);
    return this;
  }

  off<K extends EventName>(event: K, listener: (payload: EventMap[K]) => void): this {
    this.emitter.off(event, listener);
    return this;
  }

  emit<K extends EventName>(event: K, payload: EventMap[K]): boolean {
    return this.emitter.emit(event, payload);
  }

  listenerCount(event: EventName): number {
    return this.emitter.listenerCount(event);
  }

  removeAllListeners(event?: EventName): this {
    if (event) {
      this.emitter.removeAllListeners(event);
    } else {
      this.emitter.removeAllListeners();
    }
    return this;
  }
}

// Singleton — strategies and subscribers should import this directly.
export const eventBus = new TypedEventBus();
