// W5 — cross-platform arb STUB strategy.
//
// This strategy will arb mispricings between Limitless (Base CLOB) and
// Polymarket (Polygon CLOB). It is gated behind CROSS_PLATFORM_ENABLED
// and remains inert until the Polymarket venue is implemented and
// Simon's Polymarket account is reactivated.
//
//   CROSS_PLATFORM_ENABLED=false (default) → tick() is a no-op
//   CROSS_PLATFORM_ENABLED=true             → tick() throws — Polymarket
//                                             venue is still a stub
//
// Wiring:
//   - implements the BaseStrategy contract so it can be loaded by the
//     same iterator (`src/strategies/iterate.ts`) that runs other
//     strategies
//   - all real work belongs in tick() once both venues are live; do NOT
//     add real logic here while the Polymarket venue throws

import { BaseStrategy, StrategyConfig, TradeDecision, StrategyStats } from '../base-strategy.js';

export interface CrossPlatformArbConfig extends StrategyConfig {
  /** Min edge in probability points (0-1) to act on. */
  minEdge?: number;
  /** Max single-leg notional in USD. */
  maxLegSizeUsd?: number;
}

function isEnabled(): boolean {
  const v = process.env.CROSS_PLATFORM_ENABLED;
  return v === 'true' || v === '1';
}

export class CrossPlatformArbStrategy extends BaseStrategy {
  private decisions = 0;

  async initialize(): Promise<void> {
    if (isEnabled()) {
      this.logger.warn(
        'CROSS_PLATFORM_ENABLED=true but Polymarket venue is still a stub — tick() will throw'
      );
    } else {
      this.logger.info('CROSS_PLATFORM_ENABLED not set — strategy inert (no-op)');
    }
  }

  async tick(): Promise<TradeDecision[]> {
    if (!isEnabled()) {
      return [];
    }
    throw new Error(
      'cross-platform arb requires both Limitless AND Polymarket venues active — implement Polymarket venue first'
    );
  }

  async shutdown(): Promise<void> {
    // nothing to release while inert
  }

  getStats(): StrategyStats {
    return {
      activePositions: 0,
      totalVolumeUsd: 0,
      pnlUsd: 0,
      lastTickDurationMs: 0,
    };
  }
}

// Default export so a future loader can `await import(...)` and instantiate.
export default CrossPlatformArbStrategy;
