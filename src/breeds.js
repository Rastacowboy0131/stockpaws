// Breed strategies. Each returns a decision: { side: "buy"|"sell", reason } or null.
// Inputs: pet config, signal (see signals.js), position (open paper position or null).
//
// Breed lineup matches the site characters one to one:
//   scalper  (Waffles) - quick in/out on short-term volatility, fee-aware targets
//   guardian (Scout)   - conservative defensive allocator, prefers holding
//   swing    (Moss)    - buy the dip, hold for mean reversion (was "dipper")
//   sniper   (Vix)     - momentum entries with strict confirmation, never chases (was "momentum")
//
// Old breed names are accepted as aliases so existing configs keep working.

import { roundTripCostPct } from "./costs.js";

// Legacy name -> current name. resolveBreed() maps any accepted name to the
// canonical strategy key; unknown names return null.
export const BREED_ALIASES = { dipper: "swing", momentum: "sniper" };

export function resolveBreed(name) {
  const canonical = BREED_ALIASES[name] || name;
  return breeds[canonical] ? canonical : null;
}

// Per-breed risk scaling applied by the engine AND the live execution rails:
//   sizeFactor: multiplies aggression*capUsd for the max position size.
//   dailyLossFactor: multiplies maxDailyLossPct for the sleep cutoff.
export const BREED_RISK = {
  guardian: { sizeFactor: 0.5, dailyLossFactor: 0.5 },
};

export function breedRisk(name) {
  return BREED_RISK[resolveBreed(name)] || { sizeFactor: 1, dailyLossFactor: 1 };
}

function minutesHeld(position) {
  return (Date.now() - new Date(position.openedAt).getTime()) / 60000;
}

// sniper (was momentum): buy confirmed momentum, but never chase. Requires a
// stronger signal than the old momentum breed (h1 >= 1.5% with real volume and
// a positive m5 confirmation) and refuses entries where price is already
// extended more than 2% above the short-term baseline (m5 move > 2%).
function sniper(pet, sig, pos) {
  if (!pos) {
    const h1 = sig.priceChange.h1 || 0;
    const m5 = sig.priceChange.m5 || 0;
    if (m5 > 2) return null; // already extended; a sniper never chases
    if (h1 >= 1.5 && (sig.volume.h1 || 0) > 2000 && m5 > 0) {
      return { side: "buy", reason: `sniper: h1 +${h1}% on $${Math.round(sig.volume.h1)} h1 volume, m5 +${m5}% confirms` };
    }
    return null;
  }
  const pnlPct = (sig.priceUsd / pos.entryPrice - 1) * 100;
  if (pnlPct <= -1.5) return { side: "sell", reason: `sniper stop: ${pnlPct.toFixed(2)}%` };
  if (pnlPct >= 3 && minutesHeld(pos) >= pet.patience) return { side: "sell", reason: `sniper take profit: +${pnlPct.toFixed(2)}%` };
  if ((sig.priceChange.h1 || 0) < -0.5 && minutesHeld(pos) >= pet.patience) return { side: "sell", reason: "sniper faded: h1 turned negative" };
  return null;
}

// swing (was dipper): buy a diet token that dipped, hold for mean reversion.
function swing(pet, sig, pos) {
  const dip = pet.params?.dipPct ?? -3;
  if (!pos) {
    if ((sig.priceChange.h6 || 0) <= dip) {
      return { side: "buy", reason: `swing: h6 ${sig.priceChange.h6}% <= ${dip}% dip threshold` };
    }
    return null;
  }
  const pnlPct = (sig.priceUsd / pos.entryPrice - 1) * 100;
  if (pnlPct <= -6) return { side: "sell", reason: `swing hard stop: ${pnlPct.toFixed(2)}%` };
  if (pnlPct >= Math.abs(dip) * 0.7 && minutesHeld(pos) >= pet.patience) {
    return { side: "sell", reason: `swing mean reversion hit: +${pnlPct.toFixed(2)}%` };
  }
  return null;
}

// scalper: small quick in/out on short-term volatility. Fee-aware: targets and
// the volatility gate are derived from the round-trip cost so every winning
// scalp clears fees plus slippage with margin.
function scalper(pet, sig, pos) {
  const rtCost = roundTripCostPct(pet, sig); // e.g. 0.8% at 30bps fee + 0.1% slip per side
  const target = Math.max(pet.params?.scalpTargetPct ?? 1.5, rtCost * 1.8);
  const stop = -(target * 0.8); // stop widened proportionally with the target
  if (!pos) {
    // min-volatility gate: if the pool moved less than the round-trip cost in
    // the last hour, there is nothing to scalp there.
    if (Math.abs(sig.priceChange.h1 || 0) < rtCost) return null;
    const m5 = Math.abs(sig.priceChange.m5 || 0);
    const active = (sig.txns?.m5?.buys || 0) + (sig.txns?.m5?.sells || 0);
    if (m5 >= 0.15 && (sig.priceChange.m5 || 0) > 0 && active >= 3) {
      return { side: "buy", reason: `scalp: m5 +${sig.priceChange.m5}%, ${active} m5 txns, h1 vol ${Math.abs(sig.priceChange.h1 || 0)}% clears ${rtCost.toFixed(2)}% cost` };
    }
    return null;
  }
  const pnlPct = (sig.priceUsd / pos.entryPrice - 1) * 100;
  if (pnlPct <= stop) return { side: "sell", reason: `scalp stop: ${pnlPct.toFixed(2)}%` };
  if (pnlPct >= target) return { side: "sell", reason: `scalp target: +${pnlPct.toFixed(2)}% (target ${target.toFixed(2)}%)` };
  if (minutesHeld(pos) >= pet.patience * 3) return { side: "sell", reason: "scalp timeout" };
  return null;
}

// guardian: conservative defensive allocator. Trades whatever big-cap diet the
// pet has, takes few entries (high signal threshold: steady h6 uptrend that is
// not overheated, with real volume), and prefers holding: wide take profit,
// exits on hard stop or clear trend break only. Position sizes and the daily
// loss cutoff are additionally scaled down by BREED_RISK (half of normal),
// enforced in the engine and the live execution rails.
function guardian(pet, sig, pos) {
  if (!pos) {
    const h6 = sig.priceChange.h6 || 0;
    const h24 = sig.priceChange.h24 || 0;
    const h1 = sig.priceChange.h1 || 0;
    // High bar: sustained multi-window uptrend, decent volume, not overheated.
    if (h6 >= 1.0 && h24 >= 0 && h1 >= 0 && h1 <= 1.5 && (sig.volume.h6 || 0) > 5000) {
      return { side: "buy", reason: `guardian: steady uptrend h6 +${h6}% / h24 +${h24}%, not overheated (h1 +${h1}%)` };
    }
    return null;
  }
  const pnlPct = (sig.priceUsd / pos.entryPrice - 1) * 100;
  if (pnlPct <= -2) return { side: "sell", reason: `guardian stop: ${pnlPct.toFixed(2)}%` };
  // Prefers holding: generous target, and only after a long minimum hold.
  if (pnlPct >= 5 && minutesHeld(pos) >= pet.patience * 4) {
    return { side: "sell", reason: `guardian take profit: +${pnlPct.toFixed(2)}%` };
  }
  // Trend break: give back the position only on a clear reversal.
  if ((sig.priceChange.h6 || 0) <= -2 && minutesHeld(pos) >= pet.patience) {
    return { side: "sell", reason: `guardian trend break: h6 ${sig.priceChange.h6}%` };
  }
  return null;
}

export const breeds = { scalper, guardian, swing, sniper };
export const BREED_NAMES = Object.keys(breeds);
