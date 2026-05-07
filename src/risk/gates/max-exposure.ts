// W1 — total exposure cap: sum of open positions + this order must stay <= MAX_TOTAL_EXPOSURE_USD.
// Implements W3-recon landmine L1 fix.
import type { ProposedOrder, RiskConfig, RiskGateDecision, RiskState } from '../types.js';

export async function maxExposureGate(
  order: ProposedOrder,
  state: RiskState,
  config: Pick<RiskConfig, 'maxTotalExposureUsd'>,
): Promise<RiskGateDecision> {
  const openSum = await state.getOpenPositionsSumUsd();
  const projected = openSum + order.sizeUsd;
  if (projected > config.maxTotalExposureUsd) {
    return {
      ok: false,
      reason: `total exposure $${projected.toFixed(2)} would exceed MAX_TOTAL_EXPOSURE_USD $${config.maxTotalExposureUsd}`,
      blockingGate: 'max-exposure',
      details: {
        openSumUsd: openSum,
        orderSizeUsd: order.sizeUsd,
        projectedUsd: projected,
        capUsd: config.maxTotalExposureUsd,
      },
    };
  }
  return { ok: true };
}
