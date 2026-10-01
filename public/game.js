// Two Bots, One Brain: two identical arenas. You move the same way in both.
// Each bot asks the server (and Jev) what to do every 1.5 s; only the state format differs.

const W = 40, H = 28;            // arena size in meters
const SCALE = 15;                // pixels per meter (canvas is 600 x 420)
const ROUND = 90;                // seconds
const DECIDE_EVERY = 1.5;        // seconds between a bot's decisions
const VISION = 22;               // meters a bot can see
const NEAR = 10;                 // "near" in the rules
const BOT_SPEED = 4.4, PLAYER_SPEED = 6;
// Combat tuning: slow enough that decisions matter, with short ranges so retreating actually helps.
const PLAYER_HP = 150, PLAYER_DMG = 6, BOT_DMG = 7, PLAYER_FIRE = 0.3;
const PLAYER_RANGE = 18, BOT_RANGE = 16;      // meters a bullet travels
const AIM_ASSIST = 0.5;                       // radians: shots within this of a bot snap to it, in each arena
const PATROL = [[32, 6], [32, 22], [22, 22], [22, 6]];
const ROUTE = [[6, 14], [13, 6], [21, 11], [14, 21], [5, 23], [9, 14], [26, 14], [30, 20], [8, 8]];

const $ = (id) => document.getElementById(id);
const COLORS = { ink: "#1e1e1e", paper: "#fefefe", pink: "#f386a1", raw: "#f59e0b", good: "#1f7a3a", bad: "#c2283d", grey: "#c4c4c4" };

let mode = "play";
let running = false, t = 0, last = 0, offline = false;
const keys = new Set();
const mouse = { x: W / 2, y: H / 2, down: false };
let player, worlds, routeIdx;

function makeWorld(brain, canvasId, prefix) {
  return {
    brain, prefix, ctx: $(canvasId).getContext("2d"),
    bot: {
      x: 32, y: H / 2, hp: 250, maxHp: 250, ammo: 12, medkits: 2, heading: 180, action: "patrol",
      alive: true, shotT: -9, reloadUntil: 0, healUntil: 0, wp: 0, diedAt: null, flash: 0,
    },
    you: { hp: PLAYER_HP, downAt: null, hit: 0 },
    bullets: [], noise: null, pending: false, nextDecide: 0.4,
    last: null, log: [], mistakes: [], stats: { n: 0, ok: 0, dmg: 0, tokens: 0, tokN: 0 },
  };
}

function reset() {
  t = 0;
  routeIdx = 0;
  player = { x: 6, y: H / 2, lastShot: -9 };
  worlds = [makeWorld("raw", "c-raw", "raw"), makeWorld("jev-state", "c-js", "js")];
  for (const w of worlds) { renderLog(w); setNow(w); }
  $("overlay").classList.remove("show");
}

// ---------- helpers ----------

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const r1 = (x) => Math.round(x * 10) / 10;
/** An arena is over when its bot or you are down. */
const ended = (w) => !w.bot.alive || w.you.downAt !== null;

function step(o, dx, dy, speed, dt) {
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) return;
  o.x = clamp(o.x + (dx / len) * speed * dt, 1, W - 1);
  o.y = clamp(o.y + (dy / len) * speed * dt, 1, H - 1);
  if (o.heading !== undefined) o.heading = (Math.atan2(dy, dx) * 180) / Math.PI;
}

function shoot(w, from, to, owner, spread = 0) {
  const a = Math.atan2(to.y - from.y, to.x - from.x) + spread;
  const speed = owner === "player" ? 34 : 26;
  const life = (owner === "player" ? PLAYER_RANGE : BOT_RANGE) / speed;
  w.bullets.push({ x: from.x, y: from.y, vx: Math.cos(a) * speed, vy: Math.sin(a) * speed, owner, life });
}

// ---------- player ----------

