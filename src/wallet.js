// Wallet layer: derive per-pet wallets from a master BIP39 seed.
// PAPER MODE: signers exist but are never funded and never send transactions.
import { HDNodeWallet, Mnemonic, JsonRpcProvider, NonceManager } from "ethers";

// NOTE: rpc.robinhoodchain.com fails TLS (unrecognized name), do not use it.
const RPC_URL = process.env.RPC_URL || "https://rpc.mainnet.chain.robinhood.com";
export const CHAIN_ID = 4663;

let provider = null;
export function getProvider() {
  if (!provider) provider = new JsonRpcProvider(RPC_URL, undefined, { staticNetwork: true });
  return provider;
}

// Deterministic index per petId (simple stable hash of the id string).
function petIndex(petId) {
  let h = 0;
  for (const c of petId) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h % 2147483647;
}

// petWallet(petId) -> { address, signer, path }
// signer is wrapped in a NonceManager (cached per pet) so back-to-back
// approve/swap transactions never race on nonces.
const signerCache = new Map();
export function petWallet(petId) {
  const seedPhrase = process.env.MASTER_SEED;
  if (!seedPhrase) throw new Error("MASTER_SEED env var not set (see .env.example)");
  const mnemonic = Mnemonic.fromPhrase(seedPhrase.trim());
  const path = `m/44'/60'/0'/0/${petIndex(petId)}`;
  const wallet = HDNodeWallet.fromMnemonic(mnemonic, path);
  if (!signerCache.has(petId)) {
    signerCache.set(petId, new NonceManager(wallet.connect(getProvider())));
  }
  const signer = signerCache.get(petId);
  signer.address = wallet.address;
  return { address: wallet.address, signer, path };
}
