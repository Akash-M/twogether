import type * as Party from "partykit/server";
import {
  WORLD_W,
  WORLD_H,
  TICK_MS,
  PLAYER_SPEED,
  PLAYER_RADIUS,
  GRAB_RADIUS,
  MAX_STRETCH,
  ORB_LERP,
  START,
  ORB_START,
  GOAL,
} from "./shared";

type Input = { mvx: number; mvy: number; grab: boolean };
type Player = { id: string; slot: number; x: number; y: number; input: Input };

/**
 * Authoritative game room.
 *
 * - Each client streams its raw input (movement vector + grab) at ~20 Hz.
 * - The server runs the one true simulation at 20 Hz and broadcasts snapshots.
 * - Ping/pong is answered immediately (not on the tick) so RTT is measured cleanly.
 */
export default class GameServer implements Party.Server {
  // Keep the instance hot so setInterval keeps ticking while players are connected.
  static options = { hibernate: false };

  players = new Map<string, Player>();
  orb = { x: ORB_START.x, y: ORB_START.y, held: false };
  won = false;
  tick = 0;
  loop: ReturnType<typeof setInterval> | null = null;
  lastTs = 0;

  constructor(readonly room: Party.Room) {}

  onConnect(conn: Party.Connection) {
    const slot = this.assignSlot();
    const s = this.startFor(slot);
    this.players.set(conn.id, {
      id: conn.id,
      slot,
      x: s.x,
      y: s.y,
      input: { mvx: 0, mvy: 0, grab: false },
    });
    conn.send(JSON.stringify({ t: "welcome", slot, roomId: this.room.id }));
    this.broadcastPresence();
    this.ensureLoop();
  }

  onClose(conn: Party.Connection) {
    this.players.delete(conn.id);
    this.broadcastPresence();
    if (this.players.size === 0) this.stopLoop();
  }

  onMessage(raw: string, sender: Party.Connection) {
    let msg: any;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg.t === "ping") {
      // Answer instantly for an honest round-trip measurement.
      sender.send(JSON.stringify({ t: "pong", id: msg.id, c: msg.c }));
      return;
    }
    const p = this.players.get(sender.id);
    if (!p) return;
    if (msg.t === "input") {
      p.input.mvx = clamp(num(msg.mvx), -1, 1);
      p.input.mvy = clamp(num(msg.mvy), -1, 1);
      p.input.grab = !!msg.grab;
    } else if (msg.t === "reset") {
      this.resetRound();
    }
  }

  // --- simulation -----------------------------------------------------------

  step() {
    const now = Date.now();
    let dt = (now - this.lastTs) / 1000;
    this.lastTs = now;
    if (dt > 0.1) dt = 0.1; // clamp scheduler hiccups
    this.tick++;

    for (const p of this.players.values()) {
      if (p.slot === 0) continue; // spectator
      let { mvx, mvy } = p.input;
      const m = Math.hypot(mvx, mvy);
      if (m > 1) {
        mvx /= m;
        mvy /= m;
      }
      p.x = clamp(p.x + mvx * PLAYER_SPEED * dt, PLAYER_RADIUS, WORLD_W - PLAYER_RADIUS);
      p.y = clamp(p.y + mvy * PLAYER_SPEED * dt, PLAYER_RADIUS, WORLD_H - PLAYER_RADIUS);
    }

    const p1 = this.getSlot(1);
    const p2 = this.getSlot(2);
    let held = false;
    let stretch = 0;
    if (p1 && p2 && !this.won) {
      const e1 = dist(p1, this.orb) <= GRAB_RADIUS && p1.input.grab;
      const e2 = dist(p2, this.orb) <= GRAB_RADIUS && p2.input.grab;
      stretch = dist(p1, p2);
      if (e1 && e2 && stretch <= MAX_STRETCH) {
        held = true;
        const mx = (p1.x + p2.x) / 2;
        const my = (p1.y + p2.y) / 2;
        this.orb.x += (mx - this.orb.x) * ORB_LERP;
        this.orb.y += (my - this.orb.y) * ORB_LERP;
      }
    }
    this.orb.held = held;

    if (!this.won && inRect(this.orb, GOAL)) this.won = true;

    const players = [...this.players.values()].map((p) => ({
      slot: p.slot,
      x: round(p.x),
      y: round(p.y),
      grab: p.input.grab,
    }));
    this.room.broadcast(
      JSON.stringify({
        t: "state",
        tick: this.tick,
        players,
        ox: round(this.orb.x),
        oy: round(this.orb.y),
        held,
        stretch: round(stretch),
        won: this.won,
      })
    );
  }

  // --- helpers --------------------------------------------------------------

  assignSlot() {
    const taken = new Set([...this.players.values()].map((p) => p.slot));
    if (!taken.has(1)) return 1;
    if (!taken.has(2)) return 2;
    return 0; // 3rd+ connection = spectator
  }

  startFor(slot: number) {
    if (slot === 1) return START.p1;
    if (slot === 2) return START.p2;
    return { x: WORLD_W / 2, y: WORLD_H - 60 };
  }

  getSlot(s: number) {
    for (const p of this.players.values()) if (p.slot === s) return p;
    return null;
  }

  resetRound() {
    this.orb = { x: ORB_START.x, y: ORB_START.y, held: false };
    this.won = false;
    for (const p of this.players.values()) {
      const s = this.startFor(p.slot);
      p.x = s.x;
      p.y = s.y;
    }
  }

  ensureLoop() {
    if (this.loop) return;
    this.lastTs = Date.now();
    this.loop = setInterval(() => this.step(), TICK_MS);
  }

  stopLoop() {
    if (this.loop) {
      clearInterval(this.loop);
      this.loop = null;
    }
    this.resetRound();
    this.tick = 0;
  }

  broadcastPresence() {
    const slots = [...this.players.values()].map((p) => p.slot).filter((s) => s > 0);
    this.room.broadcast(JSON.stringify({ t: "presence", count: slots.length, slots }));
  }
}

function clamp(v: number, a: number, b: number) {
  return v < a ? a : v > b ? b : v;
}
function num(v: any) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}
function dist(a: { x: number; y: number }, b: { x: number; y: number }) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}
function round(v: number) {
  return Math.round(v * 10) / 10;
}
function inRect(p: { x: number; y: number }, r: { x: number; y: number; w: number; h: number }) {
  return p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;
}
