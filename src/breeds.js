// Breed strategies. Each returns a decision: { side: "buy"|"sell", reason } or null.
// Inputs: pet config, signal (see signals.js), position (open paper position or null).

function minutesHeld(position) {
  return (Date.now() - new Date(position.openedAt).getTime()) / 60000;
}

// momentum: buy on positive 1h price and volume move, tight stop, take profit.
function momentum(pet, sig, pos) {
  if (!pos) {
    if ((sig.priceChange.h1 || 0) >= 1.0 && (sig.volume.h1 || 0) > 1000) {
      return { side: "buy", reason: `momentum: h1 +${sig.priceChange.h1}% on $${Math.round(sig.volume.h1)} h1 volume` };
    }
    return null;
  }
  const pnlPct = (sig.priceUsd / pos.entryPrice - 1) * 100;
  if (pnlPct <= -1.5) return { side: "sell", reason: `momentum stop: ${pnlPct.toFixed(2)}%` };
  if (pnlPct >= 3 && minutesHeld(pos) >= pet.patience) return { side: "sell", reason: `momentum take profit: +${pnlPct.toFixed(2)}%` };
  if ((sig.priceChange.h1 || 0) < -0.5 && minutesHeld(pos) >= pet.patience) return { side: "sell", reason: "momentum faded: h1 turned negative" };
  return null;
}

// dipper: buy a diet token that dipped, hold for mean reversion.
function dipper(pet, sig, pos) {
  const dip = pet.params?.dipPct ?? -3;
  if (!pos) {
    if ((sig.priceChange.h6 || 0) <= dip) {
      return { side: "buy", reason: `dipper: h6 ${sig.priceChange.h6}% <= ${dip}% dip threshold` };
    }
    return null;
  }
  const pnlPct = (sig.priceUsd / pos.entryPrice - 1) * 100;
  if (pnlPct <= -6) return { side: "sell", reason: `dipper hard stop: ${pnlPct.toFixed(2)}%` };
  if (pnlPct >= Math.abs(dip) * 0.7 && minutesHeld(pos) >= pet.patience) {
    return { side: "sell", reason: `dipper mean reversion hit: +${pnlPct.toFixed(2)}%` };
  }
  return null;
}

// scalper: small quick in/out on short-term volatility.
function scalper(pet, sig, pos) {
  if (!pos) {
    const m5 = Math.abs(sig.priceChange.m5 || 0);
    const active = (sig.txns?.m5?.buys || 0) + (sig.txns?.m5?.sells || 0);
    if (m5 >= 0.15 && (sig.priceChange.m5 || 0) > 0 && active >= 3) {
      return { side: "buy", reason: `scalp: m5 +${sig.priceChange.m5}%, ${active} m5 txns` };
    }
    return null;
  }
  const pnlPct = (sig.priceUsd / pos.entryPrice - 1) * 100;
  if (pnlPct <= -0.5) return { side: "sell", reason: `scalp stop: ${pnlPct.toFixed(2)}%` };
  if (pnlPct >= 0.6) return { side: "sell", reason: `scalp target: +${pnlPct.toFixed(2)}%` };
  if (minutesHeld(pos) >= pet.patience * 3) return { side: "sell", reason: "scalp timeout" };
  return null;
}

export const breeds = { momentum, dipper, scalper };
