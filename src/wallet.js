// Wallet layer: derive per-pet wallets from a master BIP39 seed.
// PAPER MODE: signers exist but are never funded and never send transactions.
import { HDNodeWallet, Mnemonic, JsonRpcProvider } from "ethers";

const RPC_URL = process.env.RPC_URL || "https://rpc.robinhoodchain.com";
export const CHAIN_ID = 46896;

let provider = null;
export function getProvider() {
  if (!provider) provider = new JsonRpcProvider(RPC_URL, CHAIN_ID);
  return provider;
}

// Deterministic index per petId (simple stable hash of the id string).
function petIndex(petId) {
  let h = 0;
  for (const c of petId) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h % 2147483647;
}

// petWallet(petId) -> { address, signer, path }
export function petWallet(petId) {
  const seedPhrase = process.env.MASTER_SEED;
  if (!seedPhrase) throw new Error("MASTER_SEED env var not set (see .env.example)");
  const mnemonic = Mnemonic.fromPhrase(seedPhrase.trim());
  const path = `m/44'/60'/0'/0/${petIndex(petId)}`;
  const wallet = HDNodeWallet.fromMnemonic(mnemonic, path);
  return { address: wallet.address, signer: wallet.connect(getProvider()), path };
}
