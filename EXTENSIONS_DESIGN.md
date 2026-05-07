# KNOXis Extensions to agents-starter

## Branch model
- main: integration branch (all merges land here after Pass 3)
- feature/risk-engine: W1 scope
- feature/maker-complement: W2 scope
- feature/council-sandbox: W3 scope
- feature/oracle-arb-extensions: W4 scope
- feature/observability: W5 scope

## File ownership (Pass 2 — DO NOT WRITE OUTSIDE YOUR SCOPE)

| Window | Branch | Owns | Reads only |
|---|---|---|---|
| W1 | feature/risk-engine | src/risk/**, db/migrations/0002_risk_state.sql, .env.example RISK_* lines | src/strategies/** |
| W2 | feature/maker-complement | src/strategies/maker-complement/**, .env.example MAKER_* lines | src/risk/types.ts, src/core/** |
| W3 | feature/council-sandbox | src/council/**, scripts/setup-council-user.sh, .env.example COUNCIL_* lines | src/risk/types.ts |
| W4 | feature/oracle-arb-extensions | src/strategies/oracle-arb/**, .env.example ORACLE_* lines | src/risk/types.ts |
| W5 | feature/observability | src/observability/**, src/integrations/**, src/core/venues/**, db/migrations/0001_init.sql | All strategies |

## Risk gate API contract (W1 must implement, all strategies must call)

```typescript
// src/risk/types.ts
export interface ProposedOrder {
  strategy: string;
  marketSlug: string;
  asset: string;
  timeframe: '5m' | '15m' | '1h';
  side: 'yes_buy' | 'no_buy' | 'yes_sell' | 'no_sell';
  price: number;
  sizeUsd: number;
  pythPrice?: number;
  pythConfidence?: number;
}

export type RiskGateDecision =
  | { ok: true }
  | { ok: false; reason: string; blockingGate: string; details?: object };

export interface RiskGate {
  evaluate(order: ProposedOrder): Promise<RiskGateDecision>;
  isHalted(): Promise<{ halted: boolean; reason?: string }>;
  recordOutcome(orderId: string, outcome: 'win' | 'loss' | 'cancel'): Promise<void>;
}
```

## SQLite schema (W5 owns, all windows reference)
See db/migrations/0001_init.sql for table definitions. Tables:
trade_events, positions, daily_pnl, risk_halts, council_proposals.
All inserts go through src/observability/sqlite-writer.ts.

## DRY_RUN convention (W3 recon landmine L2 fix)
Every strategy's executeDecisions function MUST gate on DRY_RUN at the
TOP of the function. If DRY_RUN=true, log the intended order and return.
W4 specifically responsible for fixing oracle-arb's broken gating.

## MAX_TOTAL_EXPOSURE_USD enforcement (W3 landmine L1 fix)
W1 reads MAX_TOTAL_EXPOSURE_USD from .env. Risk gate sums open positions
from positions table, blocks new orders that would exceed cap.

## Pass 3 integration order (later session)
1. Pull all 5 feature branches
2. Merge feature/observability first (DB schema + event bus everyone needs)
3. Merge feature/risk-engine (risk gate everyone calls)
4. Merge feature/oracle-arb-extensions (W4 — depends on risk gate)
5. Merge feature/maker-complement (W2 — depends on risk gate)
6. Merge feature/council-sandbox (W3 — depends on event bus + DB schema)
7. npm install && npm run typecheck && npm run test
8. DRY_RUN integration test (6 hours observing real markets, no orders)
9. Report integration results before any go-live consideration

## What NOT to do in Pass 2
- Do NOT modify upstream files outside your scope
- Do NOT touch supervisor configs
- Do NOT create .env (no secrets)
- Do NOT npm install in Pass 2 (deps will be installed once in Pass 3)
- Do NOT push to main (only push your own feature branch)
- Do NOT enable LIVE_BETTING anywhere
- Do NOT create real Limitless API keys
- Do NOT touch /root/kalshi-bot or any other repo
- Do NOT modify cc-prod or cc-live anything
