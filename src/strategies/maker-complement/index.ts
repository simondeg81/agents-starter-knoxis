// W2 — Maker complement arb strategy.
//
// Two-sided maker quoting: for each configured market, post a GTC postOnly
// YES bid and a NO bid such that the implied combined cost
// (yesBid + noBid) sits below MAKER_TARGET_SUM (default 0.95) — the
// difference is our risk-free spread. When one side fills, the other is
// already resting; if both fill, we own a complete pair that resolves to
// $1 with locked-in profit. If only one fills, the inventory model tilts
// future quotes to unwind.
//
// Foundation B per LIMITLESS_STRATEGY_v1.3 §"The eight edges" #1+#2.
//
// Boundaries respected per EXTENSIONS_DESIGN.md:
//   - This file imports src/risk/types.ts (interface only — no impl).
//   - This file imports src/core/limitless/{markets,trading,types}.ts.
//   - It does NOT modify either of those — read-only consumption.
//   - DRY_RUN gating sits at the TOP of executeDecisions per W3 L2.

import { BaseStrategy, StrategyConfig, TradeDecision } from '../base-strategy.js';
import { LimitlessClient } from '../../core/limitless/markets.js';
import { TradingClient } from '../../core/limitless/trading.js';
import type { ProposedOrder, RiskGate } from '../../risk/types.js';
import { eventBus } from '../../observability/event-bus.js';
import { computeTargetQuotes, shouldRequote } from './quote-engine.js';
import { InventoryModel, Side } from './inventory-model.js';

export interface MakerComplementConfig extends StrategyConfig {
    /** Comma-sep slugs from MAKER_MARKETS. Empty → strategy is a no-op. */
    markets: string[];
    /** Hard cap on yesBidTarget + noBidTarget (default 0.95). */
    targetSum: number;
    /** Bump in basis points (default 10 → 0.10¢). */
    quoteBumpBps: number;
    /** Drift before we cancel + replace (default 0.005 = 0.5¢, prob units). */
    requoteTolerance: number;
    /** Per-market exposure cap in USD (default 20). */
    maxInventoryPerMarket: number;
    /** USD per quote (default 2). */
    betSize: number;
}

interface OpenQuote {
    side: Side;
    /** Cents (1–99) — matches TradingClient.createOrder.limitPriceCents. */
    priceCents: number;
    sizeUsd: number;
    orderId?: string;
    submittedAt: number;
}

interface MarketQuotes {
    yes?: OpenQuote;
    no?: OpenQuote;
}

export class MakerComplementStrategy extends BaseStrategy {
    private cfg: MakerComplementConfig;
    private riskGate?: RiskGate;
    private inventory: InventoryModel;
    private openQuotes = new Map<string, MarketQuotes>();
    private lastTickStart = 0;
    private lastTickDurationMs = 0;

    constructor(
        config: StrategyConfig,
        deps: { limitless: LimitlessClient; trading: TradingClient; riskGate?: RiskGate },
    ) {
        super(config, deps);
        this.cfg = normaliseConfig(config);
        this.riskGate = deps.riskGate;
        this.inventory = new InventoryModel(this.cfg.maxInventoryPerMarket);
        this.tickIntervalMs = 5000; // brief: 5s
    }

    async initialize(): Promise<void> {
        this.logger.info({
            markets: this.cfg.markets,
            targetSum: this.cfg.targetSum,
            quoteBumpBps: this.cfg.quoteBumpBps,
            requoteTolerance: this.cfg.requoteTolerance,
            maxInventoryPerMarket: this.cfg.maxInventoryPerMarket,
            betSize: this.cfg.betSize,
            tickIntervalMs: this.tickIntervalMs,
        }, 'maker-complement init');
        if (this.cfg.markets.length === 0) {
            this.logger.warn('MAKER_MARKETS is empty — strategy will tick as a no-op');
        }
    }

    async shutdown(): Promise<void> {
        // Best-effort cancel of resting quotes on stop.
        for (const [slug, slot] of this.openQuotes) {
            for (const q of [slot.yes, slot.no]) {
                if (!q?.orderId) continue;
                try {
                    await this.trading.cancelOrder(q.orderId);
                } catch (e: any) {
                    this.logger.warn({ slug, side: q.side, err: e?.message }, 'shutdown cancel failed');
                }
            }
        }
        this.openQuotes.clear();
    }

