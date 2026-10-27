'use strict';

const canvas = document.getElementById('c');
const ctx = canvas.getContext('2d');
let W = 0, H = 0, DPR = 1;
let sky = null;

// ---- Tuning ----
const HAND_Y = 64;
const MIN_LEN = 34;
const YOYO_R = 16;
const GRAVITY = 2200;
const THROW_SPEED = 900;
const RETURN_SPEED = 1300;
const MAX_LIVES = 5;
const STEP = 1 / 120;
const maxLen = () => H - HAND_Y - 40;

// ---- State ----
let state = 'menu'; // menu | play | over
let paused = false;
let score = 0, best = Number(localStorage.getItem('yoyo-best') || 0);
let lives = 3, elapsed = 0, combo = 0, invuln = 0, shake = 0;
let spawnTimer = 0, overTimer = 0;
let ents = [], particles = [], floaters = [];

const input = { down: false, left: false, right: false };
let needRelease = false;
const hand = { x: 0, tx: 0 };
const yo = { x: 0, y: 0, px: 0, py: 0, len: MIN_LEN, spin: 1, angle: 0, out: false, dead: false };

// ---- Audio ----
let actx = null, muted = false;
function initAudio() {
  if (actx) return;
  try { actx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { actx = null; }
}
function beep(freq, dur, type = 'sine', vol = 0.12, slideTo = 0) {
  if (!actx || muted) return;
  const t = actx.currentTime;
  const o = actx.createOscillator(), g = actx.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, t);
  if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
  g.gain.setValueAtTime(vol, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(actx.destination);
  o.start(t);
  o.stop(t + dur);
}

// ---- Setup ----
function resize() {
  DPR = Math.min(window.devicePixelRatio || 1, 2);
  W = window.innerWidth;
  H = window.innerHeight;
  canvas.width = Math.round(W * DPR);
  canvas.height = Math.round(H * DPR);
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  makeSky();
  hand.tx = Math.min(Math.max(hand.tx || W / 2, 20), W - 20);
}

function makeSky() {
  sky = document.createElement('canvas');
  sky.width = canvas.width;
  sky.height = canvas.height;
  const s = sky.getContext('2d');
  s.setTransform(DPR, 0, 0, DPR, 0, 0);
  const g = s.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, '#120b33');
  g.addColorStop(0.6, '#2a1250');
  g.addColorStop(1, '#4a1a5e');
  s.fillStyle = g;
  s.fillRect(0, 0, W, H);
  for (let i = 0; i < (W * H) / 4000; i++) {
    s.globalAlpha = 0.2 + Math.random() * 0.6;
    s.fillStyle = '#fff';
    const r = Math.random() * 1.4 + 0.3;
    s.beginPath();
    s.arc(Math.random() * W, Math.random() * H, r, 0, Math.PI * 2);
    s.fill();
  }
  s.globalAlpha = 1;
}

function resetYoyo() {
  hand.x = hand.tx;
  yo.x = yo.px = hand.x;
  yo.y = yo.py = HAND_Y + MIN_LEN;
  yo.len = MIN_LEN;
  yo.spin = 1;
  yo.dead = false;
  yo.out = false;
}

function startGame() {
  state = 'play';
  score = 0; lives = 3; elapsed = 0; combo = 0; invuln = 0; shake = 0;
  spawnTimer = 0.6;
  ents = []; particles = []; floaters = [];
  needRelease = true; // the press that started the game shouldn't throw
  resetYoyo();
}

function gameOver() {
  state = 'over';
  overTimer = 0;
  if (score > best) {
    best = score;
    localStorage.setItem('yoyo-best', String(best));
  }
  beep(300, 0.6, 'triangle', 0.15, 60);
}

const level = () => 1 + Math.floor(elapsed / 25);

// ---- Input ----
function press() {
  initAudio();
  if (state === 'menu') { startGame(); return; }
  if (state === 'over') { if (overTimer > 0.7) startGame(); else needRelease = true; return; }
  if (paused) { paused = false; needRelease = true; return; }
  input.down = true;
}
function release() {
  input.down = false;
  needRelease = false;
}

canvas.addEventListener('pointermove', e => { hand.tx = e.clientX; });
canvas.addEventListener('pointerdown', e => {
  hand.tx = e.clientX;
  canvas.setPointerCapture?.(e.pointerId);
  press();
});
canvas.addEventListener('pointerup', release);
canvas.addEventListener('pointercancel', release);

