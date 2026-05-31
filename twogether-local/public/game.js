// Twogether — real-time spike client (PartyKit-free / plain WebSocket build).
// Plain ES module, no bundler. Realtime via the native WebSocket API; QR via the qrcode pkg (CDN).
import QRCode from "https://esm.sh/qrcode";

// ---- world constants (MUST match src/shared.ts) ---------------------------
const WORLD_W = 1280,
  WORLD_H = 720;
const PLAYER_SPEED = 340,
  PLAYER_RADIUS = 26;
const ORB_RADIUS = 30,
  GRAB_RADIUS = 95,
  MAX_STRETCH = 380;
// ---- level geometry (MUST match server.mjs) ----
const IGNITE = { x: 380, y: 360 }, IGNITE_R = 120;
const LOCK = { x: 820, y: 360 }, LOCK_R = 72;
const GATE_X = 980;
const DOOR_EMBER = { x: 1066, y: 96, w: 176, h: 200, name: "EMBER" };
const DOOR_TIDE = { x: 1066, y: 424, w: 176, h: 200, name: "TIDE" };

// ---- network cadence ------------------------------------------------------
const INPUT_MS = 50; // send input 20x/sec
const PING_MS = 1000;
const INTERP_MS = 100; // render remote entities this far in the past for smoothness

// ---- dom ------------------------------------------------------------------
const $ = (id) => document.getElementById(id);
const canvas = $("game");
const ctx = canvas.getContext("2d");

// ---- state ----------------------------------------------------------------
let socket = null;
let roomId = null;
let mySlot = 0;
let presence = { count: 0, slots: [] };
let snaps = []; // {rt, slots:{1:{x,y,grab},2:{...}}, ox, oy, held, won, stretch}
let won = false;
let screen = "home";

const local = { x: 0, y: 0, init: false }; // client-side prediction of OWN avatar
let lastSentAt = 0;
let lastSent = { mvx: 0, mvy: 0, grab: false };

let rttEMA = null;
let pingId = 0;
let simOneWay = 0; // simulated one-way latency in ms (added round-trip = 2x this)
let introDone = false; // chapter intro card shown once

// counters
let frames = 0,
  fpsT = 0,
  fps = 0;
let stCount = 0,
  stT = 0,
  stRate = 0;
let desync = 0;

// ---- input ----------------------------------------------------------------
const keys = new Set();
let joy = { x: 0, y: 0 };
let joyActive = false;
let grabActive = false;
let stickId = null,
  grabId = null;
let stickOrigin = { x: 0, y: 0 };
const STICK_R = 55;

const stickEl = $("stick"),
  knobEl = $("stick-knob"),
  grabEl = $("grab");

addEventListener("keydown", (e) => {
  keys.add(e.key.toLowerCase());
  if (e.key === " ") e.preventDefault();
});
addEventListener("keyup", (e) => keys.delete(e.key.toLowerCase()));

addEventListener("pointerdown", (e) => {
  if (screen !== "play") return;
  const half = innerWidth * 0.5;
  if (e.clientX < half && stickId === null) {
    stickId = e.pointerId;
    stickOrigin = { x: e.clientX, y: e.clientY };
    stickEl.style.left = e.clientX + "px";
    stickEl.style.top = e.clientY + "px";
    stickEl.classList.add("on");
    knobEl.style.transform = "translate(-50%, -50%)";
    joy = { x: 0, y: 0 };
    joyActive = true;
  } else if (e.clientX >= half && grabId === null) {
    grabId = e.pointerId;
    grabActive = true;
    grabEl.classList.add("on");
  }
});
addEventListener("pointermove", (e) => {
  if (e.pointerId === stickId) {
    const dx = e.clientX - stickOrigin.x,
      dy = e.clientY - stickOrigin.y;
    const len = Math.hypot(dx, dy);
    const cl = Math.min(len, STICK_R);
    const ang = Math.atan2(dy, dx);
    const kx = Math.cos(ang) * cl,
      ky = Math.sin(ang) * cl;
    knobEl.style.transform = `translate(calc(-50% + ${kx}px), calc(-50% + ${ky}px))`;
    joy = { x: (Math.cos(ang) * cl) / STICK_R, y: (Math.sin(ang) * cl) / STICK_R };
  }
});
function endPointer(e) {
  if (e.pointerId === stickId) {
    stickId = null;
    joyActive = false;
    joy = { x: 0, y: 0 };
    stickEl.classList.remove("on");
  }
  if (e.pointerId === grabId) {
    grabId = null;
    grabActive = false;
    grabEl.classList.remove("on");
  }
}
addEventListener("pointerup", endPointer);
addEventListener("pointercancel", endPointer);

