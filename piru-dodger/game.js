"use strict";
/* PIRU ST — Rainbow Dodger
   Player (P-hat) dodges the DJ-UFO's rainbow orbs & vinyl records.
   3 lives. Shoot the boss enough to blow it up -> next level. */

const canvas = document.getElementById("game");
const ctx = canvas.getContext("2d");
const W = canvas.width, H = canvas.height;
const GROUND_Y = H * 0.81 + 30;   // player's feet line (near the curb)
const UIFONT = '"Press Start 2P", "Courier New", monospace';

// ---------- asset loading ----------
const IMG = {};                    // IMG[sheet][anim] = [{img,w,h}, ...]
let bgImg = null, beamImg = null, titleImg = null;
const explodeFrames = [];          // explosion sprite animation (from the boss sheet)
let assetsLeft = 0, assetsTotal = 0, loadFailed = false;

function loadImage(src) {
  assetsTotal++; assetsLeft++;
  const im = new Image();
  im.onload = () => { assetsLeft--; };
  im.onerror = () => { assetsLeft--; loadFailed = true; console.error("failed", src); };
  im.src = src;
  return im;
}
function loadAssets() {
  bgImg = loadImage("assets/raw/background.jpg?v=3");
  titleImg = loadImage("assets/title.jpg?v=1");
  beamImg = loadImage("assets/boss/beam.png");
  try { if (document.fonts) document.fonts.load('16px "Press Start 2P"'); } catch (e) {}
  for (let i = 0; i < 6; i++) explodeFrames.push(loadImage(`assets/boss/explode_${i}.png`));
  for (const sheet in window.MANIFEST) {
    IMG[sheet] = {};
    for (const anim in window.MANIFEST[sheet]) {
      IMG[sheet][anim] = window.MANIFEST[sheet][anim].map(f => ({
        img: loadImage(f.file), w: f.w, h: f.h
      }));
    }
  }
}

// ---------- input ----------
const keys = {};
const KEYMAP = {
  ArrowLeft: "left", KeyA: "left",
  ArrowRight: "right", KeyD: "right",
  ArrowUp: "jump", KeyW: "jump", Space: "jump",
  KeyJ: "shoot", KeyF: "shoot", KeyZ: "shoot",
  Enter: "start", KeyP: "pause"
};
addEventListener("keydown", e => {
  const a = KEYMAP[e.code];
  if (a) {
    e.preventDefault();
    if (!keys[a]) keys[a + "_p"] = true;   // edge: pressed this frame
    keys[a] = true;
  }
});
addEventListener("keyup", e => {
  const a = KEYMAP[e.code];
  if (a) { e.preventDefault(); keys[a] = false; }
});
// on-screen gamepad buttons
document.querySelectorAll("[data-k]").forEach(btn => {
  const k = btn.dataset.k;
  const on = e => { e.preventDefault(); if (!keys[k]) keys[k + "_p"] = true; keys[k] = true; keys.start = true; keys.start_p = true; };
  const off = e => { e.preventDefault(); keys[k] = false; };
  btn.addEventListener("touchstart", on, { passive: false });
  btn.addEventListener("touchend", off, { passive: false });
  btn.addEventListener("touchcancel", off, { passive: false });
  btn.addEventListener("mousedown", on);
  btn.addEventListener("mouseup", off);
  btn.addEventListener("mouseleave", off);
});
// tap canvas to start / shoot
canvas.addEventListener("pointerdown", () => { keys.start = true; keys.start_p = true; });

// thumb-pad: hold or DRAG side to side to steer (pointer = mouse + touch)
const dpad = document.querySelector(".dpad");
if (dpad) {
  let pid = null;
  const steer = clientX => {
    const r = dpad.getBoundingClientRect();
    const rel = clientX - (r.left + r.width / 2);
    const dz = r.width * 0.12;                 // small dead zone in the middle
    keys.left = rel < -dz;
    keys.right = rel > dz;
    dpad.dataset.dir = keys.left ? "left" : keys.right ? "right" : "";
  };
  const stop = () => { pid = null; keys.left = keys.right = false; dpad.dataset.dir = ""; };
  dpad.addEventListener("pointerdown", e => {
    e.preventDefault(); pid = e.pointerId;
    try { dpad.setPointerCapture(pid); } catch (_) {}
    keys.start = true; keys.start_p = true;
    steer(e.clientX);
  });
  dpad.addEventListener("pointermove", e => { if (e.pointerId === pid) steer(e.clientX); });
  dpad.addEventListener("pointerup", stop);
  dpad.addEventListener("pointercancel", stop);
}

