// W1 — drawdown halt: blocks orders when current equity has fallen
// DRAWDOWN_HALT_PCT below today's peak equity.
import type { ProposedOrder, RiskConfig, RiskGateDecision, RiskState } from '../types.js';

export async function drawdownGate(
  _order: ProposedOrder,
  state: RiskState,
  config: Pick<RiskConfig, 'drawdownHaltPct'>,
): Promise<RiskGateDecision> {
  const peak = await state.getDailyPeakEquityUsd();
  const equity = await state.getCurrentEquityUsd();
  if (peak <= 0 || equity <= 0) return { ok: true };
  const drawdownPct = ((peak - equity) / peak) * 100;
  if (drawdownPct >= config.drawdownHaltPct) {
    return {
      ok: false,
      reason: `drawdown ${drawdownPct.toFixed(2)}% reached DRAWDOWN_HALT_PCT ${config.drawdownHaltPct}%`,
      blockingGate: 'drawdown',
      details: {
        peakUsd: peak,
        equityUsd: equity,
        drawdownPct,
        haltPct: config.drawdownHaltPct,
      },
    };
  }
  return { ok: true };
}
