// Execution layer: real onchain trades on Robinhood Chain via Uniswap V3.
// HARD GATE: nothing here sends a transaction unless BOTH are true:
//   1. process.env.EXECUTION_MODE === "live"
//   2. pet.liveTrading === true in pets/<id>.json
// Anything else throws before touching a signer. Default is paper.
//
// Verified deployment (chainId 4663, RPC https://rpc.mainnet.chain.robinhood.com):
//   SwapRouter  0xCaf681a66D020601342297493863E78C959E5cb2
//   Factory     0x1f7d7550B1b028f7571E69A784071F0205FD2EfA (router.factory())
//   QuoterV2    0x0269F8b86bB3C1e927DaCEDb72f3463Ef6D26F61 (same factory as router)
//   WETH9       0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73 (router.WETH9())
// Stock tokens share a rebasing implementation (stock splits), so balances are
// ALWAYS read live from chain right before use. Never cache token quantities.

import { Contract, parseEther, formatEther, formatUnits, MaxUint256 } from "ethers";
import { petWallet, getProvider } from "./wallet.js";
import { getSignal } from "./signals.js";
import { loadState, logTrade } from "./portfolio.js";

export const ADDR = {
  router: "0xCaf681a66D020601342297493863E78C959E5cb2",
  factory: "0x1f7d7550B1b028f7571E69A784071F0205FD2EfA",
  quoterV2: "0x0269F8b86bB3C1e927DaCEDb72f3463Ef6D26F61",
  weth: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73",
  usdg: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
};

export const FEE_TIERS = [100, 500, 3000, 10000];
export const MIN_LIQUIDITY_USD = 5000;
const DEFAULT_SLIPPAGE_PCT = 1;
const GAS_RESERVE_ETH = "0.002"; // never wrap the last bit of ETH, gas must survive
const DEADLINE_SECONDS = 120;

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function allowance(address,address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
];
const WETH_ABI = [
  ...ERC20_ABI,
  "function deposit() payable",
  "function withdraw(uint256)",
];
// SwapRouter02: exactInputSingle takes NO deadline field; deadline is passed
// via multicall(uint256 deadline, bytes[] data).
const ROUTER_ABI = [
  "function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96)) payable returns (uint256 amountOut)",
  "function multicall(uint256 deadline, bytes[] data) payable returns (bytes[] results)",
];
const QUOTER_ABI = [
  "function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96)) returns (uint256 amountOut,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate)",
];
const FACTORY_ABI = [
  "function getPool(address,address,uint24) view returns (address)",
];
const POOL_ABI = ["function liquidity() view returns (uint128)"];

export function isLive(pet) {
  return process.env.EXECUTION_MODE === "live" && pet?.liveTrading === true;
}

function assertLive(pet) {
  if (process.env.EXECUTION_MODE !== "live") {
    throw new Error("refused: EXECUTION_MODE is not 'live' (paper mode)");
  }
  if (pet?.liveTrading !== true) {
    throw new Error(`refused: pet ${pet?.id} does not have liveTrading:true`);
  }
}

function erc20(address, signerOrProvider) {
  return new Contract(address, ERC20_ABI, signerOrProvider);
}
export function wethContract(signerOrProvider) {
  return new Contract(ADDR.weth, WETH_ABI, signerOrProvider);
}

// Surface revert reasons instead of ethers' wall of JSON.
function revertReason(e) {
  return e?.revert?.args?.join(", ") || e?.reason || e?.shortMessage || e?.message || String(e);
}

// --- quoting ------------------------------------------------------------

// Quote exact input via QuoterV2 (state-changing sim through eth_call).
export async function quoteExactInputSingle(tokenIn, tokenOut, amountIn, fee, provider = getProvider()) {
  const quoter = new Contract(ADDR.quoterV2, QUOTER_ABI, provider);
  try {
    const [amountOut] = await quoter.quoteExactInputSingle.staticCall({
      tokenIn, tokenOut, amountIn, fee, sqrtPriceLimitX96: 0n,
    });
    return amountOut;
  } catch (e) {
    throw new Error(`quote failed (${fee} bps pool ${tokenIn}->${tokenOut}): ${revertReason(e)}`);
  }
}