function readInput() {
  let mvx = 0,
    mvy = 0;
  if (joyActive) {
    mvx = joy.x;
    mvy = joy.y;
  } else {
    if (keys.has("a") || keys.has("arrowleft")) mvx -= 1;
    if (keys.has("d") || keys.has("arrowright")) mvx += 1;
    if (keys.has("w") || keys.has("arrowup")) mvy -= 1;
    if (keys.has("s") || keys.has("arrowdown")) mvy += 1;
  }
  const grab = grabActive || keys.has(" ");
  return { mvx, mvy, grab };
}

// ---- networking -----------------------------------------------------------
function connect(room) {
  roomId = room;
  openSocket();
  startPing();
}
function openSocket() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  socket = new WebSocket(`${proto}://${location.host}/?room=${encodeURIComponent(roomId)}`);
  socket.addEventListener("message", onMessage);
  socket.addEventListener("close", () => {
    // simple auto-reconnect (covers Wi-Fi/cellular blips, screen lock, etc.)
    if (roomId) setTimeout(openSocket, 1000);
  });
}

// All outbound traffic goes through here so the latency simulator can delay it.
function netSend(obj) {
  const s = JSON.stringify(obj);
  const doSend = () => {
    if (socket && socket.readyState === 1) socket.send(s);
  };
  if (simOneWay > 0) setTimeout(doSend, simOneWay);
  else doSend();
}

function onMessage(e) {
  let m;
  try {
    m = JSON.parse(e.data);
  } catch {
    return;
  }
  // Simulate inbound latency by delaying when we *process* the message.
  if (simOneWay > 0) setTimeout(() => handleMessage(m), simOneWay);
  else handleMessage(m);
}

function handleMessage(m) {
  if (m.t === "state") {
    const slots = {};
    for (const p of m.players) slots[p.slot] = { x: p.x, y: p.y, grab: p.grab };
    snaps.push({ rt: performance.now(), slots, ox: m.ox, oy: m.oy, held: m.held, won: m.won, stretch: m.stretch, stage: m.stage, orbActive: m.orbActive, gateOpen: m.gateOpen, door: m.door });
    if (snaps.length > 16) snaps.shift();
    won = m.won;
    stCount++;
    if (won && screen === "play") showWin();
  } else if (m.t === "welcome") {
    mySlot = m.slot;
  } else if (m.t === "presence") {
    presence = m;
    updateLobby();
    updateBanner();
  } else if (m.t === "pong") {
    const r = performance.now() - m.c;
    rttEMA = rttEMA == null ? r : rttEMA * 0.8 + r * 0.2;
  }
}

function startPing() {
  setInterval(() => {
    if (socket && socket.readyState === 1) {
      const id = ++pingId;
      netSend({ t: "ping", id, c: performance.now() });
    }
  }, PING_MS);
}

function sendInput(force) {
  const now = performance.now();
  const i = readInput();
  const changed = i.grab !== lastSent.grab;
  if (!force && !changed && now - lastSentAt < INPUT_MS) return;
  lastSentAt = now;
  lastSent = i;
  netSend({ t: "input", ...i });
}

// ---- helpers --------------------------------------------------------------
function latestSnap() {
  return snaps[snaps.length - 1];
}