    async tick(): Promise<TradeDecision[]> {
        this.lastTickStart = Date.now();
        const decisions: TradeDecision[] = [];
        if (this.cfg.markets.length === 0) return decisions;

        for (const slug of this.cfg.markets) {
            try {
                const book = await this.limitless.getOrderbook(slug);
                const target = computeTargetQuotes(book, {
                    targetSum: this.cfg.targetSum,
                    quoteBumpBps: this.cfg.quoteBumpBps,
                });
                if (!target) {
                    this.logger.debug({ slug }, 'no quotable book this tick');
                    continue;
                }

                // Inventory-aware tilt: shave the over-stocked side, push the
                // under-stocked side. requoteTolerance is the magnitude.
                const skew = this.inventory.skewBias(slug);
                const tilt = skew * this.cfg.requoteTolerance;
                const yesTargetProb = clampProb(target.yesBid - Math.max(0, tilt));
                const noTargetProb = clampProb(target.noBid - Math.max(0, -tilt));

                const open = this.openQuotes.get(slug) ?? {};
                const yesTargetCents = Math.round(yesTargetProb * 100);
                const noTargetCents = Math.round(noTargetProb * 100);
                const tolCents = this.cfg.requoteTolerance * 100;

                this.maybeQuote(decisions, slug, 'YES', yesTargetCents, open.yes?.priceCents ?? 0, tolCents);
                this.maybeQuote(decisions, slug, 'NO', noTargetCents, open.no?.priceCents ?? 0, tolCents);
            } catch (e: any) {
                this.logger.warn({ slug, err: e?.message }, 'tick error for market');
            }
        }

        this.lastTickDurationMs = Date.now() - this.lastTickStart;
        return decisions;
    }

    private maybeQuote(
        out: TradeDecision[],
        slug: string,
        side: Side,
        targetCents: number,
        currentCents: number,
        toleranceCents: number,
    ): void {
        if (!shouldRequote(currentCents, targetCents, toleranceCents)) return;
        if (!this.inventory.canQuote(slug, side, this.cfg.betSize)) {
            this.logger.debug({ slug, side }, 'inventory cap reached — skipping requote');
            return;
        }
        out.push({
            action: 'BUY',
            marketSlug: slug,
            side,
            priceLimit: targetCents,
            amountUsd: this.cfg.betSize,
            reason: `maker-complement ${side} quote @ ${targetCents}¢`,
            orderType: 'GTC',
            postOnly: true,
        });
    }

    protected async executeDecisions(decisions: TradeDecision[]): Promise<void> {
        // EXTENSIONS_DESIGN: DRY_RUN gate at TOP (W3 landmine L2 fix).
        if (process.env.DRY_RUN === 'true') {
            this.logger.info({
                strategy: 'maker-complement',
                count: decisions.length,
                decisions: decisions.map(d => ({
                    marketSlug: d.marketSlug,
                    side: d.side,
                    priceLimit: d.priceLimit,
                    amountUsd: d.amountUsd,
                    orderType: d.orderType,
                    postOnly: d.postOnly,
                })),
            }, '[maker-complement][DRY_RUN] would execute');
            const tsNs = BigInt(Date.now()) * 1_000_000n;
            for (const d of decisions) {
                if (d.action === 'SKIP') continue;
                eventBus.emit('strategy.dry_run', {
                    timestampNs: tsNs,
                    strategy: 'maker-complement',
                    marketSlug: d.marketSlug,
                    asset: extractAsset(d.marketSlug),
                    timeframe: extractTimeframe(d.marketSlug),
                    isDryRun: true,
                    side: d.side === 'YES' ? 'yes_buy' : 'no_buy',
                    price: d.priceLimit / 100,
                    sizeUsd: d.amountUsd,
                });
            }
            return;
        }

        for (const decision of decisions) {
            if (decision.action === 'SKIP') continue;

            // Risk gate: optional in Pass 2, mandatory once W1 + Pass 3 wires it.
            if (this.riskGate) {
                const proposed: ProposedOrder = {
                    strategy: 'maker-complement',
                    marketSlug: decision.marketSlug,
                    asset: extractAsset(decision.marketSlug),
                    timeframe: extractTimeframe(decision.marketSlug),
                    side: decision.side === 'YES' ? 'yes_buy' : 'no_buy',
                    price: decision.priceLimit / 100,
                    sizeUsd: decision.amountUsd,
                };
                const gateDecision = await this.riskGate.evaluate(proposed);
                if (!gateDecision.ok) {
                    this.logger.warn({
                        marketSlug: decision.marketSlug,
                        side: decision.side,
                        reason: gateDecision.reason,
                        blockingGate: gateDecision.blockingGate,
                    }, '[maker-complement][risk-block]');
                    eventBus.emit('strategy.risk_block', {
                        timestampNs: BigInt(Date.now()) * 1_000_000n,
                        strategy: 'maker-complement',
                        marketSlug: decision.marketSlug,
                        asset: proposed.asset,
                        timeframe: proposed.timeframe,
                        isDryRun: false,
                        side: proposed.side,
                        price: proposed.price,
                        sizeUsd: proposed.sizeUsd,
                        riskBlockReason: gateDecision.reason,
                    });
                    continue;
                }
            } else {
                // TODO(W1+Pass3): once feature/risk-engine merges, riskGate
                // becomes mandatory and this branch becomes unreachable.
                this.logger.warn({
                    marketSlug: decision.marketSlug,
                }, '[maker-complement] riskGate not wired (Pass2) - proceeding without risk evaluation');
            }

            // Cancel any prior resting quote on this side before placing the new one.
            await this.cancelExistingQuote(decision.marketSlug, decision.side as Side);

            try {
                const result = await this.trading.createOrder({
                    marketSlug: decision.marketSlug,
                    side: decision.side,
                    limitPriceCents: decision.priceLimit,
                    usdAmount: decision.amountUsd,
                    orderType: decision.orderType ?? 'GTC',
                    postOnly: decision.postOnly,
                });

                const orderId = extractOrderId(result);
                this.recordOpenQuote(decision.marketSlug, decision.side as Side, decision.priceLimit, decision.amountUsd, orderId);
                this.inventory.add(decision.marketSlug, decision.side as Side, decision.amountUsd);
                this.logger.info({
                    marketSlug: decision.marketSlug,
                    side: decision.side,
                    priceCents: decision.priceLimit,
                    amountUsd: decision.amountUsd,
                    orderId,
                }, 'maker-complement quote posted');
                eventBus.emit('strategy.submit', {
                    timestampNs: BigInt(Date.now()) * 1_000_000n,
                    strategy: 'maker-complement',
                    marketSlug: decision.marketSlug,
                    asset: extractAsset(decision.marketSlug),
                    timeframe: extractTimeframe(decision.marketSlug),
                    isDryRun: false,
                    side: decision.side === 'YES' ? 'yes_buy' : 'no_buy',
                    price: decision.priceLimit / 100,
                    sizeUsd: decision.amountUsd,
                    orderId,
                });
            } catch (err: any) {
                this.logger.warn({
                    err: err?.message,
                    decision: { marketSlug: decision.marketSlug, side: decision.side, priceLimit: decision.priceLimit },
                }, 'maker-complement order submission failed');
            }
        }
    }