function updatePlayer(dt) {
  if (mode === "play") {
    let dx = 0, dy = 0;
    if (keys.has("w") || keys.has("arrowup")) dy -= 1;
    if (keys.has("s") || keys.has("arrowdown")) dy += 1;
    if (keys.has("a") || keys.has("arrowleft")) dx -= 1;
    if (keys.has("d") || keys.has("arrowright")) dx += 1;
    step(player, dx, dy, PLAYER_SPEED, dt);
    if (mouse.down && t - player.lastShot > PLAYER_FIRE) {
      player.lastShot = t;
      const aim = Math.atan2(mouse.y - player.y, mouse.x - player.x);
      for (const w of worlds) {
        if (ended(w)) continue;
        // The bots stand in different places, so aim assist snaps to each arena's own bot.
        // The same click is equally accurate in both arenas.
        const b = w.bot;
        const toBot = Math.atan2(b.y - player.y, b.x - player.x);
        const off = Math.abs(Math.atan2(Math.sin(toBot - aim), Math.cos(toBot - aim)));
        const snap = off < AIM_ASSIST && dist(player, b) <= PLAYER_RANGE + 2;
        shoot(w, player, snap ? b : mouse, "player");
        w.noise = { x: player.x, y: player.y, t };
      }
    }
    return;
  }
  // Watch mode: a scripted route, the same in both arenas. It fires in bursts at each arena's bot.
  const [tx, ty] = ROUTE[routeIdx % ROUTE.length];
  if (Math.hypot(tx - player.x, ty - player.y) < 0.6) routeIdx++;
  step(player, tx - player.x, ty - player.y, 4.2, dt);
  const burst = t % 18 < 11;
  if (burst && t - player.lastShot > 0.4) {
    player.lastShot = t;
    for (const w of worlds) {
      if (ended(w) || dist(player, w.bot) > PLAYER_RANGE) continue;
      shoot(w, player, w.bot, "player", Math.sin(t * 7.3) * 0.09);
      w.noise = { x: player.x, y: player.y, t };
    }
  }
}

// ---------- bots ----------

function updateBot(w, dt) {
  const b = w.bot;
  if (ended(w)) return;
  b.flash = Math.max(0, b.flash - dt);
  if (b.ammo === 0 && !b.reloadUntil) b.reloadUntil = t + 2.5;
  if (b.reloadUntil && t >= b.reloadUntil) { b.ammo = 12; b.reloadUntil = 0; }

  const d = dist(b, player);
  const visible = d < VISION;
  switch (b.action) {
    case "retreat":
      step(b, b.x - player.x, b.y - player.y, BOT_SPEED * 1.1, dt);
      break;
    case "heal":
      if (!b.healUntil && b.medkits > 0) b.healUntil = t + 1;
      if (b.healUntil && t >= b.healUntil) { b.hp = Math.min(b.maxHp, b.hp + 110); b.medkits--; b.healUntil = 0; }
      break;
    case "attack":
      if (visible) {
        if (d > 11) step(b, player.x - b.x, player.y - b.y, BOT_SPEED, dt);
        else if (d < 7) step(b, b.x - player.x, b.y - player.y, BOT_SPEED * 0.6, dt);
        b.heading = (Math.atan2(player.y - b.y, player.x - b.x) * 180) / Math.PI;
        if (b.ammo > 0 && !b.reloadUntil && t - b.shotT > 0.5) {
          b.shotT = t; b.ammo--;
          shoot(w, b, player, "bot", Math.sin(t * 5.1) * 0.12);
        }
      } else {
        step(b, player.x - b.x, player.y - b.y, BOT_SPEED, dt);
      }
      break;
    case "investigate":
      if (w.noise && Math.hypot(w.noise.x - b.x, w.noise.y - b.y) > 1) step(b, w.noise.x - b.x, w.noise.y - b.y, BOT_SPEED, dt);
      break;
    default: {
      const [px, py] = PATROL[b.wp % PATROL.length];
      if (Math.hypot(px - b.x, py - b.y) < 1) b.wp++;
      step(b, px - b.x, py - b.y, BOT_SPEED * 0.7, dt);
    }
  }
}

