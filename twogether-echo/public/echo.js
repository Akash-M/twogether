// Twogether — The Echo client. Pairing + hidden simultaneous choice + reveal.
// Your own pick is shown only to you; the partner's pick arrives only at reveal.
import QRCode from "https://esm.sh/qrcode";

const $ = (id) => document.getElementById(id);

let socket = null;
let roomId = null;
let mySlot = 0;
let presence = { count: 0, slots: [] };
let echoState = null;
let myPick = null;
let screen = "home";

// ---- networking -----------------------------------------------------------
function connect(room) {
  roomId = room;
  openSocket();
}
function openSocket() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  socket = new WebSocket(`${proto}://${location.host}/?room=${encodeURIComponent(roomId)}`);
  socket.addEventListener("message", onMessage);
  socket.addEventListener("close", () => {
    if (roomId) setTimeout(openSocket, 1000); // auto-reconnect
  });
}
function netSend(obj) {
  if (socket && socket.readyState === 1) socket.send(JSON.stringify(obj));
}

function onMessage(e) {
  let m;
  try {
    m = JSON.parse(e.data);
  } catch {
    return;
  }
  if (m.t === "echo") {
    // Clear my local pick when a fresh choose round begins for me.
    if (m.phase === "choose" && !m.locked[mySlot]) myPick = null;
    echoState = m;
    renderEcho();
  } else if (m.t === "welcome") {
    mySlot = m.slot;
  } else if (m.t === "presence") {
    presence = m;
    updateLobby();
    if (screen === "play") renderEcho();
  }
}

// ---- render ---------------------------------------------------------------
function optById(prompt, id) {
  return prompt.options.find((o) => o.id === id);
}

function renderEcho() {
  if (screen !== "play" || !echoState) return;
  const es = echoState;
  if (es.phase === "won") return showWin();

  $("ewait").classList.toggle("hidden", presence.count >= 2);

  // progress dots
  const prog = $("progress");
  prog.innerHTML = "";
  for (let i = 0; i < es.total; i++) {
    const d = document.createElement("span");
    d.className = "dot" + (i < es.index ? " on" : "");
    prog.appendChild(d);
  }
  const lbl = document.createElement("span");
  lbl.className = "prog-label";
  lbl.textContent = `in sync ${es.index}/${es.total}`;
  prog.appendChild(lbl);

  $("prompt").textContent = es.prompt.q;
  const stage = $("stage");
  stage.innerHTML = "";
  const other = mySlot === 1 ? 2 : 1;

  if (es.phase === "reveal" && es.reveal) {
    const mine = optById(es.prompt, es.reveal[mySlot]);
    const theirs = optById(es.prompt, es.reveal[other]);
    const match = es.reveal.match;
    const wrap = document.createElement("div");
    wrap.className = "reveal " + (match ? "match" : "miss");
    wrap.innerHTML = `
      <div class="rv-pair">
        <div class="rv-card"><div class="rv-emoji">${mine ? mine.emoji : "—"}</div><div class="rv-name">${mine ? mine.label : ""}</div><div class="rv-who">you</div></div>
        <div class="rv-vs">${match ? "✓" : "✗"}</div>
        <div class="rv-card"><div class="rv-emoji">${theirs ? theirs.emoji : "—"}</div><div class="rv-name">${theirs ? theirs.label : ""}</div><div class="rv-who">them</div></div>
      </div>
      <div class="rv-banner">${match ? "In sync!" : "Out of sync — back to the start"}</div>`;
    stage.appendChild(wrap);
    $("status").textContent = match ? "Nice. Next one…" : "Shake it off — again!";
  } else {
    const iLocked = !!es.locked[mySlot];
    for (const o of es.prompt.options) {
      const b = document.createElement("button");
      b.className = "card" + (myPick === o.id ? " picked" : "") + (iLocked && myPick !== o.id ? " dim" : "");
      b.innerHTML = `<span class="card-emoji">${o.emoji}</span><span class="card-label">${o.label}</span>`;
      if (!iLocked) b.addEventListener("click", () => pick(o.id));
      stage.appendChild(b);
    }
    const partnerLocked = !!es.locked[other];
    $("status").textContent = iLocked
      ? partnerLocked
        ? "Both locked — revealing…"
        : "Locked in. No peeking — waiting for them…"
      : partnerLocked
      ? "They've locked in. Your move 👀"
      : "Pick one — privately.";
  }
}

function pick(id) {
  if (myPick) return;
  myPick = id;
  netSend({ t: "pick", choice: id });
  renderEcho();
}

// ---- screens / pairing ----------------------------------------------------
function show(name) {
  screen = name;
  $("home").classList.toggle("hidden", name !== "home");
  $("lobby").classList.toggle("hidden", name !== "lobby");
  $("win").classList.toggle("hidden", name !== "win");
  $("play").classList.toggle("hidden", name !== "play");
  if (name === "play") renderEcho();
}

function genCode() {
  const alpha = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let s = "";
  for (let i = 0; i < 4; i++) s += alpha[(Math.random() * alpha.length) | 0];
  return s;
}
function inviteUrl() {
  return location.origin + location.pathname + "?room=" + roomId;
}
function updateLobby() {
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
    $("qr").src = await QRCode.toDataURL(inviteUrl(), { margin: 1, width: 360 });
  } catch {
    $("qr").style.display = "none";
  }
}
function showWin() {
  show("win");
}

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
};
$("btn-enter").onclick = () => show("play");
$("btn-again").onclick = () => {
  netSend({ t: "reset" });
  myPick = null;
  show("play");
};
$("btn-copy").onclick = async () => {
  try {
    await navigator.clipboard.writeText(inviteUrl());
    $("btn-copy").textContent = "Copied!";
    setTimeout(() => ($("btn-copy").textContent = "Copy invite link"), 1500);
  } catch {}
};

// ---- boot -----------------------------------------------------------------
function boot() {
  const room = new URLSearchParams(location.search).get("room");
  if (room) {
    $("join-code").value = room.toUpperCase();
    connect(room.toUpperCase());
    show("play");
  } else {
    show("home");
  }
}
boot();