window.addEventListener('keydown', e => {
  if (e.code === 'Space' || e.code === 'Enter' || e.code === 'ArrowDown' || e.code === 'KeyS') {
    e.preventDefault();
    if (!e.repeat) press();
  } else if (e.code === 'ArrowLeft' || e.code === 'KeyA') input.left = true;
  else if (e.code === 'ArrowRight' || e.code === 'KeyD') input.right = true;
  else if (e.code === 'KeyP' && state === 'play') paused = !paused;
  else if (e.code === 'KeyM') muted = !muted;
});
window.addEventListener('keyup', e => {
  if (e.code === 'Space' || e.code === 'Enter' || e.code === 'ArrowDown' || e.code === 'KeyS') release();
  else if (e.code === 'ArrowLeft' || e.code === 'KeyA') input.left = false;
  else if (e.code === 'ArrowRight' || e.code === 'KeyD') input.right = false;
});
window.addEventListener('blur', () => { if (state === 'play') paused = true; release(); });
window.addEventListener('resize', resize);

// ---- Simulation ----
function stepYoyo(dt) {
  const holding = state === 'play' && input.down && !needRelease && !yo.dead;
  const wasOut = yo.out;

  if (holding) {
    if (!wasOut) { yo.py = yo.y - 12; beep(520, 0.18, 'sine', 0.06, 180); } // flick it down
    yo.len = Math.min(maxLen(), yo.len + THROW_SPEED * dt);
  } else {
    yo.len = Math.max(MIN_LEN, yo.len - RETURN_SPEED * dt);
  }
  yo.out = holding || yo.len > MIN_LEN + 1;

  if (!yo.out) {
    // Resting in the hand: follow it and recharge spin.
    yo.x += (hand.x - yo.x) * Math.min(1, dt * 25);
    yo.y += (HAND_Y + MIN_LEN - yo.y) * Math.min(1, dt * 25);
    yo.px = yo.x; yo.py = yo.y;
    if (wasOut) {
      if (combo > 1 && state === 'play') addFloater(hand.x, HAND_Y + 70, `Combo x${combo}!`, '#ffd23f');
      combo = 0;
      yo.dead = false;
    }
    yo.spin = Math.min(1, yo.spin + 0.7 * dt);
    yo.angle += yo.spin * 6 * dt;
    return;
  }

  // Verlet integration with the string as a max-length constraint.
  const vx = (yo.x - yo.px) * 0.996;
  const vy = (yo.y - yo.py) * 0.996;
  yo.px = yo.x; yo.py = yo.y;
  yo.x += vx;
  yo.y += vy + GRAVITY * dt * dt;

  const dx = yo.x - hand.x, dy = yo.y - HAND_Y;
  const d = Math.hypot(dx, dy);
  if (d > yo.len) {
    const k = yo.len / d;
    yo.x = hand.x + dx * k;
    yo.y = HAND_Y + dy * k;
  }
  if (yo.x < YOYO_R) { yo.x = YOYO_R; yo.px = yo.x + (yo.x - yo.px) * 0.5; }
  if (yo.x > W - YOYO_R) { yo.x = W - YOYO_R; yo.px = yo.x + (yo.x - yo.px) * 0.5; }
  if (yo.y > H - YOYO_R) { yo.y = H - YOYO_R; }

  yo.angle += (yo.dead ? 1 : 10 + yo.spin * 40) * dt;

  if (state === 'play' && !yo.dead) {
    yo.spin -= (0.1 + level() * 0.008) * dt;
    if (yo.spin <= 0) {
      yo.spin = 0;
      yo.dead = true;
      loseLife('Out of spin!');
    }
  }
}

function spawn() {
  const lvl = level();
  const hazard = Math.min(0.45, 0.16 + lvl * 0.03);
  const r = Math.random();
  let type;
  if (r < 0.035 && lives < MAX_LIVES) type = 'heart';
  else if (r < 0.035 + hazard) type = 'bat';
  else if (r < 0.035 + hazard + 0.15) type = 'gem';
  else type = 'star';
  const fromLeft = Math.random() < 0.5;
  const speed = (90 + Math.random() * 80) * (1 + lvl * 0.08) * (type === 'gem' ? 1.5 : 1);
  const top = HAND_Y + 110, bottom = H - 50;
  const y = top + Math.random() * Math.max(10, bottom - top);
  ents.push({
    type, y, baseY: y,
    x: fromLeft ? -30 : W + 30,
    vx: fromLeft ? speed : -speed,
    t: Math.random() * 6,
    r: type === 'bat' ? 17 : 14,
  });
}

function burst(x, y, color, n = 14, spd = 220) {
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2, s = spd * (0.3 + Math.random() * 0.7);
    const life = 0.4 + Math.random() * 0.4;
    particles.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life, max: life, color, size: 2 + Math.random() * 3 });
  }
}

