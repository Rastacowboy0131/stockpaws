/* ============================================================
   STOCKPAWS wallet.js v2
   - EIP-6963 discovery + legacy window.ethereum fallback
   - Mobile deep links when no wallet injected
   - Auto switch/add Robinhood Chain (4663)
   - Watch-only blocked: connect requires personal_sign
   - PERSISTENT SESSION: the signed message + signature are kept
     in localStorage, so closing the site / new tabs stay logged
     in (up to 7 days) without re-signing. The same signature is
     what authenticates cloud saves in /api/state.
   - Multi-tab sync via the storage event
   - Disconnect wipes the session everywhere -> data locks again
   ============================================================ */
(function () {
  "use strict";

  const CHAIN = {
    chainId: "0x1237", // 4663
    chainName: "Robinhood Chain",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: ["https://rpc.mainnet.chain.robinhood.com"],
    blockExplorerUrls: ["https://robinhoodchain.blockscout.com"],
  };

  const SESSION_KEY = "stockpaws.session.v1";
  const SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

  const providers = new Map(); // uuid -> {info, provider}
  let active = null;
  let account = null;
  let verified = false;
  let session = null; // {address, message, signature, walletName, ts}

  const $ = (id) => document.getElementById(id);
  const connectBtn = $("connectBtn");
  const modal = $("walletModal");
  const modalClose = $("walletModalClose");
  const walletList = $("walletList");
  const deeplinks = $("walletDeeplinks");
  const statusBox = $("walletStatus");
  const disconnectBtn = $("disconnectBtn");

  // ---------- EIP-6963 ----------
  window.addEventListener("eip6963:announceProvider", (e) => {
    const { info, provider } = e.detail || {};
    if (info && provider && !providers.has(info.uuid)) {
      providers.set(info.uuid, { info, provider });
      if (!modal.hidden) renderWalletList();
    }
  });
  window.dispatchEvent(new Event("eip6963:requestProvider"));

  function legacyProviders() {
    const out = [];
    const eth = window.ethereum;
    if (!eth) return out;
    const list = Array.isArray(eth.providers) && eth.providers.length ? eth.providers : [eth];
    list.forEach((p, i) => {
      const name =
        p.isMetaMask ? "MetaMask" :
        p.isTrust || p.isTrustWallet ? "Trust Wallet" :
        p.isCoinbaseWallet ? "Coinbase Wallet" :
        p.isPhantom ? "Phantom" :
        p.isRabby ? "Rabby" :
        p.isOkxWallet || p.isOKExWallet ? "OKX Wallet" :
        "Browser Wallet";
      const dupe = [...providers.values()].some((x) => x.info.name === name);
      if (!dupe) out.push({ info: { uuid: "legacy-" + i, name, icon: "" }, provider: p });
    });
    return out;
  }
  const allProviders = () => [...providers.values(), ...legacyProviders()];

  // ---------- UI helpers ----------
  function toast(msg, ms = 2600) {
    const t = $("toast");
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(t._h);
    t._h = setTimeout(() => (t.hidden = true), ms);
  }
  window.spToast = toast;

  function setStatus(msg, isErr = false) {
    statusBox.hidden = !msg;
    statusBox.textContent = msg || "";
    statusBox.classList.toggle("err", isErr);
  }
  const shortAddr = (a) => (a ? a.slice(0, 6) + "…" + a.slice(-4) : "—");

  function openModal() {
    modal.hidden = false;
    document.body.style.overflow = "hidden";
    renderWalletList();
  }
  function closeModal() {
    modal.hidden = true;
    document.body.style.overflow = "";
    setStatus("");
  }

  function renderWalletList() {
    const found = allProviders();
    walletList.innerHTML = "";
    if (account && verified) {
      deeplinks.hidden = true;
      disconnectBtn.hidden = false;
      setStatus("Connected: " + shortAddr(account) + " ✅ verified owner. Session stays active on this device for 7 days.");
      return;
    }
    disconnectBtn.hidden = true;
    if (found.length === 0) {
      deeplinks.hidden = false;
      setupDeeplinks();
      return;
    }
    deeplinks.hidden = true;
    found.forEach((entry) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "wallet-opt";
      // EIP-6963 info comes from arbitrary extensions: never innerHTML it raw.
      if (entry.info.icon) {
        const img = document.createElement("img");
        img.src = entry.info.icon;
        img.alt = "";
        b.appendChild(img);
      } else {
        const s = document.createElement("span");
        s.style.fontSize = "1.4rem";
        s.textContent = "🦊";
        b.appendChild(s);
      }
      const nameSpan = document.createElement("span");
      nameSpan.textContent = entry.info.name;
      b.appendChild(nameSpan);
      b.addEventListener("click", () => connectWith(entry));
      walletList.appendChild(b);
    });
  }

  function setupDeeplinks() {
    const here = window.location.href.replace(/^https?:\/\//, "");
    $("dlMetaMask").href = "https://metamask.app.link/dapp/" + here;
    $("dlTrust").href = "https://link.trustwallet.com/open_url?coin_id=60&url=" + encodeURIComponent(window.location.href);
    $("dlCoinbase").href = "https://go.cb-w.com/dapp?cb_url=" + encodeURIComponent(window.location.href);
    $("dlPhantom").href = "https://phantom.app/ul/browse/" + encodeURIComponent(window.location.href) + "?ref=" + encodeURIComponent(window.location.origin);
  }

  // ---------- chain ----------
  async function ensureChain(provider) {
    try {
      await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: CHAIN.chainId }] });
    } catch (err) {
      if (err && (err.code === 4902 || (err.data && err.data.originalError && err.data.originalError.code === 4902))) {
        await provider.request({ method: "wallet_addEthereumChain", params: [CHAIN] });
      } else if (err && err.code === 4001) {
        throw new Error("Network switch rejected. Stay on Robinhood Chain to hunt.");
      } else {
        try { await provider.request({ method: "wallet_addEthereumChain", params: [CHAIN] }); } catch (_) {}
      }
    }
  }

  // ---------- session ----------
  function saveSession(s) {
    session = s;
    localStorage.setItem(SESSION_KEY, JSON.stringify(s));
  }
  function loadSession() {
    try {
      const raw = localStorage.getItem(SESSION_KEY);
      if (!raw) return null;
      const s = JSON.parse(raw);
      if (!s || !s.address || !s.signature || !s.message || !s.ts) return null;
      if (Date.now() - s.ts > SESSION_MAX_AGE_MS) { localStorage.removeItem(SESSION_KEY); return null; }
      return s;
    } catch { return null; }
  }
  function clearSession() {
    session = null;
    localStorage.removeItem(SESSION_KEY);
  }

  // ---------- connect ----------
  async function connectWith(entry) {
    try {
      setStatus("Requesting account…");
      const provider = entry.provider;
      const accounts = await provider.request({ method: "eth_requestAccounts" });
      if (!accounts || !accounts.length) throw new Error("No account returned by wallet.");
      const acct = accounts[0];

      setStatus("Switching to Robinhood Chain…");
      await ensureChain(provider);

      setStatus("Sign the message in your wallet to verify ownership (free, no gas)…");
      const issued = Date.now();
      const nonce = Math.random().toString(36).slice(2, 10).toUpperCase();
      const msg =
        "STOCKPAWS session\n\n" +
        "Signing proves this wallet is yours (watch-only wallets can't sign)\n" +
        "and unlocks your cloud saves. Free — no transaction is sent.\n\n" +
        "Wallet: " + acct + "\n" +
        "Issued: " + issued + "\n" +
        "Nonce: " + nonce;
      // Spec-compliant personal_sign takes HEX data. MetaMask tolerates plain
      // strings but Phantom/others reject them -> hex first, plain fallback.
      const msgHex = "0x" + Array.from(new TextEncoder().encode(msg))
        .map((b) => b.toString(16).padStart(2, "0")).join("");
      let sig;
      try {
        sig = await provider.request({ method: "personal_sign", params: [msgHex, acct] });
      } catch (e1) {
        if (e1 && e1.code === 4001) {
          throw new Error("Signature rejected. Watch-only wallets can't connect to STOCKPAWS.");
        }
        try {
          sig = await provider.request({ method: "personal_sign", params: [msg, acct] });
        } catch (e2) {
          throw new Error("Signature failed or was rejected. Watch-only wallets can't connect to STOCKPAWS.");
        }
      }
      if (!sig || typeof sig !== "string" || sig.length < 100) {
        throw new Error("Invalid signature. Watch-only wallets can't connect to STOCKPAWS.");
      }

      active = entry;
      account = acct;
      verified = true;
      saveSession({ address: acct, message: msg, signature: sig, walletName: entry.info.name, ts: issued });

      wireProviderEvents(provider);
      await refreshUI();
      renderWalletList();
      toast("Wallet connected 🐾");
      setTimeout(closeModal, 900);
      document.dispatchEvent(new CustomEvent("sp:connected", { detail: { account: acct } }));
    } catch (err) {
      // user rejection / watch-only is expected UX, surfaced in the modal — not an app error
      const expected = /rejected|Watch-only|Signature/i.test(err && err.message || "");
      if (!expected) console.error(err);
      verified = false;
      setStatus(err.message || "Connection failed.", true);
    }
  }

  // ---------- silent restore (new tab / reopened site) ----------
  async function restoreSession() {
    const s = loadSession();
    if (!s) { refreshUI(); return; }
    session = s;
    account = s.address;
    verified = true;
    refreshUI();
    document.dispatchEvent(new CustomEvent("sp:connected", { detail: { account, restored: true } }));

    // best-effort provider re-attach after wallets announce themselves
    setTimeout(async () => {
      const found = allProviders();
      if (!found.length) return; // e.g. plain mobile browser: session still valid for viewing data
      let entry = found.find((f) => f.info.name === s.walletName) || found[0];
      try {
        const accs = await entry.provider.request({ method: "eth_accounts" }); // silent, no popup
        if (Array.isArray(accs) && accs.length) {
          if (accs.some((a) => a.toLowerCase() === account.toLowerCase())) {
            active = entry;
            wireProviderEvents(entry.provider);
            refreshUI();
          } else {
            // wallet is now on a DIFFERENT account -> lock the old data
            doDisconnect("Wallet account changed — reconnect to verify the new one");
          }
        }
        // accs empty = wallet locked; keep the session (already proven owner)
      } catch (_) {}
    }, 600);
  }

  function wireProviderEvents(provider) {
    if (provider._spWired) return;
    provider._spWired = true;
    provider.on && provider.on("accountsChanged", (accs) => {
      if (!accs || !accs.length) return doDisconnect("Wallet disconnected");
      if (account && accs.some((a) => a.toLowerCase() === account.toLowerCase())) return;
      doDisconnect("Account changed — reconnect to verify ownership");
    });
    provider.on && provider.on("chainChanged", () => refreshUI());
    provider.on && provider.on("disconnect", () => {});
  }

  // ---------- disconnect (full logout) ----------
  function doDisconnect(msg) {
    clearSession();
    account = null;
    verified = false;
    active = null;
    refreshUI();
    renderWalletList();
    closeModal();
    if (msg) toast(msg);
    document.dispatchEvent(new CustomEvent("sp:disconnected"));
  }

  // ---------- multi-tab sync ----------
  window.addEventListener("storage", (e) => {
    if (e.key !== SESSION_KEY) return;
    if (!e.newValue && account) {
      // disconnected in another tab
      account = null; verified = false; active = null; session = null;
      refreshUI(); renderWalletList();
      toast("Logged out in another tab");
      document.dispatchEvent(new CustomEvent("sp:disconnected"));
    } else if (e.newValue && !account) {
      restoreSession(); // connected in another tab
    }
  });

  // ---------- balance ----------
  async function fetchBalance(addr) {
    try {
      if (active && active.provider) {
        const cid = await active.provider.request({ method: "eth_chainId" });
        if (cid === CHAIN.chainId) {
          const wei = await active.provider.request({ method: "eth_getBalance", params: [addr, "latest"] });
          return parseInt(wei, 16) / 1e18;
        }
      }
    } catch (_) {}
    try {
      const res = await fetch(CHAIN.rpcUrls[0], {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getBalance", params: [addr, "latest"] }),
      });
      const j = await res.json();
      return parseInt(j.result, 16) / 1e18;
    } catch (_) { return null; }
  }

  async function refreshUI() {
    const netDot = $("netDot");
    const netLabel = $("netLabel");
    const walletShort = $("walletShort");
    const vaultBal = $("vaultBal");
    const notice = $("deskNotice");

    if (account && verified) {
      connectBtn.textContent = shortAddr(account);
      netDot.classList.add("on");
      netLabel.textContent = "Connected · RH · 4663";
      walletShort.textContent = shortAddr(account);
      notice.textContent = "Leash secured. Your pet's progress saves to this wallet.";
      const bal = await fetchBalance(account);
      if (account) vaultBal.textContent = bal == null ? "— ETH" : bal.toFixed(4) + " ETH";
    } else {
      connectBtn.textContent = "Connect Wallet";
      netDot.classList.remove("on");
      netLabel.textContent = "Connect wallet · RH · 4663";
      walletShort.textContent = "—";
      vaultBal.textContent = "0.0000 ETH";
      notice.textContent = "Connect wallet (top right) to unlock your pet, saves, and hunts.";
    }
  }

  // ---------- public ----------
  window.spWallet = {
    get account() { return verified ? account : null; },
    get connected() { return !!(account && verified); },
    get session() { return verified && session ? { address: session.address, message: session.message, signature: session.signature } : null; },
    open: openModal,
    disconnect: () => doDisconnect("Disconnected — data locked until you reconnect"),
  };

  // ---------- events ----------
  connectBtn.addEventListener("click", openModal);
  modalClose.addEventListener("click", closeModal);
  modal.addEventListener("click", (e) => { if (e.target === modal) closeModal(); });
  disconnectBtn.addEventListener("click", () => window.spWallet.disconnect());
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !modal.hidden) closeModal(); });

  // restore after app.js has registered its listeners (same task queue)
  setTimeout(restoreSession, 0);
})();
