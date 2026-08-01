/* ============================================================
   STOCKPAWS /api/state - per-wallet cloud saves (Postgres)
   Auth: stateless wallet-signature sessions. The client sends the
   message it signed at connect + the signature; we recover the
   signer address with ethers and only serve that wallet's row.
   Watch-only wallets can never produce a valid signature.

   Env (Vercel -> Project -> Settings -> Environment Variables):
     DATABASE_URL   Postgres connection string (Railway public URL)

   If env is missing, returns 503 and the site silently falls
   back to per-browser localStorage - nothing breaks.

   Table is created lazily on cold start, no manual SQL needed:
     paw_states(address text primary key, state jsonb,
                updated_at timestamptz)
   ============================================================ */
const { verifyMessage } = require("ethers");
const { Pool } = require("pg");

const SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

let pool = null;
let tableReady = null;

function getPool() {
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: 3,
      ssl: { rejectUnauthorized: false },
    });
  }
  return pool;
}

function ensureTable() {
  if (!tableReady) {
    tableReady = getPool().query(
      `CREATE TABLE IF NOT EXISTS paw_states (
         address text PRIMARY KEY,
         state jsonb,
         updated_at timestamptz NOT NULL DEFAULT now()
       )`
    );
  }
  return tableReady;
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  if (!process.env.DATABASE_URL) {
    return res.status(503).json({ error: "storage_not_configured" });
  }

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = null; } }
  const { address, message, signature, action, state } = body || {};
  if (!address || !message || !signature || !action) {
    return res.status(400).json({ error: "missing fields" });
  }

  // ---- verify the wallet-signature session ----
  try {
    if (!message.startsWith("STOCKPAWS session")) throw new Error("bad message scope");
    if (!message.toLowerCase().includes(address.toLowerCase())) throw new Error("address not in message");
    const tsMatch = message.match(/Issued:\s*(\d+)/);
    const ts = tsMatch ? parseInt(tsMatch[1], 10) : 0;
    if (!ts || Date.now() - ts > SESSION_MAX_AGE_MS || ts - Date.now() > 5 * 60 * 1000) {
      return res.status(401).json({ error: "session_expired" });
    }
    const recovered = verifyMessage(message, signature);
    if (recovered.toLowerCase() !== address.toLowerCase()) throw new Error("signature mismatch");
  } catch (e) {
    return res.status(401).json({ error: "invalid_session", detail: e.message });
  }

  const addr = address.toLowerCase();

  try {
    await ensureTable();
    const db = getPool();

    if (action === "load") {
      const r = await db.query(
        "SELECT state FROM paw_states WHERE address = $1",
        [addr]
      );
      return res.status(200).json({ ok: true, state: r.rows[0] ? r.rows[0].state : null });
    }

    if (action === "save") {
      if (!state || typeof state !== "object") return res.status(400).json({ error: "bad state" });
      const payload = JSON.stringify(state);
      if (payload.length > 100_000) return res.status(413).json({ error: "state too large" });
      await db.query(
        `INSERT INTO paw_states (address, state, updated_at)
         VALUES ($1, $2::jsonb, now())
         ON CONFLICT (address) DO UPDATE
           SET state = EXCLUDED.state, updated_at = now()`,
        [addr, payload]
      );
      return res.status(200).json({ ok: true });
    }

    if (action === "wipe") {
      await db.query("DELETE FROM paw_states WHERE address = $1", [addr]);
      return res.status(200).json({ ok: true });
    }

    return res.status(400).json({ error: "unknown action" });
  } catch (e) {
    return res.status(500).json({ error: "storage_error", detail: e.message });
  }
};
