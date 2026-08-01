// Paper portfolio state: positions, realized/unrealized P&L, daily loss tracking.
import fs from "node:fs";
import path from "node:path";

const STATE_DIR = "state";
const TRADES_DIR = "trades";

function today() {
  return new Date().toISOString().slice(0, 10);
}

export function loadState(petId) {
  const file = path.join(STATE_DIR, `${petId}.json`);
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, "utf8"));
  return { petId, positions: {}, realizedPnlUsd: 0, dailyPnl: { date: today(), realizedUsd: 0 }, sleeping: false };
}

export function saveState(state) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  // Atomic write: crash mid-write must never corrupt the state file.
  const file = path.join(STATE_DIR, `${state.petId}.json`);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, file);
}

export function logTrade(petId, entry) {
  fs.mkdirSync(TRADES_DIR, { recursive: true });
  fs.appendFileSync(path.join(TRADES_DIR, `${petId}.jsonl`), JSON.stringify(entry) + "\n");
}

export function rollDay(state) {
  if (state.dailyPnl.date !== today()) {
    state.dailyPnl = { date: today(), realizedUsd: 0 };
    state.sleeping = false;
  }
}

// Open a paper position.
export function openPosition(state, token, sizeUsd, price) {
  state.positions[token.address] = {
    symbol: token.symbol,
    address: token.address,
    sizeUsd,
    qty: sizeUsd / price,
    entryPrice: price,
    openedAt: new Date().toISOString(),
  };
}

// Close a paper position, book realized P&L. Returns realized USD.
export function closePosition(state, address, price) {
  const pos = state.positions[address];
  if (!pos) return 0;
  const realized = pos.qty * (price - pos.entryPrice);
  state.realizedPnlUsd += realized;
  state.dailyPnl.realizedUsd += realized;
  delete state.positions[address];
  return realized;
}

// Mark to market: returns { unrealizedUsd, marks: {addr: {price, pnlUsd}} }
export function markToMarket(state, priceByAddress) {
  let unrealizedUsd = 0;
  const marks = {};
  for (const [addr, pos] of Object.entries(state.positions)) {
    const price = priceByAddress[addr];
    if (price == null) continue;
    const pnl = pos.qty * (price - pos.entryPrice);
    unrealizedUsd += pnl;
    marks[addr] = { price, pnlUsd: pnl };
  }
  return { unrealizedUsd, marks };
}
