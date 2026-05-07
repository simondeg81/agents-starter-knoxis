// W5 — Limitless venue adapter. Wraps the existing core/limitless clients
// and presents them through the venue-neutral Venue interface.
//
// This file owns NO trading logic of its own — it is a translation layer
// between venue-neutral types and the existing Limitless SDK. All actual
// SDK work delegates to `LimitlessClient` (markets) and `TradingClient`
// (orders).

import { LimitlessClient } from '../limitless/markets.js';
import { TradingClient } from '../limitless/trading.js';
import type {
  Market as LimitlessMarket,
  Orderbook as LimitlessOrderbook,
  CreateOrderParams,
  OrderType as LimitlessOrderType,
} from '../limitless/types.js';
import {
  Venue,
  VenueName,
  Market,
  MarketFilter,
  Orderbook,
  VenueOrder,
  VenueOrderType,
  VenueSide,
  OrderResult,
  VenueUnavailableError,
} from './types.js';

const VENUE: VenueName = 'limitless';

// ── Translation helpers ──────────────────────────────────────────────────────

function venueOrderTypeToLimitless(t: VenueOrderType): LimitlessOrderType {
  switch (t) {
    case 'limit':         return 'GTC';
    case 'fill_or_kill':  return 'FOK';
    case 'fill_and_kill': return 'FAK';
    case 'market':        return 'FOK'; // Limitless has no true 'market' type — FOK is closest
    default:              return 'FOK';
  }
}

function venueSideToLimitless(side: VenueSide): 'YES' | 'NO' {
  // Limitless represents 'sell' as a buy of the opposite outcome at the
  // resting bid. Buyer-only model — selling a YES position is effectively
  // a NO buy. Adapters are encouraged to reject sell sides until/unless
  // the consumer code explicitly converts them; here we map naïvely and
  // let the strategy decide.
  if (side === 'yes_buy' || side === 'yes_sell') return 'YES';
  return 'NO';
}

function limitlessMarketToVenue(m: LimitlessMarket): Market {
  // existing prices array is e.g. [42.8, 57.2] (cents, sums ~100). Convert
  // to probability [0,1].
  let yesPrice: number | undefined;
  let noPrice: number | undefined;
  if (Array.isArray(m.prices) && m.prices.length >= 1 && Number.isFinite(m.prices[0])) {
    yesPrice = m.prices[0] / 100;
  }
  if (Array.isArray(m.prices) && m.prices.length >= 2 && Number.isFinite(m.prices[1])) {
    noPrice = m.prices[1] / 100;
  }

  let volumeUsd: number | undefined;
  if (typeof m.volumeFormatted === 'string') {
    const n = Number(m.volumeFormatted);
    if (Number.isFinite(n)) volumeUsd = n;
  }
  let liquidityUsd: number | undefined;
  if (typeof m.liquidityFormatted === 'string') {
    const n = Number(m.liquidityFormatted);
    if (Number.isFinite(n)) liquidityUsd = n;
  }

  return {
    slug: m.slug,
    title: m.title,
    yesPrice,
    noPrice,
    volumeUsd,
    liquidityUsd,
    expirationTimestamp: m.expirationTimestamp,
    status: typeof m.status === 'string' ? m.status.toLowerCase() : undefined,
    venue: VENUE,
    raw: m,
  };
}

function limitlessOrderbookToVenue(slug: string, ob: LimitlessOrderbook): Orderbook {
  const bids = (ob.bids ?? []).map((lvl) => ({
    price: Number(lvl.price) / 100,
    sizeUsd: Number(lvl.size),
  }));
  const asks = (ob.asks ?? []).map((lvl) => ({
    price: Number(lvl.price) / 100,
    sizeUsd: Number(lvl.size),
  }));
  return {
    marketSlug: slug,
    venue: VENUE,
    bids,
    asks,
    mid: typeof ob.midpoint === 'number' ? ob.midpoint / 100 : undefined,
    asOf: Date.now(),
  };
}

// ── Adapter ──────────────────────────────────────────────────────────────────

export interface LimitlessVenueDeps {
  /** Pre-constructed market client. If omitted, a fresh one is created. */
  client?: LimitlessClient;
  /** Pre-constructed trading client (must be wired with signer). Required
   *  for placeOrder/cancelOrder; absent => those methods throw. */
  trading?: TradingClient;
}

export class LimitlessVenue implements Venue {
  readonly name: VenueName = VENUE;
  private client: LimitlessClient;
  private trading?: TradingClient;

  constructor(deps: LimitlessVenueDeps = {}) {
    this.client = deps.client ?? new LimitlessClient();
    this.trading = deps.trading;
  }

  async discoverMarkets(filter: MarketFilter): Promise<Market[]> {
    const raw = await this.client.getActiveMarkets({
      tradeType: 'clob',
      limit: filter.limit ?? 100,
    });

    const out: Market[] = [];
    for (const m of raw) {
      const venueMarket = limitlessMarketToVenue(m);

      if (filter.minVolumeUsd !== undefined && (venueMarket.volumeUsd ?? 0) < filter.minVolumeUsd) {
        continue;
      }
      if (filter.expiresAfter !== undefined && (venueMarket.expirationTimestamp ?? 0) <= filter.expiresAfter) {
        continue;
      }
      if (filter.expiresBefore !== undefined && (venueMarket.expirationTimestamp ?? Infinity) >= filter.expiresBefore) {
        continue;
      }
      if (filter.query) {
        const q = filter.query.toLowerCase();
        const inTitle = (venueMarket.title ?? '').toLowerCase().includes(q);
        const inSlug  = venueMarket.slug.toLowerCase().includes(q);
        if (!inTitle && !inSlug) continue;
      }
      out.push(venueMarket);
    }
    return out;
  }

  async getOrderbook(slug: string): Promise<Orderbook> {
    const ob = await this.client.getOrderbook(slug);
    return limitlessOrderbookToVenue(slug, ob);
  }

  async placeOrder(order: VenueOrder): Promise<OrderResult> {
    if (!this.trading) {
      throw new VenueUnavailableError(VENUE, 'placeOrder requires a TradingClient — none was injected');
    }
    if ((order.type === 'limit') && order.limitPrice === undefined) {
      throw new VenueUnavailableError(VENUE, 'limit order requires limitPrice');
    }

    // Limitless takes price in CENTS (1-99) per CreateOrderParams.
    const limitPriceCents = order.limitPrice !== undefined
      ? Math.max(1, Math.min(99, Math.round(order.limitPrice * 100)))
      : 50;

    const params: CreateOrderParams = {
      marketSlug: order.marketSlug,
      side: venueSideToLimitless(order.side),
      limitPriceCents,
      usdAmount: order.sizeUsd,
      orderType: venueOrderTypeToLimitless(order.type),
    };

    const raw = await this.trading.createOrder(params);

    // The existing TradingClient returns vendor-shaped JSON; pull a stable
    // orderId out without leaning on a particular shape.
    const orderId =
      (raw && typeof raw === 'object' && (
        (raw as Record<string, unknown>).id ??
        (raw as Record<string, unknown>).orderId ??
        (raw as Record<string, unknown>).order_id
      )) || `limitless:${order.marketSlug}:${Date.now()}`;

    return {
      orderId: String(orderId),
      status: 'submitted',
      raw,
    };
  }

  async cancelOrder(orderId: string): Promise<void> {
    if (!this.trading) {
      throw new VenueUnavailableError(VENUE, 'cancelOrder requires a TradingClient — none was injected');
    }
    await this.trading.cancelOrder(orderId);
  }
}