// entity interpolation at (now - INTERP_MS) using local receive timestamps
function interpAt(targetT) {
  if (snaps.length === 0) return null;
  if (snaps.length === 1) return snaps[0];
  let a = snaps[0],
    b = snaps[snaps.length - 1];
  for (let i = 0; i < snaps.length - 1; i++) {
    if (snaps[i].rt <= targetT && snaps[i + 1].rt >= targetT) {
      a = snaps[i];
      b = snaps[i + 1];
      break;
    }
  }
  const span = b.rt - a.rt || 1;
  const f = Math.max(0, Math.min(1, (targetT - a.rt) / span));
  return { a, b, f };
}

function lerp(a, b, f) {
  return a + (b - a) * f;
}

// ---- main loop ------------------------------------------------------------
let lastFrame = performance.now();
function frame(now) {
  const dt = Math.min(0.05, (now - lastFrame) / 1000);
  lastFrame = now;

  // fps / state-rate counters
  frames++;
  if (now - fpsT > 500) {
    fps = Math.round((frames * 1000) / (now - fpsT));
    frames = 0;
    fpsT = now;
    stRate = Math.round((stCount * 1000) / (now - stT));
    stCount = 0;
    stT = now;
  }

  if (screen === "play" || screen === "win") {
    updatePrediction(dt);
    sendInput(false);
    draw();
    updateHud();
    updateObjective();
  }
  requestAnimationFrame(frame);
}

function updatePrediction(dt) {
  if (mySlot !== 1 && mySlot !== 2) return;
  const i = readInput();
  let { mvx, mvy } = i;
  const m = Math.hypot(mvx, mvy);
  if (m > 1) {
    mvx /= m;
    mvy /= m;
  }
  const snap = latestSnap();
  const auth = snap && snap.slots[mySlot];
  if (!local.init && auth) {
    local.x = auth.x;
    local.y = auth.y;
    local.init = true;
  }
  // predict immediately for responsive feel
  local.x = clamp(local.x + mvx * PLAYER_SPEED * dt, PLAYER_RADIUS, WORLD_W - PLAYER_RADIUS);
  local.y = clamp(local.y + mvy * PLAYER_SPEED * dt, PLAYER_RADIUS, WORLD_H - PLAYER_RADIUS);
  // softly reconcile toward the server's authoritative position
  if (auth) {
    desync = Math.hypot(local.x - auth.x, local.y - auth.y);
    local.x += (auth.x - local.x) * 0.12;
    local.y += (auth.y - local.y) * 0.12;
  }
}

// ---- rendering ------------------------------------------------------------
let view = { scale: 1, ox: 0, oy: 0 };
function resize() {
  const dpr = Math.min(2, devicePixelRatio || 1);
  canvas.width = Math.floor(innerWidth * dpr);
  canvas.height = Math.floor(innerHeight * dpr);
  const scale = Math.min(innerWidth / WORLD_W, innerHeight / WORLD_H);
  view.scale = scale * dpr;
  view.ox = (canvas.width - WORLD_W * view.scale) / 2;
  view.oy = (canvas.height - WORLD_H * view.scale) / 2;
}
addEventListener("resize", resize);

function wx(x) {
  return view.ox + x * view.scale;
}
function wy(y) {
  return view.oy + y * view.scale;
}
function ws(v) {
  return v * view.scale;
}

