// W1 — halted gate: blocks all orders if any active halt exists in risk_halts.
import type { ProposedOrder, RiskGateDecision, RiskState } from '../types.js';

export async function haltedGate(
  _order: ProposedOrder,
  state: RiskState,
): Promise<RiskGateDecision> {
  const halts = await state.getActiveHalts();
  if (halts.length === 0) return { ok: true };
  const first = halts[0];
  const extra = halts.length > 1 ? ` (+${halts.length - 1} more active)` : '';
  return {
    ok: false,
    reason: `system halted: ${first.reason}${extra}`,
    blockingGate: 'halted',
    details: { halts },
  };
}
