# Known Issues

Findings from the 2026-07-31 full audit that were deliberately deferred (too big
or not blocking for paper mode). Severity: HIGH blocks live money, MED should
be fixed before scaling, LOW is cosmetic/hardening.

## Engine (paper)

- FIXED (2026-08-01) `portfolio.js` paper P&L used to model zero fees and zero
  slippage. The engine now applies a cost model per side (pool fee, default
  30 bps, plus slippage, default 0.1%) to every paper fill, and the scalper
  target was raised to clear round-trip costs with margin.
- MED No stale price detection. A dexscreener pair with no trades for hours
  still returns its last price; breeds will happily "trade" against it. Add a
  freshness check (e.g. require txns.h1 > 0 or reject pairs whose h24 volume
  is 0).
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
- MED Gas price is left to ethers defaults; no maxFeePerGas cap. A hostile or
  glitching RPC could suggest an absurd gas price. Add a sanity cap before
  live use.
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
- LOW CORS is `*`. Fine for a public toy API; revisit if the payload ever
  holds anything sensitive.
- LOW `ensureTable` result is cached even on failure; a transient DB error at
  cold start wedges the function until redeploy. Reset `tableReady` on catch.

## Ops

- HIGH (process, not code) The dev MASTER_SEED in `.env.example` is public in
  git history. Fine because it must never be funded, but the go-live procedure
  in README (generate a fresh seed) is mandatory, not optional.