function updateBullets(w, dt) {
  const b = w.bot;
  if (ended(w)) { w.bullets = []; return; }
  w.bullets = w.bullets.filter((p) => {
    p.x += p.vx * dt; p.y += p.vy * dt; p.life -= dt;
    if (p.life <= 0 || p.x < 0 || p.y < 0 || p.x > W || p.y > H) return false;
    if (p.owner === "player" && b.alive && Math.hypot(p.x - b.x, p.y - b.y) < 0.9) {
      b.hp = Math.max(0, b.hp - PLAYER_DMG); b.flash = 0.12;
      if (b.hp === 0) { b.alive = false; b.diedAt = t; addLog(w, { action: "down", note: `at ${t.toFixed(1)}s` }); }
      return false;
    }
    if (p.owner === "bot" && Math.hypot(p.x - player.x, p.y - player.y) < 0.75) {
      w.stats.dmg += BOT_DMG; w.you.hit = 0.12;
      w.you.hp = Math.max(0, w.you.hp - BOT_DMG);
      if (w.you.hp === 0) { w.you.downAt = t; addLog(w, { action: "youdown", note: `at ${t.toFixed(1)}s` }); }
      return false;
    }
    return true;
  });
}

// ---------- decisions ----------

function snapshot(w) {
  const b = w.bot;
  const d = dist(b, player);
  return {
    hp: Math.round(b.hp), maxHp: b.maxHp, ammo: b.ammo, medkits: b.medkits,
    enemyDistances: d < VISION ? [r1(d)] : [],
    noiseSecondsAgo: w.noise ? r1(t - w.noise.t) : null,
    position: { x: b.x, y: b.y }, heading: b.heading, tick: Math.round(t * 60),
  };
}

async function decide(w) {
  w.pending = true;
  const round = roundId;
  const input = snapshot(w);
  const askedAt = t;
  try {
    const res = await fetch("/api/decide", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ brain: w.brain, input }),
    });
    const d = await res.json();
    if (round !== roundId || !running) return;
    if (!res.ok) throw new Error(d.error || "request failed");
    const b = w.bot;
    if (ended(w)) return;
    b.action = d.action;
    if (d.action !== "heal") b.healUntil = 0;
    const ok = d.action === d.expected;
    w.stats.n++; if (ok) w.stats.ok++;
    if (d.tokens) { w.stats.tokens += d.tokens; w.stats.tokN++; }
    w.last = { ...d, ok };
    addLog(w, { action: d.action, ok, expected: d.expected, conf: d.confidence });
    if (!ok) w.mistakes.push({ t: askedAt, action: d.action, expected: d.expected, input });
    $(`${w.prefix}-chars`).textContent = d.chars;
    setNow(w);
    updateScore();
  } catch (err) {
    if (round === roundId) addLog(w, { action: "error", note: String(err.message || err).slice(0, 40) });
  } finally {
    if (round === roundId) { w.pending = false; w.nextDecide = t + DECIDE_EVERY; }
  }
}

// ---------- HUD ----------

function addLog(w, entry) {
  w.log.unshift({ t, ...entry });
  w.log = w.log.slice(0, 4);
  renderLog(w);
}

function renderLog(w) {
  $(`${w.prefix}-log`).innerHTML = w.log.map((e) => {
    if (e.action === "down") return `<div class="no"><span>${e.t.toFixed(1)}s · BOT DOWN</span><span>${e.note}</span></div>`;
    if (e.action === "youdown") return `<div class="ok"><span>${e.t.toFixed(1)}s · BOT WON</span><span>you went down ${e.note}</span></div>`;
    if (e.action === "error") return `<div class="no"><span>${e.t.toFixed(1)}s · error</span><span>${e.note}</span></div>`;
    return `<div class="${e.ok ? "ok" : "no"}"><span>${e.t.toFixed(1)}s · ${e.action}</span><span>${e.ok ? "✓" : `✗ should be ${e.expected}`} · ${Math.round(e.conf * 100)}%</span></div>`;
  }).join("");
}

