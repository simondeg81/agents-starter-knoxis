// W1 — risk gate API contract per EXTENSIONS_DESIGN.md
// All strategies depend on this file. Keep exports stable.

export interface ProposedOrder {
  strategy: string;
  marketSlug: string;
  asset: string;
  timeframe: '5m' | '15m' | '1h';
  side: 'yes_buy' | 'no_buy' | 'yes_sell' | 'no_sell';
  price: number;
  sizeUsd: number;
  pythPrice?: number;
  pythConfidence?: number;
}

export type RiskGateDecision =
  | { ok: true }
  | { ok: false; reason: string; blockingGate: string; details?: object };

export interface RiskGate {
  evaluate(order: ProposedOrder): Promise<RiskGateDecision>;
  isHalted(): Promise<{ halted: boolean; reason?: string }>;
  recordOutcome(orderId: string, outcome: 'win' | 'loss' | 'cancel'): Promise<void>;
}

export interface RiskConfig {
  liveBetMax: number;
  liveLossCap: number;
  drawdownHaltPct: number;
  correlationGroupCap: number;
  adverseHaltLosses: number;
  volRegimeHighFactor: number;
  pythConfGatePct: number;
  maxTotalExposureUsd: number;
  dbPath: string;
}

export interface ActiveHalt {
  haltId: number;
  haltedAtNs: number;
  reason: string;
  blockingGate: string;
  detailsJson?: string;
}

export type Outcome = 'win' | 'loss' | 'cancel';

export interface RiskState {
  getOpenPositionsSumUsd(asset?: string): Promise<number>;
  getDailyPnlUsd(): Promise<number>;
  getDailyPeakEquityUsd(): Promise<number>;
  getCurrentEquityUsd(): Promise<number>;
  getLastOutcomes(n: number): Promise<Outcome[]>;
  getActiveHalts(): Promise<ActiveHalt[]>;
  insertHalt(reason: string, blockingGate: string, details?: object): Promise<void>;
  recordTradeOutcome(orderId: string, outcome: Outcome): Promise<void>;
}