// Discover the fee tier whose pool gives the best output for this trade.
// Tries all existing pools and picks the highest quote (which naturally favors
// the deepest liquidity for a given size).
export async function bestFeeTier(tokenIn, tokenOut, amountIn, provider = getProvider()) {
  const factory = new Contract(ADDR.factory, FACTORY_ABI, provider);
  let best = null;
  for (const fee of FEE_TIERS) {
    const pool = await factory.getPool(tokenIn, tokenOut, fee);
    if (pool === "0x0000000000000000000000000000000000000000") continue;
    const liq = await new Contract(pool, POOL_ABI, provider).liquidity().catch(() => 0n);
    if (liq === 0n) continue;
    let amountOut;
    try {
      amountOut = await quoteExactInputSingle(tokenIn, tokenOut, amountIn, fee, provider);
    } catch {
      continue;
    }
    if (!best || amountOut > best.amountOut) best = { fee, pool, amountOut };
  }
  if (!best) throw new Error(`no usable Uniswap V3 pool for ${tokenIn} -> ${tokenOut}`);
  return best;
}

// ETH price in USD from the WETH/USDG 500bps pool (USDG has 6 decimals).
export async function ethUsdPrice(provider = getProvider()) {
  const out = await quoteExactInputSingle(ADDR.weth, ADDR.usdg, parseEther("1"), 500, provider);
  return parseFloat(formatUnits(out, 6));
}

// --- risk rails (enforced HERE, not just in the strategy layer) ----------

export async function checkRails(pet, { side, token, sizeUsd, signal }) {
  // 1. Diet whitelist: the actual token ADDRESS must be in the pet's diet.
  const dietAddrs = (pet.diet || []).map(t => t.address.toLowerCase());
  if (!dietAddrs.includes(token.address.toLowerCase())) {
    throw new Error(`refused: ${token.symbol} (${token.address}) is not in ${pet.id}'s diet`);
  }
  // 2. Max trade size from pet cap.
  const maxTradeUsd = pet.aggression * pet.capUsd;
  if (side === "buy" && sizeUsd > maxTradeUsd + 0.01) {
    throw new Error(`refused: trade $${sizeUsd.toFixed(2)} exceeds max $${maxTradeUsd.toFixed(2)} (aggression*cap)`);
  }
  // 3. Pool liquidity floor (reuse the signal layer's best-pair liquidity).
  const sig = signal || await getSignal(token);
  if (!sig) throw new Error(`refused: no market signal for ${token.symbol}`);
  if ((sig.liquidityUsd || 0) < MIN_LIQUIDITY_USD) {
    throw new Error(`refused: ${token.symbol} liquidity $${Math.round(sig.liquidityUsd || 0)} below $${MIN_LIQUIDITY_USD} floor`);
  }
  // 4. Daily loss cutoff: sleeping pets may sell (close) but never buy.
  const state = loadState(pet.id);
  if (side === "buy" && state.sleeping) {
    throw new Error(`refused: ${pet.id} hit its daily loss cutoff and is sleeping`);
  }
  return sig;
}

// --- WETH plumbing --------------------------------------------------------

// Make sure the wallet holds at least `amountWei` WETH, wrapping ETH if needed
// while keeping a gas reserve. Throws if it cannot.
export async function ensureWeth(signer, amountWei) {
  const weth = wethContract(signer);
  const have = await weth.balanceOf(signer.address);
  if (have >= amountWei) return;
  const need = amountWei - have;
  const ethBal = await signer.provider.getBalance(signer.address);
  const reserve = parseEther(GAS_RESERVE_ETH);
  if (ethBal - reserve < need) {
    throw new Error(`insufficient funds: need ${formatEther(need)} more WETH, wallet has ${formatEther(ethBal)} ETH (gas reserve ${GAS_RESERVE_ETH})`);
  }
  const tx = await weth.deposit({ value: need });
  await tx.wait();
}

async function ensureAllowance(signer, tokenAddr, spender, amountWei) {
  const t = erc20(tokenAddr, signer);
  const allowance = await t.allowance(signer.address, spender);
  if (allowance >= amountWei) return;
  const tx = await t.approve(spender, MaxUint256);
  await tx.wait();
}

// --- swap core -------------------------------------------------------------

