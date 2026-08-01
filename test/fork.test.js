// Fork test suite: run via test/fork.sh (needs a local anvil fork on RPC_URL).
// Proves end to end on a fork of Robinhood Chain mainnet:
//   1. wrap ETH -> WETH
//   2. live buy of AAPL through the Uniswap V3 router (balance increases)
//   3. live sell back to WETH
//   4. withdraw-all to the recorded funder
//   5. risk rails refuse: oversize trade, non-diet token, thin pool,
//      sleeping pet, missing funder, paper-mode gate
import assert from "node:assert/strict";
import fs from "node:fs";
import { Contract, parseEther, formatEther } from "ethers";
import { petWallet, getProvider } from "../src/wallet.js";
import { ADDR, executeTrade, checkRails, ensureWeth, wethContract, ethUsdPrice, bestFeeTier } from "../src/execution.js";
import { withdrawAll } from "../src/withdraw.js";

const AAPL = { symbol: "AAPL", address: "0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9" };
const NVDA = { symbol: "NVDA", address: "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC" };
const PET_ID = "fork-test";
const PET_FILE = `pets/${PET_ID}.json`;
const FUNDER = "0x1111111111111111111111111111111111111111"; // fresh address, no fork-account weirdness

// Fake but realistic signal so tests do not depend on dexscreener being up.
const AAPL_SIGNAL = {
  symbol: "AAPL", address: AAPL.address, priceUsd: 250,
  priceChange: {}, volume: {}, txns: {},
  liquidityUsd: 300000, pairAddress: "0xc748f4671a867db48b552f6b7650bf3255e05f80f00e3f7aad1b17ccb7898fdb",
  fetchedAt: new Date().toISOString(),
};

const ERC20 = ["function balanceOf(address) view returns (uint256)"];

let passed = 0, failed = 0;
async function t(name, fn) {
  try { await fn(); passed++; console.log(`PASS ${name}`); }
  catch (e) { failed++; console.error(`FAIL ${name}: ${e.message}`); }
}
async function expectRefusal(name, fn, needle) {
  await t(name, async () => {
    try { await fn(); } catch (e) {
      assert.ok(e.message.includes(needle), `wrong refusal: ${e.message}`);
      return;
    }
    throw new Error("was NOT refused");
  });
}

const provider = getProvider();
const net = await provider.getNetwork();
console.log(`fork chainId=${net.chainId}, rpc=${process.env.RPC_URL}`);

// --- setup: test pet + cheat-dealt ETH ---
const pet = {
  id: PET_ID, name: "Forky", breed: "scalper", live: true, liveTrading: true,
  aggression: 0.2, patience: 1, capUsd: 200, maxDailyLossPct: 5, slippagePct: 1.5,
  funder: FUNDER,
  diet: [{ symbol: "AAPL", address: AAPL.address }],
};
fs.mkdirSync("pets", { recursive: true });
fs.writeFileSync(PET_FILE, JSON.stringify(pet, null, 2));
fs.rmSync(`state/${PET_ID}.json`, { force: true });
fs.rmSync(`trades/${PET_ID}.jsonl`, { force: true });

const { address: petAddr, signer } = petWallet(PET_ID);
await provider.send("anvil_setBalance", [petAddr, "0x" + parseEther("1").toString(16)]);
console.log(`test pet wallet ${petAddr} dealt 1 ETH (anvil cheatcode)`);

const ethUsd = await ethUsdPrice(provider);
console.log(`ETH/USD via WETH-USDG 500bps pool: $${ethUsd.toFixed(2)}`);

// --- fee tier discovery evidence ---
await t("fee tier discovery finds a WETH/AAPL pool", async () => {
  const best = await bestFeeTier(ADDR.weth, AAPL.address, parseEther("0.01"), provider);
  console.log(`  best WETH->AAPL tier: ${best.fee} bps, pool ${best.pool}, quote ${formatEther(best.amountOut)} AAPL per 0.01 WETH`);
  assert.ok(best.amountOut > 0n);
});

// --- 1. wrap ---
await t("wrap ETH to WETH", async () => {
  await ensureWeth(signer, parseEther("0.05"));
  const bal = await wethContract(provider).balanceOf(petAddr);
  assert.ok(bal >= parseEther("0.05"), `weth balance ${formatEther(bal)}`);
});

