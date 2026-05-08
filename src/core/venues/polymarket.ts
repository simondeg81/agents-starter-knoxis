/**
 * src/core/venues/polymarket.ts — Polymarket venue stub.
 *
 * Placeholder for cross-platform arbitrage between Limitless (Base, Pyth)
 * and Polymarket (Polygon, Chainlink). Both serve binary BTC up/down
 * markets but with different liquidity, oracles, and fee structures —
 * which is exactly the shape of a cross-venue arb opportunity.
 *
 * Status: NOT IMPLEMENTED. Every method throws. The Python bot at
 * github.com/simondeg81/kalshi-bot already has a working PolymarketClient
 * (see polymarket_client.py); this stub will eventually mirror its surface
 * area in TypeScript so a Limitless-side strategy can quote both venues.
 *
 * Why this is a stub today:
 *   1. Cross-platform arb is an L4+ goal. Single-venue Limitless oracle-arb
 *      is L2-L3 work and not yet proven (chat 22 first-5-fills not run).
 *   2. The Python Polymarket bot is the canonical implementation. Porting
 *      it twice (TypeScript + maintaining Python) doubles maintenance cost
 *      until single-venue economics are proven on each side.
 *   3. The shape of the cross-venue arb signal is unknown — depends on
 *      both venues' fee + slippage profiles, which only the Python bot's
 *      P1.5 post-mortem will reveal.
 *
 * TODO:
 *   - Once P1.5 maker post-mortem clears in kalshi-bot, port the
 *     PolymarketClient surface area (markets, orderbook, place_order
 *     FOK + GTC, settlement) over.
 *   - Add Pyth ↔ Chainlink lag detection so we can take the slow oracle
 *     side when divergence is large enough to cover fees + slippage.
 *   - Wire as a venue plugin behind src/core/venues/registry.ts (also
 *     does not yet exist).
 */

export interface PolymarketMarket {
    slug: string;
    upTokenId: string;
    downTokenId: string;
    upPrice: number;
    downPrice: number;
    windowTs: number;
}

export class PolymarketVenue {
    constructor() {
        throw new Error(
            'PolymarketVenue is a stub. Cross-platform arb is L4+ work. ' +
            'See docs/L3-PORT-PLAN.md and kalshi-bot/polymarket_client.py.'
        );
    }

    async getMarkets(): Promise<PolymarketMarket[]> {
        throw new Error('PolymarketVenue.getMarkets: stub — not implemented');
    }

    async placeOrder(_args: unknown): Promise<never> {
        throw new Error('PolymarketVenue.placeOrder: stub — not implemented');
    }

    async getBalance(): Promise<never> {
        throw new Error('PolymarketVenue.getBalance: stub — not implemented');
    }
}
