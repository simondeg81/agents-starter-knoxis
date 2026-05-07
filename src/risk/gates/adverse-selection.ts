// W1 — adverse selection halt: if the last ADVERSE_HALT_LOSSES outcomes
// are all losses, the strategy is being picked off and we halt new orders.
import type { ProposedOrder, RiskConfig, RiskGateDecision, RiskState } from '../types.js';

export async function adverseSelectionGate(
  _order: ProposedOrder,
  state: RiskState,
  config: Pick<RiskConfig, 'adverseHaltLosses'>,
): Promise<RiskGateDecision> {
  const window = config.adverseHaltLosses;
  if (window <= 0) return { ok: true };
  const recent = await state.getLastOutcomes(window);
  if (recent.length < window) return { ok: true };
  const losses = recent.filter((o) => o === 'loss').length;
  if (losses >= window) {
    return {
      ok: false,
      reason: `adverse selection: ${losses}/${window} most-recent resolutions are losses`,
      blockingGate: 'adverse-selection',
      details: { recent, losses, window },
    };
  }
  return { ok: true };
}
