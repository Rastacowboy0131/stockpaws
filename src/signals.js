// Signal layer: price/volume for diet tokens from dexscreener.
// Caches responses; will not hit the API more than once per minute per token.

const API = "https://api.dexscreener.com";
const CHAIN = "robinhood";
const MIN_POLL_MS = 60_000;

const cache = new Map(); // address(lower) -> { at, signal }

async function fetchJson(url) {
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`dexscreener ${res.status} for ${url}`);
  return res.json();
}

// Pick the most liquid robinhood pair for a token address.
function bestPair(pairs, address) {
  const addr = address.toLowerCase();
  return (pairs || [])
    .filter(p => p.chainId === CHAIN && p.baseToken?.address?.toLowerCase() === addr)
    .sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0] || null;
}

// getSignal(token) -> { symbol, address, priceUsd, priceChange {m5,h1,h6,h24},
//   volume {m5,h1,h24}, txns, liquidityUsd, pairAddress, fetchedAt } or null
export async function getSignal(token) {
  const key = token.address.toLowerCase();
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < MIN_POLL_MS) return hit.signal;

  let pair = null;
  try {
    const data = await fetchJson(`${API}/tokens/v1/${CHAIN}/${token.address}`);
    pair = bestPair(Array.isArray(data) ? data : data.pairs, token.address);
  } catch {
    // fall through to search
  }
  if (!pair) {
    try {
      const data = await fetchJson(`${API}/latest/dex/search?q=${encodeURIComponent(token.symbol)}`);
      pair = bestPair(data.pairs, token.address);
    } catch (e) {
      console.error(`signal fetch failed for ${token.symbol}: ${e.message}`);
    }
  }

  // Guard against garbage: a NaN price would poison P&L state downstream.
  const px = pair ? parseFloat(pair.priceUsd) : NaN;
  if (pair && !Number.isFinite(px)) {
    console.error(`signal for ${token.symbol}: non-numeric priceUsd ${JSON.stringify(pair.priceUsd)}, ignoring pair`);
    pair = null;
  }
  const signal = pair
    ? {
        symbol: token.symbol,
        address: token.address,
        priceUsd: px,
        priceChange: pair.priceChange || {},
        volume: pair.volume || {},
        txns: pair.txns || {},
        liquidityUsd: pair.liquidity?.usd || 0,
        pairAddress: pair.pairAddress,
        fetchedAt: new Date().toISOString(),
      }
    : null;
  cache.set(key, { at: Date.now(), signal });
  return signal;
}