function setNow(w) {
  const l = w.last;
  $(`${w.prefix}-act`).textContent = l ? l.action : "…";
  $(`${w.prefix}-mark`).innerHTML = l ? `<span class="mark ${l.ok ? "ok" : "no"}">${l.ok ? "✓ CORRECT" : `✗ ${l.expected.toUpperCase()}`}</span>` : "";
}

function updateHud() {
  for (const w of worlds) {
    const b = w.bot;
    $(`${w.prefix}-hp`).style.width = `${(b.hp / b.maxHp) * 100}%`;
    $(`${w.prefix}-hp-t`).textContent = b.alive ? `${Math.round(b.hp)}/${b.maxHp}` : "DOWN";
    $(`${w.prefix}-ammo`).textContent = b.reloadUntil ? "↻" : b.ammo;
    $(`${w.prefix}-med`).textContent = b.medkits;
    $(`${w.prefix}-correct`).textContent = `${w.stats.ok}/${w.stats.n}`;
  }
  $("timer").textContent = Math.max(0, ROUND - t).toFixed(1);
}

function updateScore() {
  const [a, j] = worlds;
  $("s-raw").innerHTML = `${a.stats.ok}<small>/${a.stats.n}</small>`;
  $("s-js").innerHTML = `${j.stats.ok}<small>/${j.stats.n}</small>`;
}

// ---------- drawing ----------

// 12x11 bot and 10x10 player, drawn pixel by pixel. k = outline, b = body, w = white.
const BOT = [
  ".....kk.....", "......k.....", "..kkkkkkkk..", ".kbbbbbbbbk.", ".kbwwbbwwbk.", ".kbwwbbwwbk.",
  ".kbbbbbbbbk.", ".kbbkkkkbbk.", ".kbbbbbbbbk.", "..kkkkkkkk..",
];
const BOT_LEGS = ["..kk....kk..", "...kk..kk..."];
const PLAYER = ["...kkkk...", "..kkkkkk..", "..kwwwwk..", "..kwkkwk..", "...kwwk...", ".kkkkkkkk.", "k.kkkkkk.k", "..kkkkkk.."];
const PLAYER_LEGS = [["..kk..kk..", "..k....k.."], ["...kkkk...", "...k..k..."]];
const PX = 2.8;

function sprite(c, rows, cx, cy, pal) {
  const w = rows[0].length * PX, h = rows.length * PX;
  const x0 = Math.round(cx - w / 2), y0 = Math.round(cy - h / 2);
  rows.forEach((row, r) => {
    for (let i = 0; i < row.length; i++) {
      const col = pal[row[i]];
      if (col) { c.fillStyle = col; c.fillRect(x0 + i * PX, y0 + r * PX, Math.ceil(PX), Math.ceil(PX)); }
    }
  });
  return { x0, y0, w, h };
}