// block mobile scroll / pinch-zoom / double-tap-zoom
["gesturestart", "gesturechange", "gestureend"].forEach(ev =>
  document.addEventListener(ev, e => e.preventDefault(), { passive: false }));
document.addEventListener("touchmove", e => { if (e.touches.length > 1) e.preventDefault(); }, { passive: false });
let lastTouchEnd = 0;
document.addEventListener("touchend", e => {
  const now = Date.now();
  if (now - lastTouchEnd < 300) e.preventDefault();   // double-tap zoom
  lastTouchEnd = now;
}, { passive: false });

function consume(a) { if (keys[a + "_p"]) { keys[a + "_p"] = false; return true; } return false; }
function clearEdges() { for (const k in keys) if (k.endsWith("_p")) keys[k] = false; }

// ---------- helpers ----------
const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
const rand = (a, b) => a + Math.random() * (b - a);
function overlap(a, b) {
  return Math.abs(a.x - b.x) * 2 < (a.w + b.w) && Math.abs(a.y - b.y) * 2 < (a.h + b.h);
}
function drawSprite(frame, scale, cx, topY, flip) {
  const w = frame.w * scale, h = frame.h * scale;
  ctx.save();
  ctx.translate(cx, topY);
  if (flip) ctx.scale(-1, 1);
  ctx.drawImage(frame.img, -w / 2, 0, w, h);
  ctx.restore();
}

// ---------- game state ----------
const STATE = { TITLE: 0, INTRO: 1, PLAY: 2, CLEAR: 3, OVER: 4 };
let state = STATE.TITLE;
let stateT = 0;            // time in current state
let level = 1, score = 0, lives = 3;
let trans = null;                  // start transition: { t, started }
const FLICKER_DUR = 0.42, FADE_DUR = 0.6;
const gamepadEl = document.getElementById("gamepad");

const PLAYER_SCALE = 170 / 338;   // player display height ~170px
const BOSS_SCALE = 152 / 324;
const CHARGE_T = 0.34;                  // time the rainbow builds up in the hand before firing
// rainbow beam drawn at the boss's own scale so it matches the one in his hand
function beamDims() {
  const w = (beamImg && beamImg.naturalWidth ? beamImg.naturalWidth : 93) * BOSS_SCALE;
  const h = (beamImg && beamImg.naturalHeight ? beamImg.naturalHeight : 210) * BOSS_SCALE;
  return { w, h, core: w * 0.34 };
}

const player = {
  x: W / 2, y: 0,           // y = vertical offset above ground (jump height, >=0)
  vx: 0, vy: 0,
  w: 55, h: 130,            // hitbox (scaled with the sprite)
  facing: 1,                // 1 right, -1 left
  airborne: false,
  inv: 0,                   // invulnerability after hit
  shootT: 0, shootCD: 0,
  animT: 0,
};

const boss = {
  x: W / 2, y: 110,
  tx: W / 2,                // move target x
  w: 150, h: 70,            // hitbox (UFO body)
  hp: 5, maxhp: 5,
  bob: 0,
  attackT: 0,               // cooldown until next attack
  anim: "idle", animT: 0, animOnce: false,
  castPhase: null, castT: 0, castN: 1,   // beam cast: 'charge' -> 'release'
  recoil: 0,
  alive: true,
};

let bossProj = [];   // beam:{x,y,vy,life} | vinyl/roll:{x,y,vx,vy,r,hue,ang,spin,life}
let bullets = [];    // {x,y,vy,w,h}
let particles = [];  // {x,y,vx,vy,life,max,col,size}
let explosions = []; // {x,y,t,dur,sc} — explosion sprite for hit effects

