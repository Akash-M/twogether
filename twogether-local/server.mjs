// Twogether — Chapter 1 server (PartyKit-free).
// Serves /public over HTTP and runs an authoritative, staged co-op level over WebSocket.
// `npm install && npm start`.
import http from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(__dirname, "public");
const PORT = process.env.PORT || 3000;

// ---- world + level constants (MUST match public/game.js) ------------------
const WORLD_W = 1280,
  WORLD_H = 720;
const TICK_MS = 50,
  PLAYER_SPEED = 340,
  PLAYER_RADIUS = 26;
const GRAB_RADIUS = 95,
  MAX_STRETCH = 380,
  ORB_LERP = 0.35;

const IGNITE = { x: 380, y: 360 },
  IGNITE_R = 120; // both must be within this (and holding) to wake the light
const LOCK = { x: 820, y: 360 },
  LOCK_R = 72; // deliver the lit light here to open the gate
const DOOR_EMBER = { x: 1066, y: 96, w: 176, h: 200, name: "EMBER" };
const DOOR_TIDE = { x: 1066, y: 424, w: 176, h: 200, name: "TIDE" };
const START = { p1: { x: 180, y: 300 }, p2: { x: 180, y: 430 } };

// ---- static file server ---------------------------------------------------
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".ico": "image/x-icon",
  ".svg": "image/svg+xml",
};
const server = http.createServer(async (req, res) => {
  let urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
  if (urlPath === "/") urlPath = "/index.html";
  const filePath = normalize(join(PUBLIC, urlPath));
  if (!filePath.startsWith(PUBLIC)) {
    res.writeHead(403);
    return res.end("forbidden");
  }
  try {
    const data = await readFile(filePath);
    res.writeHead(200, { "content-type": MIME[extname(filePath)] || "application/octet-stream" });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end("not found");
  }
});

// ---- rooms ----------------------------------------------------------------
const rooms = new Map();
let nextId = 1;

function getRoom(id) {
  let r = rooms.get(id);
  if (!r) {
    r = { id, conns: new Set(), players: new Map(), loop: null, last: 0 };
    resetRoom(r);
    rooms.set(id, r);
  }
  return r;
}

function resetRoom(r) {
  r.stage = "ignite"; // ignite -> carry -> choose -> done
  r.orb = { x: IGNITE.x, y: IGNITE.y, active: false, held: false };
  r.gateOpen = false;
  r.door = null;
  r.won = false;
  r.tick = 0;
  if (r.players) for (const p of r.players.values()) Object.assign(p, startFor(p.slot));
}

const wss = new WebSocketServer({ server });
wss.on("connection", (ws, req) => {
  const url = new URL(req.url, "http://localhost");
  const roomId = (url.searchParams.get("room") || "LOBBY").toUpperCase();
  const r = getRoom(roomId);
  const id = "c" + nextId++;
  const slot = assignSlot(r);
  const s = startFor(slot);
  r.players.set(id, { id, slot, x: s.x, y: s.y, input: { mvx: 0, mvy: 0, grab: false } });
  r.conns.add(ws);
  ws.send(JSON.stringify({ t: "welcome", slot, roomId }));
  broadcastPresence(r);
  ensureLoop(r);

  ws.on("message", (buf) => {
    let m;
    try {
      m = JSON.parse(buf.toString());
    } catch {
      return;
    }
    if (m.t === "ping") {
      ws.send(JSON.stringify({ t: "pong", id: m.id, c: m.c }));
      return;
    }
    const p = r.players.get(id);
    if (!p) return;
    if (m.t === "input") {
      p.input.mvx = clamp(num(m.mvx), -1, 1);
      p.input.mvy = clamp(num(m.mvy), -1, 1);
      p.input.grab = !!m.grab;
    } else if (m.t === "reset") {
      resetRoom(r);
    }
  });

  ws.on("close", () => {
    r.players.delete(id);
    r.conns.delete(ws);
    broadcastPresence(r);
    if (r.conns.size === 0) {
      stopLoop(r);
      rooms.delete(r.id);
    }
  });
});

function ensureLoop(r) {
  if (r.loop) return;
  r.last = Date.now();
  r.loop = setInterval(() => step(r), TICK_MS);
}
function stopLoop(r) {
  if (r.loop) clearInterval(r.loop);
  r.loop = null;
}

