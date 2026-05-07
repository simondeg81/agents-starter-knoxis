// W5 — venue-neutral types. Used by every venue adapter (limitless,
// polymarket, …). Strategies depend on these types, NOT on any
// venue-specific module.
//
// Conventions:
//   - prices are probabilities in [0, 1]
//   - sizes/notionals are USD
//   - timestamps are milliseconds-since-epoch unless suffixed _ns

export type VenueName = 'limitless' | 'polymarket' | string;

export type Asset = 'BTC' | 'ETH' | 'SOL' | 'XRP' | 'DOGE' | string;

/** Side normalised across venues. Map venue-specific sides at the adapter boundary. */
export type VenueSide = 'yes_buy' | 'no_buy' | 'yes_sell' | 'no_sell';

/** Order execution semantics. Adapters translate to vendor-specific names. */
export type VenueOrderType = 'limit' | 'market' | 'fill_or_kill' | 'fill_and_kill';

export interface MarketFilter {
  /** Filter to a specific asset symbol (BTC/ETH/...). Optional. */
  asset?: Asset;
  /** Substring match against market title or slug. Optional. */
  query?: string;
  /** Minimum 24h USD volume. Optional. */
  minVolumeUsd?: number;
  /** Only return markets that expire after this ms-epoch. Optional. */
  expiresAfter?: number;
  /** Only return markets that expire before this ms-epoch. Optional. */
  expiresBefore?: number;
  /** Cap on number of markets returned. Optional. */
  limit?: number;
}

export interface Market {
  /** Venue-unique market identifier — preferred for routing. */
  slug: string;
  /** Human-readable name. */
  title?: string;
  /** Asset symbol if the adapter can derive it. */
  asset?: Asset;
  /** Probability of YES outcome [0,1]. */
  yesPrice?: number;
  /** Probability of NO outcome [0,1]. */
  noPrice?: number;
  /** 24h notional volume in USD. */
  volumeUsd?: number;
  /** Resting liquidity in USD. */
  liquidityUsd?: number;
  /** Expiration as ms-epoch. */
  expirationTimestamp?: number;
  /** Vendor status string, lower-cased: 'open' | 'closed' | 'resolved' | etc. */
  status?: string;
  /** Adapter source — populated by the adapter. */
  venue: VenueName;
  /** Anything the adapter wants to pass through (e.g. positionIds). */
  raw?: unknown;
}

export interface OrderbookLevel {
  /** Price as probability in [0,1]. */
  price: number;
  /** Resting size — USD notional. */
  sizeUsd: number;
}

export interface Orderbook {
  marketSlug: string;
  venue: VenueName;
  bids: OrderbookLevel[];
  asks: OrderbookLevel[];
  /** Midpoint in [0,1] if available. */
  mid?: number;
  /** Server timestamp (ms) when adapter built this. */
  asOf: number;
}

export interface VenueOrder {
  marketSlug: string;
  side: VenueSide;
  type: VenueOrderType;
  /** Required for 'limit'; ignored for 'market'. Probability in [0,1]. */
  limitPrice?: number;
  /** USD notional. */
  sizeUsd: number;
  /** Optional client tag for tracing across logs. */
  clientRef?: string;
}

export type OrderStatus = 'submitted' | 'filled' | 'partial' | 'cancelled' | 'rejected';

export interface OrderResult {
  orderId: string;
  status: OrderStatus;
  /** Average fill price if known. Probability [0,1]. */
  avgFillPrice?: number;
  /** Filled USD notional. */
  filledUsd?: number;
  /** Pass-through vendor response for audit/debugging. */
  raw?: unknown;
}

export interface Venue {
  /** Human-friendly name; matches `venue` field on returned objects. */
  readonly name: VenueName;
  discoverMarkets(filter: MarketFilter): Promise<Market[]>;
  getOrderbook(slug: string): Promise<Orderbook>;
  placeOrder(order: VenueOrder): Promise<OrderResult>;
  cancelOrder(orderId: string): Promise<void>;
}

/** Thrown by adapter methods when a venue is wired but not yet usable
 *  (missing creds, unimplemented, paused). Catch this where appropriate. */
export class VenueUnavailableError extends Error {
  constructor(public readonly venue: VenueName, message: string) {
    super(`[${venue}] ${message}`);
    this.name = 'VenueUnavailableError';
  }
}