// ---------- level setup ----------
function bossMaxHP(n) { return 5 + (n - 1) * 3; }
function startLevel(n) {
  level = n;
  boss.maxhp = bossMaxHP(n);
  boss.hp = boss.maxhp;
  boss.x = W / 2; boss.tx = W / 2; boss.y = 110;
  boss.alive = true; boss.recoil = 0;
  boss.attackT = 1.2;
  boss.anim = "idle"; boss.animT = 0; boss.animOnce = false;
  boss.castPhase = null; boss.castT = 0;
  bossProj = []; bullets = []; particles = [];
  player.x = W / 2; player.y = 0; player.vy = 0; player.vx = 0;
  player.airborne = false; player.inv = 1.0;
  state = STATE.INTRO; stateT = 0;
}
function newGame() {
  level = 1; score = 0; lives = 3;
  startLevel(1);
}

// ---------- difficulty curve ----------
function diff() {
  const n = level;
  return {
    spawn: Math.max(0.5, 1.5 - 0.11 * n),     // seconds between attacks
    pspeed: 150 + 22 * n,                      // projectile fall speed
    bossSpeed: 55 + 14 * n,                    // boss horizontal speed
    multi: n >= 4 ? 2 : 1,                     // simultaneous projectiles
    bulletDmg: 1
  };
}

// ---------- player update ----------
const MOVE_SPEED = 230, JUMP_V = 620, GRAV = 1700;
function updatePlayer(dt) {
  player.animT += dt;

  // move
  let dir = (keys.left ? -1 : 0) + (keys.right ? 1 : 0);
  if (dir !== 0) player.facing = dir;
  player.vx = dir * MOVE_SPEED;
  player.x += player.vx * dt;
  player.x = clamp(player.x, 26, W - 26);

  // jump
  if (consume("jump") && !player.airborne) {
    player.vy = JUMP_V; player.airborne = true; player.animT = 0;
  }
  if (player.airborne) {
    player.y += player.vy * dt;
    player.vy -= GRAV * dt;
    if (player.y <= 0) { player.y = 0; player.vy = 0; player.airborne = false; player.animT = 0; }
  }

  // shoot
  if (player.shootCD > 0) player.shootCD -= dt;
  if (player.shootT > 0) player.shootT -= dt;
  if (keys.shoot && player.shootCD <= 0) {
    bullets.push({ x: player.x, y: GROUND_Y - player.y - 158, vy: -780, w: 8, h: 18 });
    player.shootCD = 0.22; player.shootT = 0.14;
  }

  if (player.inv > 0) player.inv -= dt;
}

function playerHitbox() {
  return { x: player.x, y: GROUND_Y - player.y - player.h / 2, w: player.w, h: player.h };
}

function playerFrame() {
  const A = IMG.player;
  // shooting pose — a single "arm up" frame, shown even while moving or airborne
  if (keys.shoot || player.shootT > 0) return A.shoot[Math.min(2, A.shoot.length - 1)];
  // airborne
  if (player.airborne) {
    let i; if (player.vy > 180) i = 1; else if (player.vy > -180) i = 2; else i = 3;
    return A.jump[clamp(i, 0, A.jump.length - 1)];
  }
  // grounded: run while a direction is held, else idle (snaps back instantly on release)
  const moving = keys.left || keys.right;
  const list = moving ? A.run : A.idle;
  return list[Math.floor(player.animT * (moving ? 14 : 6)) % list.length];
}

function drawPlayer() {
  const f = playerFrame();
  if (player.inv > 0 && Math.floor(player.inv * 16) % 2 === 0) return; // blink
  const topY = GROUND_Y - player.y - f.h * PLAYER_SCALE;
  drawSprite(f, PLAYER_SCALE, player.x, topY, player.facing < 0);
}