function draw() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // arena floor
  ctx.fillStyle = "#0e1430";
  ctx.fillRect(wx(0), wy(0), ws(WORLD_W), ws(WORLD_H));
  ctx.strokeStyle = "rgba(141,151,196,0.18)";
  ctx.lineWidth = ws(2);
  ctx.strokeRect(wx(0), wy(0), ws(WORLD_W), ws(WORLD_H));

  // stage-aware level geometry
  const snapNow = latestSnap();
  const stage = snapNow ? snapNow.stage : "ignite";
  const gateOpen = snapNow ? snapNow.gateOpen : false;
  const orbActive = snapNow ? snapNow.orbActive : false;
  drawLevel(stage, gateOpen);

  // interpolated remote + orb
  const interp = interpAt(performance.now() - INTERP_MS);
  let p1 = null,
    p2 = null,
    orb = null,
    held = false,
    stretch = 0;
  if (interp) {
    if (interp.a) {
      const { a, b, f } = interp;
      orb = { x: lerp(a.ox, b.ox, f), y: lerp(a.oy, b.oy, f) };
      held = b.held;
      stretch = b.stretch;
      const g1a = a.slots[1],
        g1b = b.slots[1];
      if (g1a && g1b) p1 = { x: lerp(g1a.x, g1b.x, f), y: lerp(g1a.y, g1b.y, f), grab: g1b.grab };
      const g2a = a.slots[2],
        g2b = b.slots[2];
      if (g2a && g2b) p2 = { x: lerp(g2a.x, g2b.x, f), y: lerp(g2a.y, g2b.y, f), grab: g2b.grab };
    } else {
      orb = { x: interp.ox, y: interp.oy };
      held = interp.held;
      stretch = interp.stretch;
      p1 = interp.slots[1];
      p2 = interp.slots[2];
    }
  }

  // override OWN avatar with predicted position
  if (mySlot === 1 && local.init) p1 = { ...(p1 || {}), x: local.x, y: local.y };
  if (mySlot === 2 && local.init) p2 = { ...(p2 || {}), x: local.x, y: local.y };

  // carry tether
  if (p1 && p2 && held) {
    const near = stretch > MAX_STRETCH * 0.8;
    ctx.strokeStyle = near ? "rgba(255,107,122,0.9)" : "rgba(255,255,255,0.5)";
    ctx.lineWidth = ws(near ? 6 : 3);
    ctx.beginPath();
    ctx.moveTo(wx(p1.x), wy(p1.y));
    ctx.lineTo(wx(p2.x), wy(p2.y));
    ctx.stroke();
  }

  // orb — dormant grey until ignited, then a glowing carried light
  if (orb) {
    ctx.beginPath();
    ctx.arc(wx(orb.x), wy(orb.y), ws(ORB_RADIUS), 0, 7);
    ctx.fillStyle = orbActive ? "#ffd76b" : "#5a6088";
    ctx.fill();
    if (orbActive) {
      ctx.shadowColor = "#ffd76b";
      ctx.shadowBlur = ws(held ? 30 : 16);
      ctx.fill();
      ctx.shadowBlur = 0;
    }
  }

  if (p1) drawPlayer(p1, "#36e0c0", mySlot === 1, "P1");
  if (p2) drawPlayer(p2, "#ff6b7a", mySlot === 2, "P2");
}

function drawPlayer(p, color, isMe, label) {
  ctx.beginPath();
  ctx.arc(wx(p.x), wy(p.y), ws(PLAYER_RADIUS), 0, 7);
  ctx.fillStyle = color;
  ctx.fill();
  if (isMe) {
    ctx.strokeStyle = "#fff";
    ctx.lineWidth = ws(4);
    ctx.stroke();
  }
  if (p.grab) {
    ctx.beginPath();
    ctx.arc(wx(p.x), wy(p.y), ws(GRAB_RADIUS), 0, 7);
    ctx.strokeStyle = color + "55";
    ctx.lineWidth = ws(2);
    ctx.stroke();
  }
  ctx.fillStyle = "#0c1020";
  ctx.font = `bold ${ws(18)}px system-ui`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(label, wx(p.x), wy(p.y));
  ctx.textBaseline = "alphabetic";
}

