// Engine loop: tick every N minutes, evaluate each live pet, apply risk rails,
// and in paper mode log intended trades instead of executing.
import fs from "node:fs";
import path from "node:path";
import { petWallet } from "./wallet.js";
import { getSignal } from "./signals.js";
import { breeds } from "./breeds.js";
import { loadState, saveState, logTrade, rollDay, openPosition, closePosition, markToMarket } from "./portfolio.js";
import { isLive, executeTrade } from "./execution.js";

const PETS_DIR = "pets";
const MIN_LIQUIDITY_USD = 5000; // do not paper-trade into puddles

function loadPets() {
  return fs.readdirSync(PETS_DIR)
    .filter(f => f.endsWith(".json"))
    .map(f => JSON.parse(fs.readFileSync(path.join(PETS_DIR, f), "utf8")))
    .filter(p => p.live !== false);
}

async function tickPet(pet) {
  const { address } = petWallet(pet.id);
  const state = loadState(pet.id);
  rollDay(state);

  const strategy = breeds[pet.breed];
  if (!strategy) {
    console.error(`[${pet.id}] unknown breed ${pet.breed}, skipping`);
    return;
  }

  // Gather signals for diet tokens (whitelist only).
  const priceByAddress = {};
  const signals = [];
  for (const token of pet.diet) {
    const sig = await getSignal(token);
    if (sig) {
      signals.push({ token, sig });
      priceByAddress[token.address.toLowerCase()] = sig.priceUsd;
      priceByAddress[token.address] = sig.priceUsd;
    }
  }

  // Daily loss cutoff: pet sleeps for the rest of the day.
  const { unrealizedUsd } = markToMarket(state, priceByAddress);
  const dayPnl = state.dailyPnl.realizedUsd + unrealizedUsd;
  const maxLossUsd = -(pet.maxDailyLossPct / 100) * pet.capUsd;
  if (!state.sleeping && dayPnl <= maxLossUsd) {
    state.sleeping = true;
    console.log(`[${pet.id}] daily loss cutoff hit (${dayPnl.toFixed(2)} USD), pet is sleeping`);
  }

  for (const { token, sig } of signals) {
    const pos = state.positions[token.address] || null;
    const decision = strategy(pet, sig, pos);
    if (!decision) continue;

    if (decision.side === "buy") {
      if (state.sleeping) continue; // sleeping pets may still close, never open
      if (pos) continue; // one position per token
      if (sig.liquidityUsd < MIN_LIQUIDITY_USD) continue;
      const openExposure = Object.values(state.positions).reduce((s, p) => s + p.sizeUsd, 0);
      const sizeUsd = Math.min(pet.aggression * pet.capUsd, pet.capUsd - openExposure);
      if (sizeUsd < 1) continue;
      if (isLive(pet)) {
        // LIVE PATH: execution.js re-checks all risk rails and sends the swap.
        try {
          const entry = await executeTrade({ pet, side: "buy", token, sizeUsd, signal: sig, reason: decision.reason });
          openPosition(state, token, sizeUsd, sig.priceUsd);
          console.log(`[${pet.id}] LIVE BUY ${token.symbol} $${entry.sizeUsd} tx=${entry.txHash} :: ${decision.reason}`);
        } catch (e) {
          console.error(`[${pet.id}] live buy refused/failed: ${e.message}`);
        }
        continue;
      }
      openPosition(state, token, sizeUsd, sig.priceUsd);
      const entry = {
        ts: new Date().toISOString(), mode: "paper", petId: pet.id, wallet: address,
        side: "buy", token: token.symbol, tokenAddress: token.address,
        sizeUsd: +sizeUsd.toFixed(2), quotedPriceUsd: sig.priceUsd,
        pairAddress: sig.pairAddress, reason: decision.reason,
      };
      logTrade(pet.id, entry);
      saveState(state); // persist immediately so a crash mid-tick cannot desync log vs state
      console.log(`[${pet.id}] PAPER BUY ${token.symbol} $${entry.sizeUsd} @ ${sig.priceUsd} :: ${decision.reason}`);
    } else if (decision.side === "sell" && pos) {
      if (isLive(pet)) {
        try {
          const entry = await executeTrade({ pet, side: "sell", token, signal: sig, reason: decision.reason });
          const realized = closePosition(state, token.address, sig.priceUsd);
          console.log(`[${pet.id}] LIVE SELL ${token.symbol} tx=${entry.txHash} pnl=${realized.toFixed(4)} :: ${decision.reason}`);
        } catch (e) {
          console.error(`[${pet.id}] live sell refused/failed: ${e.message}`);
        }
        continue;
      }
      const realized = closePosition(state, token.address, sig.priceUsd);
      const entry = {
        ts: new Date().toISOString(), mode: "paper", petId: pet.id, wallet: address,
        side: "sell", token: token.symbol, tokenAddress: token.address,
        sizeUsd: +(pos.qty * sig.priceUsd).toFixed(2), quotedPriceUsd: sig.priceUsd,
        realizedPnlUsd: +realized.toFixed(4), pairAddress: sig.pairAddress, reason: decision.reason,
      };
      logTrade(pet.id, entry);
      saveState(state); // persist immediately so a crash mid-tick cannot desync log vs state
      console.log(`[${pet.id}] PAPER SELL ${token.symbol} @ ${sig.priceUsd} pnl=${realized.toFixed(4)} :: ${decision.reason}`);
    }
  }

  const mtm = markToMarket(state, priceByAddress);
  state.lastTick = {
    at: new Date().toISOString(),
    unrealizedUsd: +mtm.unrealizedUsd.toFixed(4),
    realizedUsd: +state.realizedPnlUsd.toFixed(4),
    openPositions: Object.keys(state.positions).length,
    marks: mtm.marks,
  };
  saveState(state);
  console.log(`[${pet.id}] tick done: open=${state.lastTick.openPositions} realized=$${state.lastTick.realizedUsd} unrealized=$${state.lastTick.unrealizedUsd}${state.sleeping ? " (sleeping)" : ""}`);
}

async function tick() {
  const pets = loadPets();
  console.log(`--- tick ${new Date().toISOString()} :: ${pets.length} pet(s) ---`);
  for (const pet of pets) {
    try { await tickPet(pet); } catch (e) { console.error(`[${pet.id}] tick error: ${e.message}`); }
  }
}

export { tick, loadPets };

const isMain = process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1])) && process.argv[1].endsWith("engine.js");
if (isMain) {
  const intervalMin = parseFloat(process.env.TICK_MINUTES || "5");
  const once = process.argv.includes("--once");
  const ticks = process.argv.includes("--ticks") ? parseInt(process.argv[process.argv.indexOf("--ticks") + 1], 10) : null;

  console.log(`stockpaws engine, PAPER MODE, tick every ${intervalMin} min`);
  await tick();
  if (!once) {
    let count = 1;
    const timer = setInterval(async () => {
      await tick();
      count++;
      if (ticks && count >= ticks) { clearInterval(timer); console.log("done"); }
    }, intervalMin * 60_000);
  }
}