// ---------- boss update ----------
function setBossAnim(name, once) {
  if (boss.anim !== name) { boss.anim = name; boss.animT = 0; boss.animOnce = !!once; }
}
function updateBoss(dt) {
  const D = diff();
  boss.animT += dt;
  boss.bob += dt;

  // drift toward target, pick new target periodically
  if (Math.abs(boss.x - boss.tx) < 8) boss.tx = rand(90, W - 90);
  const dir = Math.sign(boss.tx - boss.x);
  boss.x += dir * D.bossSpeed * dt;
  boss.y = 92 + Math.sin(boss.bob * 1.6) * 14;

  if (boss.recoil > 0) { boss.recoil -= dt; }

  // attacks
  boss.attackT -= dt;
  if (boss.attackT <= 0 && boss.recoil <= 0 && boss.castPhase === null) {
    boss.attackT = D.spawn + rand(-0.15, 0.25);
    if (Math.random() < 0.55) {                 // rainbow beam: charge in hand, then release & fire
      boss.castPhase = "charge"; boss.castT = CHARGE_T; boss.castN = D.multi;
    } else {
      setBossAnim("vinyl", true);
      for (let k = 0; k < D.multi; k++) launchAttack("vinyl", D, k);
    }
  }
  // beam cast: rainbow grows in the hand, then the hand frame switches to "no rainbow" and it fires
  if (boss.castPhase === "charge") {
    boss.castT -= dt;
    if (boss.castT <= 0) {
      boss.castPhase = "release"; boss.castT = 0.22;
      for (let k = 0; k < boss.castN; k++) spawnBeam(D, k);
    }
  } else if (boss.castPhase === "release") {
    boss.castT -= dt;
    if (boss.castT <= 0) boss.castPhase = null;
  }

  // animation selection (cast frames are chosen in drawBoss)
  if (boss.castPhase) { /* handled in drawBoss */ }
  else if (boss.recoil > 0) setBossAnim("recoil", true);
  else if (boss.animOnce) {
    const list = IMG.boss[boss.anim];
    if (boss.animT * 14 >= list.length) { boss.animOnce = false; setBossAnim("idle", false); }
  } else {
    setBossAnim("move", false);
  }
}

// the DJ's hand (the "gun barrel") relative to the boss anchor, in display px
function handPos() { return { x: boss.x + 24, y: boss.y + 88 }; }

function spawnBeam(D, k) {
  const h = handPos();
  const off = k === 0 ? 0 : rand(46, 84) * (Math.random() < 0.5 ? -1 : 1);
  const bd = beamDims();
  bossProj.push({ kind: "beam", x: clamp(h.x + off, 20, W - 20), y: h.y + bd.h,
    vx: 0, vy: D.pspeed * 1.6, life: 6 });   // emerges at the hand, then falls straight down
}

function launchAttack(kind, D, k) {
  const sx = boss.x + rand(-30, 30), sy = boss.y + 64;
  const dirToP = Math.sign(player.x - sx) || 1;
  bossProj.push({ kind: "vinyl", x: sx, y: sy,
    vx: dirToP * rand(70, 150) + k * 40, vy: D.pspeed * 0.7,
    r: 17, hue: rand(0, 360), ang: 0, spin: rand(8, 14) * dirToP, life: 9 });
}

function drawBoss() {
  let list, i;
  if (boss.castPhase === "charge") {            // rainbow grows out of the hand (blast frames 3..6)
    list = IMG.boss.blast;
    i = clamp(3 + Math.floor((1 - boss.castT / CHARGE_T) * 4), 3, 6);
  } else if (boss.castPhase === "release") {    // hand frame with NO rainbow (it just fired)
    list = IMG.boss.blast; i = 2;
  } else {
    list = IMG.boss[boss.anim] || IMG.boss.idle;
    if (boss.animOnce || boss.recoil > 0) i = clamp(Math.floor(boss.animT * 14), 0, list.length - 1);
    else i = Math.floor(boss.animT * 6) % list.length;
  }
  const f = list[i];
  drawSprite(f, BOSS_SCALE, boss.x, boss.y - f.h * BOSS_SCALE * 0.02, false);
  // (George's health bar is drawn in the HUD, top-right)
}

function bossHitbox() { return { x: boss.x, y: boss.y + 24, w: boss.w, h: boss.h }; }