function draw(w) {
  const c = w.ctx, S = SCALE, b = w.bot, isJs = w.brain === "jev-state";
  c.fillStyle = COLORS.paper; c.fillRect(0, 0, W * S, H * S);
  c.fillStyle = "rgba(30,30,30,.16)";
  for (let x = 1; x < W; x++) for (let y = 1; y < H; y++) c.fillRect(x * S - 1, y * S - 1, 2, 2);

  // noise ring
  if (w.noise && t - w.noise.t < 1.2) {
    const k = (t - w.noise.t) / 1.2;
    c.strokeStyle = `rgba(30,30,30,${0.5 * (1 - k)})`; c.lineWidth = 2;
    c.beginPath(); c.arc(w.noise.x * S, w.noise.y * S, (1 + k * 6) * S, 0, Math.PI * 2); c.stroke();
  }

  if (b.alive) {
    // vision and "near" circles
    c.fillStyle = isJs ? "rgba(243,134,161,.08)" : "rgba(245,158,11,.07)";
    c.beginPath(); c.arc(b.x * S, b.y * S, VISION * S, 0, Math.PI * 2); c.fill();
    c.setLineDash([6, 6]); c.strokeStyle = "rgba(194,40,61,.45)"; c.lineWidth = 1.5;
    c.beginPath(); c.arc(b.x * S, b.y * S, NEAR * S, 0, Math.PI * 2); c.stroke(); c.setLineDash([]);
    c.fillStyle = "rgba(194,40,61,.6)"; c.font = "16px VT323, monospace"; c.fillText("near", b.x * S + NEAR * S * 0.72, b.y * S - NEAR * S * 0.72);
  }

  // bullets
  for (const p of w.bullets) {
    c.fillStyle = p.owner === "player" ? COLORS.ink : COLORS.bad;
    c.fillRect(p.x * S - 2.5, p.y * S - 2.5, 5, 5);
  }

  // player
  const walk = Math.floor(t * 7) % 2;
  const youDown = w.you.downAt !== null;
  sprite(c, [...PLAYER, ...PLAYER_LEGS[running && !youDown ? walk : 0]], player.x * S, player.y * S,
    { k: youDown ? COLORS.grey : w.you.hit > 0 ? COLORS.bad : COLORS.ink, w: COLORS.paper });
  c.fillStyle = COLORS.ink; c.font = "16px VT323, monospace"; c.fillText("YOU", player.x * S - 10, player.y * S + 1.7 * S);
  // your hp in this arena
  c.fillStyle = COLORS.ink; c.font = "18px VT323, monospace"; c.fillText(`YOU ${w.you.hp}/${PLAYER_HP}`, 8, 18);
  c.strokeStyle = COLORS.ink; c.lineWidth = 1.5; c.strokeRect(8, 24, 100, 7);
  c.fillRect(9, 25, 98 * (w.you.hp / PLAYER_HP), 5);
  if (youDown) {
    c.fillStyle = COLORS.ink; c.font = "28px VT323, monospace";
    c.fillText(`BOT WON · you went down at ${w.you.downAt.toFixed(1)}s`, W * S / 2 - 170, 34);
  }

  // bot
  const body = !b.alive ? COLORS.grey : b.flash > 0 ? COLORS.paper : isJs ? COLORS.pink : COLORS.raw;
  const still = !running || !b.alive || b.healUntil;
  const box = sprite(c, [...BOT, BOT_LEGS[still ? 0 : walk]], b.x * S, b.y * S, { k: COLORS.ink, b: body, w: COLORS.paper });
  const size = box.w, bx = box.x0, by = box.y0;
  if (b.alive) {
    // pupils follow the heading
    const a = (b.heading * Math.PI) / 180, ox = Math.cos(a) > 0.3 ? 1 : 0, oy = Math.sin(a) > 0.3 ? 1 : 0;
    c.fillStyle = COLORS.ink;
    c.fillRect(bx + (3 + ox) * PX, by + (4 + oy) * PX, Math.ceil(PX), Math.ceil(PX));
    c.fillRect(bx + (7 + ox) * PX, by + (4 + oy) * PX, Math.ceil(PX), Math.ceil(PX));
    // hp bar
    c.fillStyle = COLORS.paper; c.fillRect(bx - 4, by - 12, size + 8, 7);
    c.fillStyle = isJs ? COLORS.pink : COLORS.raw; c.fillRect(bx - 3, by - 11, (size + 6) * (b.hp / b.maxHp), 5);
    c.strokeStyle = COLORS.ink; c.lineWidth = 1.5; c.strokeRect(bx - 4, by - 12, size + 8, 7);
    // action bubble
    if (w.last) {
      const label = `${w.last.action.toUpperCase()} ${w.last.ok ? "✓" : "✗"}`;
      c.font = "20px VT323, monospace";
      const tw = c.measureText(label).width + 12;
      const lx = clamp(b.x * S - tw / 2, 2, W * S - tw - 2), ly = by - 36;
      c.fillStyle = w.last.ok ? COLORS.good : COLORS.bad; c.fillRect(lx, ly, tw, 20);
      c.strokeStyle = COLORS.ink; c.strokeRect(lx, ly, tw, 20);
      c.fillStyle = COLORS.paper; c.fillText(label, lx + 6, ly + 15);
    }
    if (b.reloadUntil || b.healUntil) {
      c.fillStyle = COLORS.ink; c.font = "16px VT323, monospace";
      c.fillText(b.healUntil ? "+ healing" : "reloading", bx - 6, by + size + 16);
    }
  } else {
    c.strokeStyle = COLORS.ink; c.lineWidth = 3;
    c.beginPath(); c.moveTo(bx + 4, by + 4); c.lineTo(bx + size - 4, by + size - 4); c.moveTo(bx + size - 4, by + 4); c.lineTo(bx + 4, by + size - 4); c.stroke();
    c.fillStyle = COLORS.ink; c.font = "28px VT323, monospace";
    c.fillText(`BOT DOWN · ${b.diedAt.toFixed(1)}s`, W * S / 2 - 90, 34);
  }

  if (!running && t === 0) {
    c.fillStyle = "rgba(30,30,30,.72)"; c.fillRect(0, H * S / 2 - 30, W * S, 60);
    c.fillStyle = COLORS.paper; c.font = "30px VT323, monospace";
    c.fillText("PRESS START ROUND", W * S / 2 - 105, H * S / 2 + 9);
  }
}

