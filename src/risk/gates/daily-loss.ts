// W1 — daily loss cap: blocks new orders once realized+unrealized PnL for
// the current UTC day is at or below LIVE_LOSS_CAP (negative threshold).
import type { ProposedOrder, RiskConfig, RiskGateDecision, RiskState } from '../types.js';

export async function dailyLossGate(
  _order: ProposedOrder,
  state: RiskState,
  config: Pick<RiskConfig, 'liveLossCap'>,
): Promise<RiskGateDecision> {
  const pnl = await state.getDailyPnlUsd();
  if (pnl <= config.liveLossCap) {
    return {
      ok: false,
      reason: `daily PnL $${pnl.toFixed(2)} at or below LIVE_LOSS_CAP $${config.liveLossCap}`,
      blockingGate: 'daily-loss',
      details: { pnlUsd: pnl, capUsd: config.liveLossCap },
    };
  }
  return { ok: true };
}