function drawLevel(stage, gateOpen) {
  const t = performance.now();
  const pulse = 0.5 + 0.5 * Math.sin(t / 400);

  // LOCK socket — the carry target
  const lockActive = stage === "carry";
  ctx.beginPath();
  ctx.arc(wx(LOCK.x), wy(LOCK.y), ws(LOCK_R), 0, 7);
  ctx.strokeStyle = lockActive ? `rgba(54,224,192,${0.45 + 0.4 * pulse})` : "rgba(141,151,196,0.3)";
  ctx.lineWidth = ws(4);
  ctx.stroke();
  if (lockActive) {
    ctx.fillStyle = "rgba(54,224,192,0.85)";
    ctx.font = `${ws(15)}px ui-monospace, monospace`;
    ctx.textAlign = "center";
    ctx.fillText("LOCK", wx(LOCK.x), wy(LOCK.y - LOCK_R - 12));
  }

  // GATE — closed (red) until the light is delivered, then parts open
  ctx.strokeStyle = gateOpen ? "rgba(54,224,192,0.25)" : "rgba(255,107,122,0.7)";
  ctx.lineWidth = ws(6);
  if (gateOpen) {
    ctx.beginPath(); ctx.moveTo(wx(GATE_X), wy(40)); ctx.lineTo(wx(GATE_X), wy(180)); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(wx(GATE_X), wy(540)); ctx.lineTo(wx(GATE_X), wy(680)); ctx.stroke();
  } else {
    ctx.beginPath(); ctx.moveTo(wx(GATE_X), wy(40)); ctx.lineTo(wx(GATE_X), wy(680)); ctx.stroke();
  }

  // DOORS — meaningful once the gate is open
  if (gateOpen) {
    for (const d of [DOOR_EMBER, DOOR_TIDE]) {
      ctx.fillStyle = `rgba(54,224,192,${0.1 + 0.1 * pulse})`;
      ctx.fillRect(wx(d.x), wy(d.y), ws(d.w), ws(d.h));
      ctx.strokeStyle = "rgba(54,224,192,0.8)";
      ctx.lineWidth = ws(3);
      ctx.strokeRect(wx(d.x), wy(d.y), ws(d.w), ws(d.h));
      ctx.fillStyle = "rgba(232,236,255,0.92)";
      ctx.font = `bold ${ws(24)}px ui-monospace, monospace`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(d.name, wx(d.x + d.w / 2), wy(d.y + d.h / 2));
      ctx.textBaseline = "alphabetic";
    }
  }

  // IGNITE cue ring around the dormant light
  if (stage === "ignite") {
    ctx.beginPath();
    ctx.arc(wx(IGNITE.x), wy(IGNITE.y), ws(IGNITE_R), 0, 7);
    ctx.setLineDash([ws(9), ws(11)]);
    ctx.strokeStyle = `rgba(255,215,107,${0.25 + 0.3 * pulse})`;
    ctx.lineWidth = ws(2);
    ctx.stroke();
    ctx.setLineDash([]);
  }
}

function updateObjective() {
  const el = $("objective");
  if (!el) return;
  if (screen !== "play" || presence.count < 2) {
    el.classList.add("hidden");
    return;
  }
  const s = latestSnap();
  const stage = s ? s.stage : "ignite";
  const txt =
    stage === "ignite"
      ? "Move together and both HOLD to wake the light"
      : stage === "carry"
      ? "Carry the light to the LOCK"
      : stage === "choose"
      ? "Choose a door — stand in the SAME one, together"
      : "";
  if (txt) {
    el.textContent = txt;
    el.classList.remove("hidden");
  } else {
    el.classList.add("hidden");
  }
}

// ---- hud ------------------------------------------------------------------
function updateHud() {
  $("hud-rtt").textContent = "RTT " + (rttEMA == null ? "–" : Math.round(rttEMA) + "ms");
  $("hud-fps").textContent = fps + " fps";
  $("hud-rate").textContent = stRate + " st/s";
  $("hud-slot").textContent = mySlot ? "P" + mySlot : "spec";
  $("hud-desync").textContent = "Δ " + Math.round(desync);
}

