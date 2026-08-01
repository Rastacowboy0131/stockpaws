# 🐾 STOCKPAWS

Pet agents that hunt Robinhood Chain stock tokens. Cartoon Playground edition.
Static frontend + one Vercel serverless function for per-wallet cloud saves.

## Folder structure

```
stockpaws/
├── index.html            # the whole site (single page)
├── css/style.css         # Cartoon Playground theme
├── js/
│   ├── wallet.js         # connect, sessions, watch-only block, disconnect
│   └── app.js            # desk game, per-wallet saves, tickers ← CONFIG here
├── api/
│   └── state.js          # serverless: signature-verified Postgres saves
├── package.json          # ethers + pg (used by api/state.js on the server)
├── .env.example          # env vars you set in Vercel
├── assets/               # logo, favicons, transparent pet poses
└── README.md
```

## ⚙️ 1. Replace the placeholders

Open **`js/app.js`** — CONFIG block at the top:

```js
const CONFIG = {
  CONTRACT_ADDRESS: "0xYOUR_TOKEN_CONTRACT_ADDRESS",
  BUY_LINK: "https://YOUR_BUY_LINK_HERE",
  X_LINK: "https://x.com/YOUR_X_HANDLE",
  TELEGRAM_LINK: "https://t.me/YOUR_TELEGRAM",
};
```

## 🗄️ 2. Postgres (per-wallet cloud saves)

Any Postgres works (we use Railway). In Vercel → your project →
Settings → Environment Variables, add:

```
DATABASE_URL=postgresql://user:password@host:port/dbname
```

(`.env.example` shows the same. The connection string never appears in
frontend code — only `api/state.js` reads it on the server.)

No manual SQL needed: `api/state.js` creates the `paw_states` table on
first request.

> **No database yet? Fine.** The site detects the missing config and quietly
> falls back to per-browser localStorage. You can deploy today and add
> the database later with zero code changes.

## ▶️ 3. Run locally

```bash
# full stack (frontend + /api function) — needs vercel CLI
vercel dev

# frontend only (cloud saves fall back to local cache)
python -m http.server 3000
```

## 🚀 4. Deploy

```bash
vercel --prod
```

Vercel auto-installs `ethers` and `pg` for the api function from package.json.
After adding env vars, redeploy once so the function picks them up.

## 👛 Wallet system

- **Detection** — EIP-6963 discovery: MetaMask, Trust, Phantom, Coinbase,
  Rabby, OKX… any injected EVM wallet, desktop + mobile in-app browsers.
  Legacy `window.ethereum` fallback. No wallet in a mobile browser? The modal
  shows deep links that reopen the site inside the wallet's own browser.
- **Network** — auto switch/add Robinhood Chain (4663), official RPC.
- **Watch-only blocked** — connecting requires a free `personal_sign`.
  Watch-only wallets can't sign → they can never finish connecting.
- **Sessions persist** — the signed proof is stored on the device, so closing
  the site, reloading, or opening a new tab keeps you connected for up to
  7 days without re-signing. Tabs stay in sync (log out in one, all lock).
- **Disconnect = logout** — tap your address (top right) → Disconnect. The
  session is wiped, the desk resets to a locked state, trades show
  "🔒 Connect wallet to view your hunts", and nothing saves until the wallet
  signs in again.
- **Per-wallet data** — every wallet address gets its own pet state: cached
  locally per-address AND synced to Postgres through `/api/state`, which
  verifies the wallet signature on every request (so only the real owner can
  read/write their row). Connect the same wallet on another device and your
  pet follows you.

## 🎮 The desk

Feed / Praise / Scold / Scan / Approve / Veto all require a connected wallet.
Proposals and P&L are labeled **SIM** until your vault contracts ship — wire
real hunts into `scan()` in `js/app.js` when ready.

---

STOCKPAWS — original brand. Not affiliated with Robinhood Markets, Inc. NFA. DYOR.
