export interface Proposal {
  parameter: string;
  currentValue: number | string | null;
  suggestedValue: number | string;
  reason: string;
  evidence: Record<string, unknown>;
  /** ISO-8601 timestamp filled in by the caller */
  ts?: string;
}

/**
 * Vol-regime heuristic.
 *
 * If 1m BTC ATR is materially elevated vs the trailing daily average,
 * suggest tightening sizing via VOL_REGIME_HIGH_FACTOR. The 1.75x cutoff
 * is chosen so we only fire on actual regime shifts, not noise.
 */
export function proposeVolRegime(
  btcAtr1m: number,
  btcAtr1dAvg: number
): Proposal | null {
  if (!Number.isFinite(btcAtr1m) || !Number.isFinite(btcAtr1dAvg)) return null;
  if (btcAtr1dAvg <= 0) return null;
  const ratio = btcAtr1m / btcAtr1dAvg;
  if (ratio < 1.75) return null;
  const suggested = Math.max(0.4, Math.min(1.0, 1.0 / ratio));
  return {
    parameter: 'VOL_REGIME_HIGH_FACTOR',
    currentValue: null,
    suggestedValue: Number(suggested.toFixed(3)),
    reason: `BTC 1m ATR is ${ratio.toFixed(2)}x the 1d average (>=1.75x trigger)`,
    evidence: { btcAtr1m, btcAtr1dAvg, ratio },
  };
}

/**
 * Adverse-rate-trend heuristic.
 *
 * Look at the last N settled bets. If win rate slips below 60% over a
 * meaningful sample, suggest bumping ORACLE_MIN_EDGE so the strategy
 * becomes more selective. Reported as a relative bump (+0.05) so W1
 * can apply it against whatever ORACLE_MIN_EDGE happens to be.
 */
export function proposeMinEdgeBump(
  recentOutcomes: Array<'win' | 'loss' | 'cancel'>,
  minSample = 10
): Proposal | null {
  const settled = recentOutcomes.filter(o => o === 'win' || o === 'loss');
  if (settled.length < minSample) return null;
  const wins = settled.filter(o => o === 'win').length;
  const wr = wins / settled.length;
  if (wr >= 0.60) return null;
  const shortfallPts = (0.60 - wr) * 100;
  const bumpAbs = Math.min(0.10, Math.ceil(shortfallPts / 5) * 0.05);
  return {
    parameter: 'ORACLE_MIN_EDGE',
    currentValue: null,
    suggestedValue: `+${bumpAbs.toFixed(2)}`,
    reason: `Last ${settled.length} settled bets WR=${(wr * 100).toFixed(1)}% (<60% threshold)`,
    evidence: { sample: settled.length, wins, losses: settled.length - wins, wr },
  };
}

/**
 * Exposure-imbalance heuristic.
 *
 * If a single asset accounts for more than 60% of total open USD
 * exposure, suggest tightening CORRELATION_GROUP_CAP toward half of
 * the observed concentration.
 */
export function proposeCorrelationCap(
  perAssetUsd: Record<string, number>
): Proposal | null {
  const total = Object.values(perAssetUsd)
    .reduce((s, v) => s + (Number.isFinite(v) ? v : 0), 0);
  if (total <= 0) return null;
  let topAsset = '';
  let topUsd = 0;
  for (const [a, v] of Object.entries(perAssetUsd)) {
    if (Number.isFinite(v) && v > topUsd) { topUsd = v; topAsset = a; }
  }
  const share = topUsd / total;
  if (share < 0.60) return null;
  const suggested = Number((share * 0.5).toFixed(2));
  return {
    parameter: 'CORRELATION_GROUP_CAP',
    currentValue: null,
    suggestedValue: suggested,
    reason: `${topAsset} is ${(share * 100).toFixed(1)}% of open USD exposure (>=60% trigger)`,
    evidence: { topAsset, topUsd, totalUsd: total, share },
  };
}
