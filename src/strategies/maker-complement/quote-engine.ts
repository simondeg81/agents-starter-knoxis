// W2 — pure quote-target functions for maker-complement. No I/O, no class
// state — easy to test, easy to reason about. The strategy class in
// index.ts wires these into a tick() loop.
//
// Unit conventions:
//   - prices passed/returned here are probability units in [0, 1]
//     (e.g. 0.40 = 40¢ per contract).
//   - shouldRequote takes any consistent unit (cents or probability);
//     the caller is responsible for matching units across all 3 args.

import type { Orderbook } from '../../core/limitless/types.js';

export interface QuoteEngineConfig {
    /** Hard cap on yesBid + noBid post targets (default 0.95). Below this,
     * the implied spread is wide enough for both quotes to coexist with
     * a positive risk-free band. */
    targetSum: number;
    /** Bump in basis points applied above the implied bid on each side
     * (e.g. 10 → 0.001 = 0.10¢). */
    quoteBumpBps: number;
}

export interface TargetQuotes {
    /** Maker YES bid in [0, 1]. */
    yesBid: number;
    /** Maker NO bid in [0, 1]. */
    noBid: number;
}

const MIN_TICK = 0.001;
const PRICE_FLOOR = 0.01;
const PRICE_CEIL = 0.99;

function bestBid(book: Orderbook): number | null {
    if (!book?.bids || book.bids.length === 0) return null;
    let best = -Infinity;
    for (const lvl of book.bids) {
        const p = parseFloat(lvl.price);
        if (Number.isFinite(p) && p > best) best = p;
    }
    return best === -Infinity ? null : best;
}

function bestAsk(book: Orderbook): number | null {
    if (!book?.asks || book.asks.length === 0) return null;
    let best = Infinity;
    for (const lvl of book.asks) {
        const p = parseFloat(lvl.price);
        if (Number.isFinite(p) && p < best) best = p;
    }
    return best === Infinity ? null : best;
}

function roundToTick(p: number): number {
    return Math.round(p / MIN_TICK) * MIN_TICK;
}

/**
 * Compute target maker-complement quotes (YES bid and NO bid) from a YES-side
 * CLOB orderbook. The NO side bid is derived from the binary identity:
 *
 *     no_bid_implied = 1 - best_yes_ask
 *
 * We then post both sides one bump above their implied bids:
 *
 *     yesBid = best_yes_bid + bump
 *     noBid  = (1 - best_yes_ask) + bump
 *
 * subject to:
 *
 *     yesBid + noBid <= targetSum
 *
 * Returns null when the book is empty/crossed, the bumped sum violates
 * targetSum (spread too tight for safe two-sided quoting), or either
 * target falls outside [PRICE_FLOOR, PRICE_CEIL].
 */
export function computeTargetQuotes(
    book: Orderbook,
    cfg: QuoteEngineConfig,
): TargetQuotes | null {
    const yb = bestBid(book);
    const ya = bestAsk(book);
    if (yb === null || ya === null) return null;
    if (ya <= yb) return null; // crossed or zero-spread

    const bump = cfg.quoteBumpBps / 10000;
    const noBidImplied = 1 - ya;

    const yesTarget = roundToTick(yb + bump);
    const noTarget = roundToTick(noBidImplied + bump);

    if (yesTarget < PRICE_FLOOR || yesTarget > PRICE_CEIL) return null;
    if (noTarget < PRICE_FLOOR || noTarget > PRICE_CEIL) return null;
    if (yesTarget + noTarget > cfg.targetSum) return null;

    return { yesBid: yesTarget, noBid: noTarget };
}

// Floating-point slack: drifts produced by `0.40 - 0.405` etc. are not
// bit-exact 0.005 in IEEE 754. The epsilon prevents FP noise from
// flipping a "drift == tolerance" case into a spurious requote.
const REQUOTE_EPS = 1e-9;

/**
 * Should we replace the current resting quote with a new target?
 *
 * Returns true when either:
 *   - we have no current quote (currentQuote === 0), or
 *   - |currentQuote - targetQuote| > tolerance (with FP slack).
 *
 * Caller chooses units (cents OR probability) — must be consistent across
 * all three args.
 */
export function shouldRequote(
    currentQuote: number,
    targetQuote: number,
    tolerance: number,
): boolean {
    if (currentQuote === 0) return true;
    return Math.abs(currentQuote - targetQuote) > tolerance + REQUOTE_EPS;
}
