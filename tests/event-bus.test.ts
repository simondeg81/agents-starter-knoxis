// W5 — event bus contract tests.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { TypedEventBus } from '../src/observability/event-bus.js';

test('subscribe + emit delivers payload', () => {
  const bus = new TypedEventBus();
  const received: unknown[] = [];

  bus.on('strategy.fill', (e) => received.push(e));

  const payload = {
    timestampNs: 1_700_000_000_000_000_000n,
    strategy: 'oracle-arb',
    marketSlug: 'btc-up-or-down-1-hour-1700000003600',
    asset: 'BTC' as const,
    timeframe: '1h' as const,
    isDryRun: false,
    side: 'yes_buy' as const,
    price: 0.42,
    sizeUsd: 5,
    orderId: 'ord_123',
  };
  bus.emit('strategy.fill', payload);

  assert.equal(received.length, 1);
  assert.deepEqual(received[0], payload);
});

test('off() removes the listener', () => {
  const bus = new TypedEventBus();
  let calls = 0;
  const handler = () => { calls++; };

  bus.on('risk.halt', handler);
  bus.emit('risk.halt', { timestampNs: 1n, reason: 'manual' });
  assert.equal(calls, 1);

  bus.off('risk.halt', handler);
  bus.emit('risk.halt', { timestampNs: 2n, reason: 'manual' });
  assert.equal(calls, 1, 'handler must not fire after off()');
});

test('multiple subscribers each receive one delivery', () => {
  const bus = new TypedEventBus();
  let a = 0, b = 0;
  bus.on('council.proposal', () => { a++; });
  bus.on('council.proposal', () => { b++; });

  bus.emit('council.proposal', {
    timestampNs: 1n,
    parameter: 'ORACLE_MIN_EDGE',
    currentValue: '0.10',
    proposedValue: '0.12',
    reasoning: 'test',
  });

  assert.equal(a, 1);
  assert.equal(b, 1);
  assert.equal(bus.listenerCount('council.proposal'), 2);
});

test('removeAllListeners clears handlers', () => {
  const bus = new TypedEventBus();
  bus.on('strategy.cancel', () => {});
  bus.on('strategy.cancel', () => {});
  assert.equal(bus.listenerCount('strategy.cancel'), 2);
  bus.removeAllListeners('strategy.cancel');
  assert.equal(bus.listenerCount('strategy.cancel'), 0);
});
