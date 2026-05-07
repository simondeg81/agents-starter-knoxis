// W2 — per-market open-exposure tracker. The strategy uses this to:
//   1. Refuse to post a new quote that would push our committed exposure
//      on a side past MAKER_MAX_INVENTORY_PER_MARKET, and
//   2. Skew quote targets toward the side that would unwind accumulated
//      one-sided inventory.
//
// State is in-memory only. Pass 3 / W5 will wire persistence via the
// observability sqlite-writer; until then a restart resets exposure
// (acceptable in DRY_RUN; risky once live — flagged in the report).

export type Side = 'YES' | 'NO';

interface MarketInventory {
    yesNotional: number;
    noNotional: number;
}

export class InventoryModel {
    private state = new Map<string, MarketInventory>();

    constructor(private maxPerMarketUsd: number) {}

    private bucket(slug: string): MarketInventory {
        let s = this.state.get(slug);
        if (!s) {
            s = { yesNotional: 0, noNotional: 0 };
            this.state.set(slug, s);
        }
        return s;
    }

    /**
     * Whether posting `usd` of additional `side` exposure would exceed the
     * per-market cap. Used as a pre-check before pushing a new decision.
     */
    canQuote(slug: string, side: Side, usd: number): boolean {
        const s = this.bucket(slug);
        const next = (side === 'YES' ? s.yesNotional : s.noNotional) + usd;
        return next <= this.maxPerMarketUsd;
    }

    /** Record committed exposure (a fill or a posted maker quote). */
    add(slug: string, side: Side, usd: number): void {
        const s = this.bucket(slug);
        if (side === 'YES') s.yesNotional += usd;
        else s.noNotional += usd;
    }

    /** Release committed exposure (cancel, expiry, or position close). */
    release(slug: string, side: Side, usd: number): void {
        const s = this.bucket(slug);
        if (side === 'YES') s.yesNotional = Math.max(0, s.yesNotional - usd);
        else s.noNotional = Math.max(0, s.noNotional - usd);
    }

    /**
     * Imbalance bias for quote tilting. Returns a value in [-1, +1]:
     *   +1 → all exposure is on YES; caller should tilt to unwind YES
     *        (e.g. shave the YES bid toward 0 / push the NO bid up)
     *   -1 → all exposure is on NO; caller should tilt the opposite way
     *    0 → balanced (or empty)
     */
    skewBias(slug: string): number {
        const s = this.bucket(slug);
        const total = s.yesNotional + s.noNotional;
        if (total === 0) return 0;
        const denom = Math.max(total, this.maxPerMarketUsd);
        const bias = (s.yesNotional - s.noNotional) / denom;
        if (bias > 1) return 1;
        if (bias < -1) return -1;
        return bias;
    }

    /** Snapshot of a single market's exposure (read-only). */
    snapshot(slug: string): { yesNotional: number; noNotional: number } {
        const s = this.bucket(slug);
        return { yesNotional: s.yesNotional, noNotional: s.noNotional };
    }

    totalOpenPositions(): number {
        let n = 0;
        for (const s of this.state.values()) {
            if (s.yesNotional > 0) n++;
            if (s.noNotional > 0) n++;
        }
        return n;
    }

    totalNotional(): number {
        let t = 0;
        for (const s of this.state.values()) t += s.yesNotional + s.noNotional;
        return t;
    }
}
