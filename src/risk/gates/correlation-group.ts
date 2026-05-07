// W1 — correlation group cap: BTC, ETH, SOL move together. Sum of open
// exposure across this correlated group cannot exceed
// CORRELATION_GROUP_CAP * LIVE_BET_MAX after this order is added.
import type { ProposedOrder, RiskConfig, RiskGateDecision, RiskState } from '../types.js';

const CRYPTO_GROUP = new Set(['BTC', 'ETH', 'SOL']);

export async function correlationGroupGate(
  order: ProposedOrder,
  state: RiskState,
  config: Pick<RiskConfig, 'correlationGroupCap' | 'liveBetMax'>,
): Promise<RiskGateDecision> {
  const asset = order.asset.toUpperCase();
  if (!CRYPTO_GROUP.has(asset)) return { ok: true };

  const sums = await Promise.all(
    [...CRYPTO_GROUP].map((a) => state.getOpenPositionsSumUsd(a)),
  );
  const groupOpen = sums.reduce((a, b) => a + b, 0);
  const projected = groupOpen + order.sizeUsd;
  const cap = config.correlationGroupCap * config.liveBetMax;

  if (projected > cap) {
    return {
      ok: false,
      reason: `crypto group exposure $${projected.toFixed(2)} would exceed cap $${cap.toFixed(2)} (${config.correlationGroupCap}x LIVE_BET_MAX)`,
      blockingGate: 'correlation-group',
      details: {
        group: [...CRYPTO_GROUP],
        groupOpenUsd: groupOpen,
        orderSizeUsd: order.sizeUsd,
        projectedUsd: projected,
        capUsd: cap,
      },
    };
  }
  return { ok: true };
}
