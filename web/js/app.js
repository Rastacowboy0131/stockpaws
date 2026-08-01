/* ============================================================
   STOCKPAWS app.js v2 — per-wallet saves + cloud sync
   >>> EDIT THE CONFIG BLOCK BELOW BEFORE LAUNCH <<<

   Data model:
   - Disconnected = locked demo state. Actions prompt connect.
   - Connected    = state keyed to the wallet address:
       1) local cache  stockpaws.desk.<address>   (instant)
       2) cloud        POST /api/state (Supabase) (cross-device)
     Cloud wins on load; saves are debounced to both.
     If /api/state isn't deployed/configured yet, the site
     silently keeps working on local cache alone.
   ============================================================ */
(function () {
  "use strict";

  // ================== CONFIG — REPLACE PLACEHOLDERS ==================
  const CONFIG = {
    CONTRACT_ADDRESS: "TBA",  // $PAWS CA - set at launch
    BUY_LINK: "#",            // dex/launchpad buy page
    X_LINK: "#",              // X / Twitter
    TELEGRAM_LINK: "#",       // Telegram
  };
  // ===================================================================

  const $ = (id) => document.getElementById(id);

  // ---------- links ----------
  $("caText").textContent = CONFIG.CONTRACT_ADDRESS;
  ["buyBtn", "buyBtnHero", "buyBtnFooter"].forEach((id) => ($(id).href = CONFIG.BUY_LINK));
  $("xLink").href = CONFIG.X_LINK;
  $("tgLink").href = CONFIG.TELEGRAM_LINK;

  $("copyCaBtn").addEventListener("click", async () => {
    if (CONFIG.CONTRACT_ADDRESS === "TBA") {
      window.spToast("token not launched yet 🐾");
      return;
    }
    try {
      await navigator.clipboard.writeText(CONFIG.CONTRACT_ADDRESS);
      window.spToast("CA copied 🐾");
    } catch {
      const ta = document.createElement("textarea");
      ta.value = CONFIG.CONTRACT_ADDRESS;
      document.body.appendChild(ta); ta.select();
      document.execCommand("copy"); ta.remove();
      window.spToast("CA copied 🐾");
    }
  });

  // ---------- tickers ----------
  const TICKERS = [
    ["NVDA","NVIDIA"],["AAPL","Apple"],["GOOGL","Alphabet"],["MSFT","Microsoft"],
    ["AMZN","Amazon"],["META","Meta"],["TSLA","Tesla"],["AMD","AMD"],
    ["QQQ","Invesco QQQ"],["SPY","S&P 500 ETF"],["IWM","Russell 2000"],["GME","GameStop"],
    ["HOOD","Robinhood"],["COIN","Coinbase"],["PLTR","Palantir"],["NFLX","Netflix"],
    ["DIS","Disney"],["BA","Boeing"],["XOM","Exxon"],["JPM","JPMorgan"],
  ];
  const grid = $("tickerGrid");
  function renderTickers(filter) {
    const f = (filter || "").trim().toLowerCase();
    grid.innerHTML = "";
    let n = 0;
    TICKERS.forEach(([tk, nm]) => {
      if (f && !tk.toLowerCase().includes(f) && !nm.toLowerCase().includes(f)) return;
      const d = document.createElement("div");
      d.className = "ticker-chip";
      d.innerHTML = `<span class="tk">$${tk}</span><span class="nm">${nm}</span>`;
      grid.appendChild(d); n++;
    });
    $("tickerCount").textContent = n + " shown";
  }
  renderTickers("");
  $("tickerFilter").addEventListener("input", (e) => renderTickers(e.target.value));

  // ---------- pets ----------
  const PETS = {
    waffles: { name:"Waffles", role:"Scalper",  mood:"😺", img:"assets/pets/waffles-1.png", tickers:["NVDA","AAPL","QQQ"] },
    vix:     { name:"Vix",     role:"Sniper",   mood:"🦊", img:"assets/pets/vix-1.png",     tickers:["TSLA","AMD","COIN"] },
    scout:   { name:"Scout",   role:"Guardian", mood:"🐶", img:"assets/pets/scout-3.png",   tickers:["SPY","MSFT","JPM"] },
    moss:    { name:"Moss",    role:"Swing",    mood:"🌿", img:"assets/pets/moss-1.png",    tickers:["GOOGL","AMZN","DIS"] },
  };

  const DEFAULT_STATE = {
    pet:"waffles", xp:40, level:1,
    energy:74, trust:62, edge:41, streak:2, hunger:72, bond:62,
    autonomy:25, pnl:0, trades:[],
  };

  let S = { ...DEFAULT_STATE };
  let owner = null;           // wallet address the current state belongs to
  let cloudOk = true;         // flips false if /api/state is missing/unconfigured
  let saveTimer = null;

  const lsKey = (addr) => "stockpaws.desk." + addr.toLowerCase();
  const clamp = (v) => Math.max(0, Math.min(100, Math.round(v)));

  // ---------- storage ----------
  function loadLocal(addr) {
    try { return JSON.parse(localStorage.getItem(lsKey(addr)) || "null"); } catch { return null; }
  }
  function saveLocal(addr, state) {
    try { localStorage.setItem(lsKey(addr), JSON.stringify(state)); } catch {}
  }

  async function apiCall(action, extra) {
    const sess = window.spWallet && window.spWallet.session;
    if (!sess || !cloudOk) return null;
    try {
      const res = await fetch("/api/state", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...sess, action, ...extra }),
      });
      if (res.status === 503 || res.status === 404 || res.status === 405) {
        cloudOk = false; // storage not set up yet — local-only mode
        console.info("STOCKPAWS: cloud saves not configured, using local cache.");
        return null;
      }
      if (!res.ok) return null;
      return await res.json();
    } catch {
      return null; // network hiccup — local cache still has it
    }
  }

  function save() {
    if (!owner) return; // locked mode never persists
    saveLocal(owner, S);
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => apiCall("save", { state: S }), 1200);
  }

  async function loadFor(addr) {
    owner = addr;
    const local = loadLocal(addr);
    S = Object.assign({}, DEFAULT_STATE, local || {});
    renderDesk(); // instant paint from cache
    const cloud = await apiCall("load");
    if (cloud && cloud.state && owner === addr) {
      S = Object.assign({}, DEFAULT_STATE, cloud.state); // cloud wins (cross-device truth)
      saveLocal(addr, S);
      renderDesk();
    }
  }

  function lock() {
    owner = null;
    S = { ...DEFAULT_STATE };
    prop = null;
    $("proposal").hidden = true;
    renderDesk();
    log("logged out. connect wallet to load your pet.");
  }

  // ---------- render ----------
  function log(line) {
    $("petLog").innerHTML = `<span class="log-name">${PETS[S.pet].name.toUpperCase()}</span> ${line}`;
  }

  function renderDesk() {
    const p = PETS[S.pet];
    $("petAvatar").src = p.img;
    $("petMood").textContent = S.hunger < 30 ? "😿" : S.trust > 75 ? "😻" : p.mood;
    $("petName").textContent = p.name;
    const funded = !!owner;
    $("petMeta").textContent = `${p.role} · bond ${S.bond}% · ${funded ? "Funded" : "Unfunded"}`;
    const need = 220 * S.level;
    $("xpFill").style.width = clamp((S.xp / need) * 100) + "%";
    $("xpText").textContent = `${S.xp}/${need} xp`;
    $("lvlBadge").textContent = "Lv " + S.level;
    $("pnlBadge").textContent = (S.pnl >= 0 ? "+" : "") + S.pnl.toFixed(2) + " sim";
    $("stEnergy").textContent = S.energy;
    $("stTrust").textContent = S.trust;
    $("stEdge").textContent = S.edge;
    $("stStreak").textContent = S.streak + "🔥";
    $("hungerFill").style.width = S.hunger + "%";
    $("hungerVal").textContent = S.hunger;
    $("autonomy").value = S.autonomy;
    $("autonomyVal").textContent = S.autonomy + "%";
    document.querySelectorAll(".pick").forEach((b) => b.classList.toggle("active", b.dataset.pet === S.pet));
    renderTrades();
  }

  function renderTrades() {
    const ul = $("tradeList");
    ul.innerHTML = "";
    if (!owner) {
      ul.innerHTML = `<li class="trade-empty">🔒 Connect wallet to view your hunts.</li>`;
      return;
    }
    if (!S.trades.length) {
      ul.innerHTML = `<li class="trade-empty">No hunts yet. Scan stocks to get a proposal.</li>`;
      return;
    }
    S.trades.slice(0, 6).forEach((t) => {
      const li = document.createElement("li");
      const cls = t.pl >= 0 ? "trade-pl-pos" : "trade-pl-neg";
      li.innerHTML = `<span>$${t.tk} ${t.side} ${t.qty} @ ${t.px}</span><span class="${cls}">${t.pl >= 0 ? "+" : ""}$${t.pl.toFixed(2)}</span>`;
      ul.appendChild(li);
    });
  }

  function gainXp(n) {
    S.xp += n;
    const need = 220 * S.level;
    if (S.xp >= need) { S.xp -= need; S.level++; window.spToast(`${PETS[S.pet].name} leveled up! Lv ${S.level} 🎉`); }
  }

  // ---------- actions (locked until connected) ----------
  function requireWallet() {
    if (owner) return true;
    log("connect wallet first, human. no leash, no data.");
    window.spWallet && window.spWallet.open();
    return false;
  }

  const LINES = {
    feed:   ["nom nom. energy up!", "treats accepted. ready to hunt.", "fuel loaded. tickers look tasty."],
    praise: ["tail wagging. trust up!", "good human. bond deepens.", "purring at the chart."],
    scold:  ["...fine. dialing back the size.", "noted. discipline restored.", "aggression tucked away."],
  };
  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

  document.querySelectorAll("[data-act]").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (!requireWallet()) return;
      const act = btn.dataset.act;
      if (act === "feed")   { S.hunger = clamp(S.hunger + 18); S.energy = clamp(S.energy + 8); gainXp(6); log(pick(LINES.feed)); }
      if (act === "praise") { S.trust = clamp(S.trust + 6);  S.bond = clamp(S.bond + 4);      gainXp(8); log(pick(LINES.praise)); }
      if (act === "scold")  { S.edge = clamp(S.edge + 5);   S.trust = clamp(S.trust - 2);     gainXp(4); log(pick(LINES.scold)); }
      if (act === "scan")   { return scan(); }
      save(); renderDesk();
    });
  });

  // ---------- sim hunt (labeled SIM; wire real hunts here when contracts ship) ----------
  const BASE_PX = { NVDA:950, AAPL:189, QQQ:480, TSLA:177, AMD:165, COIN:310, SPY:560, MSFT:430, JPM:260, GOOGL:188, AMZN:188, DIS:112 };
  let prop = null;

  function scan() {
    if (S.hunger < 15) { log("too hungry to hunt. feed me first."); renderDesk(); return; }
    const p = PETS[S.pet];
    const tk = pick(p.tickers);
    const px = (BASE_PX[tk] * (0.97 + Math.random() * 0.06)).toFixed(2);
    const side = Math.random() > 0.35 ? "LONG" : "SHORT";
    const qty = 1 + Math.floor(Math.random() * 10);
    prop = { tk, px, side, qty };
    $("propTicker").textContent = "$" + tk;
    $("propBody").textContent = `${side} ${qty} @ ${px}`;
    $("proposal").hidden = false;
    S.hunger = clamp(S.hunger - 8);
    S.energy = clamp(S.energy - 5);
    log(`spotted $${tk}. proposal up — approve or veto, you hold the leash.`);
    save(); renderDesk();
  }

  $("approveBtn").addEventListener("click", () => {
    if (!prop || !requireWallet()) return;
    const pl = +((Math.random() * 8 - 2.8) * (1 + S.edge / 100)).toFixed(2);
    S.trades.unshift({ ...prop, pl });
    S.trades = S.trades.slice(0, 50);
    S.pnl = +(S.pnl + pl).toFixed(2);
    if (pl >= 0) { S.streak++; S.edge = clamp(S.edge + 2); log(`hunt closed +$${pl.toFixed(2)} (sim). feed me a win treat?`); }
    else { S.streak = 0; S.trust = clamp(S.trust - 3); log(`hunt closed -$${Math.abs(pl).toFixed(2)} (sim). scold me if you must.`); }
    gainXp(14);
    prop = null; $("proposal").hidden = true;
    save(); renderDesk();
  });

  $("vetoBtn").addEventListener("click", () => {
    if (!prop || !requireWallet()) return;
    S.trust = clamp(S.trust + 2); S.edge = clamp(S.edge + 1);
    log("vetoed. discipline logged — the pet learns your taste.");
    gainXp(5);
    prop = null; $("proposal").hidden = true;
    save(); renderDesk();
  });

  // ---------- pet picker / autonomy ----------
  document.querySelectorAll(".pick").forEach((b) => {
    b.addEventListener("click", () => {
      if (!requireWallet()) return;
      S.pet = b.dataset.pet;
      prop = null; $("proposal").hidden = true;
      log("linked · " + PETS[S.pet].role);
      save(); renderDesk();
    });
  });
  $("autonomy").addEventListener("input", (e) => {
    S.autonomy = +e.target.value;
    $("autonomyVal").textContent = S.autonomy + "%";
    if (owner) save();
  });

  // ---------- wallet hooks ----------
  function onConnected(addr, restored) {
    if (!addr || owner === addr) return;
    loadFor(addr);
    log(restored ? "welcome back. leash still on. 🐾" : "leash secured. your pet now saves to this wallet.");
  }
  document.addEventListener("sp:connected", (e) => onConnected(e.detail.account, e.detail.restored));
  document.addEventListener("sp:disconnected", lock);

  renderDesk();

  // Restore race guard: wallet.js may restore the session in the task gap
  // BEFORE this script's listeners exist. Pull the state directly too.
  function checkRestored() {
    if (window.spWallet && window.spWallet.connected) onConnected(window.spWallet.account, true);
  }
  checkRestored();
  setTimeout(checkRestored, 120);
  setTimeout(checkRestored, 600);
})();