// ---------- loop ----------

let roundId = 0;

function frame(now) {
  const dt = Math.min(0.05, (now - last) / 1000 || 0);
  last = now;
  if (running) {
    t += dt;
    updatePlayer(dt);
    for (const w of worlds) {
      updateBot(w, dt);
      updateBullets(w, dt);
      w.you.hit = Math.max(0, w.you.hit - dt);
      if (!ended(w) && !w.pending && t >= w.nextDecide) decide(w);
    }
    if (t >= ROUND || worlds.every(ended)) endRound();
  }
  for (const w of worlds) draw(w);
  updateHud();
  requestAnimationFrame(frame);
}

function endRound() {
  running = false;
  const [a, j] = worlds;
  const pct = (s) => (s.n ? `${Math.round((s.ok / s.n) * 100)}%` : "–");
  const tok = (s) => (s.tokN ? Math.round(s.tokens / s.tokN) : "–");
  const better = j.stats.n && a.stats.n && j.stats.ok / j.stats.n > a.stats.ok / a.stats.n;
  $("o-title").innerHTML = better ? 'Same brain. <span class="hl">Better data won.</span>' : "Round over";
  $("o-table").innerHTML = `
    <tr><td></td><td>Raw bot</td><td>jev-state bot</td></tr>
    <tr><td>Correct decisions <small>(fair score)</small></td><td>${a.stats.ok}/${a.stats.n} (${pct(a.stats)})</td><td class="hl">${j.stats.ok}/${j.stats.n} (${pct(j.stats)})</td></tr>
    <tr><td>Outcome</td><td>${outcome(a)}</td><td>${outcome(j)}</td></tr>
    <tr><td>Bot hp left</td><td>${Math.round(a.bot.hp)}/${a.bot.maxHp}</td><td>${Math.round(j.bot.hp)}/${j.bot.maxHp}</td></tr>
    <tr><td>Your hp left</td><td>${a.you.hp}/${PLAYER_HP}</td><td>${j.you.hp}/${PLAYER_HP}</td></tr>
    <tr><td>Avg input tokens</td><td>${tok(a.stats)}</td><td>${tok(j.stats)}</td></tr>`;
  $("o-mistakes").innerHTML = [a, j].map(mistakesHtml).join("");
  $("overlay").classList.add("show");
}