// ---- the level (authoritative) --------------------------------------------
function step(r) {
  const now = Date.now();
  let dt = (now - r.last) / 1000;
  r.last = now;
  if (dt > 0.1) dt = 0.1;
  r.tick++;

  // integrate player movement
  for (const p of r.players.values()) {
    if (p.slot === 0) continue;
    let { mvx, mvy } = p.input;
    const m = Math.hypot(mvx, mvy);
    if (m > 1) {
      mvx /= m;
      mvy /= m;
    }
    p.x = clamp(p.x + mvx * PLAYER_SPEED * dt, PLAYER_RADIUS, WORLD_W - PLAYER_RADIUS);
    p.y = clamp(p.y + mvy * PLAYER_SPEED * dt, PLAYER_RADIUS, WORLD_H - PLAYER_RADIUS);
  }

  const p1 = getSlot(r, 1);
  const p2 = getSlot(r, 2);
  let held = false;
  let stretch = 0;

  if (p1 && p2) {
    stretch = dist(p1, p2);

    if (r.stage === "ignite") {
      // Both must be near the dormant light AND holding to wake it.
      const n1 = dist(p1, r.orb) <= IGNITE_R && p1.input.grab;
      const n2 = dist(p2, r.orb) <= IGNITE_R && p2.input.grab;
      if (n1 && n2) {
        r.orb.active = true;
        r.stage = "carry";
      }
    } else if (r.stage === "carry") {
      // Co-carry: the light only moves while both hold it and stay close.
      const e1 = dist(p1, r.orb) <= GRAB_RADIUS && p1.input.grab;
      const e2 = dist(p2, r.orb) <= GRAB_RADIUS && p2.input.grab;
      if (e1 && e2 && stretch <= MAX_STRETCH) {
        held = true;
        const mx = (p1.x + p2.x) / 2;
        const my = (p1.y + p2.y) / 2;
        r.orb.x += (mx - r.orb.x) * ORB_LERP;
        r.orb.y += (my - r.orb.y) * ORB_LERP;
      }
      if (dist(r.orb, LOCK) <= LOCK_R) {
        r.orb.x = LOCK.x;
        r.orb.y = LOCK.y;
        r.gateOpen = true;
        r.stage = "choose";
      }
    } else if (r.stage === "choose") {
      // Both players must stand in the SAME door to choose the path.
      if (inRect(p1, DOOR_EMBER) && inRect(p2, DOOR_EMBER)) {
        r.door = "EMBER";
        r.stage = "done";
        r.won = true;
      } else if (inRect(p1, DOOR_TIDE) && inRect(p2, DOOR_TIDE)) {
        r.door = "TIDE";
        r.stage = "done";
        r.won = true;
      }
    }
  }
  r.orb.held = held;

  const players = [...r.players.values()].map((p) => ({ slot: p.slot, x: round(p.x), y: round(p.y), grab: p.input.grab }));
  broadcast(r, {
    t: "state",
    tick: r.tick,
    players,
    ox: round(r.orb.x),
    oy: round(r.orb.y),
    held,
    stretch: round(stretch),
    stage: r.stage,
    orbActive: r.orb.active,
    gateOpen: r.gateOpen,
    door: r.door,
    won: r.won,
  });
}

// ---- helpers --------------------------------------------------------------
function assignSlot(r) {
  const taken = new Set([...r.players.values()].map((p) => p.slot));
  if (!taken.has(1)) return 1;
  if (!taken.has(2)) return 2;
  return 0;
}
function startFor(slot) {
  if (slot === 1) return { x: START.p1.x, y: START.p1.y };
  if (slot === 2) return { x: START.p2.x, y: START.p2.y };
  return { x: WORLD_W / 2, y: WORLD_H - 60 };
}
function getSlot(r, s) {
  for (const p of r.players.values()) if (p.slot === s) return p;
  return null;
}
function broadcast(r, obj) {
  const msg = JSON.stringify(obj);
  for (const ws of r.conns) if (ws.readyState === 1) ws.send(msg);
}
function broadcastPresence(r) {
  const slots = [...r.players.values()].map((p) => p.slot).filter((s) => s > 0);
  broadcast(r, { t: "presence", count: slots.length, slots });
}
function clamp(v, a, b) {
  return v < a ? a : v > b ? b : v;
}
function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}
function dist(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}
function round(v) {
  return Math.round(v * 10) / 10;
}
function inRect(p, r) {
  return p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;
}

server.listen(PORT, () => {
  console.log(`\n  Twogether — Chapter 1 (The Hollow) running:`);
  console.log(`  • This machine:   http://localhost:${PORT}`);
  console.log(`  • Same Wi-Fi:     http://<your-LAN-IP>:${PORT}   (mac: ipconfig getifaddr en0)`);
  console.log(`\n  Open on two phones on the SAME Wi-Fi, create a room on one, join on the other.\n`);
});
