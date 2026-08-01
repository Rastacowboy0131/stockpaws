// Cost model for paper fills: pool fee plus slippage, per side.
// Paper P&L should approximate live net P&L, not gross moves.
//
// Fee tier: dexscreener does not expose the uni v3 fee tier of a pair, so the
// per-token fee can be set in the pet diet entry as feeBps (e.g. 30 = 0.3%).
// When a signal carries feeBps (set from diet config by the engine), that wins.
// Default: 30 bps (0.3%) per side.
// Slippage: configurable per pet via costSlippagePct, default 0.1% per side.

export const DEFAULT_FEE_BPS = 30;      // 0.3% per side
export const DEFAULT_SLIPPAGE_PCT = 0.1; // 0.1% per side

// Per-side cost in percent for a given pet + signal.
export function perSideCostPct(pet, sig) {
  const feeBps = sig?.feeBps ?? DEFAULT_FEE_BPS;
  const slipPct = pet?.costSlippagePct ?? DEFAULT_SLIPPAGE_PCT;
  return feeBps / 100 + slipPct;
}

// Full round-trip cost in percent (entry + exit).
export function roundTripCostPct(pet, sig) {
  return 2 * perSideCostPct(pet, sig);
}