// ---------- projectiles ----------
function updateProjectiles(dt) {
  for (const p of bossProj) {
    p.life -= dt;
    if (p.kind === "beam") {
      p.y += p.vy * dt;                              // shoots straight down
      if (p.y >= GROUND_Y - 4) { p.life = 0; spawnBurst(p.x, GROUND_Y - 6, 16, 150); }
    } else if (p.kind === "roll") {
      p.x += p.vx * dt; p.ang += p.spin * dt;
    } else {                                         // vinyl: lobs, then rolls on the ground
      p.x += p.vx * dt; p.y += p.vy * dt;
      p.vy += 420 * dt; p.ang += p.spin * dt;
      if (p.y >= GROUND_Y - 8) {
        p.kind = "roll"; p.y = GROUND_Y - 8;
        p.vx = (Math.sign(p.vx) || 1) * Math.max(160, Math.abs(p.vx));
        p.life = 2.4;
      }
    }
  }
  bossProj = bossProj.filter(p => p.life > 0 && p.x > -40 && p.x < W + 40);

  for (const b of bullets) b.y += b.vy * dt;
  bullets = bullets.filter(b => b.y > -30);
}

function drawProjectiles() {
  // bullets (red)
  for (const b of bullets) {
    ctx.save();
    ctx.shadowColor = "#ff4d4d"; ctx.shadowBlur = 8;
    ctx.fillStyle = "#ffc2c2";
    ctx.fillRect(b.x - b.w / 2, b.y - b.h / 2, b.w, b.h);
    ctx.fillStyle = "#ff2424";
    ctx.fillRect(b.x - b.w / 2 + 2, b.y - b.h / 2 + 2, b.w - 4, b.h - 4);
    ctx.restore();
  }
  for (const p of bossProj) {
    if (p.kind === "beam") drawBeam(p);
    else drawVinyl(p);
  }
}

const RAINBOW = ["#ff3b3b", "#ff9e2c", "#ffe83b", "#4cd964", "#34aadc", "#5e5ce6", "#bf5af2"];
function drawBeam(p) {
  const bd = beamDims();
  const topY = p.y - bd.h;                            // sprite bottom = leading edge at p.y
  if (beamImg && beamImg.naturalWidth) {
    ctx.drawImage(beamImg, p.x - bd.w / 2, topY, bd.w, bd.h);
  } else {                                            // fallback: rainbow stripes
    const cw = bd.core / RAINBOW.length;
    for (let r = 0; r < RAINBOW.length; r++) {
      ctx.fillStyle = RAINBOW[r];
      ctx.fillRect(p.x - bd.core / 2 + r * cw, topY, cw + 1, bd.h);
    }
  }
}
function drawVinyl(p) {
  ctx.save();
  ctx.translate(p.x, p.y); ctx.rotate(p.ang);
  ctx.fillStyle = "#0c0c0e";
  ctx.beginPath(); ctx.arc(0, 0, p.r, 0, 7); ctx.fill();
  ctx.strokeStyle = "rgba(255,255,255,0.18)"; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.arc(0, 0, p.r * 0.7, 0, 7); ctx.stroke();
  ctx.beginPath(); ctx.arc(0, 0, p.r * 0.5, 0, 7); ctx.stroke();
  ctx.fillStyle = `hsl(${p.hue},85%,55%)`;
  ctx.beginPath(); ctx.arc(0, 0, p.r * 0.34, 0, 7); ctx.fill();
  ctx.fillStyle = "#0c0c0e";
  ctx.beginPath(); ctx.arc(0, 0, 2, 0, 7); ctx.fill();
  // shine
  ctx.strokeStyle = "rgba(255,255,255,0.5)"; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.arc(0, 0, p.r - 2, -0.9, -0.3); ctx.stroke();
  ctx.restore();
}

