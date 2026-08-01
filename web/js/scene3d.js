/* ============================================================
   STOCKPAWS scene3d.js — Three.js floating gold coins
   - Real 3D spinning coins with lighting + depth over the world
   - Mobile-friendly: capped count, clamped DPR, pauses when the
     tab is hidden, disabled for prefers-reduced-motion
   - Graceful: if WebGL/Three fails, emoji floaties remain
   ============================================================ */
(function () {
  "use strict";
  if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  if (typeof THREE === "undefined") return;

  const canvas = document.getElementById("fx3d");
  if (!canvas) return;

  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
  } catch (e) { return; }

  const DPR = Math.min(window.devicePixelRatio || 1, 2);
  renderer.setPixelRatio(DPR);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
  camera.position.set(0, 0, 16);

  // warm cartoon lighting
  scene.add(new THREE.AmbientLight(0xfff2d0, 0.85));
  const sun = new THREE.DirectionalLight(0xffffff, 1.0);
  sun.position.set(4, 8, 6);
  scene.add(sun);
  const fill = new THREE.DirectionalLight(0xB48CFF, 0.35);
  fill.position.set(-6, -2, 4);
  scene.add(fill);

  // ---- paw face texture (drawn on a canvas -> crisp cartoon paw) ----
  function pawTexture() {
    const c = document.createElement("canvas");
    c.width = c.height = 256;
    const x = c.getContext("2d");
    x.fillStyle = "#FFC531";
    x.fillRect(0, 0, 256, 256);
    // rim ring
    x.strokeStyle = "#E89B00";
    x.lineWidth = 18;
    x.beginPath(); x.arc(128, 128, 108, 0, Math.PI * 2); x.stroke();
    // paw print
    x.fillStyle = "#B77400";
    const pad = (px, py, rx, ry) => { x.beginPath(); x.ellipse(px, py, rx, ry, 0, 0, Math.PI * 2); x.fill(); };
    pad(128, 152, 44, 38);          // palm
    pad(84, 96, 17, 21); pad(128, 84, 17, 21); pad(172, 96, 17, 21); // toes
    // shine
    x.fillStyle = "rgba(255,255,255,.55)";
    x.beginPath(); x.ellipse(88, 76, 30, 16, -0.6, 0, Math.PI * 2); x.fill();
    const t = new THREE.CanvasTexture(c);
    return t;
  }

  const faceTex = pawTexture();
  const isMobile = Math.min(window.innerWidth, window.innerHeight) < 760;
  const COUNT = isMobile ? 9 : 16;

  const edgeMat = new THREE.MeshStandardMaterial({ color: 0xE0A200, metalness: 0.5, roughness: 0.32 });
  const faceMat = new THREE.MeshStandardMaterial({ map: faceTex, metalness: 0.35, roughness: 0.38 });
  const geo = new THREE.CylinderGeometry(1, 1, 0.24, 40);

  const coins = [];
  for (let i = 0; i < COUNT; i++) {
    const m = new THREE.Mesh(geo, [edgeMat, faceMat, faceMat]);
    m.rotation.x = Math.PI / 2; // face the camera
    const s = 0.45 + Math.random() * 0.6;
    m.scale.setScalar(s);
    m.position.set(
      (Math.random() - 0.5) * 22,
      (Math.random() - 0.5) * 13,
      -4 - Math.random() * 8
    );
    m.userData = {
      spin: 0.008 + Math.random() * 0.02,
      bobA: 0.4 + Math.random() * 0.8,
      bobS: 0.5 + Math.random() * 0.8,
      phase: Math.random() * Math.PI * 2,
      baseY: m.position.y,
    };
    scene.add(m);
    coins.push(m);
  }

  function resize() {
    const w = window.innerWidth, h = window.innerHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  resize();
  window.addEventListener("resize", resize);

  let running = true;
  document.addEventListener("visibilitychange", () => { running = !document.hidden; if (running) tick(); });

  let t = 0;
  function tick() {
    if (!running) return;
    t += 0.016;
    for (const c of coins) {
      c.rotation.z += c.userData.spin;           // coin spin
      c.position.y = c.userData.baseY + Math.sin(t * c.userData.bobS + c.userData.phase) * c.userData.bobA;
    }
    renderer.render(scene, camera);
    requestAnimationFrame(tick);
  }
  tick();
})();
