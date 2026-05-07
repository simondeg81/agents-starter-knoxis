// W5 — Telegram integration. Subscribes to the event bus and posts
// human-readable messages to a Telegram chat via the Bot API.
//
// Configuration via env:
//   TELEGRAM_BOT_TOKEN  — required to enable
//   TELEGRAM_CHAT_ID    — required to enable
//   TELEGRAM_ENABLED    — optional; if set to 'false' explicitly, force off
//
// If either token or chat id is missing, attach() is a no-op (DRY_RUN
// paper-mode default behaviour). No outbound calls happen until both are set.

import { pino } from 'pino';
import type {
  TypedEventBus,
  StrategyFillEvent,
  RiskHaltEvent,
  CouncilProposalEvent,
} from '../observability/event-bus.js';

const logger = pino({ level: process.env.LOG_LEVEL || 'info', name: 'telegram' });

export interface TelegramConfig {
  botToken: string;
  chatId: string;
  apiBase?: string; // override for tests
  // Default: only send fills on the real-money path (is_dry_run=false).
  // Set sendDryRun=true to also relay paper fills.
  sendDryRun?: boolean;
}

function readConfig(): TelegramConfig | null {
  const enabled = process.env.TELEGRAM_ENABLED;
  if (enabled === 'false' || enabled === '0') return null;

  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId   = process.env.TELEGRAM_CHAT_ID;
  if (!botToken || !chatId) return null;

  return {
    botToken,
    chatId,
    apiBase: process.env.TELEGRAM_API_BASE || 'https://api.telegram.org',
    sendDryRun: process.env.TELEGRAM_SEND_DRY_RUN === 'true',
  };
}

async function postMessage(cfg: TelegramConfig, text: string): Promise<void> {
  const url = `${cfg.apiBase}/bot${cfg.botToken}/sendMessage`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: cfg.chatId,
        text,
        disable_web_page_preview: true,
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      logger.warn({ status: res.status, body: body.slice(0, 200) }, 'telegram send failed');
    }
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'telegram send threw');
  }
}

function fmtFill(e: StrategyFillEvent): string {
  return [
    'FILL: ' + e.strategy,
    '  asset=' + e.asset + ' tf=' + e.timeframe,
    '  price=' + e.price.toFixed(4),
    '  size=$' + e.sizeUsd.toFixed(2),
    '  market=' + e.marketSlug,
    '  order=' + e.orderId,
  ].join('\n');
}

function fmtHalt(e: RiskHaltEvent): string {
  const detailsLine = e.details ? '\n  details=' + JSON.stringify(e.details) : '';
  return 'HALT: ' + e.reason + detailsLine;
}

function fmtProposal(e: CouncilProposalEvent): string {
  return [
    'COUNCIL: ' + e.parameter,
    '  ' + e.currentValue + ' -> ' + e.proposedValue,
    '  reasoning: ' + e.reasoning,
    '  Approve? Reply YES/NO',
  ].join('\n');
}

export interface TelegramHandle {
  detach(): void;
  /** Returns true if config is present and the integration is wired. */
  isActive(): boolean;
}

/**
 * Attach the Telegram integration to the given bus. If env config is
 * missing this returns a no-op handle (matching the DRY_RUN default).
 *
 * @param bus the event bus to subscribe on
 * @param overrideConfig optional config override (useful in tests)
 */
export function attachTelegram(
  bus: TypedEventBus,
  overrideConfig?: TelegramConfig | null,
): TelegramHandle {
  const cfg = overrideConfig === undefined ? readConfig() : overrideConfig;
  if (!cfg) {
    logger.info('TELEGRAM_BOT_TOKEN/CHAT_ID not set — telegram integration inactive');
    return { detach() { /* noop */ }, isActive() { return false; } };
  }

  const onFill = (e: StrategyFillEvent) => {
    if (e.isDryRun && !cfg.sendDryRun) return;
    void postMessage(cfg, fmtFill(e));
  };
  const onHalt = (e: RiskHaltEvent) => {
    void postMessage(cfg, fmtHalt(e));
  };
  const onProposal = (e: CouncilProposalEvent) => {
    void postMessage(cfg, fmtProposal(e));
  };

  bus.on('strategy.fill', onFill);
  bus.on('risk.halt', onHalt);
  bus.on('council.proposal', onProposal);

  logger.info('telegram integration attached');

  return {
    detach() {
      bus.off('strategy.fill', onFill);
      bus.off('risk.halt', onHalt);
      bus.off('council.proposal', onProposal);
    },
    isActive() {
      return true;
    },
  };
}

// Exported for tests so they can format without a live bot.
export const _internals = { fmtFill, fmtHalt, fmtProposal };
