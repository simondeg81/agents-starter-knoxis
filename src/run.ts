/**
 * KNOXis Limitless bot entrypoint.
 *
 * Composes: observability + risk gate + strategies.
 *
 * DRY_RUN safety:
 *   - Each strategy gates DRY_RUN at the TOP of executeDecisions (W3 L2)
 *   - When DRY_RUN=true and no PRIVATE_KEY is provided, this entrypoint
 *     generates an ephemeral random wallet via viem.generatePrivateKey().
 *     The key is never persisted, the wallet has 0 USDC on-chain, and
 *     because the DRY_RUN gate blocks createOrder, it never signs.
 *   - LIMITLESS_API_KEY is never required for read-only market data.
 */
import 'dotenv/config';
import { generatePrivateKey } from 'viem/accounts';

// Ephemeral wallet path: only kicks in when DRY_RUN=true and no key given.
if (!process.env.PRIVATE_KEY && process.env.DRY_RUN === 'true') {
  process.env.PRIVATE_KEY = generatePrivateKey();
  console.log('[run] DRY_RUN: generated ephemeral wallet (random, never persisted, never signs)');
}

import { initialize as initObservability } from './observability/index.js';
import { DefaultRiskGate } from './risk/index.js';
import { getWallet } from './core/wallet.js';
import { LimitlessClient } from './core/limitless/markets.js';
import { TradingClient } from './core/limitless/trading.js';
import { OrderSigner } from './core/limitless/sign.js';
import {
  OracleArbStrategy,
  type OracleArbConfig,
} from './strategies/oracle-arb/index.js';
import {
  MakerComplementStrategy,
  type MakerComplementConfig,
} from './strategies/maker-complement/index.js';
import type { BaseStrategy } from './strategies/base-strategy.js';

function oracleConfigFromEnv(): OracleArbConfig {
  return {
    id: 'oracle-arb-1',
    type: 'oracle-arb',
    enabled: true,
    assets: (process.env.ORACLE_ASSETS ?? 'BTC,ETH,SOL').split(',').map((s) => s.trim()),
    minConfidencePercent: parseFloat(process.env.ORACLE_MIN_CONFIDENCE ?? '0.82'),
    minEdgePercent: parseFloat(process.env.ORACLE_MIN_EDGE ?? '0.10'),
    minMarketPrice: parseFloat(process.env.ORACLE_MIN_PRICE ?? '0.30'),
    maxMarketPrice: parseFloat(process.env.ORACLE_MAX_PRICE ?? '0.75'),
    betSizeUsd: parseFloat(process.env.ORACLE_BET_SIZE ?? '1'),
    timeframes: (process.env.ORACLE_TIMEFRAMES ?? '1h').split(',').map((s) => s.trim()),
    maxPositions: parseInt(process.env.ORACLE_MAX_POSITIONS ?? '10', 10),
    minMinutesToExpiry: parseInt(process.env.ORACLE_MIN_MINUTES ?? '0', 10),
    maxMinutesToExpiry: parseInt(process.env.ORACLE_MAX_MINUTES ?? '90', 10),
  };
}

function makerConfigFromEnv(): MakerComplementConfig {
  return {
    id: 'maker-complement-1',
    type: 'maker-complement',
    enabled: true,
    markets: (process.env.MAKER_MARKETS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    targetSum: parseFloat(process.env.MAKER_TARGET_SUM ?? '0.95'),
    quoteBumpBps: parseInt(process.env.MAKER_QUOTE_BUMP_BPS ?? '10', 10),
    requoteTolerance: parseFloat(process.env.MAKER_REQUOTE_TOLERANCE ?? '0.005'),
    maxInventoryPerMarket: parseFloat(process.env.MAKER_MAX_INVENTORY_PER_MARKET ?? '20'),
    betSize: parseFloat(process.env.MAKER_BET_SIZE ?? '2'),
  };
}

async function main() {
  console.log('[run] KNOXis Limitless bot starting');
  console.log(`[run] DRY_RUN=${process.env.DRY_RUN ?? '(unset)'}`);
  console.log(`[run] node version: ${process.version}`);

  // 1. Observability — applies migrations 0001 + 0002 idempotently
  const dbPath = process.env.RISK_DB_PATH ?? '/var/lib/knoxis/knoxis-limitless.db';
  const obs = initObservability({ dbPath });
  console.log(`[run] observability ready (applied=${JSON.stringify(obs.appliedMigrations)})`);

  // 2. Risk gate — opens its own SQLite connection lazily on first evaluate()
  const riskGate = new DefaultRiskGate();
  console.log('[run] risk gate configured');

  // 3. Wallet + Limitless clients
  const { client: walletClient, account } = getWallet();
  const limitless = new LimitlessClient();
  const signer = new OrderSigner(walletClient, account);
  const trading = new TradingClient(limitless, signer);
  console.log(`[run] wallet+clients ready (addr=${account.address})`);

  // 4. Strategies (gated on env)
  const strategies: BaseStrategy[] = [];

  if (process.env.ORACLE_ENABLED === 'true') {
    const cfg = oracleConfigFromEnv();
    const s = new OracleArbStrategy(cfg, { limitless, trading, riskGate });
    s.setWalletAddress(account.address);
    strategies.push(s);
    console.log(
      `[run] oracle-arb registered (assets=${cfg.assets.join(',')}, timeframes=${cfg.timeframes?.join(',') ?? '1h'})`
    );
  }

  if (process.env.MAKER_ENABLED === 'true') {
    const cfg = makerConfigFromEnv();
    if (cfg.markets.length === 0) {
      console.log('[run] MAKER_ENABLED=true but MAKER_MARKETS empty — skipping registration');
    } else {
      const s = new MakerComplementStrategy(cfg, { limitless, trading, riskGate });
      strategies.push(s);
      console.log(`[run] maker-complement registered (${cfg.markets.length} markets)`);
    }
  }

  if (strategies.length === 0) {
    console.log('[run] no strategies enabled. Set ORACLE_ENABLED=true or MAKER_ENABLED=true.');
    return;
  }

  // 5. Start each strategy. BaseStrategy.start() runs its own setTimeout
  // tick loop (5–10 s depending on strategy); we don't drive ticks from here.
  for (const s of strategies) {
    await s.start();
  }
  console.log(`[run] ${strategies.length} strategies running`);

  // 6. Shutdown handlers
  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    console.log(`[run] shutdown signal: ${signal}`);
    for (const s of strategies) {
      try {
        await s.stop();
      } catch (e) {
        console.error(`[run] stop error:`, e);
      }
    }
    setTimeout(() => process.exit(0), 1000);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('[run] fatal:', err);
  process.exit(1);
});
