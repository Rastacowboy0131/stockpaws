# Known Issues

Findings from the 2026-07-31 full audit that were deliberately deferred (too big
or not blocking for paper mode). Severity: HIGH blocks live money, MED should
be fixed before scaling, LOW is cosmetic/hardening.

## Engine (paper)

- FIXED (2026-08-01) `portfolio.js` paper P&L used to model zero fees and zero
  slippage. The engine now applies a cost model per side (pool fee, default
  30 bps, plus slippage, default 0.1%) to every paper fill, and the scalper
  target was raised to clear round-trip costs with margin.
- FIXED (2026-08-01, audit 2) Stale price detection added in `signals.js`: pairs
  with zero h1 transactions AND zero h1 volume are rejected before any breed
  sees them (confirmed live: caught a frozen COIN pair on the first tick).
- LOW No market-hours model. Tokenized stocks trade thin overnight/weekends;
  liquidity floor catches the worst of it but a time-of-day guard would help.
- LOW `tick.js` writes the minute lock before running the tick; a crash
  mid-tick burns that minute (next run in the same minute skips). Acceptable
  since state saves are now atomic and per-trade.
- LOW Daily loss cutoff uses UTC dates (`toISOString().slice(0,10)`), so the
  "day" rolls at 00:00 UTC, not US market midnight. Consistent but worth
  knowing.

## Execution (live path)

- MED `executeTrade` buy path: quote and swap happen inside
  `swapExactInputSingle` via `bestFeeTier` immediately before the swap, so the
  quote-to-swap gap is one RPC round trip. A rebase in that window on the BUY
  side is harmless (amountIn is WETH, not the rebasing token). SELL side is
  now retried with a fresh balance re-read (fixed in this audit), but a rebase
  landing between the retry read and the swap can still revert; the trade
  fails safe (position stays open, next tick retries).
- FIXED (2026-08-01, audit 2) Gas price cap: `gasOverrides()` in execution.js
  asserts the RPC-suggested gas price is under MAX_GAS_GWEI (default 10 gwei,
  env-overridable) and passes explicit fee overrides on every write tx
  (deposit, approve, swap, unwrap; withdraw send asserts the cap too). Fork
  suite still 12/12 after the change.
- MED No two-hop routing through USDG. Some stock tokens may only have deep
  liquidity against USDG, not WETH; `bestFeeTier` only considers direct
  tokenIn->tokenOut pools, so those tokens are untradeable (trade refuses
  safely with "no usable pool"). Documented, intentionally not built yet:
  adds quote complexity and a second pool's fees/slippage.
- LOW `ensureWeth` gas reserve is a constant 0.002 ETH; on gas spikes this may
  be too thin for approve+swap+unwrap sequences.
- LOW Approvals are infinite (MaxUint256) to the router. Standard practice,
  but a compromised router upgrade would have unlimited pull. Router here is
  not upgradeable per bytecode check at deploy time, so accepted.

## Web (secondary)

- MED `web/api/state.js` signature replay: a captured signed message is valid
  for its full 7-day window from ANY client (no nonce, no binding to origin).
  Anyone who intercepts one request can read/overwrite/wipe that wallet's paw
  state for up to 7 days. Mitigation: shrink SESSION_MAX_AGE_MS, or add a
  server-issued nonce challenge. Requires client changes; deferred.
- FIXED (2026-08-01, audit 2) Stored XSS hardening in `web/js/app.js`: trade
  rows loaded from cloud/local state (`t.tk`, `t.side`, `t.qty`, `t.px`) are
  now HTML-escaped before innerHTML, and restored state is sanitized (unknown
  pet ids fall back to default, non-array trades dropped). Relevant because a
  replayed session could write hostile JSON to a victim's state row.
- FIXED (2026-08-01, audit 2) `web/js/wallet.js` wallet picker built provider
  name/icon from EIP-6963 announcements via innerHTML; a malicious extension
  could inject markup. Now DOM-built with textContent.
- FIXED (2026-08-01, audit 2) `web/api/state.js` 500 responses echoed raw DB
  error messages (`detail: e.message`), which can leak host/connection info.
  Now logged server-side only.
- LOW CORS is `*`. Fine for a public toy API; revisit if the payload ever
  holds anything sensitive.
- FIXED (2026-08-01, prior pass) `ensureTable` no longer caches failures;
  transient DB errors at cold start retry on the next request.

## Ops

- HIGH (process, not code) The dev MASTER_SEED in `.env.example` is public in
  git history. Fine because it must never be funded, but the go-live procedure
  in README (generate a fresh seed) is mandatory, not optional.
