// W5 — KNOXis dashboard JSON endpoint.
//
// Exposes a single read-only endpoint at GET http://localhost:3457/state.json
// that the existing KNOXis dashboard scrapes. Returns:
//   - openPositions
//   - todayPnl   (per-strategy + total)
//   - recentEvents (last 50)
//   - activeHalts
//   - pendingCouncilProposals
//
// The endpoint is intended for localhost scraping only; binds to 127.0.0.1
// by default. Override with KNOXIS_DASHBOARD_HOST if you need otherwise
// (use behind nginx on cc-prod / cc-staging — never expose raw to the
// internet).

import { createServer, IncomingMessage, ServerResponse, Server } from 'node:http';
import type Database from 'better-sqlite3';
import { pino } from 'pino';

const logger = pino({ level: process.env.LOG_LEVEL || 'info', name: 'knoxis-dashboard' });

const DEFAULT_PORT = 3457;
const DEFAULT_HOST = '127.0.0.1';
const RECENT_EVENTS_LIMIT = 50;

export interface DashboardEndpointConfig {
  db: Database.Database;
  port?: number;
  host?: string;
}

interface OpenPositionRow {
  market_slug: string;
  strategy: string;
  asset: string;
  side: string;
  entry_price: number;
  size_usd: number;
  opened_at_ns: number;
  is_dry_run: number;
}

interface DailyPnlRow {
  utc_date: string;
  strategy: string;
  realized_pnl_usd: number;
  fees_paid_usd: number;
  rebates_received_usd: number;
  n_trades: number;
  n_wins: number;
  n_losses: number;
  n_risk_blocks: number;
}

interface TradeEventRow {
  id: number;
  timestamp_ns: number;
  created_at: string;
  strategy: string;
  market_slug: string;
  asset: string;
  timeframe: string;
  event_type: string;
  side: string | null;
  price: number | null;
  size_usd: number | null;
  order_id: string | null;
  outcome: string | null;
  realized_pnl_usd: number | null;
  risk_block_reason: string | null;
  is_dry_run: number;
}

interface RiskHaltRow {
  id: number;
  halted_at_ns: number;
  reason: string;
  details_json: string | null;
  cleared_at_ns: number | null;
  cleared_by: string | null;
  cleared_reason: string | null;
}

interface CouncilProposalRow {
  id: number;
  proposed_at_ns: number;
  parameter: string;
  current_value: string;
  proposed_value: string;
  reasoning: string;
  status: string;
  decided_at_ns: number | null;
  decided_by: string | null;
}

function utcToday(): string {
  return new Date().toISOString().slice(0, 10);
}

function buildState(db: Database.Database) {
  const today = utcToday();

  const openPositions = db
    .prepare(`SELECT * FROM positions ORDER BY opened_at_ns DESC`)
    .all() as OpenPositionRow[];

  const todayPnlRows = db
    .prepare(`SELECT * FROM daily_pnl WHERE utc_date = ?`)
    .all(today) as DailyPnlRow[];

  const todayPnl = {
    utcDate: today,
    perStrategy: todayPnlRows,
    total: todayPnlRows.reduce(
      (acc, r) => {
        acc.realizedPnlUsd     += r.realized_pnl_usd ?? 0;
        acc.feesPaidUsd        += r.fees_paid_usd ?? 0;
        acc.rebatesReceivedUsd += r.rebates_received_usd ?? 0;
        acc.nTrades            += r.n_trades ?? 0;
        acc.nWins              += r.n_wins ?? 0;
        acc.nLosses            += r.n_losses ?? 0;
        acc.nRiskBlocks        += r.n_risk_blocks ?? 0;
        return acc;
      },
      {
        realizedPnlUsd: 0,
        feesPaidUsd: 0,
        rebatesReceivedUsd: 0,
        nTrades: 0,
        nWins: 0,
        nLosses: 0,
        nRiskBlocks: 0,
      },
    ),
  };

  const recentEvents = db
    .prepare(`
      SELECT id, timestamp_ns, created_at, strategy, market_slug, asset,
             timeframe, event_type, side, price, size_usd, order_id,
             outcome, realized_pnl_usd, risk_block_reason, is_dry_run
        FROM trade_events
       ORDER BY id DESC
       LIMIT ?
    `)
    .all(RECENT_EVENTS_LIMIT) as TradeEventRow[];

  const activeHalts = db
    .prepare(`SELECT * FROM v_active_halts ORDER BY halted_at_ns DESC`)
    .all() as RiskHaltRow[];

  const pendingCouncilProposals = db
    .prepare(`
      SELECT * FROM council_proposals
       WHERE status = 'pending'
       ORDER BY proposed_at_ns DESC
    `)
    .all() as CouncilProposalRow[];

  return {
    asOf: new Date().toISOString(),
    openPositions,
    todayPnl,
    recentEvents,
    activeHalts,
    pendingCouncilProposals,
  };
}

// Public for tests: bypass http to verify state shape directly.
export function getStateSnapshot(db: Database.Database) {
  return buildState(db);
}

export interface DashboardHandle {
  server: Server;
  url: string;
  close(): Promise<void>;
}

export function startDashboardEndpoint(cfg: DashboardEndpointConfig): Promise<DashboardHandle> {
  const port = cfg.port ?? Number(process.env.KNOXIS_DASHBOARD_PORT ?? DEFAULT_PORT);
  const host = cfg.host ?? process.env.KNOXIS_DASHBOARD_HOST ?? DEFAULT_HOST;

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (!req.url) {
      res.statusCode = 400;
      res.end('bad request');
      return;
    }

    // Basic routing — only one endpoint.
    const url = new URL(req.url, 'http://placeholder');
    if (req.method !== 'GET') {
      res.statusCode = 405;
      res.setHeader('Allow', 'GET');
      res.end('method not allowed');
      return;
    }

    if (url.pathname === '/state.json') {
      try {
        const body = JSON.stringify(buildState(cfg.db));
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Cache-Control', 'no-store');
        res.end(body);
      } catch (err) {
        logger.error({ err: (err as Error).message }, 'state.json build failed');
        res.statusCode = 500;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'state_build_failed' }));
      }
      return;
    }

    if (url.pathname === '/healthz') {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/plain');
      res.end('ok');
      return;
    }

    res.statusCode = 404;
    res.setHeader('Content-Type', 'text/plain');
    res.end('not found');
  });

  return new Promise<DashboardHandle>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const addr = server.address();
      const boundPort = typeof addr === 'object' && addr ? addr.port : port;
      const url = `http://${host}:${boundPort}`;
      logger.info({ url }, 'knoxis-dashboard endpoint listening');
      resolve({
        server,
        url,
        close: () => new Promise<void>((res) => server.close(() => res())),
      });
    });
  });
}