function addFloater(x, y, text, color) {
  floaters.push({ x, y, text, color, life: 1 });
}

function loseLife(msg) {
  lives--;
  shake = 12;
  invuln = 1.5;
  addFloater(yo.x, yo.y - 30, msg, '#ff4d5e');
  burst(yo.x, yo.y, '#ff4d5e', 20, 260);
  beep(160, 0.35, 'sawtooth', 0.12, 50);
  if (lives <= 0) gameOver();
}

function collect(e) {
  if (e.type === 'bat') {
    burst(e.x, e.y, '#b06bff', 16);
    if (invuln <= 0) loseLife('Ouch!');
    return;
  }
  if (e.type === 'heart') {
    lives = Math.min(MAX_LIVES, lives + 1);
    burst(e.x, e.y, '#ff6fae', 18);
    addFloater(e.x, e.y - 20, '+1 life', '#ff6fae');
    beep(660, 0.12, 'triangle', 0.12, 990);
    return;
  }
  combo++;
  const base = e.type === 'gem' ? 30 : 10;
  const pts = base * combo;
  score += pts;
  yo.spin = Math.min(1, yo.spin + (e.type === 'gem' ? 0.12 : 0.06));
  const color = e.type === 'gem' ? '#5ff3ff' : '#ffd23f';
  burst(e.x, e.y, color, e.type === 'gem' ? 20 : 12);
  addFloater(e.x, e.y - 20, combo > 1 ? `+${pts} x${combo}` : `+${pts}`, color);
  beep(700 + Math.min(combo, 12) * 70, 0.1, 'square', 0.05);
}

function update(dt) {
  if (input.left) hand.tx -= 650 * dt;
  if (input.right) hand.tx += 650 * dt;
  hand.tx = Math.min(Math.max(hand.tx, 20), W - 20);
  hand.x += (hand.tx - hand.x) * Math.min(1, dt * 18);

  stepYoyo(dt);

  if (state === 'over') overTimer += dt;
  if (state === 'play') {
    elapsed += dt;
    invuln = Math.max(0, invuln - dt);
    spawnTimer -= dt;
    if (spawnTimer <= 0) {
      spawn();
      spawnTimer = Math.max(0.35, 1.1 - level() * 0.08) * (0.6 + Math.random() * 0.8);
    }
  }

  for (let i = ents.length - 1; i >= 0; i--) {
    const e = ents[i];
    e.t += dt;
    e.x += e.vx * dt;
    e.y = e.baseY + Math.sin(e.t * (e.type === 'bat' ? 3 : 2)) * (e.type === 'bat' ? 26 : 10);
    if (state === 'play' && yo.out && Math.hypot(e.x - yo.x, e.y - yo.y) < e.r + YOYO_R) {
      ents.splice(i, 1);
      collect(e);
      continue;
    }
    if (e.x < -60 || e.x > W + 60) ents.splice(i, 1);
  }

  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i];
    p.life -= dt;
    p.x += p.vx * dt; p.y += p.vy * dt;
    p.vy += 300 * dt;
    if (p.life <= 0) particles.splice(i, 1);
  }
  for (let i = floaters.length - 1; i >= 0; i--) {
    const f = floaters[i];
    f.life -= dt * 0.9;
    f.y -= 40 * dt;
    if (f.life <= 0) floaters.splice(i, 1);
  }
  shake = Math.max(0, shake - 40 * dt);
}

// ---- Drawing ----
function starPath(cx, cy, R, r, rot) {
  ctx.beginPath();
  for (let i = 0; i < 10; i++) {
    const a = rot + (i * Math.PI) / 5 - Math.PI / 2;
    const rad = i % 2 ? r : R;
    ctx.lineTo(cx + Math.cos(a) * rad, cy + Math.sin(a) * rad);
  }
  ctx.closePath();
}

function heartPath(x, y, s) {
  ctx.beginPath();
  ctx.moveTo(x, y + s * 0.7);
  ctx.bezierCurveTo(x - s * 1.3, y - s * 0.1, x - s * 0.6, y - s * 1.1, x, y - s * 0.4);
  ctx.bezierCurveTo(x + s * 0.6, y - s * 1.1, x + s * 1.3, y - s * 0.1, x, y + s * 0.7);
  ctx.closePath();
}

