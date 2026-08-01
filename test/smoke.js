// Smoke test: verify trade logging and P&L accounting using live prices with a
// forced entry, then simulated price moves through the real breed logic.
// Uses a scratch pet id so real state files stay clean.
import { petWallet } from "../src/wallet.js";
import { getSignal } from "../src/signals.js";
import { breeds } from "../src/breeds.js";
import { loadState, saveState, logTrade, openPosition, closePosition, markToMarket } from "../src/portfolio.js";

const pet = {
  id: "smoke-test", breed: "scalper", aggression: 0.2, patience: 0, capUsd: 500, maxDailyLossPct: 5,
  diet: [{ symbol: "AAPL", address: "0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9" }],
};

const { address, path } = petWallet(pet.id);
console.log("wallet:", address, path);

const token = pet.diet[0];
const sig = await getSignal(token);
if (!sig) throw new Error("no live signal for AAPL");
console.log("live signal:", sig.symbol, sig.priceUsd, "liq", sig.liquidityUsd);

const state = loadState(pet.id);
state.positions = {}; state.realizedPnlUsd = 0;

// Forced paper buy at live price.
const sizeUsd = pet.aggression * pet.capUsd;
openPosition(state, token, sizeUsd, sig.priceUsd);
logTrade(pet.id, { ts: new Date().toISOString(), mode: "paper", petId: pet.id, wallet: address, side: "buy", token: token.symbol, tokenAddress: token.address, sizeUsd, quotedPriceUsd: sig.priceUsd, pairAddress: sig.pairAddress, reason: "smoke test forced entry" });

// Simulate a +0.8% move; scalper should take profit.
const upPrice = sig.priceUsd * 1.008;
const fakeSig = { ...sig, priceUsd: upPrice };
const decision = breeds.scalper(pet, fakeSig, state.positions[token.address]);
console.log("breed decision at +0.8%:", decision);
if (decision?.side !== "sell") throw new Error("expected scalper sell at +0.8%");

const mtm = markToMarket(state, { [token.address]: upPrice });
console.log("mark to market before exit:", mtm.unrealizedUsd.toFixed(4), "USD");

const realized = closePosition(state, token.address, upPrice);
logTrade(pet.id, { ts: new Date().toISOString(), mode: "paper", petId: pet.id, wallet: address, side: "sell", token: token.symbol, tokenAddress: token.address, sizeUsd: +(sizeUsd * 1.008).toFixed(2), quotedPriceUsd: upPrice, realizedPnlUsd: +realized.toFixed(4), pairAddress: sig.pairAddress, reason: decision.reason });
saveState(state);
console.log("realized:", realized.toFixed(4), "USD; state saved. OK");