    private async cancelExistingQuote(slug: string, side: Side): Promise<void> {
        const slot = this.openQuotes.get(slug);
        if (!slot) return;
        const existing = side === 'YES' ? slot.yes : slot.no;
        if (!existing?.orderId) return;
        try {
            await this.trading.cancelOrder(existing.orderId);
            this.inventory.release(slug, side, existing.sizeUsd);
        } catch (e: any) {
            this.logger.warn({ slug, side, orderId: existing.orderId, err: e?.message }, 'cancel of prior quote failed');
        }
        if (side === 'YES') slot.yes = undefined;
        else slot.no = undefined;
    }

    private recordOpenQuote(slug: string, side: Side, priceCents: number, sizeUsd: number, orderId: string | undefined): void {
        const slot = this.openQuotes.get(slug) ?? {};
        const q: OpenQuote = { side, priceCents, sizeUsd, orderId, submittedAt: Date.now() };
        if (side === 'YES') slot.yes = q;
        else slot.no = q;
        this.openQuotes.set(slug, slot);
    }

    getStats() {
        return {
            activePositions: this.inventory.totalOpenPositions(),
            totalVolumeUsd: this.inventory.totalNotional(),
            pnlUsd: 0, // pnl tracking deferred to W5 observability
            lastTickDurationMs: this.lastTickDurationMs,
        };
    }
}

// ───── helpers ─────

function clampProb(p: number): number {
    if (p < 0.01) return 0.01;
    if (p > 0.99) return 0.99;
    return p;
}

function extractAsset(slug: string): string {
    // slugs like 'btc-up-or-down-1-hour-...' or 'btc-above-100k'
    const m = slug.match(/^([a-z]+)-/);
    return m ? m[1].toUpperCase() : 'UNKNOWN';
}

function extractTimeframe(slug: string): '5m' | '15m' | '1h' {
    if (/-up-or-down-5-minutes?-/.test(slug)) return '5m';
    if (/-up-or-down-15-minutes?-/.test(slug)) return '15m';
    return '1h';
}

function extractOrderId(result: any): string | undefined {
    if (typeof result?.id === 'string') return result.id;
    if (typeof result?.orderId === 'string') return result.orderId;
    if (typeof result?.order?.id === 'string') return result.order.id;
    return undefined;
}

function normaliseConfig(raw: StrategyConfig): MakerComplementConfig {
    const r = raw as Partial<MakerComplementConfig> & StrategyConfig;
    const markets = Array.isArray(r.markets)
        ? r.markets.filter((s): s is string => typeof s === 'string' && s.length > 0)
        : [];
    return {
        ...r,
        markets,
        targetSum: typeof r.targetSum === 'number' ? r.targetSum : 0.95,
        quoteBumpBps: typeof r.quoteBumpBps === 'number' ? r.quoteBumpBps : 10,
        requoteTolerance: typeof r.requoteTolerance === 'number' ? r.requoteTolerance : 0.005,
        maxInventoryPerMarket: typeof r.maxInventoryPerMarket === 'number' ? r.maxInventoryPerMarket : 20,
        betSize: typeof r.betSize === 'number' ? r.betSize : 2,
    } as MakerComplementConfig;
}