// ---------- particles ----------
const RED = ["#ff2424", "#ff5a3a", "#c81414", "#ff7a5a"];
// red burst — used only when a beam hits the ground
function spawnBurst(x, y, n, spread) {
  for (let i = 0; i < n; i++) {
    const a = rand(0, 7), s = rand(40, spread);
    particles.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s - 20,
      life: rand(0.3, 0.7), max: 0.7, size: rand(2, 5),
      col: RED[i % RED.length] });
  }
}
function updateParticles(dt) {
  for (const p of particles) {
    p.life -= dt;
    p.x += p.vx * dt; p.y += p.vy * dt; p.vy += 240 * dt;
  }
  particles = particles.filter(p => p.life > 0);
}
function drawParticles() {
  for (const p of particles) {
    ctx.globalAlpha = clamp(p.life / p.max, 0, 1);
    ctx.fillStyle = p.col;
    ctx.fillRect(p.x - p.size / 2, p.y - p.size / 2, p.size, p.size);
  }
  ctx.globalAlpha = 1;
}

// ---------- explosions (sprite animation from the sheet) ----------
function spawnExplosion(x, y, sc) { explosions.push({ x, y, t: 0, dur: 0.36, sc }); }
function updateExplosions(dt) {
  for (const e of explosions) e.t += dt;
  explosions = explosions.filter(e => e.t < e.dur);
}
function drawExplosions() {
  const n = explodeFrames.length;
  for (const e of explosions) {
    const p = e.t / e.dur;
    const f = explodeFrames[clamp(Math.floor(p * n), 0, n - 1)];
    if (!f || !f.naturalWidth) continue;
    const w = f.naturalWidth * e.sc, h = f.naturalHeight * e.sc;
    ctx.globalAlpha = p > 0.7 ? clamp(1 - (p - 0.7) / 0.3, 0, 1) : 1;
    ctx.drawImage(f, e.x - w / 2, e.y - h / 2, w, h);
  }
  ctx.globalAlpha = 1;
}

// ---------- collisions ----------
function handleCollisions() {
  // bullets vs boss
  if (boss.alive) {
    const bh = bossHitbox();
    for (const b of bullets) {
      if (overlap({ x: b.x, y: b.y, w: b.w, h: b.h }, bh)) {
        b.y = -999;
        boss.hp -= diff().bulletDmg;
        boss.recoil = 0.18; boss.animT = 0;
        score += 10;
        spawnExplosion(b.x, b.y - 6, 0.42);          // hit spark on the boss
        if (boss.hp <= 0) defeatBoss();
      }
    }
  }
  // boss projectiles vs player
  if (player.inv <= 0) {
    const ph = playerHitbox();
    for (const p of bossProj) {
      const bd = p.kind === "beam" ? beamDims() : null;
      const box = bd
        ? { x: p.x, y: p.y - bd.h / 2, w: bd.core, h: bd.h }
        : { x: p.x, y: p.y, w: p.r * 1.6, h: p.r * 1.6 };
      if (overlap(box, ph)) {
        if (p.kind !== "beam") p.life = 0;             // beam passes through, keeps falling
        hitPlayer();
        break;
      }
    }
  }
}
function hitPlayer() {
  lives--;
  player.inv = 1.3; player.animT = 0;
  spawnExplosion(player.x, GROUND_Y - player.y - player.h / 2, 0.6);
  if (lives <= 0) { state = STATE.OVER; stateT = 0; }
}
function defeatBoss() {
  boss.alive = false;
  score += 100 * level;
  spawnExplosion(boss.x, boss.y + 36, 1.7);          // big blast when the boss goes down
  spawnExplosion(boss.x - 52, boss.y + 70, 1.0);
  spawnExplosion(boss.x + 56, boss.y + 22, 1.0);
  state = STATE.CLEAR; stateT = 0;
  bossProj = [];
}

// ---------- rendering: background & HUD ----------
const bgBuf = document.createElement("canvas");
bgBuf.width = W; bgBuf.height = H;
const bgBufCtx = bgBuf.getContext("2d");
let bgReady = false;
function drawBackground() {
  if (!bgReady && bgImg && bgImg.complete && bgImg.naturalWidth) {
    bgBufCtx.drawImage(bgImg, 0, 0, W, H);   // scale the big art once, then blit each frame
    bgReady = true;
  }
  if (bgReady) ctx.drawImage(bgBuf, 0, 0);
  else { ctx.fillStyle = "#0a0d16"; ctx.fillRect(0, 0, W, H); }
}

