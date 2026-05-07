// W2 — unit tests for quote-engine pure functions.
// Run with:
//   node --import tsx --test src/strategies/maker-complement/__tests__/quote-engine.test.ts

import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { computeTargetQuotes, shouldRequote } from '../quote-engine.js';
import type { Orderbook } from '../../../core/limitless/types.js';

const cfg = { targetSum: 0.95, quoteBumpBps: 10 };

function book(bids: Array<[string, string]>, asks: Array<[string, string]>): Orderbook {
    return {
        bids: bids.map(([price, size]) => ({ price, size })),
        asks: asks.map(([price, size]) => ({ price, size })),
    };
}

describe('computeTargetQuotes', () => {
    it('returns sensible targets on a typical wide book', () => {
        // best yes bid 0.40, best yes ask 0.50, bump 0.001
        // yesBid target = 0.401, noBidImplied = 0.50, noBid target = 0.501
        // sum 0.902 ≤ 0.95
        const b = book([['0.40', '100'], ['0.39', '50']], [['0.50', '100'], ['0.51', '80']]);
        const t = computeTargetQuotes(b, cfg);
        assert.ok(t, 'target should not be null');
        assert.equal(t!.yesBid, 0.401);
        assert.equal(t!.noBid, 0.501);
    });

    it('returns null when bids side is empty', () => {
        const b = book([], [['0.50', '100']]);
        assert.equal(computeTargetQuotes(b, cfg), null);
    });

    it('returns null when asks side is empty', () => {
        const b = book([['0.40', '100']], []);
        assert.equal(computeTargetQuotes(b, cfg), null);
    });

    it('returns null on a crossed book', () => {
        const b = book([['0.50', '100']], [['0.40', '100']]);
        assert.equal(computeTargetQuotes(b, cfg), null);
    });

    it('returns null when targetSum constraint is violated by a tight spread', () => {
        // best yes bid 0.50, best yes ask 0.51 → yesTarget 0.501, noTarget 0.491
        // sum 0.992 > 0.95
        const b = book([['0.50', '100']], [['0.51', '100']]);
        assert.equal(computeTargetQuotes(b, cfg), null);
    });

    it('picks the BEST bid and BEST ask (not the first level)', () => {
        // bids out-of-order; best should still be 0.42
        const b = book(
            [['0.40', '100'], ['0.42', '50'], ['0.41', '20']],
            [['0.55', '100'], ['0.50', '20'], ['0.52', '50']],
        );
        const t = computeTargetQuotes(b, cfg);
        assert.ok(t);
        // bump 0.001
        // yesTarget = 0.42 + 0.001 = 0.421
        // noBidImplied = 1 - 0.50 = 0.50, noTarget = 0.501
        // sum 0.922 ≤ 0.95
        assert.equal(t!.yesBid, 0.421);
        assert.equal(t!.noBid, 0.501);
    });

    it('honours a stricter targetSum', () => {
        // same book as the typical case, sum was 0.902.
        // targetSum=0.90 should now reject it.
        const b = book([['0.40', '100']], [['0.50', '100']]);
        const t = computeTargetQuotes(b, { targetSum: 0.90, quoteBumpBps: 10 });
        assert.equal(t, null);
    });

    it('rejects targets outside [0.01, 0.99]', () => {
        // best yes bid 0.99 would push yesTarget = 0.991 → still ≤ 0.99? no, > ceil
        const b = book([['0.99', '10']], [['0.995', '5']]);
        assert.equal(computeTargetQuotes(b, cfg), null);
    });
});

describe('shouldRequote', () => {
    it('returns true when there is no current quote (currentQuote === 0)', () => {
        assert.equal(shouldRequote(0, 0.40, 0.005), true);
    });

    it('returns true when drift exceeds tolerance', () => {
        assert.equal(shouldRequote(0.40, 0.41, 0.005), true);
    });

    it('returns false when drift is within tolerance', () => {
        assert.equal(shouldRequote(0.40, 0.402, 0.005), false);
    });

    it('returns false when drift exactly equals tolerance (strictly greater)', () => {
        assert.equal(shouldRequote(0.40, 0.405, 0.005), false);
    });

    it('is symmetric in direction (target above OR below current)', () => {
        assert.equal(shouldRequote(0.40, 0.41, 0.005), shouldRequote(0.41, 0.40, 0.005));
    });

    it('works with cent-scale units when caller is consistent', () => {
        assert.equal(shouldRequote(40, 41, 0.5), true);
        assert.equal(shouldRequote(40, 40.4, 0.5), false);
    });
});
