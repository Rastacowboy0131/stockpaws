# stockpaws

Virtual pets whose personality is a trading strategy. Each pet has its own EVM wallet
on Robinhood Chain (chainId 4663, RPC https://rpc.mainnet.chain.robinhood.com) and trades
RH tokenized stocks. Default mode is paper: no transactions are sent, no keys are funded.
Phase 3 adds a real execution layer, hard-gated behind EXECUTION_MODE=live plus a per-pet
liveTrading:true flag.

## Architecture

- `src/wallet.js` - derives one wallet per pet from a master BIP39 seed (MASTER_SEED env var),
  path `m/44'/60'/0'/0/<hash(petId)>`. Signers connect to the Robinhood Chain RPC but never sign.
- `src/signals.js` - price/volume signals for a pet's diet tokens from the dexscreener API,
  cached with a 60s floor so we never poll faster than once per minute per token.
- `src/breeds.js` - strategy per breed (names match the site characters one to one):
  - `scalper` (Waffles): quick in/out on 5m volatility, fee-aware: profit target is at least
    +1.5% (and always >= 1.8x the round-trip cost), stop widened proportionally, plus a
    min-volatility gate (no scalping pools that moved less than the round-trip cost in the
    last hour).
  - `guardian` (Scout): conservative defensive allocator. Big-cap diet bias, position sizes
    capped at HALF of aggression*cap, daily loss cutoff at HALF of maxDailyLossPct, high
    entry bar (steady h6/h24 uptrend with volume, not overheated), prefers holding (+5%
    target after a long minimum hold, exits only on hard stop or clear trend break).
  - `swing` (Moss, was `dipper`): buy a diet token down X% (default 3%) on 6h, hold for mean
    reversion, 6% hard stop.
  - `sniper` (Vix, was `momentum`): buy confirmed momentum (h1 >= 1.5% with volume and
    positive m5), never chases: refuses entries already extended more than 2% above the
    short-term baseline. 1.5% stop, 3% take profit.
  - Old names `dipper` and `momentum` are accepted as aliases and mapped automatically.
- `src/costs.js` - paper cost model: pool fee (default 30 bps per side, override per diet
  token via `feeBps`) plus slippage (default 0.1% per side, override per pet via
  `costSlippagePct`). Paper buys fill above quote, sells below, so paper P&L approximates
  live net P&L. Each state file records `costModelEnabledAt`.
- `src/portfolio.js` - paper positions, mark to market per tick, realized and unrealized P&L,
  daily loss tracking. State persists to `state/<petId>.json`.
- `src/engine.js` - the tick loop. Risk rails: max position = aggression * capUsd, total
  exposure capped at capUsd, diet whitelist only, minimum $5k pair liquidity, and a daily
  loss cutoff (maxDailyLossPct of capUsd) that puts the pet to sleep until the next day
  (sleeping pets can close positions but not open new ones).
- Intended trades are appended to `trades/<petId>.jsonl`.
- `src/tick.js` - one-shot tick runner for cron/heartbeat: evaluates all live pets once and exits.
  Skips if a tick already ran within the same minute (guard in `state/tick-lock.json`).
- `src/cli.js` - pet management: create-pet, list-pets, retire-pet.
- `src/feed.js` - formats trade log entries into short Discord-ready messages.
- `src/export-web.js` - dumps pets, P&L, and recent trades to `web/data.json` for the static site in `web/`.

## Pet config schema (pets/*.json)

```json
{
  "id": "pixel",
  "name": "Pixel",
  "breed": "scalper | guardian | swing | sniper",
  "live": true,
  "liveTrading": false,
  "funder": "0xYourWalletThatFundedThePet",
  "slippagePct": 1,
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
node --env-file=.env src/tick.js       # single tick, cron-friendly
node --env-file=.env src/engine.js     # loop forever, tick every TICK_MINUTES
node --env-file=.env src/engine.js --once
```

## Pet management

```
node --env-file=.env src/cli.js create-pet --name Waffles --breed scalper --aggression 0.15 --patience 2 --cap 300 --diet AAPL,TSLA
node --env-file=.env src/cli.js list-pets
node --env-file=.env src/cli.js retire-pet waffles
```

## Trade feed

```
node src/feed.js --since 2026-08-01T00:00:00Z   # or omit --since to use the saved cursor
```

Prints Discord-ready lines for new trades and advances `state/feed-cursor.json`.

## Web dashboard

```
node --env-file=.env src/export-web.js   # writes web/data.json
cd web && python3 -m http.server 8080    # or any static server
```

## Live execution layer (phase 3)

- `src/execution.js` - real Uniswap V3 swaps on Robinhood Chain. Verified addresses
  (all confirmed onchain, router.factory() and quoter.factory() match):
  - SwapRouter02 `0xCaf681a66D020601342297493863E78C959E5cb2` (NOTE: SwapRouter02, so
    exactInputSingle has no deadline field; deadlines go through `multicall(deadline, data)`)
  - Factory `0x1f7d7550B1b028f7571E69A784071F0205FD2EfA`
  - QuoterV2 `0x0269F8b86bB3C1e927DaCEDb72f3463Ef6D26F61`
  - WETH9 `0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73`
  - USDG `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168` (6 decimals, used for ETH/USD pricing)
- Buy path: size in USD -> ETH via the WETH/USDG 500bps pool -> wrap ETH keeping a gas
  reserve -> quote through QuoterV2 across fee tiers 100/500/3000/10000 picking the best
  output -> exactInputSingle with a slippage-guarded minimum out (default 1%, per-pet
  `slippagePct`) -> wait for receipt, log tx hash.
- Sell path: reads the LIVE token balance right before the swap. Stock tokens share a
  rebasing implementation (stock splits change balances), so quantities are never cached.
- Risk rails enforced inside `executeTrade` itself, independent of the strategy layer:
  diet whitelist checked against the actual token address, max trade size
  (aggression * capUsd), $5k pool liquidity floor from the signal layer, and the daily
  loss cutoff (sleeping pets cannot buy).
- `src/withdraw.js` - withdraw-all: sells every open position to WETH, unwraps, sends all
  ETH to the pet's recorded `funder` address. There is no destination override; if the pet
  JSON has no valid `funder`, the withdrawal is refused.
- Feed messages for live trades include the Blockscout tx link
  (`https://robinhoodchain.blockscout.com/tx/<hash>`).

## Fork tests

```
./test/fork.sh    # starts an anvil fork of RH mainnet and runs test/fork.test.js
```

Proves on a fork: wrap ETH, live buy AAPL (balance increases), all four risk rails plus
the liveTrading gate refuse correctly, live sell back to WETH, withdraw-all reaches the
funder. Needs a working anvil; on old glibc hosts use the musl build
(`foundry_stable_alpine_amd64.tar.gz`) and point `ANVIL_BIN` at it. No real transactions
are ever sent by the tests.

## Go-live procedure (real money)

Read this whole section before funding anything.

**Custody warning:** pet wallets are derived from `MASTER_SEED`. Whoever holds that seed
phrase holds every pet's funds. Treat the production seed like a hot-wallet key: generate
it fresh (never reuse the dev/test seed), store it only in the production `.env` (mode 600)
plus one offline backup, and never commit it. This is experimental software trading thin
onchain stock-token pools; assume the entire balance can be lost.

1. Set a fresh `MASTER_SEED` in the production `.env`. Confirm `RPC_URL` is
   `https://rpc.mainnet.chain.robinhood.com` (the `rpc.robinhoodchain.com` host fails TLS).
2. Create the pet with a funder recorded:
   `node --env-file=.env src/cli.js create-pet --name Waffles --breed scalper --cap 150 --funder 0xYourWallet`
   The funder is the ONLY address withdrawals can ever go to.
3. Send a small amount of ETH to the pet's wallet address (printed at creation, also in
   list-pets). Recommended at launch: $100 to $200 per pet, no more. Keep `capUsd` at or
   below what you funded.
4. Flip the switches: set `"liveTrading": true` in `pets/<id>.json` and `EXECUTION_MODE=live`
   in the environment the tick runner uses. Both are required; either one missing means
   paper mode.
5. The tick runner (`src/tick.js` on cron, or `src/engine.js`) now routes that pet's
   decisions through the live execution path. Watch the feed and
   `trades/<id>.jsonl` for tx hashes; every live trade links to Blockscout.
6. To pull funds out: `node --env-file=.env src/withdraw.js <petId>` liquidates everything
   and sends the ETH to the recorded funder.

Kill switch: unset `EXECUTION_MODE` (or set anything other than `live`) and every pet
instantly reverts to paper, no matter what the pet files say.
