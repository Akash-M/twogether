// Twogether — The Echo (hidden simultaneous-choice sync level).
// Both players get the same prompt; each picks privately. The server NEVER reveals a
// player's choice until both have locked in. Match -> advance the streak; mismatch -> restart.
// Chain a streak of all prompts to win. `npm install && npm start` (default port 3001).
import http from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(__dirname, "public");
const PORT = process.env.PORT || 3001;

const STREAK = 3; // prompts you must match in a row to win
const REVEAL_MS = 2400; // how long both choices stay visible before resolving

// ---- prompt pool (light & playful; mix of gut + know-your-partner) --------
const POOL = [
  { q: "If we bolt from here, which way?", options: [ { id: "l", emoji: "⬅️", label: "Left" }, { id: "r", emoji: "➡️", label: "Right" }, { id: "u", emoji: "⬆️", label: "Straight on" } ] },
  { q: "Grab one snack:", options: [ { id: "pizza", emoji: "🍕", label: "Pizza" }, { id: "choc", emoji: "🍫", label: "Chocolate" }, { id: "corn", emoji: "🍿", label: "Popcorn" } ] },
  { q: "Tonight, we're…", options: [ { id: "in", emoji: "🛋️", label: "Cozy in" }, { id: "out", emoji: "🌃", label: "Out out" }, { id: "play", emoji: "🎮", label: "Game on" } ] },
  { q: "Grab one & run:", options: [ { id: "photos", emoji: "📷", label: "The photos" }, { id: "plant", emoji: "🪴", label: "The plant" }, { id: "keep", emoji: "🧸", label: "The keepsake" } ] },
  { q: "Pick a colour:", options: [ { id: "red", emoji: "🔴", label: "Red" }, { id: "blue", emoji: "🔵", label: "Blue" }, { id: "yellow", emoji: "🟡", label: "Yellow" } ] },
  { q: "We're animals. We're…", options: [ { id: "fox", emoji: "🦊", label: "Foxes" }, { id: "turtle", emoji: "🐢", label: "Turtles" }, { id: "owl", emoji: "🦉", label: "Owls" } ] },
  { q: "The map says…", options: [ { id: "trust", emoji: "🗺️", label: "Trust it" }, { id: "wing", emoji: "🧭", label: "Wing it" }, { id: "ask", emoji: "🙋", label: "Ask someone" } ] },
  { q: "Pick a door:", options: [ { id: "ember", emoji: "🔥", label: "Ember" }, { id: "tide", emoji: "🌊", label: "Tide" }, { id: "bright", emoji: "✨", label: "The bright one" } ] },
  { q: "Dream escape:", options: [ { id: "mtn", emoji: "🏔️", label: "Mountains" }, { id: "beach", emoji: "🏖️", label: "Beach" }, { id: "city", emoji: "🏙️", label: "City" } ] },
  { q: "First instinct:", options: [ { id: "save", emoji: "🛟", label: "Save them" }, { id: "plan", emoji: "🧠", label: "Make a plan" }, { id: "go", emoji: "🏃", label: "Just go" } ] },
];

function pickPrompts() {
  const idx = [...POOL.keys()];
  for (let i = idx.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [idx[i], idx[j]] = [idx[j], idx[i]];
  }
  return idx.slice(0, STREAK).map((i) => POOL[i]);
}

