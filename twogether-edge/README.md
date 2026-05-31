# Twogether — Phase 0 Real-Time Spike

A deliberately tiny, throwaway prototype whose **only** job is to answer one question:

> Does real-time co-op feel good on two phones over mobile web?

If yes, we build the real game (branching story, 10 chapters, accounts, saved sessions, landing page).
If no, we pivot to a hybrid / narrative model. **Nothing else is built until this question is answered.**

There is no art, no story, and no login here on purpose. Don't judge the looks — judge the *feel*.

---

## What it does

Two phones join the same room. Each player drives one avatar in a shared 2D arena and must
**carry an orb to the glowing pad** — but the orb only moves while **both** players are holding it
*and* staying within a max distance of each other. That single mechanic continuously stresses
real-time synchronization, which is exactly the thing we need to judge.

## Architecture (why it should feel responsive)

- **PartyKit (Cloudflare edge)** hosts the room. The server is geographically close to players → low latency.
- **Server-authoritative simulation @ 20 Hz.** Clients stream input; the server runs the one true sim and broadcasts snapshots.
- **Client-side prediction** for *your own* avatar (moves instantly, then softly reconciles to the server) so controls feel tight even with latency.
- **Entity interpolation** (~100 ms) for the *other* player and the orb so their motion stays smooth.
- **Ping/pong** answered instantly for an honest round-trip read.

```
src/server.ts    PartyKit authoritative room + 20Hz tick
src/shared.ts    world/sim constants (mirrored in public/game.js)
public/index.html, style.css, game.js    Canvas client (touch + keyboard)
preview.html     single-device demo (no backend) — feel the mechanic instantly
```

---

## Run it locally

```bash
npm install
npm run dev          # starts PartyKit dev server on http://127.0.0.1:1999
```

Open `http://127.0.0.1:1999` in two browser tabs (or your phone on the same Wi-Fi using your
machine's LAN IP). One tab clicks **Create a room**, the other opens the invite link / enters the code.
Local dev has ~0 ms latency, so it will feel perfect — the *real* test is deployed (below).

## Deploy (for the real two-phone test)

```bash
npx partykit login   # one-time, opens GitHub OAuth (free)
npm run deploy        # prints a public https://<name>.<you>.partykit.dev URL
```

That public URL is what you open on real phones over cellular/Wi-Fi.

---

## The two-phone test protocol

1. Open the deployed URL on **Phone A** → **Create a room**.
2. On **Phone B**, scan the QR (or open the copied invite link, or type the 4-char code).
3. Both tap **Enter game**. Try to carry the orb to the pad together.
4. Repeat on **different networks** — e.g. Phone A on Wi-Fi, Phone B on cellular; then both on cellular.
5. Watch the **HUD** (top of screen) and note the numbers:
   - `RTT` — round-trip latency in ms (the headline number)
   - `fps` — client frame rate
   - `st/s` — state snapshots received per second (should hover ~20)
   - `Δ` — desync: distance between your predicted position and the server's (lower = tighter)

Record RTT and how it *felt* in each network combo. Also try to deliberately break it:
walk into an elevator, lock/unlock the screen, swap Wi-Fi↔cellular (it should auto-reconnect).

## Go / no-go criteria (confirm/adjust before testing)

**GO** (real-time is viable; proceed to full game) if, on cellular:
- Median `RTT` ≲ **120 ms**, and
- avatar movement holds **30 fps+** and feels responsive (thanks to prediction), and
- the **co-carry feels coordinated**, not like fighting rubber bands.

**NO-GO / PIVOT** if RTT routinely exceeds ~200 ms, the orb visibly fights you, or reconnects are jarring.
Fallback options in order: (a) tune tick rate / interpolation, (b) try **WebRTC P2P** (PeerJS) for
lower latency with a TURN fallback, (c) pivot to **hybrid** (real-time "moments" inside a turn-based
narrative) or fully **narrative** co-op.

---

## Known limitations (intentional for a spike)

- Max 2 players per room; a 3rd connection becomes a spectator.
- No accounts, no saved progress, no persistence — that's Phase 1+ (Supabase).
- `preview.html` uses *auto-grab when near* for a frictionless single-device demo; the networked
  client uses an explicit **HOLD** button. The preview is for feel only, not a networked test.
- CDN imports (`partysocket`, `qrcode`) load from esm.sh at runtime — fine on a normal deploy.
