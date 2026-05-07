import * as dotenv from 'dotenv';
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import pino from 'pino';

import { assertKeyIsolation } from './key-isolation-check.js';
import { ReadOnlyState } from './read-only-state.js';
import {
  proposeVolRegime,
  proposeMinEdgeBump,
  proposeCorrelationCap,
  type Proposal,
} from './proposals.js';

dotenv.config();

const logger = pino({ level: process.env.LOG_LEVEL || 'info', name: 'council' });

interface CouncilConfig {
  enabled: boolean;
  tickSecs: number;
  dbPath: string;
  proposalsPath: string;
  keyFileToDeny: string;
}

function loadConfig(): CouncilConfig {
  return {
    enabled: (process.env.COUNCIL_ENABLED ?? 'false').toLowerCase() === 'true',
    tickSecs: Math.max(5, parseInt(process.env.COUNCIL_TICK_SECS ?? '60', 10)),
    dbPath: process.env.COUNCIL_DB_PATH ?? '/var/lib/knoxis/knoxis-limitless.db',
    proposalsPath:
      process.env.COUNCIL_PROPOSALS_PATH ?? '/var/lib/knoxis/council_proposals.json',
    keyFileToDeny:
      process.env.COUNCIL_KEY_FILE_TO_DENY ?? '/var/lib/knoxis/keys/limitless_private.key',
  };
}

function appendProposal(path: string, p: Proposal): void {
  try {
    const dir = dirname(path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    if (!existsSync(path)) writeFileSync(path, '');
    appendFileSync(path, JSON.stringify(p) + '\n');
  } catch (err) {
    logger.error({ err: (err as Error).message, path }, 'Failed to append proposal');
  }
}

async function tick(state: ReadOnlyState, cfg: CouncilConfig): Promise<void> {
  const ts = new Date().toISOString();
  const proposals: Proposal[] = [];

  // Heuristic 1: vol regime.
  // Pyth ATR buffer is wired in W4 (oracle-arb-extensions); until then
  // we pass NaN sentinels and the heuristic returns null.
  const btcAtr1m = NaN;
  const btcAtr1dAvg = NaN;
  const vol = proposeVolRegime(btcAtr1m, btcAtr1dAvg);
  if (vol) proposals.push({ ...vol, ts });

  // Heuristic 2: adverse rate trend.
  const outcomes = state.getRecentOutcomes(20).map((o) => o.outcome);
  const adverse = proposeMinEdgeBump(outcomes);
  if (adverse) proposals.push({ ...adverse, ts });

  // Heuristic 3: exposure imbalance.
  const positions = state.getOpenPositions();
  const perAsset: Record<string, number> = {};
  for (const p of positions) {
    perAsset[p.asset] = (perAsset[p.asset] ?? 0) + p.sizeUsd;
  }
  const corr = proposeCorrelationCap(perAsset);
  if (corr) proposals.push({ ...corr, ts });

  if (proposals.length === 0) {
    logger.debug(
      { outcomes: outcomes.length, openPositions: positions.length },
      'No proposals this tick'
    );
    return;
  }
  for (const p of proposals) appendProposal(cfg.proposalsPath, p);
  logger.info(
    { count: proposals.length, parameters: proposals.map((p) => p.parameter) },
    'Council proposals written'
  );
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  logger.info(cfg, 'Council starting');

  // Layer 0: privilege check -- must run before any DB or network I/O.
  assertKeyIsolation(cfg.keyFileToDeny);

  if (!cfg.enabled) {
    logger.warn('COUNCIL_ENABLED=false -- exiting after isolation check');
    return;
  }

  const state = new ReadOnlyState(cfg.dbPath);

  let running = true;
  const shutdown = (sig: string) => {
    logger.info({ sig }, 'Council shutting down');
    running = false;
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // Self-rescheduling tick loop -- a slow heuristic does not pile timers.
  const loop = async () => {
    if (!running) return;
    const start = Date.now();
    try {
      await tick(state, cfg);
    } catch (err) {
      logger.error({ err: (err as Error).message }, 'Tick failed');
    }
    const elapsed = Date.now() - start;
    const wait = Math.max(1000, cfg.tickSecs * 1000 - elapsed);
    if (running) setTimeout(loop, wait);
  };
  void loop();
}

main().catch((err) => {
  logger.fatal({ err: (err as Error).message }, 'Council fatal');
  process.exit(1);
});
