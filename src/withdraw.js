// Withdraw-all: liquidate a pet's positions and send all ETH to the pet's
// recorded funder address. HARD RULES:
//   - the destination is ALWAYS pets/<id>.json "funder"; refuse if missing.
//   - no override flag exists on purpose. Change the pet file if the funder changes.
// Gated the same as execution: EXECUTION_MODE=live AND pet.liveTrading:true.
//
// Usage: node --env-file=.env src/withdraw.js <petId>

import fs from "node:fs";
import path from "node:path";
import { Contract, formatEther, parseEther, getAddress, isAddress, MaxUint256 } from "ethers";
import { petWallet } from "./wallet.js";
import { ADDR, wethContract, isLive, sellAllWithRetry, gasOverrides } from "./execution.js";
import { logTrade } from "./portfolio.js";

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
];

const GAS_HEADROOM = parseEther("0.0005");

function loadPet(petId) {
  const file = path.join("pets", `${petId}.json`);
  if (!fs.existsSync(file)) throw new Error(`no such pet: ${petId}`);
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

// withdrawAll(petId) -> { funder, steps: [...], ethSentWei }
export async function withdrawAll(petId) {
  const pet = loadPet(petId);
  if (!isLive(pet)) {
    throw new Error("refused: withdraw requires EXECUTION_MODE=live and liveTrading:true on the pet");
  }
  if (!pet.funder || !isAddress(pet.funder)) {
    throw new Error(`refused: pet ${petId} has no valid funder address recorded; withdrawals only go to the recorded funder`);
  }
  const funder = getAddress(pet.funder);
  const { signer, address } = petWallet(petId);
  const provider = signer.provider;
  const steps = [];

  // 1. Sell every open diet-token position back to WETH (live balances only).
  for (const token of pet.diet || []) {
    const t = new Contract(token.address, ERC20_ABI, signer);
    const bal = await t.balanceOf(address); // live read, rebase safe
    if (bal === 0n) continue;
    // Rebase-safe: approve max (exact-amount approvals can fail transferFrom
    // when the rebasing share math rounds), then sell with the shared retry
    // helper (handles share-math rounding reverts on full-balance sells).
    const allowance = await t.allowance(address, ADDR.router);
    if (allowance < bal) await (await t.approve(ADDR.router, MaxUint256)).wait();
    const amountIn = await t.balanceOf(address);
    const result = await sellAllWithRetry(signer, t, token.address, amountIn, pet.slippagePct ?? 1);
    steps.push({ step: "sell", token: token.symbol, txHash: result.txHash });
    logTrade(petId, {
      ts: new Date().toISOString(), mode: "live", petId, wallet: address,
      side: "sell", token: token.symbol, tokenAddress: token.address,
      txHash: result.txHash, reason: "withdraw-all liquidation",
    });
  }

  // 2. Unwrap all WETH.
  const weth = wethContract(signer);
  const wbal = await weth.balanceOf(address);
  if (wbal > 0n) {
    const tx = await weth.withdraw(wbal, await gasOverrides(provider));
    await tx.wait();
    steps.push({ step: "unwrap", amountEth: formatEther(wbal), txHash: tx.hash });
  }

  // 3. Send all ETH (minus gas for this one tx) to the funder.
  // RH Chain is an Arbitrum Orbit chain: plain transfers cost more than 21000
  // gas (ArbOS L1 component), so always estimate.
  const ethBal = await provider.getBalance(address);
  await gasOverrides(provider); // asserts gas price is under the sanity cap
  const feeData = await provider.getFeeData();
  const gasPrice = feeData.maxFeePerGas ?? feeData.gasPrice ?? parseEther("0.000000001");
  const gasLimit = await provider.estimateGas({ from: address, to: funder, value: 1n }).catch(() => 100000n);
  const gasCost = gasPrice * gasLimit * 2n + GAS_HEADROOM;
  if (ethBal <= gasCost) {
    return { funder, steps, ethSentWei: 0n, note: "nothing left to send after gas" };
  }
  const value = ethBal - gasCost;
  const tx = await signer.sendTransaction({ to: funder, value, gasLimit });
  const rc = await tx.wait();
  if (rc.status !== 1) throw new Error(`ETH transfer failed: ${tx.hash}`);
  steps.push({ step: "send", to: funder, amountEth: formatEther(value), txHash: tx.hash });
  logTrade(petId, {
    ts: new Date().toISOString(), mode: "live", petId, wallet: address,
    side: "withdraw", token: "ETH", txHash: tx.hash,
    sizeUsd: null, reason: `withdraw-all to funder ${funder}`,
  });
  return { funder, steps, ethSentWei: value };
}

const isMain = process.argv[1] && process.argv[1].endsWith("withdraw.js");
if (isMain) {
  const petId = process.argv[2];
  if (!petId) { console.error("usage: node src/withdraw.js <petId>"); process.exit(1); }
  try {
    const res = await withdrawAll(petId);
    console.log(JSON.stringify(res, (k, v) => (typeof v === "bigint" ? v.toString() : v), 2));
  } catch (e) {
    console.error(`withdraw failed: ${e.message}`);
    process.exit(1);
  }
}