// subtle bloom applied to the scene (background + entities), before the UI is drawn
const fxBuf = document.createElement("canvas");
fxBuf.width = W; fxBuf.height = H;
const fxCtx = fxBuf.getContext("2d");
function applyGlow() {
  fxCtx.clearRect(0, 0, W, H);
  fxCtx.drawImage(canvas, 0, 0);
  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  ctx.globalAlpha = 0.26;
  ctx.filter = "blur(6px) brightness(1.6)";
  ctx.drawImage(fxBuf, 0, 0);
  ctx.restore();
  ctx.filter = "none";
}
function pixText(txt, x, y, size, col, align = "center") {
  txt = String(txt).toUpperCase();
  ctx.font = `${size}px ${UIFONT}`;
  ctx.textAlign = align; ctx.textBaseline = "alphabetic";
  ctx.lineJoin = "round";
  const o = Math.max(2, Math.round(size * 0.16));
  ctx.fillStyle = "rgba(0,0,0,0.9)";            // hard drop shadow
  ctx.fillText(txt, x + o, y + o);
  ctx.lineWidth = Math.max(3, size * 0.18);     // black outline
  ctx.strokeStyle = "#000";
  ctx.strokeText(txt, x, y);
  ctx.fillStyle = col;                          // bright fill
  ctx.fillText(txt, x, y);
}
function drawHeart(cx, cy, s, filled) {
  ctx.beginPath();
  ctx.moveTo(cx, cy + s * 0.34);
  ctx.bezierCurveTo(cx - s * 0.55, cy - s * 0.06, cx - s * 0.42, cy - s * 0.44, cx, cy - s * 0.14);
  ctx.bezierCurveTo(cx + s * 0.42, cy - s * 0.44, cx + s * 0.55, cy - s * 0.06, cx, cy + s * 0.34);
  ctx.closePath();
  ctx.lineJoin = "round"; ctx.lineWidth = 3; ctx.strokeStyle = "#000";
  ctx.fillStyle = filled ? "#ff3b5c" : "rgba(255,255,255,0.13)";
  ctx.fill(); ctx.stroke();
}
function drawHUD() {
  // player health — hearts (top-left)
  for (let i = 0; i < 3; i++) drawHeart(26 + i * 32, 30, 24, i < lives);
  // level (left, under hearts)
  pixText("LEVEL " + level, 14, 62, 9, "#41d0ff", "left");
  // score (center)
  pixText("SCORE", W / 2, 22, 9, "#ffd24a");
  pixText(String(score).padStart(6, "0"), W / 2, 46, 16, "#ffffff");
  // GEORGE health bar (top-right)
  const bw = 150, bh = 12, bx = W - 16 - bw, by = 34;
  pixText("GEORGE", W - 16, 26, 10, "#ff7a99", "right");
  ctx.fillStyle = "#000"; ctx.fillRect(bx - 3, by - 3, bw + 6, bh + 6);
  ctx.fillStyle = "#3a1020"; ctx.fillRect(bx, by, bw, bh);
  const hpf = boss.alive ? clamp(boss.hp / boss.maxhp, 0, 1) : 0;
  const g = ctx.createLinearGradient(bx, 0, bx + bw, 0);
  g.addColorStop(0, "#ff3b5c"); g.addColorStop(1, "#ffae42");
  ctx.fillStyle = g; ctx.fillRect(bx, by, bw * hpf, bh);
}

