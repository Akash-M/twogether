# Twogether

A web-based, two-player co-op game you play across **two phones** — no console, no install. One story, real-time cooperation, and a branching path so **no two pairs reach the end the same way**.

> **Status: Phase 0 — real-time feasibility spike.** Before building the full game, we're proving the riskiest assumption: that real-time co-op *feels good* on two phones over mobile web. (Early answer: yes.)

## What's here

The Phase 0 spike in two flavors, plus a standalone preview:

| Path | What it is |
|---|---|
| `twogether-local/` | **Primary build.** Plain Node + `ws`. No cloud account, no CLI — `npm install && npm start`, then test on two phones over the same Wi-Fi. Includes a built-in **latency slider** to feel the co-op at 50–200 ms. |
| `twogether-edge/` | Same game on **PartyKit** (Cloudflare edge) for low-latency global rooms. The deploy target for the real product. |
| `twogether-edge/preview.html` | A single-device, dependency-free demo (two thumbs) to feel the core mechanic instantly. |

Each folder has its own README with run/deploy steps.

## The spike, in one screen

Two players each control an avatar. Carry the glowing orb to the pad — but it **only moves while both of you hold it** and stay close together. That single mechanic continuously stresses real-time sync, which is exactly what we need to judge. A HUD shows live RTT / fps / state-rate / desync.

## Quick start (local build)

```bash
cd twogether-local
npm install
npm start            # prints the URL
```

Find your machine's LAN IP (`ipconfig getifaddr en0` on macOS), open `http://<ip>:3000` on two phones on the same Wi-Fi, create a room on one, join on the other. Use the **sim lag** control to feel how it plays at 100–150 ms.

## Go / no-go bar

Real-time is a **GO** if, at ~120–150 ms latency: controls stay responsive (they do — client-side prediction), and the co-carry still feels coordinated rather than fighting you.

## Roadmap (post-spike)

- [ ] Lock the real-time go/no-go (latency test)
- [ ] Story design + the branching engine that guarantees unique paths
- [ ] 10-chapter structure
- [ ] Free accounts + saved shared sessions
- [ ] SEO + AI-discoverable landing page

## Tech

Server-authoritative simulation @ 20 Hz; clients predict their own avatar and interpolate the partner + orb. Canvas rendering, touch + keyboard input, mobile-hardened (wake lock, safe-area, auto-reconnect).