// ---- static file server ---------------------------------------------------
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json",
};
const server = http.createServer(async (req, res) => {
  let p = decodeURIComponent((req.url || "/").split("?")[0]);
  if (p === "/") p = "/index.html";
  const fp = normalize(join(PUBLIC, p));
  if (!fp.startsWith(PUBLIC)) {
    res.writeHead(403);
    return res.end("forbidden");
  }
  try {
    const data = await readFile(fp);
    res.writeHead(200, { "content-type": MIME[extname(fp)] || "application/octet-stream" });
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
    r = { id, conns: new Set(), slotByConn: new Map(), revealTimer: null };
    resetGame(r);
    rooms.set(id, r);
  }
  return r;
}
function resetGame(r) {
  if (r.revealTimer) {
    clearTimeout(r.revealTimer);
    r.revealTimer = null;
  }
  r.prompts = pickPrompts();
  r.index = 0;
  r.phase = "choose"; // choose | reveal | won
  r.picks = { 1: null, 2: null };
  r.lastMatch = null;
  r.won = false;
}

const wss = new WebSocketServer({ server });
wss.on("connection", (ws, req) => {
  const url = new URL(req.url, "http://localhost");
  const roomId = (url.searchParams.get("room") || "LOBBY").toUpperCase();
  const r = getRoom(roomId);
  const slot = assignSlot(r);
  r.slotByConn.set(ws, slot);
  r.conns.add(ws);
  ws.send(JSON.stringify({ t: "welcome", slot, roomId }));
  broadcastPresence(r);
  broadcastEcho(r);

  ws.on("message", (buf) => {
    let m;
    try {
      m = JSON.parse(buf.toString());
    } catch {
      return;
    }
    const slot = r.slotByConn.get(ws);
    if (m.t === "pick") {
      if (r.phase !== "choose" || (slot !== 1 && slot !== 2)) return;
      if (r.picks[slot] != null) return; // already locked — no changing your mind
      const prompt = r.prompts[r.index];
      if (!prompt.options.some((o) => o.id === m.choice)) return; // sanity
      r.picks[slot] = m.choice;
      if (r.picks[1] != null && r.picks[2] != null) enterReveal(r);
      else broadcastEcho(r); // tell partner you've locked (NOT what you chose)
    } else if (m.t === "reset") {
      resetGame(r);
      broadcastEcho(r);
    }
  });

  ws.on("close", () => {
    const s = r.slotByConn.get(ws);
    r.slotByConn.delete(ws);
    r.conns.delete(ws);
    if (s === 1 || s === 2) {
      // a player left mid-round — clear picks so the remaining player isn't stuck
      if (r.phase === "choose") r.picks[s] = null;
    }
    if (r.conns.size === 0) {
      if (r.revealTimer) clearTimeout(r.revealTimer);
      rooms.delete(r.id);
    } else {
      broadcastPresence(r);
      broadcastEcho(r);
    }
  });
});

function enterReveal(r) {
  r.phase = "reveal";
  r.lastMatch = r.picks[1] === r.picks[2];
  broadcastEcho(r);
  r.revealTimer = setTimeout(() => resolveReveal(r), REVEAL_MS);
}

function resolveReveal(r) {
  r.revealTimer = null;
  if (r.lastMatch) {
    r.index++;
    if (r.index >= r.prompts.length) {
      r.phase = "won";
      r.won = true;
    } else {
      r.phase = "choose";
    }
  } else {
    r.index = 0; // mismatch -> back to the start
    r.phase = "choose";
  }
  r.picks = { 1: null, 2: null };
  broadcastEcho(r);
}

// ---- broadcast ------------------------------------------------------------
function broadcastEcho(r) {
  const prompt = r.prompts[r.index] || r.prompts[r.prompts.length - 1];
  const base = {
    t: "echo",
    phase: r.phase,
    index: r.index,
    total: r.prompts.length,
    prompt, // same prompt+options for both players
    locked: { 1: r.picks[1] != null, 2: r.picks[2] != null },
    won: r.won,
    // reveal is included ONLY during the reveal phase
    reveal: r.phase === "reveal" ? { 1: r.picks[1], 2: r.picks[2], match: r.lastMatch } : null,
  };
  send(r, base);
}
function broadcastPresence(r) {
  const slots = [...r.slotByConn.values()].filter((s) => s > 0);
  send(r, { t: "presence", count: slots.length, slots });
}
function send(r, obj) {
  const msg = JSON.stringify(obj);
  for (const ws of r.conns) if (ws.readyState === 1) ws.send(msg);
}
function assignSlot(r) {
  const taken = new Set(r.slotByConn.values());
  if (!taken.has(1)) return 1;
  if (!taken.has(2)) return 2;
  return 0; // spectator
}

server.listen(PORT, () => {
  console.log(`\n  Twogether — The Echo running:`);
  console.log(`  • This machine:   http://localhost:${PORT}`);
  console.log(`  • Same Wi-Fi:     http://<your-LAN-IP>:${PORT}   (mac: ipconfig getifaddr en0)`);
  console.log(`\n  Open on two phones on the SAME Wi-Fi — no peeking at each other's screen!\n`);
});
