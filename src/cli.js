// stockpaws pet management CLI.
// Commands: create-pet, list-pets, retire-pet. Configs live as JSON in pets/.
import fs from "node:fs";
import path from "node:path";
import { petWallet } from "./wallet.js";
import { loadState, markToMarket } from "./portfolio.js";
import { BREED_NAMES, resolveBreed } from "./breeds.js";

const PETS_DIR = "pets";

// Known Robinhood Chain stock token addresses for diet shorthand.
// Addresses verified against the most liquid robinhood-chain pair on dexscreener.
const KNOWN_TOKENS = {
  AAPL: "0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9",
  TSLA: "0x322F0929c4625eD5bAd873c95208D54E1c003b2d",
  MSFT: "0xe93237C50D904957Cf27E7B1133b510C669c2e74",
  NVDA: "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC",
  SPY: "0x117cc2133c37B721F49dE2A7a74833232B3B4C0C",
  QQQ: "0xD5f3879160bc7c32ebb4dC785F8a4F505888de68",
  GOOGL: "0x2e0847E8910a9732eB3fb1bb4b70a580ADAD4FE3",
  AMZN: "0x12f190a9F9d7D37a250758b26824B97CE941bF54",
  AMD: "0x86923f96303D656E4aa86D9d42D1e57ad2023fdC",
  COIN: "0x6330D8C3178a418788dF01a47479c0ce7CCF450b",
};

function parseFlags(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) {
      const key = argv[i].slice(2);
      const val = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : true;
      flags[key] = val;
    }
  }
  return flags;
}

function petFile(id) {
  return path.join(PETS_DIR, `${id}.json`);
}

function loadPets() {
  if (!fs.existsSync(PETS_DIR)) return [];
  return fs.readdirSync(PETS_DIR)
    .filter(f => f.endsWith(".json"))
    .map(f => JSON.parse(fs.readFileSync(path.join(PETS_DIR, f), "utf8")));
}

function createPet(flags) {
  const name = flags.name;
  const breed = resolveBreed(flags.breed);
  if (!name || !flags.breed) {
    console.error("usage: cli.js create-pet --name Waffles --breed scalper [--aggression 0.2] [--patience 2] [--cap 500] [--diet AAPL,TSLA]");
    process.exit(1);
  }
  if (!breed) {
    console.error(`unknown breed "${flags.breed}" (${BREED_NAMES.join(" | ")})`);
    process.exit(1);
  }
  const id = name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  if (fs.existsSync(petFile(id))) {
    console.error(`pet "${id}" already exists`);
    process.exit(1);
  }
  const dietSyms = String(flags.diet || "AAPL,TSLA,MSFT").split(",").map(s => s.trim().toUpperCase()).filter(Boolean);
  const diet = [];
  for (const sym of dietSyms) {
    if (!KNOWN_TOKENS[sym]) {
      console.error(`unknown diet token "${sym}" (known: ${Object.keys(KNOWN_TOKENS).join(", ")}); add its address to KNOWN_TOKENS or edit the pet JSON afterwards`);
      process.exit(1);
    }
    diet.push({ symbol: sym, address: KNOWN_TOKENS[sym] });
  }
  const funder = flags.funder || null;
  if (funder && !/^0x[0-9a-fA-F]{40}$/.test(funder)) {
    console.error("--funder must be a 0x address (the wallet withdrawals will go to)");
    process.exit(1);
  }
  const pet = {
    id,
    name,
    breed,
    live: true,
    liveTrading: false,
    funder,
    slippagePct: 1,
    aggression: Math.min(1, Math.max(0, parseFloat(flags.aggression ?? "0.2"))),
    patience: parseFloat(flags.patience ?? "2"),
    capUsd: parseFloat(flags.cap ?? "500"),
    maxDailyLossPct: parseFloat(flags["max-daily-loss"] ?? "5"),
    params: {},
    diet,
  };
  fs.mkdirSync(PETS_DIR, { recursive: true });
  fs.writeFileSync(petFile(id), JSON.stringify(pet, null, 2) + "\n");
  const { address } = petWallet(id);
  console.log(`created pet "${name}" (${id})`);
  console.log(`  breed: ${breed}, aggression: ${pet.aggression}, patience: ${pet.patience}m, cap: $${pet.capUsd}`);
  console.log(`  diet: ${diet.map(d => d.symbol).join(", ")}`);
  console.log(`  wallet: ${address} (paper mode, never funded)`);
}

function listPets() {
  const pets = loadPets();
  if (!pets.length) return console.log("no pets yet, create one with create-pet");
  for (const pet of pets) {
    const state = loadState(pet.id);
    let address = "(MASTER_SEED not set)";
    try { address = petWallet(pet.id).address; } catch {}
    const lastMarks = state.lastTick?.marks || {};
    const priceByAddress = Object.fromEntries(Object.entries(lastMarks).map(([a, m]) => [a, m.price]));
    const { unrealizedUsd } = markToMarket(state, priceByAddress);
    const balance = pet.capUsd + state.realizedPnlUsd + unrealizedUsd;
    const status = pet.live === false ? "retired" : state.sleeping ? "asleep" : "awake";
    const open = Object.keys(state.positions).length;
    console.log(`${pet.name} (${pet.id}) [${pet.breed}] ${status}`);
    console.log(`  wallet: ${address}`);
    console.log(`  paper balance: $${balance.toFixed(2)} (cap $${pet.capUsd})`);
    console.log(`  realized P&L: $${state.realizedPnlUsd.toFixed(2)}, unrealized: $${unrealizedUsd.toFixed(2)}, open positions: ${open}`);
    if (state.lastTick) console.log(`  last tick: ${state.lastTick.at}`);
  }
}

function retirePet(id) {
  if (!id) {
    console.error("usage: cli.js retire-pet <id>");
    process.exit(1);
  }
  const file = petFile(id);
  if (!fs.existsSync(file)) {
    console.error(`no pet "${id}"`);
    process.exit(1);
  }
  const pet = JSON.parse(fs.readFileSync(file, "utf8"));
  pet.live = false;
  fs.writeFileSync(file, JSON.stringify(pet, null, 2) + "\n");
  console.log(`pet "${pet.name}" (${id}) retired. Config kept in pets/, state and trade logs untouched.`);
}

const [cmd, ...rest] = process.argv.slice(2);
const flags = parseFlags(rest);

switch (cmd) {
  case "create-pet": createPet(flags); break;
  case "list-pets": listPets(); break;
  case "retire-pet": retirePet(rest.find(a => !a.startsWith("--"))); break;
  default:
    console.log("stockpaws CLI (paper mode)");
    console.log("  create-pet --name <name> --breed <scalper|guardian|swing|sniper> [--aggression 0.2] [--patience 2] [--cap 500] [--diet AAPL,TSLA] [--funder 0x...]");
    console.log("  list-pets");
    console.log("  retire-pet <id>");
}
