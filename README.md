# agent-pets

Virtual pets whose personality is a trading strategy. Each pet has its own EVM wallet
on Robinhood Chain (chainId 46896) and trades RH tokenized stocks. Phase 1 is paper
trade only: no transactions are ever sent, no keys are funded.

## Architecture

- `src/wallet.js` - derives one wallet per pet from a master BIP39 seed (MASTER_SEED env var),
  path `m/44'/60'/0'/0/<hash(petId)>`. Signers connect to the Robinhood Chain RPC but never sign.
- `src/signals.js` - price/volume signals for a pet's diet tokens from the dexscreener API,
  cached with a 60s floor so we never poll faster than once per minute per token.
- `src/breeds.js` - strategy per breed:
  - `momentum`: buy on positive 1h price plus volume move, 1.5% stop, 3% take profit.
  - `dipper`: buy a diet token down X% (default 3%) on 6h, hold for mean reversion, 6% hard stop.
  - `scalper`: quick in/out on 5m volatility, 0.5% stop / 0.6% target / timeout exit.
- `src/portfolio.js` - paper positions, mark to market per tick, realized and unrealized P&L,
  daily loss tracking. State persists to `state/<petId>.json`.
- `src/engine.js` - the tick loop. Risk rails: max position = aggression * capUsd, total
  exposure capped at capUsd, diet whitelist only, minimum $5k pair liquidity, and a daily
  loss cutoff (maxDailyLossPct of capUsd) that puts the pet to sleep until the next day
  (sleeping pets can close positions but not open new ones).
- Intended trades are appended to `trades/<petId>.jsonl`.

## Pet config schema (pets/*.json)

```json
{
  "id": "pixel",
  "name": "Pixel",
  "breed": "momentum | dipper | scalper",
  "live": true,
  "aggression": 0.2,
  "patience": 2,
  "capUsd": 500,
  "maxDailyLossPct": 5,
  "params": { "dipPct": -3 },
  "diet": [{ "symbol": "AAPL", "address": "0x..." }]
}
```

- `aggression` (0-1): position size as a fraction of capUsd.
- `patience`: minimum hold time in minutes before profit-taking exits.
- `diet`: whitelist of tokens the pet may trade. Nothing else, ever.

## Run paper mode

```
cp .env.example .env   # then set your own throwaway MASTER_SEED
node src/engine.js                 # loop forever, tick every TICK_MINUTES
node src/engine.js --once          # single tick
node --env-file=.env src/engine.js
```

## Phase 2 (real execution) will add

- Uniswap v3 router integration on Robinhood Chain: quoting via QuoterV2, exactInputSingle
  swaps with slippage limits, USDG as the quote asset.
- Funding flow and balance checks per pet wallet, gas management.
- Execution safety: tx simulation before send, nonce management, retry and revert handling,
  per-trade and per-day hard caps enforced on chain balances, kill switch.
- Better signals: candle history (dexscreener only gives point-in-time m5/h1/h6/h24 deltas),
  so phase 2 should record its own price series for real momentum and volatility measures.
- Slippage-aware sizing against pool liquidity, and accounting for the 24/5 tokenized
  stock market schedule (pairs go quiet on weekends).