async function swapExactInputSingle(signer, { tokenIn, tokenOut, amountIn, slippagePct }) {
  const { fee, amountOut: quoted } = await bestFeeTier(tokenIn, tokenOut, amountIn, signer.provider);
  const bps = BigInt(Math.round((slippagePct ?? DEFAULT_SLIPPAGE_PCT) * 100));
  const amountOutMinimum = (quoted * (10000n - bps)) / 10000n;
  await ensureAllowance(signer, tokenIn, ADDR.router, amountIn);
  const router = new Contract(ADDR.router, ROUTER_ABI, signer);
  const params = {
    tokenIn, tokenOut, fee,
    recipient: signer.address,
    amountIn, amountOutMinimum,
    sqrtPriceLimitX96: 0n,
  };
  const deadline = Math.floor(Date.now() / 1000) + DEADLINE_SECONDS;
  const callData = router.interface.encodeFunctionData("exactInputSingle", [params]);
  let tx;
  try {
    tx = await router.multicall(deadline, [callData]);
  } catch (e) {
    throw new Error(`swap reverted: ${revertReason(e)}`);
  }
  const receipt = await tx.wait();
  if (receipt.status !== 1) throw new Error(`swap tx ${tx.hash} failed onchain`);
  return { txHash: tx.hash, fee, quoted, amountOutMinimum, receipt };
}

// --- public entry point ------------------------------------------------------

// executeTrade({ pet, side: "buy"|"sell", token, sizeUsd, signal?, reason? })
// buy: spends sizeUsd worth of ETH/WETH for the stock token.
// sell: sells the ENTIRE live token balance back to WETH (rebase safe: balance
//       is read from chain at execution time, never from cached state).
// Returns the trade log entry (already appended to trades/<petId>.jsonl).
export async function executeTrade({ pet, side, token, sizeUsd, signal, reason }) {
  assertLive(pet);
  const sig = await checkRails(pet, { side, token, sizeUsd, signal });
  const { signer, address } = petWallet(pet.id);
  const provider = signer.provider;
  const slippagePct = pet.slippagePct ?? DEFAULT_SLIPPAGE_PCT;
  const ethUsd = await ethUsdPrice(provider);

  let result, amountIn, amountOut, tokenDecimals;
  const tokenC = erc20(token.address, provider);
  tokenDecimals = Number(await tokenC.decimals());

  if (side === "buy") {
    amountIn = parseEther((sizeUsd / ethUsd).toFixed(18));
    await ensureWeth(signer, amountIn);
    const before = await tokenC.balanceOf(address);
    result = await swapExactInputSingle(signer, {
      tokenIn: ADDR.weth, tokenOut: token.address, amountIn, slippagePct,
    });
    const after = await tokenC.balanceOf(address);
    amountOut = after - before;
  } else if (side === "sell") {
    amountIn = await tokenC.balanceOf(address); // live read, rebase safe
    if (amountIn === 0n) throw new Error(`refused: no live ${token.symbol} balance to sell`);
    const weth = wethContract(provider);
    const before = await weth.balanceOf(address);
    result = await swapExactInputSingle(signer, {
      tokenIn: token.address, tokenOut: ADDR.weth, amountIn, slippagePct,
    });
    const after = await weth.balanceOf(address);
    amountOut = after - before;
  } else {
    throw new Error(`unknown side ${side}`);
  }

  const entry = {
    ts: new Date().toISOString(),
    mode: "live",
    petId: pet.id,
    wallet: address,
    side,
    token: token.symbol,
    tokenAddress: token.address,
    sizeUsd: side === "buy"
      ? +sizeUsd.toFixed(2)
      : +((parseFloat(formatEther(amountOut)) * ethUsd)).toFixed(2),
    quotedPriceUsd: sig.priceUsd,
    feeTier: result.fee,
    amountIn: side === "buy" ? formatEther(amountIn) : formatUnits(amountIn, tokenDecimals),
    amountOut: side === "buy" ? formatUnits(amountOut, tokenDecimals) : formatEther(amountOut),
    txHash: result.txHash,
    pairAddress: sig.pairAddress,
    reason: reason || "",
  };
  logTrade(pet.id, entry);
  return entry;
}