function outcome(w) {
  if (!w.bot.alive) return `bot down · ${w.bot.diedAt.toFixed(1)}s`;
  if (w.you.downAt !== null) return `bot won · ${w.you.downAt.toFixed(1)}s`;
  return "both standing";
}

function describeInput(i) {
  const hp = `hp ${Math.round((i.hp / i.maxHp) * 100)}%`;
  const enemy = i.enemyDistances.length ? `you ${i.enemyDistances[0].toFixed(1)} m away` : "you out of sight";
  const noise = i.noiseSecondsAgo == null ? "" : ` · noise ${Math.round(i.noiseSecondsAgo)}s ago`;
  return `${hp} · ${enemy}${noise}`;
}

function mistakesHtml(w) {
  const name = w.brain === "raw" ? "Raw bot" : "jev-state bot";
  if (!w.mistakes.length) return `<div class="m-head ok">${name}: no wrong decisions ✓</div>`;
  const died = w.bot.diedAt;
  const fatal = died == null ? null : [...w.mistakes].reverse().find((m) => m.t <= died && died - m.t < 4);
  const rows = w.mistakes.slice(0, 4).map((m) => `
    <div class="m-row${m === fatal ? " fatal" : ""}">
      <span>${m.t.toFixed(1)}s · <b>${m.action}</b> ✗ should be <b>${m.expected}</b></span>
      <span>${describeInput(m.input)}${m === fatal ? ` · died ${(died - m.t).toFixed(1)}s later` : ""}</span>
    </div>`).join("");
  const more = w.mistakes.length > 4 ? `<div class="m-more">+ ${w.mistakes.length - 4} more</div>` : "";
  return `<div class="m-head">${name}: ${w.mistakes.length} wrong decision${w.mistakes.length > 1 ? "s" : ""}</div>${rows}${more}`;
}

function start() {
  roundId++;
  reset();
  running = true;
}

// ---------- shareable result image ----------

function downloadResult() {
  const [a, j] = worlds;
  const cv = document.createElement("canvas");
  cv.width = 1200; cv.height = 630;
  const c = cv.getContext("2d");
  c.fillStyle = COLORS.pink; c.fillRect(0, 0, 1200, 630);
  c.fillStyle = "rgba(30,30,30,.2)";
  for (let x = 5; x < 1200; x += 10) for (let y = 5; y < 630; y += 10) c.fillRect(x, y, 2, 2);

  // window
  c.fillStyle = COLORS.ink; c.fillRect(68, 58, 1072, 520);
  c.fillStyle = COLORS.paper; c.fillRect(60, 50, 1072, 520);
  c.strokeStyle = COLORS.ink; c.lineWidth = 3; c.strokeRect(60, 50, 1072, 520);
  c.fillStyle = COLORS.ink; c.fillRect(60, 50, 1072, 44);
  c.fillStyle = COLORS.paper; c.font = "30px VT323, monospace"; c.fillText("TWO_BOTS_ONE_BRAIN.result", 78, 82);

  const pct = (s) => (s.n ? Math.round((s.ok / s.n) * 100) : 0);
  c.fillStyle = COLORS.ink; c.font = "600 58px 'Space Grotesk', sans-serif";
  c.fillText("Same brain. Same rules.", 96, 168);
  const win = j.stats.n && pct(j.stats) > pct(a.stats);
  const line = win ? "Better data won." : "Different data.";
  c.font = "600 58px 'Space Grotesk', sans-serif";
  const lw = c.measureText(line).width;
  c.fillStyle = COLORS.pink; c.fillRect(90, 186, lw + 16, 66);
  c.fillStyle = COLORS.ink; c.fillText(line, 98, 238);

  const rows = [
    ["", "RAW BOT", "JEV-STATE BOT"],
    ["Correct decisions", `${a.stats.ok}/${a.stats.n} (${pct(a.stats)}%)`, `${j.stats.ok}/${j.stats.n} (${pct(j.stats)}%)`],
    ["Outcome", outcome(a), outcome(j)],
    ["Avg input tokens", a.stats.tokN ? String(Math.round(a.stats.tokens / a.stats.tokN)) : "-", j.stats.tokN ? String(Math.round(j.stats.tokens / j.stats.tokN)) : "-"],
  ];
  rows.forEach((r, i) => {
    const y = 316 + i * 52;
    if (i > 0) { c.fillStyle = COLORS.pink; c.fillRect(806, y - 36, 300, 48); }
    c.fillStyle = COLORS.ink;
    c.font = i === 0 ? "28px VT323, monospace" : "500 26px 'IBM Plex Mono', monospace";
    c.fillText(r[0], 96, y);
    c.fillText(r[1], 500, y);
    c.font = i === 0 ? "28px VT323, monospace" : "600 26px 'IBM Plex Mono', monospace";
    c.fillText(r[2], 820, y);
    c.fillRect(90, y + 14, 1016, 2);
  });
  c.font = "500 17px 'IBM Plex Mono', monospace"; c.fillStyle = "#555";
  c.fillText("Correct decisions is the fair score. Outcome also depends on aim and positioning.", 96, 510);
  c.font = "500 20px 'IBM Plex Mono', monospace"; c.fillStyle = "#3a3a3a";
  c.fillText("github.com/suranjaychandra/two-bots-one-brain  ·  built with jev-state  ·  model: Jev", 96, 545);

  const link = document.createElement("a");
  link.download = `two-bots-one-brain-${Date.now()}.png`;
  link.href = cv.toDataURL("image/png");
  link.click();
}