// ---------- overlays ----------
function drawDim(a) { ctx.fillStyle = `rgba(4,5,10,${a})`; ctx.fillRect(0, 0, W, H); }
function titleScreen() {
  if (Math.floor(stateT * 2) % 2 === 0) pixText("START GAME", W / 2, H * 0.8, 26, "#ffd24a");
  pixText("DODGE GEORGE'S BEAMS & RECORDS,", W / 2, H * 0.91, 9, "#e8ecff");
  pixText("BEAT HIM TO LEVEL UP!", W / 2, H * 0.91 + 17, 9, "#ffd24a");
}
function introScreen() {
  pixText("LEVEL " + level, W / 2, H * 0.40, 38, "#ffe24a");
  pixText(level === 1 ? "GET READY!" : "GEORGE GOT TOUGHER", W / 2, H * 0.40 + 30, 12, "#41d0ff");
}
function clearScreen() {
  pixText("LEVEL CLEAR!", W / 2, H * 0.40, 30, "#ffe24a");
  pixText("+" + (100 * level) + " PTS", W / 2, H * 0.40 + 28, 14, "#41d0ff");
}
function overScreen() {
  drawDim(0.6);
  pixText("GAME OVER", W / 2, H * 0.38, 38, "#ff2b2b");
  pixText("LEVEL " + level, W / 2, H * 0.38 + 30, 14, "#ffffff");
  pixText("SCORE " + score, W / 2, H * 0.38 + 54, 14, "#41d0ff");
  if (Math.floor(stateT * 2) % 2 === 0) pixText("PRESS START", W / 2, H * 0.60, 16, "#ffd24a");
}
// flicker to black, then fade into the game
function drawTransition() {
  if (!trans) return;
  let a;
  if (trans.t < FLICKER_DUR) {
    const strobe = (Math.floor(trans.t * 28) % 2 === 0) ? 0.85 : 0.12;
    a = Math.max(strobe, trans.t / FLICKER_DUR);     // strobes, trending to full black
  } else {
    a = 1 - (trans.t - FLICKER_DUR) / FADE_DUR;       // fade black -> clear
  }
  ctx.fillStyle = `rgba(0,0,0,${clamp(a, 0, 1)})`;
  ctx.fillRect(0, 0, W, H);
}

// ---------- main loop ----------
let last = performance.now();
function frame(now) {
  let dt = (now - last) / 1000; last = now;
  if (dt > 0.05) dt = 0.05;
  stateT += dt;

  // start transition: flicker to black, then fade into the game
  if (trans) {
    trans.t += dt;
    if (!trans.started && trans.t >= FLICKER_DUR) { newGame(); trans.started = true; }
    if (trans.t >= FLICKER_DUR + FADE_DUR) trans = null;
  }

  // ---- update ----
  if (state === STATE.TITLE) {
    if (!trans && (consume("start") || consume("jump"))) trans = { t: 0, started: false };
  } else if (state === STATE.INTRO) {
    updateParticles(dt);
    if (stateT > 1.2) { state = STATE.PLAY; stateT = 0; }
  } else if (state === STATE.PLAY) {
    updatePlayer(dt);
    updateBoss(dt);
    updateProjectiles(dt);
    updateParticles(dt);
    updateExplosions(dt);
    handleCollisions();
  } else if (state === STATE.CLEAR) {
    updateParticles(dt);
    updateExplosions(dt);
    updatePlayer(dt);
    if (stateT > 1.6) startLevel(level + 1);
  } else if (state === STATE.OVER) {
    updateParticles(dt);
    updateExplosions(dt);
    if (stateT > 0.6 && (consume("start") || consume("jump"))) newGame();
  }

  // ---- draw scene ----
  drawBackground();
  if (state === STATE.TITLE) {
    if (titleImg && titleImg.complete && titleImg.naturalWidth) ctx.drawImage(titleImg, 0, 0, W, H);
  } else {
    if (boss.alive) drawBoss();
    drawProjectiles();
    drawPlayer();
    drawParticles();
    drawExplosions();
  }

  applyGlow();   // bloom on the scene incl. title art (UI text drawn after, stays sharp)

  // ---- UI (no glow) ----
  if (state !== STATE.TITLE) drawHUD();
  if (state === STATE.TITLE) titleScreen();
  else if (state === STATE.INTRO) introScreen();
  else if (state === STATE.CLEAR) clearScreen();
  else if (state === STATE.OVER) overScreen();

  // loading veil
  if (assetsLeft > 0) {
    drawDim(0.85);
    pixText("LOADING…", W / 2, H / 2, 24, "#fff");
  }

  drawTransition();

  // hide the on-screen console on the title screen and during the transition
  if (gamepadEl) gamepadEl.classList.toggle("gp-on", state !== STATE.TITLE && !trans);

  clearEdges();
  requestAnimationFrame(frame);
}

loadAssets();
requestAnimationFrame(frame);
