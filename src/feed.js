// Trade feed formatter: turns trade log entries into short Discord-ready messages.
// Library: formatTrade(entry, pet) and newMessagesSince(sinceIso).
// CLI: node src/feed.js [--since <iso>]  prints new messages and advances state/feed-cursor.json.
import fs from "node:fs";
import path from "node:path";

const TRADES_DIR = "trades";
const PETS_DIR = "pets";
const CURSOR_FILE = path.join("state", "feed-cursor.json");

const BREED_EMOJI = { momentum: "🚀", dipper: "🎣", scalper: "⚡" };
const BLOCKSCOUT = "https://robinhoodchain.blockscout.com";

function txSuffix(entry) {
  return entry.mode === "live" && entry.txHash ? ` | <${BLOCKSCOUT}/tx/${entry.txHash}>` : "";
}

function loadPetMap() {
  const map = {};
  if (!fs.existsSync(PETS_DIR)) return map;
  for (const f of fs.readdirSync(PETS_DIR).filter(f => f.endsWith(".json"))) {
    try {
      const pet = JSON.parse(fs.readFileSync(path.join(PETS_DIR, f), "utf8"));
      map[pet.id] = pet;
    } catch {}
  }
  return map;
}

function fmtUsd(n) {
  const abs = Math.abs(n);
  return abs >= 100 ? Math.round(abs).toString() : abs.toFixed(2).replace(/\.?0+$/, "");
}

// Breed target hints for buy messages.
function targetHint(breed) {
  if (breed === "scalper") return "target +0.6%";
  if (breed === "momentum") return "target +3%";
  if (breed === "dipper") return "riding the rebound";
  return "";
}

export function formatTrade(entry, pet) {
  const name = pet?.name || entry.petId;
  const breed = pet?.breed || "?";
  const emoji = BREED_EMOJI[breed] || "🐾";
  const price = entry.quotedPriceUsd;
  if (entry.side === "buy") {
    const hint = targetHint(breed);
    return `🐾 ${name} (${breed}) bought $${fmtUsd(entry.sizeUsd)} ${entry.token} @ ${price}${hint ? `, ${hint}` : ""} ${emoji}${txSuffix(entry)}`;
  }
  if (entry.side === "withdraw") {
    return `🐾 ${name} withdrew everything to the funder wallet 👋${txSuffix(entry)}`;
  }
  const pnl = entry.realizedPnlUsd ?? 0;
  const sign = pnl >= 0 ? "+" : "-";
  const mood = pnl >= 0 ? "😸" : "😿";
  const at = price != null ? ` @ ${price}` : "";
  const pnlPart = entry.realizedPnlUsd != null ? `, ${sign}$${fmtUsd(pnl)} ${mood}` : "";
  return `🐾 ${name} (${breed}) sold ${entry.token}${at}${pnlPart} (${entry.reason})${txSuffix(entry)}`;
}

function readAllTrades() {
  if (!fs.existsSync(TRADES_DIR)) return [];
  const entries = [];
  for (const f of fs.readdirSync(TRADES_DIR).filter(f => f.endsWith(".jsonl"))) {
    for (const line of fs.readFileSync(path.join(TRADES_DIR, f), "utf8").split("\n")) {
      if (!line.trim()) continue;
      try { entries.push(JSON.parse(line)); } catch {}
    }
  }
  return entries.sort((a, b) => a.ts.localeCompare(b.ts));
}

// newMessagesSince(sinceIso) -> { messages: string[], cursor: latest ts seen }
export function newMessagesSince(sinceIso) {
  const pets = loadPetMap();
  const trades = readAllTrades().filter(t => !sinceIso || t.ts > sinceIso);
  const messages = trades.map(t => formatTrade(t, pets[t.petId]));
  const cursor = trades.length ? trades[trades.length - 1].ts : sinceIso;
  return { messages, cursor };
}

// CLI mode
const isMain = process.argv[1] && process.argv[1].endsWith("feed.js");
if (isMain) {
  const idx = process.argv.indexOf("--since");
  let since = idx > -1 ? process.argv[idx + 1] : null;
  if (!since) {
    try { since = JSON.parse(fs.readFileSync(CURSOR_FILE, "utf8")).cursor; } catch {}
  }
  const { messages, cursor } = newMessagesSince(since);
  for (const m of messages) console.log(m);
  if (cursor) {
    fs.mkdirSync("state", { recursive: true });
    fs.writeFileSync(CURSOR_FILE, JSON.stringify({ cursor, updatedAt: new Date().toISOString() }));
  }
  if (!messages.length) console.error("(no new trades)");
}
