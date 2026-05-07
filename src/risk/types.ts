// Placeholder — W1 (feature/risk-engine) replaces with full implementation
// per EXTENSIONS_DESIGN.md risk gate API contract.
// DO NOT modify in any other window.

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