// --- 2. live buy ---
const aapl = new Contract(AAPL.address, ERC20, provider);
let boughtQty = 0n;
await t("live buy $30 AAPL, balance increases", async () => {
  const before = await aapl.balanceOf(petAddr);
  const entry = await executeTrade({ pet, side: "buy", token: AAPL, sizeUsd: 30, signal: AAPL_SIGNAL, reason: "fork test buy" });
  const after = await aapl.balanceOf(petAddr);
  boughtQty = after - before;
  assert.ok(boughtQty > 0n, "no AAPL received");
  assert.ok(entry.txHash?.startsWith("0x"), "no tx hash");
  console.log(`  bought ${formatEther(boughtQty)} AAPL, fee tier ${entry.feeTier}, tx ${entry.txHash}`);
});

// --- risk rails ---
await expectRefusal("rail: oversize trade refused", () =>
  executeTrade({ pet, side: "buy", token: AAPL, sizeUsd: 100, signal: AAPL_SIGNAL }), "exceeds max");
await expectRefusal("rail: non-diet token refused", () =>
  executeTrade({ pet, side: "buy", token: NVDA, sizeUsd: 10, signal: { ...AAPL_SIGNAL, address: NVDA.address } }), "not in");
await expectRefusal("rail: thin pool refused", () =>
  executeTrade({ pet, side: "buy", token: AAPL, sizeUsd: 10, signal: { ...AAPL_SIGNAL, liquidityUsd: 1200 } }), "below $5000 floor");
await expectRefusal("rail: sleeping pet cannot buy", async () => {
  const stFile = `state/${PET_ID}.json`;
  const st = fs.existsSync(stFile)
    ? JSON.parse(fs.readFileSync(stFile, "utf8"))
    : { petId: PET_ID, positions: {}, realizedPnlUsd: 0, dailyPnl: { date: new Date().toISOString().slice(0, 10), realizedUsd: 0 }, sleeping: false };
  st.sleeping = true; fs.mkdirSync("state", { recursive: true }); fs.writeFileSync(stFile, JSON.stringify(st));
  try { await executeTrade({ pet, side: "buy", token: AAPL, sizeUsd: 10, signal: AAPL_SIGNAL }); }
  finally { st.sleeping = false; fs.writeFileSync(stFile, JSON.stringify(st)); }
}, "sleeping");
await expectRefusal("gate: liveTrading:false refused", () =>
  executeTrade({ pet: { ...pet, liveTrading: false }, side: "buy", token: AAPL, sizeUsd: 10, signal: AAPL_SIGNAL }), "liveTrading");

// --- 3. live sell ---
await t("live sell all AAPL back to WETH", async () => {
  const wethBefore = await wethContract(provider).balanceOf(petAddr);
  const entry = await executeTrade({ pet, side: "sell", token: AAPL, signal: AAPL_SIGNAL, reason: "fork test sell" });
  const wethAfter = await wethContract(provider).balanceOf(petAddr);
  assert.equal(await aapl.balanceOf(petAddr), 0n, "AAPL not fully sold");
  assert.ok(wethAfter > wethBefore, "WETH did not increase");
  console.log(`  sold for ${formatEther(wethAfter - wethBefore)} WETH, tx ${entry.txHash}`);
});

// --- 4. withdraw-all ---
await expectRefusal("withdraw: missing funder refused", async () => {
  const noFunder = { ...pet }; delete noFunder.funder;
  fs.writeFileSync(PET_FILE, JSON.stringify(noFunder));
  try { await withdrawAll(PET_ID); }
  finally { fs.writeFileSync(PET_FILE, JSON.stringify(pet, null, 2)); }
}, "funder");

await t("withdraw-all sends ETH to funder", async () => {
  // buy again so withdraw has a position to liquidate
  await executeTrade({ pet, side: "buy", token: AAPL, sizeUsd: 20, signal: AAPL_SIGNAL, reason: "pre-withdraw buy" });
  const funderBefore = await provider.getBalance(FUNDER);
  const res = await withdrawAll(PET_ID);
  const funderAfter = await provider.getBalance(FUNDER);
  assert.ok(res.ethSentWei > 0n, "no ETH sent");
  assert.equal(funderAfter - funderBefore, res.ethSentWei, "funder did not receive exact amount");
  assert.equal(await aapl.balanceOf(petAddr), 0n, "stock left behind");
  assert.equal(await wethContract(provider).balanceOf(petAddr), 0n, "WETH left behind");
  console.log(`  funder received ${formatEther(res.ethSentWei)} ETH over ${res.steps.length} step(s)`);
});

// --- teardown ---
fs.rmSync(PET_FILE, { force: true });
fs.rmSync(`state/${PET_ID}.json`, { force: true });

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
