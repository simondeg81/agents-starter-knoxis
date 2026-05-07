// W5 — Polymarket venue STUB.
//
// All methods throw VenueUnavailableError. This file exists so that the
// cross-platform-arb strategy can compile against a Venue type when
// `CROSS_PLATFORM_ENABLED=true` is flipped, even though Polymarket itself
// won't be reachable until Simon's account comes back online.
//
// When implementing for real:
//   - replace the stubs with a real adapter wrapping a Polymarket SDK
//     (likely @polymarket/clob-client) following the LimitlessVenue pattern
//   - add POLYMARKET_* env vars to .env.example (W5 won't add them in
//     Pass 2 — out of scope per EXTENSIONS_DESIGN.md)
//   - wire credentials in core/wallet.ts or a new core/polymarket/ tree
//
// Until then: instantiating this class is fine; calling any method throws.

import {
  Venue,
  VenueName,
  Market,
  MarketFilter,
  Orderbook,
  VenueOrder,
  OrderResult,
  VenueUnavailableError,
} from './types.js';

const VENUE: VenueName = 'polymarket';
const NOT_IMPL = 'Polymarket venue not yet implemented — awaiting account reactivation.';

export class PolymarketVenue implements Venue {
  readonly name: VenueName = VENUE;

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async discoverMarkets(_filter: MarketFilter): Promise<Market[]> {
    throw new VenueUnavailableError(VENUE, NOT_IMPL);
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async getOrderbook(_slug: string): Promise<Orderbook> {
    throw new VenueUnavailableError(VENUE, NOT_IMPL);
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async placeOrder(_order: VenueOrder): Promise<OrderResult> {
    throw new VenueUnavailableError(VENUE, NOT_IMPL);
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async cancelOrder(_orderId: string): Promise<void> {
    throw new VenueUnavailableError(VENUE, NOT_IMPL);
  }
}