function drawEnt(e) {
  ctx.save();
  if (e.type === 'star') {
    ctx.shadowColor = '#ffd23f'; ctx.shadowBlur = 14;
    ctx.fillStyle = '#ffd23f';
    starPath(e.x, e.y, 15, 7, e.t * 2);
    ctx.fill();
  } else if (e.type === 'gem') {
    ctx.translate(e.x, e.y);
    ctx.shadowColor = '#5ff3ff'; ctx.shadowBlur = 16;
    ctx.fillStyle = '#5ff3ff';
    ctx.beginPath();
    ctx.moveTo(0, -16); ctx.lineTo(12, -4); ctx.lineTo(0, 16); ctx.lineTo(-12, -4);
    ctx.closePath(); ctx.fill();
    ctx.shadowBlur = 0;
    ctx.fillStyle = 'rgba(255,255,255,0.7)';
    ctx.beginPath(); ctx.moveTo(0, -16); ctx.lineTo(5, -4); ctx.lineTo(-5, -4); ctx.closePath(); ctx.fill();
  } else if (e.type === 'heart') {
    ctx.shadowColor = '#ff6fae'; ctx.shadowBlur = 14;
    ctx.fillStyle = '#ff6fae';
    heartPath(e.x, e.y, 14 + Math.sin(e.t * 6) * 1.5);
    ctx.fill();
  } else {
    const flap = Math.sin(e.t * 14);
    ctx.translate(e.x, e.y);
    if (e.vx < 0) ctx.scale(-1, 1);
    ctx.shadowColor = '#ff3355'; ctx.shadowBlur = 12;
    ctx.fillStyle = '#4b2378';
    for (const s of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.quadraticCurveTo(s * 14, -10 - flap * 10, s * 28, -4 - flap * 12);
      ctx.quadraticCurveTo(s * 20, 2, s * 22, 8);
      ctx.quadraticCurveTo(s * 12, 4, 0, 6);
      ctx.fill();
    }
    ctx.beginPath(); ctx.arc(0, 2, 10, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath();
    ctx.moveTo(-8, -4); ctx.lineTo(-6, -14); ctx.lineTo(-2, -7);
    ctx.moveTo(8, -4); ctx.lineTo(6, -14); ctx.lineTo(2, -7);
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.fillStyle = '#ff3355';
    ctx.beginPath(); ctx.arc(-4, 0, 2, 0, Math.PI * 2); ctx.arc(4, 0, 2, 0, Math.PI * 2); ctx.fill();
  }
  ctx.restore();
}

const spinColor = s => (s > 0.5 ? '#5dff9c' : s > 0.25 ? '#ffd23f' : '#ff4d5e');

function drawHandAndString() {
  // String
  const dx = yo.x - hand.x, dy = yo.y - HAND_Y;
  const d = Math.hypot(dx, dy);
  ctx.strokeStyle = 'rgba(255,255,255,0.85)';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(hand.x, HAND_Y);
  const slack = Math.max(0, yo.len - d);
  if (slack > 3) {
    ctx.quadraticCurveTo((hand.x + yo.x) / 2, (HAND_Y + yo.y) / 2 + Math.min(slack, 120) * 0.6, yo.x, yo.y);
  } else {
    ctx.lineTo(yo.x, yo.y);
  }
  ctx.stroke();

  // Arm and fist
  ctx.strokeStyle = '#d9a77a';
  ctx.lineWidth = 16;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(hand.x, -20);
  ctx.lineTo(hand.x, HAND_Y - 12);
  ctx.stroke();
  ctx.fillStyle = '#f2c79b';
  ctx.beginPath();
  ctx.arc(hand.x, HAND_Y - 4, 14, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = '#d9a77a';
  ctx.lineWidth = 2;
  for (let i = -1; i <= 1; i++) {
    ctx.beginPath();
    ctx.moveTo(hand.x + i * 6, HAND_Y - 10);
    ctx.lineTo(hand.x + i * 6, HAND_Y + 4);
    ctx.stroke();
  }
  ctx.lineCap = 'butt';
}

function drawYoyo() {
  if (invuln > 0 && Math.floor(invuln * 12) % 2) ctx.globalAlpha = 0.4;
  ctx.save();
  ctx.translate(yo.x, yo.y);
  if (state === 'play' && yo.out) {
    ctx.strokeStyle = 'rgba(255,255,255,0.15)';
    ctx.lineWidth = 3;
    ctx.beginPath(); ctx.arc(0, 0, YOYO_R + 6, 0, Math.PI * 2); ctx.stroke();
    ctx.strokeStyle = spinColor(yo.spin);
    ctx.beginPath(); ctx.arc(0, 0, YOYO_R + 6, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * yo.spin); ctx.stroke();
  }
  const g = ctx.createRadialGradient(-5, -5, 2, 0, 0, YOYO_R);
  g.addColorStop(0, yo.dead ? '#aaa' : '#ff7a8a');
  g.addColorStop(1, yo.dead ? '#555' : '#c8102e');
  ctx.fillStyle = g;
  ctx.beginPath(); ctx.arc(0, 0, YOYO_R, 0, Math.PI * 2); ctx.fill();
  ctx.rotate(yo.angle);
  ctx.strokeStyle = 'rgba(255,255,255,0.75)';
  ctx.lineWidth = 3;
  for (let i = 0; i < 3; i++) {
    const a = (i * Math.PI * 2) / 3;
    ctx.beginPath(); ctx.arc(0, 0, YOYO_R - 5, a, a + 0.9); ctx.stroke();
  }
  ctx.fillStyle = '#ffd23f';
  ctx.beginPath(); ctx.arc(0, 0, 4, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
  ctx.globalAlpha = 1;
}

function text(str, x, y, size, color, align = 'center', weight = 800, maxWidth = 1e5) {
  ctx.font = `${weight} ${size}px system-ui, -apple-system, "Segoe UI", sans-serif`;
  ctx.textAlign = align;
  ctx.textBaseline = 'middle';
  ctx.fillStyle = 'rgba(0,0,0,0.45)';
  ctx.fillText(str, x + 2, y + 2, maxWidth);
  ctx.fillStyle = color;
  ctx.fillText(str, x, y, maxWidth);
}

function drawHUD() {
  text(String(score), 20, 30, 30, '#fff', 'left', 900);
  text(`BEST ${best}`, 20, 58, 13, 'rgba(255,255,255,0.6)', 'left', 700);
  for (let i = 0; i < lives; i++) {
    ctx.fillStyle = '#ff6fae';
    heartPath(W - 24 - i * 28, 30, 10);
    ctx.fill();
  }
  text(`LV ${level()}`, W - 20, 58, 13, 'rgba(255,255,255,0.6)', 'right', 700);
  if (combo > 1 && yo.out) text(`x${combo}`, yo.x + 34, yo.y - 24, 18, '#ffd23f');
}

function overlay(lines) {
  ctx.fillStyle = 'rgba(8,4,24,0.6)';
  ctx.fillRect(0, 0, W, H);
  let y = H / 2 - (lines.length - 1) * 22;
  for (const [str, size, color] of lines) {
    text(str, W / 2, y, size, color, 'center', 800, W - 24);
    y += size + 18;
  }
}

function draw() {
  ctx.save();
  if (shake > 0) ctx.translate((Math.random() - 0.5) * shake, (Math.random() - 0.5) * shake);
  ctx.drawImage(sky, 0, 0, W, H);
  for (const e of ents) drawEnt(e);
  drawHandAndString();
  drawYoyo();
  for (const p of particles) {
    ctx.globalAlpha = Math.max(0, p.life / p.max);
    ctx.fillStyle = p.color;
    ctx.fillRect(p.x - p.size / 2, p.y - p.size / 2, p.size, p.size);
  }
  ctx.globalAlpha = 1;
  for (const f of floaters) {
    ctx.globalAlpha = Math.max(0, Math.min(1, f.life * 1.5));
    text(f.text, f.x, f.y, 18, f.color);
  }
  ctx.globalAlpha = 1;
  ctx.restore();

  const small = Math.min(16, W / 28);
  if (state === 'play') {
    drawHUD();
    if (paused) overlay([['PAUSED', 44, '#fff'], ['Click or press P to resume', small, 'rgba(255,255,255,0.8)']]);
  } else if (state === 'menu') {
    overlay([
      ['YO-YO', Math.min(84, W / 5), '#ff7a8a'],
      ['Hold click / Space to throw. Move to swing.', small, '#fff'],
      ['Grab ★ and ◆ in one throw for combos. Dodge bats.', small, '#fff'],
      ['Reel in before the spin runs out!', small, '#ffd23f'],
      ['Click or press Space to start', small + 4, '#5dff9c'],
    ]);
  } else {
    overlay([
      ['GAME OVER', Math.min(64, W / 7), '#ff4d5e'],
      [`Score ${score}`, 28, '#fff'],
      [score >= best && score > 0 ? 'New best!' : `Best ${best}`, 18, '#ffd23f'],
      ['Click or press Space to play again', small + 2, '#5dff9c'],
    ]);
  }
}

// ---- Loop ----
let last = performance.now(), acc = 0;
function frame(now) {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  if (!paused) {
    acc += dt;
    while (acc >= STEP) { update(STEP); acc -= STEP; }
  }
  draw();
  requestAnimationFrame(frame);
}

resize();
resetYoyo();
requestAnimationFrame(frame);
