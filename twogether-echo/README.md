# Twogether — The Echo

A lighter, social co-op level: **"are we on the same wavelength?"**

You both get the same prompt. Each of you picks an answer **privately** — your partner only sees
that you've *locked in*, never *what* you chose (the server doesn't reveal it until both are in).
Both reveal at once: **match → advance**, **mismatch → back to the start**. Chain a streak of **3**
to open the way.

It's the tonal counterweight to the moody carry level (`twogether-local` / "The Hollow"), and in
the story it slots as a playful realm where the In-Between tests whether two people think alike.

## Run it

```bash
npm install
npm start          # serves on http://localhost:3001
```

Find your LAN IP (`ipconfig getifaddr en0` on macOS), open `http://<ip>:3001` on **two phones on the
same Wi-Fi**, create a room on one, join from the other — and **don't peek at each other's screen.**

> Runs on port **3001** so it can run alongside `twogether-local` (port 3000) at the same time.

## How it works

- `server.mjs` — rooms + slot assignment + a prompt pool + the choose → reveal → win state machine.
  **Hidden choice is enforced server-side:** a player's pick is never broadcast until both have locked,
  at which point the reveal sends both choices together.
- `public/` — pairing (create/join/QR), tappable option cards, the simultaneous reveal, streak dots,
  and the win screen. Plain ES module, native WebSocket with auto-reconnect.

## Tuning knobs (top of `server.mjs`)

- `STREAK` — how many prompts you must match in a row (default 3).
- `REVEAL_MS` — how long both choices stay on screen before resolving.
- `POOL` — the prompt list; add your own (each prompt needs a `q` and 2–4 `options`).
