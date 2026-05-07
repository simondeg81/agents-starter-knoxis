// W1 — DefaultRiskGate composition.
//
// Evaluates 8 gates in this order. The first failing gate aborts evaluation
// and is reported as the blocking gate. Order matters:
//   1. halted              — system already halted: nothing else is meaningful
//   2. per-trade-size      — local check, no DB roundtrip
//   3. max-exposure        — DB roundtrip
//   4. pyth-confidence     — local check
//   5. correlation-group   — DB roundtrip (3 queries for BTC/ETH/SOL)
//   6. daily-loss          — DB roundtrip
//   7. drawdown            — DB roundtrip (2 queries)
//   8. adverse-selection   — DB roundtrip
//
// Orders that fail adverse-selection trigger an automatic halt insertion
// so subsequent calls are blocked by gate 1 even after the rolling window
// rolls forward.

import { pino, type Logger } from 'pino';
import { adverseSelectionGate } from './gates/adverse-selection.js';
import { correlationGroupGate } from './gates/correlation-group.js';
import { dailyLossGate } from './gates/daily-loss.js';
import { drawdownGate } from './gates/drawdown.js';
import { haltedGate } from './gates/halted.js';
import { maxExposureGate } from './gates/max-exposure.js';
import { perTradeSizeGate } from './gates/per-trade-size.js';
import { pythConfidenceGate } from './gates/pyth-confidence.js';
import { SqliteRiskState } from './state.js';
import type {
  Outcome,
  ProposedOrder,
  RiskConfig,
  RiskGate,
  RiskGateDecision,
  RiskState,
} from './types.js';

const DEFAULT_DB_PATH = '/var/lib/knoxis/knoxis-limitless.db';

export function loadConfigFromEnv(env: NodeJS.ProcessEnv = process.env): RiskConfig {
  return {
    liveBetMax: numberOr(env.LIVE_BET_MAX, 5),
    liveLossCap: numberOr(env.LIVE_LOSS_CAP, -50),
    drawdownHaltPct: numberOr(env.DRAWDOWN_HALT_PCT, 10),
    correlationGroupCap: numberOr(env.CORRELATION_GROUP_CAP, 1.5),
    adverseHaltLosses: numberOr(env.ADVERSE_HALT_LOSSES, 5),
    volRegimeHighFactor: numberOr(env.VOL_REGIME_HIGH_FACTOR, 2.0),
    pythConfGatePct: numberOr(env.PYTH_CONF_GATE_PCT, 0.5),
    maxTotalExposureUsd: numberOr(env.MAX_TOTAL_EXPOSURE_USD, 50),
    dbPath: env.RISK_DB_PATH || DEFAULT_DB_PATH,
  };
}

function numberOr(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

export class DefaultRiskGate implements RiskGate {
  private readonly log: Logger;
  private readonly config: RiskConfig;
  private readonly state: RiskState;

  constructor(opts?: { config?: RiskConfig; state?: RiskState; logger?: Logger }) {
    this.config = opts?.config ?? loadConfigFromEnv();
    this.log = opts?.logger ?? pino({
      level: process.env.LOG_LEVEL || 'info',
      name: 'risk:gate',
    });
    this.state = opts?.state ?? new SqliteRiskState(this.config.dbPath, this.log);
  }

  async evaluate(order: ProposedOrder): Promise<RiskGateDecision> {
    // Gate 1 — halted
    let d = await haltedGate(order, this.state);
    if (!d.ok) return d;

    // Gate 2 — per-trade-size (local)
    d = perTradeSizeGate(order, this.config);
    if (!d.ok) return d;

    // Gate 3 — max-exposure
    d = await maxExposureGate(order, this.state, this.config);
    if (!d.ok) return d;

    // Gate 4 — pyth-confidence (local)
    d = pythConfidenceGate(order, this.config);
    if (!d.ok) return d;

    // Gate 5 — correlation-group
    d = await correlationGroupGate(order, this.state, this.config);
    if (!d.ok) return d;

    // Gate 6 — daily-loss
    d = await dailyLossGate(order, this.state, this.config);
    if (!d.ok) return d;

    // Gate 7 — drawdown
    d = await drawdownGate(order, this.state, this.config);
    if (!d.ok) return d;

    // Gate 8 — adverse-selection
    d = await adverseSelectionGate(order, this.state, this.config);
    if (!d.ok) return d;

    return { ok: true };
  }

  async isHalted(): Promise<{ halted: boolean; reason?: string }> {
    const halts = await this.state.getActiveHalts();
    if (halts.length === 0) return { halted: false };
    const first = halts[0];
    const extra = halts.length > 1 ? ` (+${halts.length - 1} more)` : '';
    return { halted: true, reason: `${first.reason}${extra}` };
  }

  async recordOutcome(orderId: string, outcome: Outcome): Promise<void> {
    await this.state.recordTradeOutcome(orderId, outcome);

    // Re-check adverse-selection: if the last ADVERSE_HALT_LOSSES outcomes
    // are all losses, file an automatic halt so subsequent evaluations
    // short-circuit at gate 1 until cleared.
    const window = this.config.adverseHaltLosses;
    if (window <= 0) return;
    const recent = await this.state.getLastOutcomes(window);
    if (recent.length >= window && recent.every((o) => o === 'loss')) {
      const active = await this.state.getActiveHalts();
      const already = active.some((h) => h.blockingGate === 'adverse-selection');
      if (!already) {
        this.log.warn(
          { orderId, recent },
          'adverse-selection threshold reached — inserting halt',
        );
        await this.state.insertHalt(
          `adverse selection: ${window} consecutive losses`,
          'adverse-selection',
          { recent, triggeredBy: orderId },
        );
      }
    }
  }
}

export type { Outcome, ProposedOrder, RiskConfig, RiskGate, RiskGateDecision, RiskState } from './types.js';
export { SqliteRiskState } from './state.js';
