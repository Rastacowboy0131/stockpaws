// Seed demo trades for the web grid: uses live prices for entries, small simulated
// exits, all through the real portfolio accounting. Paper mode, clearly reasoned as demo.
import { getSignal } from "../src/signals.js";
import { loadState, saveState, logTrade, openPosition, closePosition, markToMarket } from "../src/portfolio.js";
import { petWallet } from "../src/wallet.js";

const AAPL = { symbol: "AAPL", address: "0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9" };
const TSLA = { symbol: "TSLA", address: "0x322F0929c4625eD5bAd873c95208D54E1c003b2d" };
const MSFT = { symbol: "MSFT", address: "0xe93237C50D904957Cf27E7B1133b510C669c2e74" };

const sigs = {};
for (const t of [AAPL, TSLA, MSFT]) sigs[t.symbol] = await getSignal(t);

function trade(petId, token, sizeUsd, movePct, holdOpen = false) {
  const sig = sigs[token.symbol];
  if (!sig) return console.error(`no signal for ${token.symbol}`);
  const { address } = petWallet(petId);
  const state = loadState(petId);
  const entryPrice = sig.priceUsd;
  openPosition(state, token, sizeUsd, entryPrice);
  logTrade(petId, {
    ts: new Date().toISOString(), mode: "paper", petId, wallet: address,
    side: "buy", token: token.symbol, tokenAddress: token.address,
    sizeUsd, quotedPriceUsd: entryPrice, pairAddress: sig.pairAddress,
    reason: "demo seed entry",
  });
  if (!holdOpen) {
    const exitPrice = entryPrice * (1 + movePct / 100);
    const qty = state.positions[token.address].qty;
    const realized = closePosition(state, token.address, exitPrice);
    logTrade(petId, {
      ts: new Date().toISOString(), mode: "paper", petId, wallet: address,
      side: "sell", token: token.symbol, tokenAddress: token.address,
      sizeUsd: +(qty * exitPrice).toFixed(2), quotedPriceUsd: +exitPrice.toFixed(4),
      realizedPnlUsd: +realized.toFixed(4), pairAddress: sig.pairAddress,
      reason: movePct >= 0 ? `demo seed exit: +${movePct}%` : `demo seed exit: ${movePct}%`,
    });
  } else {
    // record a mark so mark-to-market has a price
    const mtm = markToMarket(state, { [token.address]: entryPrice, [token.address.toLowerCase()]: entryPrice });
    state.lastTick = { at: new Date().toISOString(), unrealizedUsd: 0, realizedUsd: +state.realizedPnlUsd.toFixed(4), openPositions: Object.keys(state.positions).length, marks: mtm.marks };
  }
  saveState(state);
  console.log(`seeded ${petId}: ${token.symbol} ${holdOpen ? "open position" : `${movePct}% round trip`}`);
}

trade("waffles", AAPL, 45, 1.6);
trade("waffles", TSLA, 45, -0.5);
trade("moss", MSFT, 120, 2.1);
trade("moss", AAPL, 120, 0, true);
trade("vix", TSLA, 150, 3.05);
trade("scout", MSFT, 50, 1.2);