function updateBanner() {
  const b = $("banner");
  if (screen === "play" && presence.count < 2) {
    b.classList.remove("hidden");
    b.textContent = "Waiting for partner · room " + roomId;
  } else {
    b.classList.add("hidden");
  }
}

// ---- screens / pairing ----------------------------------------------------
function show(name) {
  screen = name;
  $("home").classList.toggle("hidden", name !== "home");
  $("lobby").classList.toggle("hidden", name !== "lobby");
  $("win").classList.toggle("hidden", name !== "win");
  const playing = name === "play";
  $("hud").classList.toggle("hidden", !playing);
  $("lat").classList.toggle("hidden", !playing);
  $("controls").classList.toggle("hidden", !playing);
  $("objective").classList.toggle("hidden", !playing);
  if (playing && !introDone) {
    introDone = true;
    const intro = $("intro");
    if (intro) intro.classList.add("run");
  }
  updateBanner();
}

function genCode() {
  const alpha = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no ambiguous chars
  let s = "";
  for (let i = 0; i < 4; i++) s += alpha[(Math.random() * alpha.length) | 0];
  return s;
}

function inviteUrl() {
  return location.origin + location.pathname + "?room=" + roomId;
}

async function updateLobby() {
  if (screen !== "lobby") return;
  $("lobby-code").textContent = roomId;
  const st = $("lobby-status");
  if (presence.count >= 2) {
    st.textContent = "Partner connected — go!";
    st.classList.add("ready");
  } else {
    st.textContent = "Waiting for your partner to join…";
    st.classList.remove("ready");
  }
}

async function renderQR() {
  try {
    const url = await QRCode.toDataURL(inviteUrl(), { margin: 1, width: 360 });
    $("qr").src = url;
  } catch (e) {
    $("qr").style.display = "none";
  }
}

async function requestWakeLock() {
  try {
    if ("wakeLock" in navigator) await navigator.wakeLock.request("screen");
  } catch {}
}
addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && screen === "play") requestWakeLock();
});

// ---- buttons --------------------------------------------------------------
$("btn-create").onclick = () => {
  connect(genCode());
  history.replaceState(null, "", inviteUrl());
  show("lobby");
  renderQR();
  updateLobby();
};
$("btn-join").onclick = () => {
  const code = $("join-code").value.trim().toUpperCase();
  if (code.length < 3) return;
  connect(code);
  show("play");
  requestWakeLock();
};
$("btn-enter").onclick = () => {
  show("play");
  requestWakeLock();
};
$("btn-copy").onclick = async () => {
  try {
    await navigator.clipboard.writeText(inviteUrl());
    $("btn-copy").textContent = "Copied!";
    setTimeout(() => ($("btn-copy").textContent = "Copy invite link"), 1500);
  } catch {}
};
$("btn-again").onclick = () => {
  netSend({ t: "reset" });
  won = false;
  show("play");
};

// ---- latency simulator: button label = added round-trip ms; one-way = half ----
$("lat")
  .querySelectorAll("button")
  .forEach((b) => {
    b.onclick = () => {
      simOneWay = Number(b.dataset.ms) / 2;
      $("lat")
        .querySelectorAll("button")
        .forEach((x) => x.classList.toggle("on", x === b));
    };
  });

function showWin() {
  const s = latestSnap();
  const door = s && s.door ? s.door : "";
  const el = $("win-path");
  if (el) el.textContent = door ? `You took the ${door} path — and no two pairs go the same way.` : "";
  show("win");
}

// ---- boot -----------------------------------------------------------------
function clamp(v, a, b) {
  return v < a ? a : v > b ? b : v;
}

function boot() {
  resize();
  const params = new URLSearchParams(location.search);
  const room = params.get("room");
  if (room) {
    // joined via shared link -> straight into the game
    $("join-code").value = room.toUpperCase();
    connect(room.toUpperCase());
    show("play");
    requestWakeLock();
  } else {
    show("home");
  }
  requestAnimationFrame(frame);
}
boot();
