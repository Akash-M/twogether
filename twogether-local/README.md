# Twogether — Local (PartyKit-free) build

Same spike, same co-carry mechanic, same diagnostics HUD — but with **zero PartyKit / ink / CLI**.
It's a plain Node server (`ws`) that can't hit the `connectToDevTools` crash, and it gives you the
**fastest possible two-phone test**: same Wi-Fi, no cloud account, no login.

## Run it (30 seconds)

```bash
npm install
npm start          # prints the URLs to open
```

Then:

1. Find your Mac's LAN IP: `ipconfig getifaddr en0` (e.g. `192.168.1.42`).
2. On **both phones (same Wi-Fi)** open `http://192.168.1.42:3000`.
3. One phone taps **Create a room**; the other scans the QR / types the 4-char code.
4. Carry the orb to the glowing pad — it only moves while **both** of you hold it.

> The HUD up top shows `RTT / fps / st/s / Δ`. On the same Wi-Fi, RTT will be tiny (~1–10 ms),
> so this proves the *mechanic and feel* but not real-world lag.
>
> **Use the `sim lag` control (top of screen) to fake latency on the spot:** tap
> `+50 / +100 / +150 / +200` to add that many milliseconds of round-trip delay. Watch the HUD
> `RTT` jump to match, and feel where the co-carry stays crisp vs. starts to fight you. This is the
> real go/no-go test and needs no second network. (You can still deploy and test over cellular for a
> true end-to-end read.)

## Deploy for a real cellular test

Any host that runs a Node process + WebSockets works (no special platform needed):

- **Render / Railway / Fly.io:** start command `node server.mjs`, it binds `process.env.PORT`.
- Open the resulting `https://…` URL on two phones on **different** networks (one on cellular).
- Judge against the go/no-go bar: median **RTT ≲ 120 ms**, **30 fps+**, carry feels coordinated.

Note: a single-region Node server adds latency for distant players. If the feel is good here, the
edge-hosted PartyKit version (`twogether-edge/`, once the `DEV` env issue is cleared) will only be better.

## Files

```
server.mjs        HTTP static server + WebSocket rooms + 20 Hz authoritative sim
public/index.html, style.css, game.js   the Canvas client (native WebSocket, auto-reconnect)
```

## Why this exists

The `twogether-edge/` (PartyKit) build crashed for you with
`rdt_mock_default.connectToDevTools is not a function`. That's an `ink` bug triggered when the
`DEV=true` environment variable is set (PartyKit's CLI ships a devtools mock without that function).
Fix for the PartyKit build: `unset DEV` (and remove `export DEV=true` from `~/.zshrc`). This local
build sidesteps the whole CLI, so it works regardless.
