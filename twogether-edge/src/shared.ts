// Shared world + simulation constants (server-authoritative).
// NOTE: these are duplicated in /public/game.js and /preview.html — keep in sync.
export const WORLD_W = 1280;
export const WORLD_H = 720;

export const TICK_MS = 50; // 20 Hz server simulation tick
export const PLAYER_SPEED = 340; // virtual units / second
export const PLAYER_RADIUS = 26;

export const ORB_RADIUS = 30;
export const GRAB_RADIUS = 95; // player-centre -> orb-centre distance to be able to grab
export const MAX_STRETCH = 380; // if the two players are farther apart than this, the orb drops
export const ORB_LERP = 0.35; // how tightly the orb eases toward the players' midpoint per tick

export const START = { p1: { x: 200, y: 360 }, p2: { x: 330, y: 360 } };
export const ORB_START = { x: 540, y: 360 };
export const GOAL = { x: 1130, y: 250, w: 150, h: 220 };
