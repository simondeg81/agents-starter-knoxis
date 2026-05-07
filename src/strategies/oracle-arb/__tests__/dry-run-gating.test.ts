import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OracleArbStrategy, type OracleArbConfig } from '../index.js';

// Minimal mocks for the W3 landmine L2 regression test + W1 risk-gate integration.
// Uses node:test (built-in to Node 18+, no extra deps). Run with:
//   npx tsx --test src/strategies/oracle-arb/__tests__/dry-run-gating.test.ts

function makeMockLimitless(): any {
    return {
        // searchMarkets / getOrderbook etc. not needed for executeDecisions tests
    };
}

function makeMockTrading() {
    const calls: any[] = [];
    return {
        client: {
            createOrder: async (args: any) => {
                calls.push(args);
                return { orderId: 'mock-order-id', status: 'matched' } as any;
            },
        } as any,
        getCalls: () => calls,
    };
}

function makeMockRiskGate(decision: { ok: true } | { ok: false; reason: string; blockingGate: string }) {
    const calls: any[] = [];
    return {
        client: {
            evaluate: async (order: any) => {
                calls.push(order);
                return decision;
            },
            isHalted: async () => ({ halted: false }),
            recordOutcome: async () => {},
        } as any,
        getCalls: () => calls,
    };
}

function baseConfig(): OracleArbConfig {
    return {
        id: 'test',
        type: 'oracle-arb',
        enabled: true,
        assets: ['BTC'],
        minConfidencePercent: 0.5,
        minEdgePercent: 0.1,
        minMarketPrice: 0.3,
        maxMarketPrice: 0.7,
        betSizeUsd: 1,
        maxPositions: 10,
        minMinutesToExpiry: 0,
        maxMinutesToExpiry: 90,
    };
}

function baseDecision(): any {
    return {
        action: 'BUY',
        marketSlug: 'btc-up-or-down-1-hour-test',
        side: 'YES',
        amountUsd: 1,
        priceLimit: 60,
        reason: 'test',
    };
}

test('W3 landmine L2: DRY_RUN=true blocks createOrder', async () => {
    const prior = process.env.DRY_RUN;
    process.env.DRY_RUN = 'true';
    try {
        const trading = makeMockTrading();
        const strategy = new OracleArbStrategy(
            baseConfig(),
            { limitless: makeMockLimitless(), trading: trading.client },
        );

        // Bypass tick(); call executeDecisions directly with a synthetic decision
        await (strategy as any).executeDecisions([baseDecision()]);

        assert.equal(
            trading.getCalls().length,
            0,
            'createOrder MUST NOT be called when DRY_RUN=true (W3 L2 regression)',
        );
    } finally {
        if (prior === undefined) delete process.env.DRY_RUN;
        else process.env.DRY_RUN = prior;
    }
});

test('W4 risk gate: ok=false blocks createOrder, evaluate is called', async () => {
    const prior = process.env.DRY_RUN;
    delete process.env.DRY_RUN; // ensure NOT in dry-run mode
    try {
        const trading = makeMockTrading();
        const riskGate = makeMockRiskGate({
            ok: false,
            reason: 'test-block',
            blockingGate: 'test-gate',
        });
        const strategy = new OracleArbStrategy(
            baseConfig(),
            {
                limitless: makeMockLimitless(),
                trading: trading.client,
                riskGate: riskGate.client,
            },
        );

        await (strategy as any).executeDecisions([baseDecision()]);

        assert.equal(
            riskGate.getCalls().length,
            1,
            'riskGate.evaluate MUST be called once before placeOrder',
        );
        assert.equal(
            trading.getCalls().length,
            0,
            'createOrder MUST NOT be called when riskGate.evaluate returns ok=false',
        );
    } finally {
        if (prior !== undefined) process.env.DRY_RUN = prior;
    }
});

test('W4 risk gate: ok=true allows createOrder', async () => {
    const prior = process.env.DRY_RUN;
    delete process.env.DRY_RUN;
    try {
        const trading = makeMockTrading();
        const riskGate = makeMockRiskGate({ ok: true });
        const strategy = new OracleArbStrategy(
            baseConfig(),
            {
                limitless: makeMockLimitless(),
                trading: trading.client,
                riskGate: riskGate.client,
            },
        );

        await (strategy as any).executeDecisions([baseDecision()]);

        assert.equal(
            riskGate.getCalls().length,
            1,
            'riskGate.evaluate is called',
        );
        assert.ok(
            trading.getCalls().length >= 1,
            'createOrder is called at least once when riskGate returns ok=true',
        );
    } finally {
        if (prior !== undefined) process.env.DRY_RUN = prior;
    }
});