// ---------- input ----------

window.addEventListener("keydown", (e) => {
  const k = e.key.toLowerCase();
  if (["w", "a", "s", "d", "arrowup", "arrowdown", "arrowleft", "arrowright", " "].includes(k)) e.preventDefault();
  keys.add(k);
});
window.addEventListener("keyup", (e) => keys.delete(e.key.toLowerCase()));
for (const id of ["c-raw", "c-js"]) {
  const cv = $(id);
  const toWorld = (e) => {
    const r = cv.getBoundingClientRect();
    mouse.x = ((e.clientX - r.left) / r.width) * W;
    mouse.y = ((e.clientY - r.top) / r.height) * H;
  };
  cv.addEventListener("mousemove", toWorld);
  cv.addEventListener("mousedown", (e) => { toWorld(e); mouse.down = true; });
}
window.addEventListener("mouseup", () => (mouse.down = false));

function setMode(m) {
  mode = m;
  $("mode-play").classList.toggle("on", m === "play");
  $("mode-watch").classList.toggle("on", m === "watch");
  $("help").textContent = m === "play"
    ? "WASD to move · click to shoot · you move the same way in both arenas"
    : "Watch mode: you follow a fixed route and fire in bursts, the same in both arenas";
}
$("mode-play").addEventListener("click", () => setMode("play"));
$("mode-watch").addEventListener("click", () => setMode("watch"));
$("start").addEventListener("click", start);
$("again").addEventListener("click", start);
$("download").addEventListener("click", downloadResult);

// Close the round summary: the × button, Esc, or a click outside the card.
const closeOverlay = () => $("overlay").classList.remove("show");
$("close").addEventListener("click", closeOverlay);
$("overlay").addEventListener("click", (e) => { if (e.target.id === "overlay") closeOverlay(); });
window.addEventListener("keydown", (e) => { if (e.key === "Escape") closeOverlay(); });

(async () => {
  try {
    const info = await (await fetch("/api/info")).json();
    offline = info.offline;
    document.body.classList.toggle("offline", offline);
    $("mode").textContent = offline ? "offline: local rules" : "live Jev";
    $("dot").classList.toggle("off", offline);
  } catch {}
  if (matchMedia("(pointer: coarse)").matches) {
    setMode("watch");
    $("help").textContent = "On a phone, Watch mode works best. Use a laptop to play with WASD + mouse.";
  }
  await document.fonts.ready;
  reset();
  requestAnimationFrame(frame);
})();
