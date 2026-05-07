// W5 — venue interface contract tests.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { LimitlessVenue } from '../src/core/venues/limitless.js';
import { PolymarketVenue } from '../src/core/venues/polymarket.js';
import { VenueUnavailableError } from '../src/core/venues/types.js';
import type { Venue } from '../src/core/venues/types.js';

// Compile-time contract: each adapter must satisfy the Venue interface.
// (TypeScript will reject this file if not.)
const _limitless: Venue = new LimitlessVenue();
const _polymarket: Venue = new PolymarketVenue();
void _limitless;
void _polymarket;

test('LimitlessVenue exposes all Venue methods', () => {
  const v = new LimitlessVenue();
  assert.equal(v.name, 'limitless');
  assert.equal(typeof v.discoverMarkets, 'function');
  assert.equal(typeof v.getOrderbook,    'function');
  assert.equal(typeof v.placeOrder,      'function');
  assert.equal(typeof v.cancelOrder,     'function');
});

test('LimitlessVenue.placeOrder without TradingClient throws VenueUnavailableError', async () => {
  const v = new LimitlessVenue(); // no trading client injected
  await assert.rejects(
    () => v.placeOrder({
      marketSlug: 'btc-up-or-down-1-hour-x',
      side: 'yes_buy',
      type: 'limit',
      limitPrice: 0.42,
      sizeUsd: 1,
    }),
    (err: unknown) => err instanceof VenueUnavailableError,
  );
});

test('LimitlessVenue.cancelOrder without TradingClient throws VenueUnavailableError', async () => {
  const v = new LimitlessVenue();
  await assert.rejects(
    () => v.cancelOrder('ord_123'),
    (err: unknown) => err instanceof VenueUnavailableError,
  );
});

test('PolymarketVenue: every method throws VenueUnavailableError', async () => {
  const v = new PolymarketVenue();
  assert.equal(v.name, 'polymarket');

  await assert.rejects(() => v.discoverMarkets({}), (err: unknown) => err instanceof VenueUnavailableError);
  await assert.rejects(() => v.getOrderbook('whatever'), (err: unknown) => err instanceof VenueUnavailableError);
  await assert.rejects(
    () => v.placeOrder({ marketSlug: 'x', side: 'yes_buy', type: 'limit', limitPrice: 0.5, sizeUsd: 1 }),
    (err: unknown) => err instanceof VenueUnavailableError,
  );
  await assert.rejects(() => v.cancelOrder('ord'), (err: unknown) => err instanceof VenueUnavailableError);
});
