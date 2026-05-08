# L3 — Polymarket → Limitless Port Plan

**Status:** DESIGN ONLY (chat 23, 08/05/2026). No code merged from this plan.
**Trigger to start porting:** P1.5 post-mortem clears in the Polymarket bot (first 5 cc-live maker fills observed and analysed).
**Authority:** chat-22 W5 14-component audit (`kalshi-bot` PR #15) and chat-22 W3 3-component audit (gap analysis) defined which Polymarket components are actually live and worth porting.

## Cross-pollination principle (Rule 20)

Improvements that proved out on the Polymarket Python bot transfer to the Limitless TypeScript bot **unless proven detrimental**. This document maps each Polymarket win to its Limitless equivalent (or marks it as "no port" if not WIRED in Polymarket either).

---

## 1. Status snapshot

### 1.1 Polymarket wins (kalshi-bot @ origin/main)

| # | Win | File / site | WIRED? |
|---|---|---|---|
| 1 | MakerBot paper resync | `oracle_arb_bot.py:1348` (sync `_maker_bot.paper` per signal); `strategies/maker_bot.py` (live_guard-aware) | YES — PR #10 |
| 2 | oracle_arb signal generator | `oracle_arb_bot.py:OracleArbBot._place_poly_bet` + `latency_engine.py:ChainlinkOracleMonitor.detect_stale_clob:562` | YES |
| 3 | Kelly sizer + dynamic bankroll | `kelly_sizer.py` (16 KB) + `shared/bankroll.py` (60s cache, reads `settings.BANKROLL`) | YES — C2 MVP shipped chat 22 |
| 4 | DDP risk system (4 tiers) | `ddp_monitor.py` (standalone supervisor, writes `KELLY_MULTIPLIER_<tf>` + `PAUSE_<tf>` settings); bots read each cycle | OPERATIONAL (separate process); `oracle_arb_bot.py` does NOT consume directly — `poly_bot_runner.py:202` does (`PAUSED by ddp_monitor`) |
| 5 | correlated_cap multi-asset | `shared/correlated_cap.py:check_correlated_bet_cap()` — caps aggregate open BTC notional at 6.5% / 10% / 15% of bankroll, era-4-sample-size tiered. Excludes oracle_arb by default. | YES — imported by `poly_bot_runner.py` |
| 6 | Comprehensive learner | `intelligence/learner.py` | **NO** — zero importers in repo (chat-22 W5 audit). Dead code. |
| 7 | Full-stack healer | `self_healer.py` (used only for `event_bus` symbol by dashboards); runs as `kalshi-healer` + `knoxis-intel-healer` supervisors | PARTIAL — `oracle_arb_bot` does not import; dashboards consume the bus |
| 8 | AutoRedeemer | `shared/auto_redeemer.py` + `oracle_arb_bot.py:223,679` | YES |
| 9 | Latency telemetry (4 sites) | `shared/latency_telemetry.py` + 4 wire sites (chat-22 W5 PR #22) | PR #22 OPEN — awaits merge |
| 10 | Settlement bootstrap | `oracle_arb_bot._bootstrap_settlement_queue:299` | YES |
| 11 | Dead zone gate | `oracle_arb_bot.py:398-411` (`DEAD_ZONE_HOURS` setting) | YES |

### 1.2 Limitless current state (agents-starter-knoxis @ origin/main)

| Subsystem | Path | Status |
|---|---|---|
| oracle-arb strategy | `src/strategies/oracle-arb/{index.ts,run.ts}` | Directional drift edge merged (PR #4); `OracleArbStrategy extends BaseStrategy`; `SLUG_DIRECTIONAL_RE` regex; window-start parsing |
| Hermes price feed | `src/core/price-feeds/hermes.ts` | Rolling buffer + `getDeltaFromWindowOpen` (PR #3) |
| Wallet (DRY_RUN-aware) | `src/core/wallet.ts` | `DryRunWallet` stub merged (PR #7); soft-gates PRIVATE_KEY/LIMITLESS_API_KEY (PRs #5/#6) |
| Limitless API surface | `src/core/limitless/{markets,trading,sign,redeem}.ts` | Present |
| Risk halts | `src/risk/types.ts` exists; **`src/risk/state.ts` MISSING** — Pass 4 wired the writer but the file is absent on origin/main. | GAP — needs forensic before port |
| Observability | `src/observability/` directory absent | GAP |
| Cross-platform venues | `src/core/venues/` exists but only `.gitkeep` | EMPTY (Phase 4 of this tile stubs `polymarket.ts`) |
| Kelly sizer / bankroll | none | MISSING |
| DDP consumer | none | MISSING |
| correlated_cap | none | MISSING |
| Learner | none | MISSING (and not worth porting — Polymarket version is dead code) |
| Healer / event_bus | none | MISSING |

---

## 2. Port plan, win by win

For each Polymarket win that is genuinely WIRED, this section lists: the Limitless target file(s), the change, the test, and the order dependency.

### 2.1 PORT — MakerBot paper resync (Polymarket win #1)

Limitless does not yet have a maker strategy that toggles between paper and live per-signal. The `DryRunWallet` (PR #7) is process-level, not per-signal. When Limitless gets its first live-toggling maker, mirror the Polymarket fix preventively.

- **Target:** future `src/strategies/maker-complement/run.ts` (currently a stub) or new `src/strategies/oracle-arb-maker/`.
- **Change:** when the strategy decides paper vs. live for a signal, set the corresponding flag on the order signer / trading client BEFORE building the order args. Mirror `oracle_arb_bot.py:1348` pattern: each signal carries its own paper bit.
- **Test:** unit test asserts that two signals in succession with opposite paper flags produce one paper order args + one live order args (no leakage).
- **Order:** parking item — wait until Limitless has a maker variant. Probably L4+.

### 2.2 KEEP — oracle_arb signal generator (Polymarket win #2)

Limitless **already has** a directional oracle-arb (PR #4). It uses Hermes Pyth instead of Chainlink. Architecturally analogous; nothing to port from Polymarket.

- **Action:** none. Note that the `chainlink_update_ts_ms` field added in chat-22 W5 PR #22 has a Pyth analogue; once latency telemetry ports to Limitless (see 2.5), stamp `pyth_publish_time_ms` from the Hermes price feed instead.

### 2.3 PORT — Kelly sizer + dynamic bankroll (Polymarket win #3)

Currently Limitless uses a fixed `betSizeUsd` per `OracleArbConfig`. Polymarket has Kelly-based sizing with delta and confidence multipliers, plus a 60s-cached `BANKROLL` resolver.

- **Targets:**
  - New `src/core/sizing/kelly.ts` — port `kelly_sizer.py` algorithm. Inputs: `confidence`, `deltaPct`, `secondsRemaining`, `kellyMultiplier` (default 0.25 = quarter-Kelly). Output: stake in USD.
  - New `src/core/sizing/bankroll.ts` — port `shared/bankroll.py`. 60s in-memory cache, persists in SQLite (`db/` already exists), default fallback. Reads from on-chain `getBalance` for USDC + persisted `BANKROLL` setting.
  - Integration in `src/strategies/oracle-arb/index.ts`: replace `betSizeUsd` with `kelly.compute(...)` call when `OracleArbConfig.useKellySizing` is true (default false initially, A/B over 50+ DRY_RUN signals before flipping default).
- **Test:** vitest port of Polymarket's Kelly tests (delta multiplier curve; uncertainty discount with N=0/N=10/N=100 settled bets; LIVE_BET_MAX cap).
- **Size:** ~150 LoC in `kelly.ts` + ~80 LoC in `bankroll.ts` + ~40 LoC integration.
- **Order:** L3 first deliverable. Self-contained.

### 2.4 PARTIAL PORT — DDP risk system (Polymarket win #4)

Polymarket runs DDP as a separate process that writes settings. Limitless has `db/` SQLite already.

- **Approach (Option A, preferred):** stand up a parallel `src/risk/ddp.ts` that runs on a 5-minute timer inside the existing strategy process (not a separate supervisor). Reads recent fill outcomes from the Limitless `db/` SQLite and writes `KELLY_MULTIPLIER_<tf>` / `PAUSE_<tf>` rows. The strategy reads these per cycle.
- **Approach (Option B, deferred):** port `ddp_monitor.py` 1:1 as a standalone process. Heavier, requires PM2 or systemd discipline that Limitless doesn't have today.
- **Test:** vitest checks that L0 → L4 escalation triggers when forced via injected mock outcomes.
- **Size:** Option A ~200 LoC + tests.
- **Order:** L3 third (after Kelly sizer; DDP modulates Kelly).
- **NOTE:** in Polymarket, DDP is consumed by `poly_bot_runner.py` (the prediction-ensemble bot), NOT by `oracle_arb_bot.py`. For Limitless, oracle-arb is the primary strategy — so we'd be wiring DDP into a different topology than the Polymarket pattern. Worth a design check before coding.

### 2.5 PORT — correlated_cap (Polymarket win #5)

Limitless trades multiple assets (BTC/ETH/SOL/XRP/DOGE/BNB/HYPE per the W4 catalog inventory). All correlated to crypto-beta. A per-strategy Kelly without a cross-strategy cap can over-expose.

- **Target:** new `src/risk/correlated-cap.ts` — port `check_correlated_bet_cap()`. Same era-tiered thresholds (6.5%/10%/15% of bankroll). Reads aggregate open notional from `db/` `positions` table (existing).
- **Integration:** call from `OracleArbStrategy.evaluate()` just before placing each order; cap or skip per the returned reduced stake.
- **Test:** unit test asserts cap kicks in at 7% / 11% / 16% bands.
- **Size:** ~80 LoC + tests.
- **Order:** L3 second (between Kelly and DDP).

### 2.6 NO PORT — Comprehensive learner (Polymarket win #6)

`intelligence/learner.py` is dead code in Polymarket per chat-22 W5 audit (zero importers). Don't port what isn't proven. Re-evaluate when/if Polymarket revives it.

### 2.7 DEFERRED — Full-stack healer (Polymarket win #7)

`self_healer.py` is mostly orphaned in Polymarket (only `event_bus` is used, by the dashboards). The healer-as-supervisor lives but isn't directly consumed by `oracle_arb_bot`.

- **Action for Limitless:** introduce `src/observability/event-bus.ts` only when there's a real consumer. Skip the heal-itself loop until Polymarket proves it useful.

### 2.8 PORT — AutoRedeemer (Polymarket win #8)

Limitless already has `src/core/limitless/redeem.ts`. Confirm parity:

- Polymarket does redemption on every WIN settlement; periodic startup pass; warns and continues on failure (never blocks bet path).
- **Test:** if the Limitless redeemer is one-shot only (script in `src/scripts/auto-claim.ts`), wire it into the oracle-arb settlement loop too. Cheap: ~30 LoC.
- **Order:** L3 fourth.

### 2.9 PORT — Latency telemetry (Polymarket win #9)

Once Polymarket PR #22 merges, port the same 4-site pattern (t0 oracle update → t1 signal-fire → t2 order-post → t3 fill-confirmed) to Limitless.

- **Targets:**
  - New `src/observability/latency-telemetry.ts` with `recordEvent({ betId, slug, paper, ts0–ts3, ... })` mirror of `shared/latency_telemetry.py`.
  - SQLite writer using existing `db/` directory.
  - Wire sites in `src/core/price-feeds/hermes.ts` (t0), `src/strategies/oracle-arb/index.ts` (t1), `src/core/limitless/trading.ts` (t2), settlement loop (t3).
  - Mirror the `bet_id` propagation refactor from PR #22.
- **Order:** L3 fifth — after Kelly + cap + DDP land, since telemetry of-no-decisions is less useful.

### 2.10 KEEP — Settlement bootstrap (Polymarket win #10)

Limitless has `src/strategies/oracle-arb/index.ts` reload-positions logic ("No persisted positions found" log line during the soak). Already analogous; no port.

### 2.11 EVALUATE — Dead zone gate (Polymarket win #11)

Polymarket gates on `DEAD_ZONE_HOURS` (e.g., low-liquidity overnight windows). Limitless trades 24/7 but on Base; Pyth update cadence is uniform. Probably less applicable. Defer until empirical evidence shows specific UTC hours underperform on Limitless.

---

## 3. Recommended port order

| Order | Win | Estimate | Gate |
|---|---|---|---|
| 1 | Kelly sizer + bankroll resolver (2.3) | ~270 LoC + tests | Self-contained |
| 2 | correlated_cap (2.5) | ~80 LoC + tests | Needs Kelly first to compute pre-cap stake |
| 3 | DDP consumer Option A (2.4) | ~200 LoC + tests | Modulates Kelly multiplier |
| 4 | AutoRedeemer parity (2.8) | ~30 LoC | Independent |
| 5 | Latency telemetry (2.9) | ~150 LoC + tests | Gated on Polymarket PR #22 merge + L3 #1-3 done so we have decisions to telemetry |

Skip / defer: 2.1 maker resync, 2.6 learner, 2.7 healer, 2.11 dead-zone.

---

## 4. Known blockers (this tile surfaced these — separate fix tiles required)

### 4.1 Hermes SSE 404 on every connect attempt
`DRY_RUN=true ORACLE_ASSETS=BTC,ETH,SOL,XRP,DOGE,BNB,HYPE npm run oracle-arb` for 60s during this tile produced **0 decisions, 0 positions, 0 traded** because every connection to `https://hermes.pyth.network/v2/updates/price/stream?ids[]=...` returned HTTP 404. Reconnect every 5s. Strategy can boot but cannot get prices.
- Likely cause: stale Pyth feed IDs, wrong query encoding (`ids[]=` vs `ids%5B%5D=`), or one invalid asset ID poisoning the request.
- Unit tests still pass (26/26) because they use mocks.
- **Action item:** separate L2-day-3-debug tile. Port plan should NOT ship until Hermes works — porting Kelly sizer onto a strategy that can't get prices is wasted work.

### 4.2 `src/risk/state.ts` missing
`src/risk/types.ts` exists with halt types but `state.ts` (the canonical halt writer per chat-22 Pass 4 discussion) is absent on origin/main. Either it never landed or was reverted. Risk-halt writes have no working path on Limitless.
- **Action item:** forensic on what happened to Pass 4's state.ts work; either restore or rewrite before DDP port (2.4).

### 4.3 No `integration-test` npm script
package.json has only `test` (vitest run) and `test:watch`. The user's tile expected `npm run integration-test`. Substituted with `timeout 60s npm run oracle-arb` which is a smoke run, not a test.
- **Action item:** if integration-style tests are wanted, add `test:integration` script that runs vitest with `--config vitest.integration.config.ts` against a real Hermes connection (gated on Hermes 4.1 fix).

---

## 5. Out-of-scope for L3 (do not port)

- **Comprehensive learner** — dead code in Polymarket.
- **Full-stack healer** — partial usage in Polymarket; no Limitless consumer to justify the surface area.
- **DDP as a separate process** — Limitless has no supervisor discipline; Option A in-process timer is appropriate.
- **Polymarket's ensemble (4-source consensus in `poly_bot_runner.py`)** — Limitless oracle-arb is delta-driven, not confidence-gated. Same architectural reason that chat-22 W5 CVD-wiring tile halted in Polymarket.
- **MakerBot.paper resync** — port when Limitless has its first live-toggling maker, not before.

---

## 6. Re-evaluation checkpoints

Re-read this plan and refresh the WIRED status table before starting **each** numbered port (3.1, 3.2, 3.3, 3.4, 3.5). Polymarket changes weekly; what was "wired" when this plan was written may have moved. Audit against `kalshi-bot` `origin/main` HEAD at port-start time, not memory.

---

_Plan authored chat 23, 08/05/2026 (Malta). Triggered by chat-22 TODO L3 entry. Authored on `agents-starter-knoxis` under cc-staging. Approval gate before any port code: P1.5 post-mortem clears in `kalshi-bot` (first 5 cc-live maker fills) AND Hermes 404 (4.1) is fixed._
