import { describe, it, expect, beforeEach } from 'vitest';
import { HermesClient } from '../../../core/price-feeds/hermes.js';

function seed(c: HermesClient, asset: string, entries: Array<{ ts: number; price: number }>) {
    (c as any).priceHistory.set(asset, entries.slice());
}

describe('HermesClient.getDeltaFromWindowOpen', () => {
    let client: HermesClient;
    beforeEach(() => { client = new HermesClient(); });

    it('a) returns null when no history exists for the asset', () => {
        expect(client.getDeltaFromWindowOpen('BTC', Date.now())).toBeNull();
        seed(client, 'ETH', [{ ts: Date.now(), price: 2000 }]);
        expect(client.getDeltaFromWindowOpen('BTC', Date.now())).toBeNull();
    });

    it('b) returns correct delta when window-open ts equals oldest entry', () => {
        const now = Date.now();
        const t0 = now - 60_000;
        seed(client, 'BTC', [
            { ts: t0, price: 100 },
            { ts: now, price: 110 },
        ]);
        const r = client.getDeltaFromWindowOpen('BTC', t0);
        expect(r).not.toBeNull();
        expect(r!.priceAtOpen).toBe(100);
        expect(r!.priceNow).toBe(110);
        expect(r!.delta).toBe(10);
        expect(r!.deltaPct).toBeCloseTo(0.1, 6);
    });

    it('c) uses earliest at-or-before entry when window-open falls between entries', () => {
        const now = Date.now();
        seed(client, 'BTC', [
            { ts: now - 90_000, price: 100 },
            { ts: now - 60_000, price: 105 },
            { ts: now - 30_000, price: 110 },
            { ts: now - 5_000,  price: 115 },
        ]);
        const r = client.getDeltaFromWindowOpen('BTC', now - 75_000);
        expect(r).not.toBeNull();
        expect(r!.priceAtOpen).toBe(100);
        expect(r!.priceNow).toBe(115);
        expect(r!.delta).toBe(15);
    });

    it('d) prunes entries older than retention window on appendHistory', () => {
        const c = new HermesClient();
        const now = 1_700_000_000_000;
        const FIVE_HOURS = 5 * 60 * 60 * 1000;
        (c as any).priceHistory.set('BTC', [
            { ts: now - FIVE_HOURS, price: 100 },
            { ts: now - 1000,       price: 110 },
        ]);
        (c as any).appendHistory('BTC', 115, now);
        const arr = (c as any).priceHistory.get('BTC');
        expect(arr.length).toBe(2);
        expect(arr.find((e: any) => e.price === 100)).toBeUndefined();
        expect(arr[0].price).toBe(110);
        expect(arr[1].price).toBe(115);
    });

    it('e) emits stale event when newest history entry > 90s old', () => {
        const now = Date.now();
        seed(client, 'BTC', [
            { ts: now - 200_000, price: 100 },
            { ts: now - 100_000, price: 110 },
        ]);
        let staleEvent: { asset: string; ageMs: number } | null = null;
        client.on('stale', (e: { asset: string; ageMs: number }) => { staleEvent = e; });
        const r = client.getDeltaFromWindowOpen('BTC', now - 200_000);
        expect(r).not.toBeNull();
        expect(staleEvent).not.toBeNull();
        expect(staleEvent!.asset).toBe('BTC');
        expect(staleEvent!.ageMs).toBeGreaterThan(90_000);
    });

    it('f) repeated calls do not corrupt state (concurrency sanity)', () => {
        const now = Date.now();
        seed(client, 'BTC', [
            { ts: now - 60_000, price: 100 },
            { ts: now,          price: 110 },
        ]);
        const results = Array.from({ length: 100 }, () =>
            client.getDeltaFromWindowOpen('BTC', now - 60_000)
        );
        for (const r of results) {
            expect(r).not.toBeNull();
            expect(r!.priceAtOpen).toBe(100);
            expect(r!.priceNow).toBe(110);
            expect(r!.delta).toBe(10);
        }
        const arr = (client as any).priceHistory.get('BTC');
        expect(arr.length).toBe(2);
    });
});
