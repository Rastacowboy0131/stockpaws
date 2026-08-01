// Export pets, P&L, and recent trades to web/data.json for the static dashboard.
import fs from "node:fs";
import path from "node:path";
import { petWallet } from "./wallet.js";
import { loadState, markToMarket } from "./portfolio.js";
import { resolveBreed } from "./breeds.js";

const PETS_DIR = "pets";
const TRADES_DIR = "trades";
const OUT = path.join("web", "data.json");

function lastTrades(petId, n = 20) {
  const file = path.join(TRADES_DIR, `${petId}.jsonl`);
  if (!fs.existsSync(file)) return [];
  const lines = fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean);
  return lines.slice(-n).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean).reverse();
}

// Mood from recent P&L: happy / neutral / sulking / sleeping.
function mood(state, dayPnl) {
  if (state.sleeping) return "sleeping";
  if (dayPnl > 0.5) return "happy";
  if (dayPnl < -0.5) return "sulking";
  return "neutral";
}

const pets = fs.readdirSync(PETS_DIR)
  .filter(f => f.endsWith(".json"))
  .map(f => JSON.parse(fs.readFileSync(path.join(PETS_DIR, f), "utf8")));

const out = { generatedAt: new Date().toISOString(), chain: "robinhood", pets: [] };

for (const pet of pets) {
  const state = loadState(pet.id);
  let address = null;
  try { address = petWallet(pet.id).address; } catch {}
  const marks = state.lastTick?.marks || {};
  const priceByAddress = Object.fromEntries(Object.entries(marks).map(([a, m]) => [a, m.price]));
  const { unrealizedUsd } = markToMarket(state, priceByAddress);
  const dayPnl = state.dailyPnl.realizedUsd + unrealizedUsd;
  out.pets.push({
    id: pet.id,
    name: pet.name,
    breed: resolveBreed(pet.breed) || pet.breed,
    live: pet.live !== false,
    wallet: address,
    capUsd: pet.capUsd,
    balanceUsd: +(pet.capUsd + state.realizedPnlUsd + unrealizedUsd).toFixed(2),
    realizedPnlUsd: +state.realizedPnlUsd.toFixed(2),
    unrealizedPnlUsd: +unrealizedUsd.toFixed(2),
    dayPnlUsd: +dayPnl.toFixed(2),
    mood: pet.live === false ? "sleeping" : mood(state, dayPnl),
    openPositions: Object.values(state.positions),
    lastTickAt: state.lastTick?.at || null,
    trades: lastTrades(pet.id),
  });
}

fs.mkdirSync("web", { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
console.log(`wrote ${OUT}: ${out.pets.length} pet(s)`);
