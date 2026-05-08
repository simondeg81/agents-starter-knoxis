import { describe, it, expect } from 'vitest';
import {
    SLUG_DIRECTIONAL_RE,
    parseTimeframeSecs,
    parseWindowStart,
} from '../index.js';

describe('parseTimeframeSecs', () => {
    it('parses 5-mins', () => {
        expect(parseTimeframeSecs('btc-up-or-down-5-mins-1715000000')).toBe(300);
    });
    it('parses 15-minutes', () => {
        expect(parseTimeframeSecs('eth-up-or-down-15-minutes-1715000000')).toBe(900);
    });
    it('parses 1-hour', () => {
        expect(parseTimeframeSecs('sol-up-or-down-1-hour-1715000000')).toBe(3600);
    });
    it('parses 1-day', () => {
        expect(parseTimeframeSecs('btc-up-or-down-1-day-1715000000')).toBe(86400);
    });
    it('returns null on malformed slug', () => {
        expect(parseTimeframeSecs('btc-flippy-flop-5-mins-123')).toBeNull();
        expect(parseTimeframeSecs('')).toBeNull();
        expect(parseTimeframeSecs('random-text')).toBeNull();
    });
});

describe('parseWindowStart', () => {
    it('returns expirationTimestamp - tfSecs*1000', () => {
        const exp = 1_715_000_000_000;
        const r = parseWindowStart({
            slug: 'btc-up-or-down-5-mins-1714999000',
            expirationTimestamp: exp,
        });
        expect(r).toBe(exp - 300_000);
    });
    it('returns null when slug unparseable', () => {
        expect(parseWindowStart({ slug: 'foo', expirationTimestamp: 123 })).toBeNull();
    });
    it('returns null when expirationTimestamp missing', () => {
        expect(parseWindowStart({ slug: 'btc-up-or-down-5-mins-1' })).toBeNull();
    });
});

describe('SLUG_DIRECTIONAL_RE', () => {
    it('matches representative directional slugs (W4 catalog patterns)', () => {
        const samples = [
            'btc-up-or-down-5-mins-1715000000',
            'eth-up-or-down-5-mins-1715000001',
            'sol-up-or-down-5-mins-1715000002',
            'doge-up-or-down-5-mins-1715000003',
            'avax-up-or-down-5-mins-1715000004',
            'arb-up-or-down-5-mins-1715000005',
            'op-up-or-down-5-mins-1715000006',
            'matic-up-or-down-5-mins-1715000007',
            'link-up-or-down-5-mins-1715000008',
            'uni-up-or-down-5-mins-1715000009',
            'aave-up-or-down-5-mins-1715000010',
            'mkr-up-or-down-5-mins-1715000011',
            'ltc-up-or-down-5-mins-1715000012',
            'bch-up-or-down-5-mins-1715000013',
            'btc-up-or-down-15-mins-1715000014',
            'eth-up-or-down-15-mins-1715000015',
            'btc-up-or-down-15-minutes-1715000016',
            'btc-up-or-down-1-hour-1715000017',
            'eth-up-or-down-1-hour-1715000018',
            'sol-up-or-down-1-hour-1715000019',
            'btc-up-or-down-4-hour-1715000020',
            'btc-up-or-down-1-day-1715000021',
            'eth-up-or-down-1-day-1715000022',
            'sol-up-or-down-1-day-1715000023',
            'doge-up-or-down-1-day-1715000024',
        ];
        for (const slug of samples) {
            expect(SLUG_DIRECTIONAL_RE.test(slug)).toBe(true);
        }
        expect(samples.length).toBe(25);
    });
    it('rejects manual one-off / non-directional slugs', () => {
        expect(SLUG_DIRECTIONAL_RE.test('btc-above-150k-by-june-30-2026')).toBe(false);
        expect(SLUG_DIRECTIONAL_RE.test('will-eth-flip-btc')).toBe(false);
        expect(SLUG_DIRECTIONAL_RE.test('btc-up-or-down-5-mins')).toBe(false);
        expect(SLUG_DIRECTIONAL_RE.test('btc-up-5-mins-1715000000')).toBe(false);
    });
});

describe('directional edge calc (port of latency_engine.py:546)', () => {
    function edge(deltaPct: number) {
        const confidence = Math.min(0.88, 0.55 + Math.abs(deltaPct) * 5000);
        const oracleYesProb =
            deltaPct > 0
                ? Math.min(0.95, 0.5 + confidence * 0.5)
                : deltaPct < 0
                    ? Math.max(0.05, 0.5 - confidence * 0.5)
                    : 0.5;
        return { confidence, oracleYesProb };
    }

    it('positive drift => yesProb > 0.5', () => {
        const { oracleYesProb } = edge(0.0005);
        expect(oracleYesProb).toBeGreaterThan(0.5);
    });
    it('negative drift => yesProb < 0.5', () => {
        const { oracleYesProb } = edge(-0.0005);
        expect(oracleYesProb).toBeLessThan(0.5);
    });
    it('zero drift => yesProb = 0.5 exactly', () => {
        const { oracleYesProb } = edge(0);
        expect(oracleYesProb).toBe(0.5);
    });
    it('|deltaPct|=0.01 saturates confidence at 0.88 ceiling', () => {
        const { confidence } = edge(0.01);
        expect(confidence).toBe(0.88);
        const { confidence: confNeg } = edge(-0.02);
        expect(confNeg).toBe(0.88);
    });
    it('confidence ceiling caps yesProb at 0.5 + 0.88*0.5 = 0.94', () => {
        const { oracleYesProb } = edge(0.05);
        expect(oracleYesProb).toBeCloseTo(0.94, 6);
    });
});
