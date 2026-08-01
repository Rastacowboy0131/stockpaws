// One-shot tick runner for cron/heartbeat: evaluate all live pets once, then exit.
// Idempotent within the same minute: if a tick already ran this minute, it skips.
// PAPER MODE only, no transactions are ever sent.
import fs from "node:fs";
import path from "node:path";
import { tick } from "./engine.js";

const LOCK_FILE = path.join("state", "tick-lock.json");

function minuteKey(d = new Date()) {
  return d.toISOString().slice(0, 16); // YYYY-MM-DDTHH:MM
}

const force = process.argv.includes("--force");
const nowKey = minuteKey();

let last = null;
try { last = JSON.parse(fs.readFileSync(LOCK_FILE, "utf8")).minute; } catch {}

if (last === nowKey && !force) {
  console.log(`tick already ran in minute ${nowKey}, skipping (use --force to override)`);
  process.exit(0);
}

fs.mkdirSync("state", { recursive: true });
fs.writeFileSync(LOCK_FILE, JSON.stringify({ minute: nowKey, at: new Date().toISOString() }));

await tick();
process.exit(0);
