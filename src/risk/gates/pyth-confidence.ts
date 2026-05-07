// W1 — pyth confidence gate: rejects orders when the Pyth oracle confidence
// interval is wider than PYTH_CONF_GATE_PCT of the price. If pythPrice or
// pythConfidence is absent, the gate is permissive (let the strategy decide
// whether to require oracle data).
import type { ProposedOrder, RiskConfig, RiskGateDecision } from '../types.js';

export function pythConfidenceGate(
  order: ProposedOrder,
  config: Pick<RiskConfig, 'pythConfGatePct'>,
): RiskGateDecision {
  const { pythPrice, pythConfidence } = order;
  if (pythPrice === undefined || pythConfidence === undefined) return { ok: true };
  if (pythPrice <= 0) return { ok: true };
  const pct = (pythConfidence / pythPrice) * 100;
  if (pct > config.pythConfGatePct) {
    return {
      ok: false,
      reason: `pyth confidence ${pct.toFixed(3)}% exceeds gate ${config.pythConfGatePct}%`,
      blockingGate: 'pyth-confidence',
      details: { pythPrice, pythConfidence, pct, gatePct: config.pythConfGatePct },
    };
  }
  return { ok: true };
}
