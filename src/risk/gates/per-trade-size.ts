// W1 — per-trade size cap: blocks orders larger than LIVE_BET_MAX (USD).
import type { ProposedOrder, RiskConfig, RiskGateDecision } from '../types.js';

export function perTradeSizeGate(
  order: ProposedOrder,
  config: Pick<RiskConfig, 'liveBetMax'>,
): RiskGateDecision {
  if (!Number.isFinite(order.sizeUsd) || order.sizeUsd <= 0) {
    return {
      ok: false,
      reason: `invalid order size: ${order.sizeUsd}`,
      blockingGate: 'per-trade-size',
      details: { sizeUsd: order.sizeUsd },
    };
  }
  if (order.sizeUsd > config.liveBetMax) {
    return {
      ok: false,
      reason: `order size $${order.sizeUsd} exceeds LIVE_BET_MAX $${config.liveBetMax}`,
      blockingGate: 'per-trade-size',
      details: { sizeUsd: order.sizeUsd, cap: config.liveBetMax },
    };
  }
  return { ok: true };
}
