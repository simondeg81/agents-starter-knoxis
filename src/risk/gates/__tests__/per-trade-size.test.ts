// W1 — unit test for per-trade-size gate. Uses node:test (built-in, no deps).
// Run with: node --import tsx --test src/risk/gates/__tests__/per-trade-size.test.ts
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { perTradeSizeGate } from '../per-trade-size.js';
import type { ProposedOrder } from '../../types.js';

const baseOrder: ProposedOrder = {
  strategy: 'test',
  marketSlug: 'btc-up-or-down-1-hour-test',
  asset: 'BTC',
  timeframe: '1h',
  side: 'yes_buy',
  price: 0.5,
  sizeUsd: 1,
};

describe('per-trade-size gate', () => {
  it('passes when size <= cap', () => {
    const d = perTradeSizeGate({ ...baseOrder, sizeUsd: 5 }, { liveBetMax: 5 });
    assert.equal(d.ok, true);
  });

  it('blocks when size > cap', () => {
    const d = perTradeSizeGate({ ...baseOrder, sizeUsd: 6 }, { liveBetMax: 5 });
    assert.equal(d.ok, false);
    if (!d.ok) {
      assert.equal(d.blockingGate, 'per-trade-size');
      assert.match(d.reason, /exceeds LIVE_BET_MAX/);
    }
  });

  it('blocks zero size as invalid', () => {
    const d = perTradeSizeGate({ ...baseOrder, sizeUsd: 0 }, { liveBetMax: 5 });
    assert.equal(d.ok, false);
    if (!d.ok) {
      assert.equal(d.blockingGate, 'per-trade-size');
    }
  });

  it('blocks negative size as invalid', () => {
    const d = perTradeSizeGate({ ...baseOrder, sizeUsd: -1 }, { liveBetMax: 5 });
    assert.equal(d.ok, false);
  });

  it('blocks NaN size as invalid', () => {
    const d = perTradeSizeGate({ ...baseOrder, sizeUsd: NaN }, { liveBetMax: 5 });
    assert.equal(d.ok, false);
  });
});
