# Limitless Active-Markets Catalog — 08/05/2026

Snapshot of `GET https://api.limitless.exchange/markets/active` taken from
staging on 08/05/2026, gathered for KNOXis Chat 22 Tile W4 (oracle-arb
filter widening recon, Pass 5).

Read-only inventory. No code changes in this tile.

## Top-line numbers

- Total active markets: **25**
- Dominant family: **`{ASSET}-up-or-down-{N}-{minutes|hour|day}-{ts}`** (Lumy auto-generated)
- One-off pattern: **`eth-price-on-may-8-0900-utc-...`** (manual, only 1 market)

## Slug patterns (by frequency)

| Count | Pattern                              | Example slug                                         | automationType |
|-------|--------------------------------------|------------------------------------------------------|----------------|
| 2     | `eth-up-or-down-N-mins-N`          | eth-up-or-down-5-mins-1778226995727                  | lumy           |
| 2     | `btc-up-or-down-N-mins-N`          | btc-up-or-down-5-mins-1778226990020                  | lumy           |
| 2     | `bnb-up-or-down-N-mins-N`          | bnb-up-or-down-5-mins-1778226997987                  | lumy           |
| 2     | `doge-up-or-down-N-mins-N`         | doge-up-or-down-5-mins-1778226996915                  | lumy           |
| 2     | `hype-up-or-down-N-mins-N`         | hype-up-or-down-5-mins-1778227003474                  | lumy           |
| 2     | `sol-up-or-down-N-mins-N`          | sol-up-or-down-5-mins-1778227830024                   | lumy           |
| 2     | `xrp-up-or-down-N-mins-N`          | xrp-up-or-down-5-mins-1778227835470                   | lumy           |
| 1     | `xag-up-or-down-N-hour-N`          | xag-up-or-down-1-hour-1778227326702                   | lumy           |
| 1     | `eth-price-on-may-N-N-utc-N`       | eth-price-on-may-8-0900-utc-1778227200172             | manual         |
| 1     | `nxpc-up-or-down-N-hour-N`         | nxpc-up-or-down-1-hour-1778227205823                  | lumy           |
| 1     | `gold-up-or-down-N-hour-N`         | gold-up-or-down-1-hour-1778227205153                  | lumy           |
| 1     | `xrp-up-or-down-N-hour-N`          | xrp-up-or-down-1-hour-1778227205887                   | lumy           |
| 1     | `btc-up-or-down-N-hour-N`          | btc-up-or-down-1-hour-1778227205888                   | lumy           |
| 1     | `doge-up-or-down-N-hour-N`         | doge-up-or-down-1-hour-1778227205889                  | lumy           |
| 1     | `sol-up-or-down-N-hour-N`          | sol-up-or-down-1-hour-1778227205742                   | lumy           |
| 1     | `eth-up-or-down-N-hour-N`          | eth-up-or-down-1-hour-1778227205706                   | lumy           |
| 1     | `xpt-up-or-down-N-hour-N`          | xpt-up-or-down-1-hour-1778227202032                   | lumy           |
| 1     | `hbar-up-or-down-N-day-N`          | hbar-up-or-down-1-day-1778144401668                   | lumy           |

## Title shape

All `up-or-down` markets have titles like:

- "BTC Up or Down - 5 mins"
- "ETH Up or Down - 1 hour"
- "HBAR Up or Down - 1 day"

The single manual market: "ETH price on May 8, 09:00 UTC?".

There is **no "above $X"** wording on any active market today. Strikes are
implicit ("up" = above current oracle price at expiry).

## Asset universe currently live

BTC, ETH, SOL, XRP, DOGE, BNB, HYPE, NXPC, XPT, XAG (silver), Gold, HBAR.

Of the oracle-arb config defaults (BTC/ETH/SOL), all three are present —
but only in `up-or-down` form, which the current strike-extraction
regexes do not recognise (see Q2/Q3 below).

## Timeframe distribution

- 5 mins: 14 markets
- 15 mins: (covered by same 5-mins pattern bucket — 2 each, see raw output)
- 1 hour: 9 markets (8 up-or-down + 1 manual eth-price-on)
- 1 day: 1 market (HBAR)

## Current oracle-arb selection logic (for reference, NOT changed in this tile)

`src/strategies/oracle-arb/index.ts:250`
```
const markets = await this.limitless.searchMarkets(asset, { limit: 50 });
```

`src/strategies/oracle-arb/index.ts:613-621` (strike extraction):
```
const match  = market.title?.match(/\0([\d.]+)\s+on/i);   // "...\5k on Friday"
const match2 = market.title?.match(/above\s+\0([\d.]+)/i); // "...above \5,000"
```

Neither regex matches "BTC Up or Down - 1 hour". So even though
`searchMarkets('BTC')` does return current BTC markets, the strategy
silently drops them at strike-parse time → 0 events. This matches the
Pass 4 result.

## Polymarket venue

`src/core/venues/polymarket.ts` does **not exist**. Only references to
Polymarket are comments in CTF/redeem helpers (Base-chain CTF reuses the
same protocol). There is no stub to be "throws-only" — the venue is
simply not wired.

## Tests

- Existing oracle-arb tests dir: none (`src/strategies/oracle-arb/__tests__/` does not exist).
- Sole test file in the repo: `src/strategies/maker-complement/__tests__/quote-engine.test.ts`.

## Recommendations for L2 (filter widening)

1. **Pivot oracle-arb from strike-based to direction-based**, since today's
   markets are "up vs down" rather than "above $X". The strike extraction
   path is dead until Limitless restores "above $X" markets.
2. If keeping a strike-style fallback, the only current candidate is the
   single `eth-price-on-may-N-N-utc-N` manual market — count on roughly
   1 such market live at a time.
3. Minimal slug filter that catches **≥80%** of current markets:
   `/^[a-z0-9]+-up-or-down-(\d+)-(mins?|minutes?|hour|day)-\d+$/`
   (covers all 24 of 25 active markets — 96%).
4. Asset whitelist for the existing BTC/ETH/SOL config still covers the
   highest-volume Lumy series; expanding to XRP/DOGE/BNB is cheap once
   the directional strategy lands.
