# 08/05/2026 — Hermes SSE 404 finding from chat-22 W5: NOT reproducible

## Summary
Chat-22 W5 60s DRY_RUN soak reported "every Hermes SSE connect returns
HTTP 404". Chat-23 W3 probe (7 variants × 3 assets, single + multi,
no-prefix + 0x-prefix) returned 200 across the board. SSE actively
streamed 8 BTC price frames in 4s.

## Likely original cause
src/core/price-feeds/hermes.ts:106 eventSource.onerror fires on any
transport-level failure (DNS, TLS, body-parse, transient network). The
chat-22 worker most likely read "error event fired" as "404" without
checking the actual HTTP status code.

## Real symptom worth investigating
The chat-22 soak's decisions=0/positions=0/traded=0 outcome is consistent
with a healthy Hermes + tight strategy thresholds + no in-window markets,
NOT with Hermes failing.

## Recommended hardening (deferred to W6 backlog item N)
Add an onerror handler that distinguishes 404 from generic transport
errors so future investigations get the actual HTTP code. ~5 LoC.

## What did NOT change
- No code touched
- No fix applied
- No PR opened against src/

This audit is the only artifact.
