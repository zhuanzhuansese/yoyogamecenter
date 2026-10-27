'use strict';

const canvas = document.getElementById('c');
const ctx = canvas.getContext('2d');
let W = 0, H = 0, DPR = 1, sky = null, wall = null, L = null;

// ---- Tuning ----
const COLS = 10, ROWS = 20, HIDDEN = 2; // two hidden spawn rows above the visible well
const DAS = 0.17, ARR = 0.05, SOFT_RATE = 0.03;
const LOCK_DELAY = 0.5, MAX_RESETS = 15, CLEAR_TIME = 0.42;
const LINE_SCORES = [0, 100, 300, 500, 800];
const LINE_NAMES = ['', 'Single', 'Double', 'Triple', 'TETRIS!'];

const PIECES = {
  I: { light: '#8ff0ff', base: '#00b4e6', dark: '#006a99', shape: [[0, 0, 0, 0], [1, 1, 1, 1], [0, 0, 0, 0], [0, 0, 0, 0]] },
  O: { light: '#fff08a', base: '#f2c40f', dark: '#a87d00', shape: [[1, 1], [1, 1]] },
  T: { light: '#ff9cf8', base: '#d81fd0', dark: '#86107f', shape: [[0, 1, 0], [1, 1, 1], [0, 0, 0]] },
  S: { light: '#a4ff94', base: '#1ecf1e', dark: '#0b7d0b', shape: [[0, 1, 1], [1, 1, 0], [0, 0, 0]] },
  Z: { light: '#ff9a94', base: '#e8141e', dark: '#8c0810', shape: [[1, 1, 0], [0, 1, 1], [0, 0, 0]] },
  J: { light: '#9aa6ff', base: '#1f2fe0', dark: '#101a8c', shape: [[1, 0, 0], [1, 1, 1], [0, 0, 0]] },
  L: { light: '#ffc27a', base: '#ff7a00', dark: '#a84800', shape: [[0, 0, 1], [1, 1, 1], [0, 0, 0]] },
};
const TYPES = Object.keys(PIECES);

// Gummy mode: sugar-coated gummy candy colours.
const GUMMY = {
  I: { light: '#9cb8ff', base: '#2a5cff', dark: '#1435b8' },
  O: { light: '#fff38a', base: '#f2cf1d', dark: '#b8930a' },
  T: { light: '#ff9ad8', base: '#ff38b4', dark: '#b8127c' },
  S: { light: '#a6f594', base: '#33c62a', dark: '#1a8a14' },
  Z: { light: '#ff9e94', base: '#ff3b2f', dark: '#b81a12' },
  J: { light: '#cbaaff', base: '#8a46ff', dark: '#5418c2' },
  L: { light: '#ffc994', base: '#ff8a1f', dark: '#c25a00' },
};
// Water mode: deep, glass-clear jelly colours.
const WATER = {
  I: { light: '#7d9bff', base: '#1f3dff', dark: '#0d1f9e' },
  O: { light: '#fff27a', base: '#d9cf1c', dark: '#8f8708' },
  T: { light: '#c79bff', base: '#7a35d8', dark: '#43168a' },
  S: { light: '#86f08a', base: '#1fb52a', dark: '#0c6e14' },
  Z: { light: '#ff8a8a', base: '#e01e2a', dark: '#8a0d14' },
  J: { light: '#e0a27a', base: '#a0522d', dark: '#5c2a12' },
  L: { light: '#ffbd7a', base: '#ff7a10', dark: '#a84a00' },
};
const PALETTES = { jelly: PIECES, gummy: GUMMY, water: WATER };

// Four clockwise rotation states per piece, as [col, row] cells (SRS orientation).
const ROTS = {};
for (const t of TYPES) {
  let m = PIECES[t].shape;
  ROTS[t] = [];
  for (let i = 0; i < 4; i++) {
    const cells = [];
    m.forEach((row, r) => row.forEach((v, c) => { if (v) cells.push([c, r]); }));
    ROTS[t].push(cells);
    m = m.map((row, r) => row.map((_, c) => m[m.length - 1 - c][r]));
  }
}

// SRS wall kicks as [dx, dy] with y pointing up.
const KICKS = {
  '01': [[0, 0], [-1, 0], [-1, 1], [0, -2], [-1, -2]],
  '10': [[0, 0], [1, 0], [1, -1], [0, 2], [1, 2]],
  '12': [[0, 0], [1, 0], [1, -1], [0, 2], [1, 2]],
  '21': [[0, 0], [-1, 0], [-1, 1], [0, -2], [-1, -2]],
  '23': [[0, 0], [1, 0], [1, 1], [0, -2], [1, -2]],
  '32': [[0, 0], [-1, 0], [-1, -1], [0, 2], [-1, 2]],
  '30': [[0, 0], [-1, 0], [-1, -1], [0, 2], [-1, 2]],
  '03': [[0, 0], [1, 0], [1, 1], [0, -2], [1, -2]],
};
const KICKS_I = {
  '01': [[0, 0], [-2, 0], [1, 0], [-2, -1], [1, 2]],
  '10': [[0, 0], [2, 0], [-1, 0], [2, 1], [-1, -2]],
  '12': [[0, 0], [-1, 0], [2, 0], [-1, 2], [2, -1]],
  '21': [[0, 0], [1, 0], [-2, 0], [1, -2], [-2, 1]],
  '23': [[0, 0], [2, 0], [-1, 0], [2, 1], [-1, -2]],
  '32': [[0, 0], [-2, 0], [1, 0], [-2, -1], [1, 2]],
  '30': [[0, 0], [1, 0], [-2, 0], [1, -2], [-2, 1]],
  '03': [[0, 0], [-1, 0], [2, 0], [-1, 2], [2, -1]],
};

// ---- State ----
let state = 'menu'; // menu | play | over
let paused = false, muted = false;
let board = [], piece = null, queue = [], bag = [];
let holdType = null, holdUsed = false, nextId = 1;
let score = 0, lines = 0, level = 1, best = Number(localStorage.getItem('tetris-best') || 0);
let dropTimer = 0, lockTimer = 0, lockResets = 0;
let clearing = null, clearTimer = 0, overTimer = 0;
let softDrop = false, dasDir = 0, dasTimer = 0, arrTimer = 0;
const held = { left: false, right: false };
const wobbles = new Map(); // piece id -> { t, amp }
let particles = [], floaters = [];
const MODES = ['jelly', 'gummy', 'water'];
let mode = MODES.includes(localStorage.getItem('tetris-mode')) ? localStorage.getItem('tetris-mode') : 'jelly';
let hardDropping = false;

// Water mode: the tank is filled up to WATER_ROW. The surface is a row of
// springs that ripple when pieces splash in.
const WATER_ROW = 8, WN = 41, LAT_SP = 80;
const wave = { h: new Float32Array(WN), v: new Float32Array(WN) };
let modeRects = [], modeBtn = null, clock = 0;

// Squishy stack: a spring mesh on the grid corners. Landings push the
// corners, and springs between neighbouring corners carry the wobble through the stack.
const VW = COLS + 1, NV = VW * (ROWS + HIDDEN + 1);
const J = { dx: new Float32Array(NV), dy: new Float32Array(NV), vx: new Float32Array(NV), vy: new Float32Array(NV) };
const solid = new Uint8Array(NV);
const J_K = 180, J_C = 350, J_DAMP = 7, J_STEP = 1 / 240, J_MAX = 0.3;

// ---- Audio ----
let actx = null;
function initAudio() {
  if (actx) return;
  try { actx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { actx = null; }
}
function beep(freq, dur, type = 'sine', vol = 0.12, slideTo = 0, delay = 0) {
  if (!actx || muted) return;
  const t = actx.currentTime + delay;
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
  sugar = null; // rebuilt at the new size on the next draw
  makeGranite();
}

// Sugar coating: seamless tiles of round white sugar beads, sized to the board
// cell. sugarRim is three times denser, for the sparkly crowd of grains along
// each gummy's edges.
let sugar = null, sugarRim = null, sugarC = 0;
function makeSugar(c) {
  const T = Math.max(48, Math.round(4 * c)), r0 = Math.max(0.6, c * 0.021);
  const tile = count => {
    const t = document.createElement('canvas');
    t.width = t.height = Math.round(T * DPR);
    const g = t.getContext('2d');
    g.scale(DPR, DPR);
    for (let i = 0; i < count; i++) {
      const x = Math.random() * T, y = Math.random() * T, r = r0 * (0.8 + Math.random() * 0.4);
      for (const dx of [-T, 0, T]) {
        for (const dy of [-T, 0, T]) {
          g.fillStyle = 'rgba(0,0,0,0.12)'; // tiny shadow under each bead
          g.beginPath(); g.arc(x + dx + r * 0.3, y + dy + r * 0.4, r, 0, Math.PI * 2); g.fill();
          g.fillStyle = 'rgba(255,255,255,0.95)';
          g.beginPath(); g.arc(x + dx, y + dy, r, 0, Math.PI * 2); g.fill();
        }
      }
    }
    return ctx.createPattern(t, 'repeat');
  };
  sugar = tile(16 * 30);
  sugarRim = tile(16 * 70);
  sugarC = c;
}

function makeSky() {
  sky = document.createElement('canvas');
  sky.width = canvas.width;
  sky.height = canvas.height;
  const s = sky.getContext('2d');
  s.setTransform(DPR, 0, 0, DPR, 0, 0);
  if (mode === 'gummy') { makeOutdoors(s); return; }
  if (mode === 'water') { makeLattice(s); return; }
  // Jelly mode: a plain light-grey photo-studio backdrop.
  const g = s.createRadialGradient(W / 2, H * 0.4, 0, W / 2, H * 0.4, Math.max(W, H) * 0.8);
  g.addColorStop(0, '#ededef');
  g.addColorStop(1, '#adadb3');
  s.fillStyle = g;
  s.fillRect(0, 0, W, H);
}

// A tile of dark speckled granite with faint light veins, for the pillars and base.
let granite = null;
function makeGranite() {
  const T = 128;
  const t = document.createElement('canvas');
  t.width = t.height = Math.round(T * DPR);
  const g = t.getContext('2d');
  g.scale(DPR, DPR);
  g.fillStyle = '#3b3c40';
  g.fillRect(0, 0, T, T);
  const wrap = draw => { for (const dx of [-T, 0, T]) for (const dy of [-T, 0, T]) draw(dx, dy); };
  for (let i = 0; i < 1400; i++) {
    const x = Math.random() * T, y = Math.random() * T, r = 0.4 + Math.random() * 1.1, v = 25 + Math.random() * 100;
    g.fillStyle = `rgba(${v},${v},${v + 4},0.6)`;
    wrap((dx, dy) => g.fillRect(x + dx, y + dy, r, r));
  }
  g.strokeStyle = 'rgba(220,220,225,0.2)';
  for (let i = 0; i < 5; i++) {
    const x = Math.random() * T, y = Math.random() * T;
    const pts = [Math.random() * 60 - 30, Math.random() * 60 - 30, Math.random() * 80 - 40, Math.random() * 80 - 40];
    g.lineWidth = 0.6 + Math.random() * 0.8;
    wrap((dx, dy) => {
      g.beginPath();
      g.moveTo(x + dx, y + dy);
      g.quadraticCurveTo(x + dx + pts[0], y + dy + pts[1], x + dx + pts[2], y + dy + pts[3]);
      g.stroke();
    });
  }
  granite = ctx.createPattern(t, 'repeat');
  granite.setTransform(new DOMMatrix([1 / DPR, 0, 0, 1 / DPR, 0, 0]));
}

// Out-of-focus daylight street, drawn with soft radial blobs (no canvas blur filter).
function makeOutdoors(s) {
  const blob = (x, y, r, color, a) => {
    const g = s.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, color);
    g.addColorStop(1, color + '00');
    s.globalAlpha = a;
    s.fillStyle = g;
    s.fillRect(x - r, y - r, r * 2, r * 2);
  };
  const horizon = H * 0.5;
  let g = s.createLinearGradient(0, 0, 0, horizon);
  g.addColorStop(0, '#b9d4ee');
  g.addColorStop(1, '#e4ebef');
  s.fillStyle = g;
  s.fillRect(0, 0, W, horizon);
  g = s.createLinearGradient(0, horizon, 0, H);
  g.addColorStop(0, '#c9c5bc');
  g.addColorStop(0.15, '#a3a19c');
  g.addColorStop(1, '#7c7b78');
  s.fillStyle = g;
  s.fillRect(0, horizon, W, H - horizon);
  for (let i = 0; i < 5; i++) blob(Math.random() * W, horizon * (0.5 + Math.random() * 0.4), 60 + Math.random() * 80, '#eef0f0', 0.7);
  const leaves = ['#6f8f35', '#93a440', '#c4a43e', '#557a32', '#a9b456'];
  for (let i = 0; i < W / 30; i++) {
    blob(Math.random() * W, horizon * (0.05 + Math.random() * 0.85), 40 + Math.random() * 90, leaves[i % leaves.length], 0.55);
  }
  for (let i = 0; i < 3; i++) blob(Math.random() * W, horizon * 1.08, 30 + Math.random() * 30, ['#d84a3a', '#3d4a5a', '#e8e8e8'][i], 0.6);
  s.globalAlpha = 1;
}

// Blue wall with a charcoal diamond lattice, `height` pixels tall. The strut
// phase is fixed in screen space so every copy of the wall lines up.
function paintWall(s, height) {
  const floor = H * 0.68;
  const g = s.createRadialGradient(W / 2, floor * 0.45, 0, W / 2, floor * 0.45, Math.max(W, floor) * 0.75);
  g.addColorStop(0, '#62b8e8');
  g.addColorStop(1, '#2c78b0');
  s.fillStyle = g;
  s.fillRect(0, 0, W, height);
  const d0 = ((-floor % LAT_SP) + LAT_SP) % LAT_SP;
  const struts = (w, color, dx, dy) => {
    s.strokeStyle = color;
    s.lineWidth = w;
    s.beginPath();
    for (let d = d0 - height - LAT_SP; d < W + LAT_SP; d += LAT_SP) { // x - y = d
      s.moveTo(d + dx, dy); s.lineTo(d + height + dx, height + dy);
    }
    for (let e = 0; e < W + height + LAT_SP; e += LAT_SP) { // x + y = e
      s.moveTo(e + dx, dy); s.lineTo(e - height + dx, height + dy);
    }
    s.stroke();
  };
  struts(12, 'rgba(10,30,50,0.3)', 2, 3);
  struts(9, '#3b4a59', 0, 0);
  struts(2, 'rgba(170,190,205,0.6)', -1.5, -2);
}

// Water mode scene: the lattice wall over a glossy floor that reflects it, with a
// yellow flower at each side. Also keeps a full-height copy of the wall for the
// back of the tank, so the water can refract it.
function makeLattice(s) {
  const floor = H * 0.68;
  wall = document.createElement('canvas');
  wall.width = canvas.width;
  wall.height = canvas.height;
  const w = wall.getContext('2d');
  w.setTransform(DPR, 0, 0, DPR, 0, 0);
  paintWall(w, H);
  s.drawImage(wall, 0, 0, wall.width, floor * DPR, 0, 0, W, floor);
  s.save();
  s.globalAlpha = 0.22;
  s.translate(0, 2 * floor);
  s.scale(1, -1);
  s.drawImage(wall, 0, 0, wall.width, floor * DPR, 0, 0, W, floor);
  s.restore();
  let g = s.createLinearGradient(0, floor, 0, H);
  g.addColorStop(0, 'rgba(30,70,100,0.75)');
  g.addColorStop(1, 'rgba(10,25,40,0.95)');
  s.fillStyle = g;
  s.fillRect(0, floor, W, H - floor);
  s.fillStyle = 'rgba(255,255,255,0.18)';
  s.fillRect(0, floor, W, 2);
  for (const fx of [W * 0.04, W * 0.96]) {
    const fy = floor - 40, r = Math.min(26, W * 0.03);
    s.strokeStyle = '#3f8f3a';
    s.lineWidth = 4;
    s.beginPath(); s.moveTo(fx, fy); s.quadraticCurveTo(fx + 10, fy + 40, fx, floor + 30); s.stroke();
    s.fillStyle = '#ffc21a';
    for (let i = 0; i < 16; i++) {
      const a = (i / 16) * Math.PI * 2;
      s.beginPath();
      s.ellipse(fx + Math.cos(a) * r * 0.6, fy + Math.sin(a) * r * 0.6, r * 0.45, r * 0.12, a, 0, Math.PI * 2);
      s.fill();
    }
    s.fillStyle = '#d97a00';
    s.beginPath(); s.arc(fx, fy, r * 0.3, 0, Math.PI * 2); s.fill();
  }
}

// ---- Game logic ----
const emptyRow = () => Array(COLS).fill(null);
const gravity = () => Math.pow(0.8 - (level - 1) * 0.007, level - 1); // seconds per row
const active = () => state === 'play' && !paused && piece;

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function takeNext() {
  while (queue.length < 6) {
    if (!bag.length) bag = shuffle(TYPES.slice());
    queue.push(bag.pop());
  }
  return queue.shift();
}

function fits(type, rot, x, y) {
  for (const [c, r] of ROTS[type][rot]) {
    const bx = x + c, by = y + r;
    if (bx < 0 || bx >= COLS || by >= ROWS + HIDDEN) return false;
    if (by >= 0 && board[by][bx]) return false;
  }
  return true;
}

const grounded = () => !fits(piece.type, piece.rot, piece.x, piece.y + 1);

function ghostY() {
  let y = piece.y;
  while (fits(piece.type, piece.rot, piece.x, y + 1)) y++;
  return y;
}

function jiggle(id, amp) { wobbles.set(id, { t: 0, amp }); }
function squish(id) {
  const w = wobbles.get(id);
  return w ? w.amp * Math.exp(-5 * w.t) * Math.sin(w.t * 22) : 0;
}

function setMode(m) {
  if (m === mode) return;
  mode = m;
  localStorage.setItem('tetris-mode', m);
  for (const a of Object.values(J)) a.fill(0);
  wave.h.fill(0); wave.v.fill(0);
  makeSky();
}

// Push the mesh corners of board cells [[col, row], ...]: down, and outward from their centre.
function jellyHit(cells, s) {
  const verts = new Set();
  for (const [c, r] of cells) for (const [dc, dr] of [[0, 0], [1, 0], [0, 1], [1, 1]]) verts.add((r + dr) * VW + c + dc);
  let cx = 0;
  for (const v of verts) cx += v % VW;
  cx /= verts.size;
  for (const v of verts) {
    J.vy[v] += s;
    J.vx[v] += (v % VW - cx) * s * 0.35;
  }
}

function stepJelly(dt) {
  solid.fill(0);
  for (let r = 0; r < ROWS + HIDDEN; r++) {
    for (let c = 0; c < COLS; c++) {
      if (!board[r][c]) continue;
      const v = r * VW + c;
      solid[v] = solid[v + 1] = solid[v + VW] = solid[v + VW + 1] = 1;
    }
  }
  const { dx, dy, vx, vy } = J;
  for (let t = 0; t < dt; t += J_STEP) {
    for (let v = 0; v < NV; v++) {
      if (!solid[v]) { dx[v] = dy[v] = vx[v] = vy[v] = 0; continue; }
      const c = v % VW;
      let sx = 0, sy = 0;
      const pull = u => { if (u >= 0 && u < NV && solid[u]) { sx += dx[u] - dx[v]; sy += dy[u] - dy[v]; } };
      if (c > 0) pull(v - 1);
      if (c < VW - 1) pull(v + 1);
      pull(v - VW);
      pull(v + VW);
      vx[v] += (-J_K * dx[v] + J_C * sx - J_DAMP * vx[v]) * J_STEP;
      vy[v] += (-J_K * dy[v] + J_C * sy - J_DAMP * vy[v]) * J_STEP;
    }
    for (let v = 0; v < NV; v++) {
      dx[v] = Math.max(-J_MAX, Math.min(J_MAX, dx[v] + vx[v] * J_STEP));
      dy[v] = Math.max(-J_MAX, Math.min(J_MAX, dy[v] + vy[v] * J_STEP));
      const c = v % VW;
      if (c === 0 || c === VW - 1) dx[v] = vx[v] = 0; // pressed against the pillars
      if (v >= NV - VW) dy[v] = vy[v] = 0; // resting on the table
    }
  }
}

// Water: kick the surface near column x and throw droplets up.
function splash(x, s) {
  const i = Math.round((x / COLS) * (WN - 1));
  for (let k = -3; k <= 3; k++) {
    const j = i + k;
    if (j >= 0 && j < WN) wave.v[j] += s * 1.6 * (1 - Math.abs(k) / 4);
  }
  for (let k = 0; k < 8 + s * 7; k++) {
    const life = 0.6 + Math.random() * 0.4;
    particles.push({ x: x + (Math.random() - 0.5) * 2, y: WATER_ROW, vx: (Math.random() - 0.5) * 6, vy: -(3 + Math.random() * 5) * Math.min(1.6, 0.6 + s * 0.3), life, max: life, color: '#e6f6ff', size: 0.06 + Math.random() * 0.14, drop: true });
  }
  beep(220, 0.18, 'sine', 0.08, 70);
  beep(1200, 0.08, 'triangle', 0.025, 400);
}

function stepWater(dt) {
  const { h, v } = wave;
  for (let t = 0; t < dt; t += J_STEP) {
    for (let i = 0; i < WN; i++) {
      const l = h[i > 0 ? i - 1 : i], r = h[i < WN - 1 ? i + 1 : i];
      v[i] += (-40 * h[i] + 900 * (l + r - 2 * h[i]) - 1.5 * v[i]) * J_STEP;
    }
    for (let i = 0; i < WN; i++) h[i] = Math.max(-1.2, Math.min(1.2, h[i] + v[i] * J_STEP));
  }
}

// Splash once, when the falling piece's bottom first reaches the water.
function checkSplash() {
  if (mode !== 'water' || piece.wet) return;
  const cells = ROTS[piece.type][piece.rot];
  if (piece.y - HIDDEN + Math.max(...cells.map(([, r]) => r)) + 1 < WATER_ROW) return;
  piece.wet = true;
  splash(piece.x + cells.reduce((a, [c]) => a + c + 0.5, 0) / cells.length, hardDropping ? 3 : softDrop ? 1.6 : 1);
  for (const [c, r] of cells) {
    const life = 0.8 + Math.random() * 0.6;
    particles.push({ x: piece.x + c + 0.5, y: piece.y - HIDDEN + r + 0.5, vx: (Math.random() - 0.5), vy: -1, g: -4, life, max: life, color: '#ffffff', size: 0.06 + Math.random() * 0.06, bubble: true });
  }
}

function spawn(type) {
  piece = { type, rot: 0, x: Math.floor((COLS - PIECES[type].shape.length) / 2), y: 0, id: nextId++ };
  if (!fits(type, 0, piece.x, 0)) { gameOver(); return; }
  if (fits(type, 0, piece.x, 1)) piece.y = 1; // drop into view right away
  piece.lowest = piece.y;
  dropTimer = 0; lockTimer = 0; lockResets = 0;
}

function afterShift() {
  if (piece.y > piece.lowest) { piece.lowest = piece.y; lockResets = 0; }
  if (lockTimer > 0 && lockResets < MAX_RESETS) { lockTimer = 0; lockResets++; }
}

function shift(dx) {
  if (!active() || !fits(piece.type, piece.rot, piece.x + dx, piece.y)) return false;
  piece.x += dx;
  afterShift();
  return true;
}

function rotate(dir) {
  if (!active() || piece.type === 'O') return;
  const from = piece.rot, to = (from + dir + 4) % 4;
  for (const [kx, ky] of (piece.type === 'I' ? KICKS_I : KICKS)[`${from}${to}`]) {
    if (fits(piece.type, to, piece.x + kx, piece.y - ky)) {
      piece.x += kx;
      piece.y -= ky;
      piece.rot = to;
      afterShift();
      jiggle(piece.id, 0.07);
      beep(440, 0.05, 'square', 0.035, 520);
      return;
    }
  }
}

function stepDown() {
  if (grounded()) return false;
  piece.y++;
  if (piece.y > piece.lowest) { piece.lowest = piece.y; lockResets = 0; }
  checkSplash();
  if (grounded()) landed();
  return true;
}

// The falling piece just hit the floor or the stack: it squashes, bounces up a
// little and wobbles back into shape, and the blocks it hit squash a bit too.
function landed() {
  const amp = hardDropping ? 0.26 : softDrop ? 0.17 : 0.14;
  jiggle(piece.id, amp);
  const cells = ROTS[piece.type][piece.rot].map(([c, r]) => [piece.x + c, piece.y + r]).filter(([, r]) => r >= 0);
  jellyHit(cells, amp * 11); // dents the top of the stack in Gummy / Water mode
  const below = new Set();
  for (const [c, r] of cells) {
    const cell = board[r + 1]?.[c];
    if (cell) below.add(cell.id);
  }
  for (const id of below) jiggle(id, amp * 0.45);
}

function softStep() {
  if (active() && stepDown()) { score++; dropTimer = 0; }
}

function hardDrop() {
  if (!active()) return;
  let n = 0;
  hardDropping = true;
  while (stepDown()) n++;
  hardDropping = false;
  score += n * 2;
  beep(180, 0.12, 'triangle', 0.12, 80);
  lock();
}

function hold() {
  if (!active() || holdUsed) return;
  const t = piece.type;
  wobbles.delete(piece.id);
  spawn(holdType || takeNext());
  holdType = t;
  holdUsed = true;
  beep(600, 0.06, 'sine', 0.06, 800);
}

function lock() {
  let hidden = true;
  ROTS[piece.type][piece.rot].forEach(([c, r]) => {
    const by = piece.y + r;
    if (by < 0) return;
    // ax / ay: where the piece sat, so its sugar coating stays put after locking.
    board[by][piece.x + c] = { type: piece.type, id: piece.id, ax: piece.x, ay: piece.y };
    if (by >= HIDDEN) hidden = false;
  });
  piece = null; // its landing bounce keeps playing on the locked blocks (same id)
  holdUsed = false;
  if (hidden) { gameOver(); return; } // locked entirely above the well

  const full = [];
  board.forEach((row, r) => { if (row.every(Boolean)) full.push(r); });
  if (!full.length) {
    beep(260, 0.08, 'triangle', 0.07, 180);
    spawn(takeNext());
    return;
  }

  const n = full.length;
  clearing = full;
  clearTimer = CLEAR_TIME;
  score += LINE_SCORES[n] * level;
  lines += n;
  floaters.push({ text: LINE_NAMES[n], color: n === 4 ? '#ffd23f' : '#fff', life: 1, size: n === 4 ? 1.3 : 0.9, oy: 0 });
  const newLevel = 1 + Math.floor(lines / 10);
  if (newLevel > level) {
    level = newLevel;
    floaters.push({ text: `Level ${level}`, color: '#5dff9c', life: 1.3, size: 0.75, oy: 1.6 });
  }
  for (const r of full) {
    for (let c = 0; c < COLS; c++) {
      const color = PALETTES[mode][board[r][c].type].base;
      if (mode === 'water' && r - HIDDEN >= WATER_ROW) { // underwater: bubbles instead of droplets
        for (let k = 0; k < 2; k++) {
          const life = 1 + Math.random() * 0.8;
          particles.push({ x: c + Math.random(), y: r - HIDDEN + Math.random(), vx: (Math.random() - 0.5) * 1.5, vy: -(1 + Math.random() * 2), g: -5, life, max: life, color: '#ffffff', size: 0.07 + Math.random() * 0.1, bubble: true });
        }
        continue;
      }
      for (let k = 0; k < 3; k++) {
        const a = Math.random() * Math.PI * 2, s = 3 + Math.random() * 7;
        const life = 0.5 + Math.random() * 0.5;
        particles.push({ x: c + 0.5, y: r - HIDDEN + 0.5, vx: Math.cos(a) * s, vy: Math.sin(a) * s - 4, life, max: life, color, size: 0.08 + Math.random() * 0.12 });
      }
    }
  }
  const notes = [523, 659, 784, 1047];
  for (let i = 0; i < n; i++) beep(notes[i], 0.18, 'square', 0.06, 0, i * 0.07);
}

function finishClear() {
  const lowest = Math.max(...clearing);
  board.forEach((row, r) => {
    const fall = clearing.filter(x => x > r).length;
    for (const cell of row) if (cell) cell.ay += fall;
  });
  board = board.filter((_, r) => !clearing.includes(r));
  while (board.length < ROWS + HIDDEN) board.unshift(emptyRow());
  // Everything that fell lands with a wobble.
  const fell = new Set(), fellCells = [];
  for (let r = 0; r <= lowest; r++) {
    board[r].forEach((cell, c) => { if (cell) { fell.add(cell.id); fellCells.push([c, r]); } });
  }
  for (const id of fell) jiggle(id, 0.13);
  for (const a of Object.values(J)) a.fill(0); // rows moved, so the mesh restarts
  if (fellCells.length) jellyHit(fellCells, 1.4);
  clearing = null;
  spawn(takeNext());
}

function startGame() {
  board = Array.from({ length: ROWS + HIDDEN }, emptyRow);
  queue = []; bag = [];
  holdType = null; holdUsed = false;
  score = 0; lines = 0; level = 1;
  clearing = null; particles = []; floaters = [];
  wobbles.clear();
  state = 'play';
  paused = false;
  spawn(takeNext());
}

function tryStart() {
  if (state === 'menu' || (state === 'over' && overTimer > 0.7)) startGame();
}

function gameOver() {
  state = 'over';
  overTimer = 0;
  if (score > best) {
    best = score;
    localStorage.setItem('tetris-best', String(best));
  }
  beep(300, 0.6, 'triangle', 0.15, 60);
}

function update(dt) {
  clock += dt;
  stepJelly(dt);
  if (mode === 'water') stepWater(dt);
  for (const [id, w] of wobbles) { w.t += dt; if (w.t > 1.5) wobbles.delete(id); }
  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i];
    p.life -= dt;
    p.x += p.vx * dt; p.y += p.vy * dt;
    p.vy += (p.g ?? 30) * dt;
    if (p.bubble && p.y < WATER_ROW) p.life = 0; // popped at the surface
    if (p.drop && p.vy > 0 && p.y > WATER_ROW) p.life = 0; // fell back in
    if (p.life <= 0) particles.splice(i, 1);
  }
  for (let i = floaters.length - 1; i >= 0; i--) {
    floaters[i].life -= dt * 0.8;
    if (floaters[i].life <= 0) floaters.splice(i, 1);
  }

  if (state === 'over') overTimer += dt;
  if (state !== 'play') return;
  if (clearing) {
    clearTimer -= dt;
    if (clearTimer <= 0) finishClear();
    return;
  }
  if (!piece) return;

  if (dasDir) {
    dasTimer += dt;
    if (dasTimer >= DAS) {
      arrTimer += dt;
      while (arrTimer >= ARR) {
        arrTimer -= ARR;
        if (!shift(dasDir)) { arrTimer = 0; break; }
      }
    }
  }

  const g = softDrop ? Math.min(gravity(), SOFT_RATE) : gravity();
  dropTimer += dt;
  while (dropTimer >= g) {
    dropTimer -= g;
    if (!stepDown()) { dropTimer = 0; break; }
    if (softDrop) score++;
  }

  if (!grounded()) lockTimer = 0;
  else if ((lockTimer += dt) >= LOCK_DELAY) lock();
}

// ---- Input ----
const KEYS = {
  ArrowLeft: 'left', KeyA: 'left', ArrowRight: 'right', KeyD: 'right',
  ArrowDown: 'down', KeyS: 'down',
  ArrowUp: 'cw', KeyX: 'cw', KeyW: 'cw', KeyZ: 'ccw', ControlLeft: 'ccw', ControlRight: 'ccw',
  Space: 'drop', Enter: 'start',
  KeyC: 'hold', ShiftLeft: 'hold', ShiftRight: 'hold',
  KeyP: 'pause', Escape: 'pause', KeyM: 'mute',
  Digit1: 'jelly', Digit2: 'gummy', Digit3: 'water', KeyG: 'mode',
};

window.addEventListener('keydown', e => {
  const a = KEYS[e.code];
  if (!a) return;
  e.preventDefault();
  initAudio();
  if (a === 'mute') { muted = !muted; return; }
  if (MODES.includes(a)) { setMode(a); return; }
  if (a === 'mode') { if (!e.repeat) setMode(MODES[(MODES.indexOf(mode) + 1) % MODES.length]); return; }
  if (state !== 'play') { if ((a === 'drop' || a === 'start') && !e.repeat) tryStart(); return; }
  if (e.repeat) return;
  if (a === 'pause') { paused = !paused; return; }
  if (paused) { if (a === 'drop' || a === 'start') paused = false; return; }
  if (a === 'left' || a === 'right') {
    held[a] = true;
    dasDir = a === 'left' ? -1 : 1;
    dasTimer = 0; arrTimer = 0;
    shift(dasDir);
  } else if (a === 'down') softDrop = true;
  else if (a === 'cw') rotate(1);
  else if (a === 'ccw') rotate(-1);
  else if (a === 'drop') hardDrop();
  else if (a === 'hold') hold();
});

window.addEventListener('keyup', e => {
  const a = KEYS[e.code];
  if (a === 'down') softDrop = false;
  else if (a === 'left' || a === 'right') {
    held[a] = false;
    dasDir = held.left ? -1 : held.right ? 1 : 0;
    dasTimer = 0; arrTimer = 0;
  }
});

// Touch / mouse: drag to move, tap to rotate, flick down to hard drop, flick up to hold.
let touch = null;
canvas.addEventListener('pointerdown', e => {
  initAudio();
  if (state !== 'play') {
    // Tapping a mode button is deliberate, so it starts at once, even in the
    // first moments of the game-over screen when a stray tap is ignored.
    const hit = modeRects.find(m => e.clientX >= m.x && e.clientX <= m.x + m.w && e.clientY >= m.y && e.clientY <= m.y + m.h);
    if (hit) { setMode(hit.mode); startGame(); } else tryStart();
    return;
  }
  // In-play mode switch button: tap to cycle to the next mode without ending the game.
  if (modeBtn && e.clientX >= modeBtn.x && e.clientX <= modeBtn.x + modeBtn.w && e.clientY >= modeBtn.y && e.clientY <= modeBtn.y + modeBtn.h) {
    setMode(MODES[(MODES.indexOf(mode) + 1) % MODES.length]);
    return;
  }
  if (paused) { paused = false; return; }
  canvas.setPointerCapture?.(e.pointerId);
  touch = { id: e.pointerId, x0: e.clientX, y0: e.clientY, ax: e.clientX, ay: e.clientY, t0: performance.now(), moved: false, axis: null };
});
canvas.addEventListener('pointermove', e => {
  if (!touch || e.pointerId !== touch.id || !active()) return;
  const step = Math.max(16, L.c * 0.9);
  const dx = e.clientX - touch.x0, dy = e.clientY - touch.y0;
  const adx = Math.abs(dx), ady = Math.abs(dy);
  // Decide the gesture axis once, from the accumulated movement. Vertical wins
  // ties because sliding down (soft drop) is the gesture most likely to pick up
  // accidental sideways drift; horizontal needs to be clearly dominant.
  if (!touch.axis) {
    if (ady > 12 && ady > adx * 1.6) touch.axis = 'v';
    else if (adx > 12 && adx > ady * 2.2) touch.axis = 'h';
  }
  if (touch.axis === 'h') {
    while (e.clientX - touch.ax >= step) { touch.ax += step; shift(1); touch.moved = true; }
    while (touch.ax - e.clientX >= step) { touch.ax -= step; shift(-1); touch.moved = true; }
    touch.ay = e.clientY; // keep synced so a later dip doesn't fire a burst of soft drops
  } else if (touch.axis === 'v') {
    touch.ax = e.clientX; // ignore horizontal drift entirely while sliding down
    while (e.clientY - touch.ay >= step) { touch.ay += step; softStep(); touch.moved = true; }
  } else {
    // Not decided yet: demand a wider horizontal travel before moving the piece,
    // so a small drift can't nudge it sideways.
    const hStep = step * 1.8;
    while (e.clientX - touch.ax >= hStep) { touch.ax += hStep; shift(1); touch.moved = true; }
    while (touch.ax - e.clientX >= hStep) { touch.ax -= hStep; shift(-1); touch.moved = true; }
    while (e.clientY - touch.ay >= step) { touch.ay += step; softStep(); touch.moved = true; }
  }
});
function endTouch(e) {
  if (!touch || e.pointerId !== touch.id) return;
  const dt = performance.now() - touch.t0;
  const dx = e.clientX - touch.x0, dy = e.clientY - touch.y0;
  if (dt < 300 && dy > 40 && dy > Math.abs(dx) * 1.5) hardDrop();
  else if (dt < 400 && dy < -40 && -dy > Math.abs(dx) * 1.5) hold();
  else if (!touch.moved && dt < 350 && Math.abs(dx) < 12 && Math.abs(dy) < 12) {
    const h = L.hold;
    if (e.clientX >= h.x && e.clientX <= h.x + h.w && e.clientY >= h.y && e.clientY <= h.y + h.h) hold();
    else rotate(1);
  }
  touch = null;
}
canvas.addEventListener('pointerup', endTouch);
canvas.addEventListener('pointercancel', () => { touch = null; });

window.addEventListener('blur', () => {
  if (state === 'play') paused = true;
  softDrop = false; held.left = held.right = false; dasDir = 0; touch = null;
});
window.addEventListener('resize', resize);

// ---- Drawing ----
function layout() {
  // Bottom margin: room for the Home link (40px) plus stage decoration
  // (tank base / granite ledge / wooden table edge ≈ 2.2 cell sizes below bh).
  // Iteratively solve: BOT = 40 + 2.2 * cell, where cell fits in (H - BOT).
  const sideRaw = Math.floor(Math.min((H - 84) / ROWS, (W - 24) / (COLS + 12.6)));
  const topRaw = Math.floor(Math.min((H - 154) / (ROWS + 4.5), (W - 24) / (COLS + 1.2)));
  const BOT = (c) => Math.ceil(40 + 2.2 * c);
  const side = Math.floor(Math.min((H - BOT(sideRaw)) / ROWS, (W - 24) / (COLS + 12.6)));
  const top = Math.floor(Math.min((H - BOT(topRaw) - 110) / (ROWS + 4.5), (W - 24) / (COLS + 1.2)));
  if (top > side * 1.15) {
    // Portrait: hold / stats / next sit in a strip above the well.
    const c = top, bw = COLS * c, bh = ROWS * c;
    const totalH = 4.5 * c + bh;
    const by = Math.round((H - totalH - BOT(c)) / 2 + 4.5 * c);
    const bx = Math.round((W - bw) / 2);
    const py = by - 4.5 * c;
    return {
      c, bx, by, bw, bh, compact: true,
      hold: { x: bx, y: py, w: 3 * c, h: 4 * c },
      next: { x: bx + bw - 3 * c, y: py, w: 3 * c, h: 4 * c },
      stats: { x: bx + 3.25 * c, y: py, w: bw - 6.5 * c, h: 4 * c },
    };
  }
  const c = side, bw = COLS * c, bh = ROWS * c;
  const bx = Math.round((W - bw) / 2), by = Math.round((H - bh - BOT(c)) / 2);
  return {
    c, bx, by, bw, bh, compact: false,
    hold: { x: bx - 6.3 * c, y: by, w: 5 * c, h: 4 * c },
    next: { x: bx + bw + 1.3 * c, y: by, w: 5 * c, h: 13.4 * c },
    stats: { x: bx - 6.3 * c, y: by + 4.5 * c, w: 5 * c, h: 8 * c },
  };
}

// Outline loops of a set of cells, as grid corner points in clockwise order.
function outlineLoops(cells) {
  const has = new Set(cells.map(([c, r]) => `${c},${r}`));
  const out = new Map();
  const edge = (x1, y1, x2, y2) => {
    const k = `${x1},${y1}`;
    if (!out.has(k)) out.set(k, []);
    out.get(k).push([x2, y2]);
  };
  for (const [c, r] of cells) {
    if (!has.has(`${c},${r - 1}`)) edge(c, r, c + 1, r);
    if (!has.has(`${c + 1},${r}`)) edge(c + 1, r, c + 1, r + 1);
    if (!has.has(`${c},${r + 1}`)) edge(c + 1, r + 1, c, r + 1);
    if (!has.has(`${c - 1},${r}`)) edge(c, r + 1, c, r);
  }
  const loops = [];
  for (const [k, list] of out) {
    const [sx, sy] = k.split(',').map(Number);
    while (list.length) {
      const loop = [[sx, sy]];
      let [x, y] = list.pop();
      while (x !== sx || y !== sy) {
        loop.push([x, y]);
        [x, y] = out.get(`${x},${y}`).pop();
      }
      loops.push(loop);
    }
  }
  return loops;
}

// Rounded outline path through the (possibly deformed) corners of a set of cells.
// k is the corner rounding as a fraction of a cell edge.
function blobPath(cells, corner, k) {
  const path = new Path2D();
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const loop of outlineLoops(cells)) {
    const pts = loop.map(([x, y]) => corner(x, y));
    const n = pts.length;
    pts.forEach((pt, i) => {
      x0 = Math.min(x0, pt[0]); x1 = Math.max(x1, pt[0]);
      y0 = Math.min(y0, pt[1]); y1 = Math.max(y1, pt[1]);
      const a = pts[(i + n - 1) % n], b = pts[(i + 1) % n];
      const sx = pt[0] + (a[0] - pt[0]) * k, sy = pt[1] + (a[1] - pt[1]) * k;
      if (i === 0) path.moveTo(sx, sy); else path.lineTo(sx, sy);
      path.quadraticCurveTo(pt[0], pt[1], pt[0] + (b[0] - pt[0]) * k, pt[1] + (b[1] - pt[1]) * k);
    });
    path.closePath();
  }
  return { path, x0, x1, y0, y1 };
}

// Squash and stretch around the bottom centre, like jelly settling. While it is
// stretched (sq < 0) after an impact, it also hops up a little: the bounce.
function squashAt(sq, x0, x1, y1) {
  if (!sq) return;
  const px = (x0 + x1) / 2;
  ctx.translate(0, Math.min(0, sq) * 1.6 * L.c);
  ctx.translate(px, y1);
  ctx.scale(1 + sq, 1 - sq);
  ctx.translate(-px, -y1);
}

// Draws cells as a puffy, sugar-coated gummy. corner(x, y) maps a grid corner to
// pixels, so the outline follows the spring mesh when it deforms. anchor is where
// the sugar pattern starts, so the grains move with the piece.
function drawGummy(cells, s, corner, p, alpha = 1, sq = 0, ghost = false, anchor = [0, 0]) {
  if (!cells.length) return;
  const { path, y0, y1, x0, x1 } = blobPath(cells, corner, 0.3);
  ctx.save();
  squashAt(sq, x0, x1, y1);
  if (ghost) {
    ctx.globalAlpha = 0.3 * alpha;
    ctx.fillStyle = '#ffffff';
    ctx.fill(path);
    ctx.restore();
    return;
  }
  ctx.globalAlpha = alpha;
  ctx.fillStyle = p.base;
  ctx.fill(path);

  ctx.save();
  ctx.clip(path);
  // Soft, matte candy: a little lighter on top, a little deeper at the bottom
  // and towards the edges. No hard outline.
  const g = ctx.createLinearGradient(0, y0, 0, y1);
  g.addColorStop(0, p.light + '55');
  g.addColorStop(0.5, p.light + '00');
  g.addColorStop(1, p.dark + '40');
  ctx.fillStyle = g;
  ctx.fill(path);
  ctx.lineWidth = s * 0.22;
  ctx.strokeStyle = p.dark + '38';
  ctx.stroke(path);
  // Sugar beads all over, crowded along the edges where the surface turns away.
  if (!sugar || sugarC !== L.c) makeSugar(L.c);
  const m = new DOMMatrix([1 / DPR, 0, 0, 1 / DPR, anchor[0], anchor[1]]);
  sugar.setTransform(m);
  ctx.fillStyle = sugar;
  ctx.fill(path);
  sugarRim.setTransform(m);
  ctx.strokeStyle = sugarRim;
  ctx.lineWidth = s * 0.1;
  ctx.stroke(path);
  ctx.restore();
  ctx.restore();
}

// Gummy mode stage: a round table with a pale wooden top and a white base, and
// two thick white pillars holding the stack.
function drawStage() {
  const { c, bx, by, bw, bh } = L;
  const cx = bx + bw / 2, ty = by + bh;
  const rx = Math.min(bw / 2 + 3.2 * c, W / 2 - 4), ry = 1.1 * c, edge = 0.18 * c, side = 1.4 * c;
  // White base.
  let g = ctx.createLinearGradient(cx - rx, 0, cx + rx, 0);
  g.addColorStop(0, '#d9d9d6');
  g.addColorStop(0.4, '#fbfbfa');
  g.addColorStop(1, '#c6c6c2');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.ellipse(cx, ty + edge + side, rx * 0.98, ry, 0, 0, Math.PI);
  ctx.lineTo(cx - rx * 0.98, ty + edge);
  ctx.lineTo(cx + rx * 0.98, ty + edge);
  ctx.fill();
  // Thin wooden edge, then the top.
  ctx.fillStyle = '#c99a5c';
  ctx.beginPath();
  ctx.ellipse(cx, ty + edge, rx, ry, 0, 0, Math.PI * 2);
  ctx.fill();
  g = ctx.createLinearGradient(0, ty - ry, 0, ty + ry);
  g.addColorStop(0, '#e9cc98');
  g.addColorStop(1, '#f6e2bb');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.ellipse(cx, ty, rx, ry, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.save();
  ctx.clip();
  // Plank seams and a little grain.
  ctx.strokeStyle = 'rgba(150,105,50,0.28)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = cx - rx - c; x < cx + rx + c; x += 1.25 * c) {
    ctx.moveTo(x, ty - ry);
    ctx.lineTo(x + 0.7 * c, ty + ry);
  }
  ctx.stroke();
  ctx.strokeStyle = 'rgba(170,120,60,0.07)';
  ctx.beginPath();
  for (let k = 0; k < 24; k++) {
    const x = cx - rx + ((k * 97) % 100) / 100 * 2 * rx, y = ty - ry + ((k * 61) % 100) / 100 * 2 * ry;
    ctx.moveTo(x, y);
    ctx.quadraticCurveTo(x + 0.4 * c, y + 0.1 * c, x + 0.9 * c, y + 0.35 * c);
  }
  ctx.stroke();
  // Soft shadows under the stack and the pillars.
  ctx.fillStyle = 'rgba(60,35,10,0.16)';
  ctx.beginPath();
  ctx.ellipse(cx, ty + 0.12 * c, bw / 2 + 1.4 * c, 0.4 * c, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  const pw = (L.compact ? 0.58 : 0.95) * c;
  for (const x of [bx - pw - 1, bx + bw + 1]) {
    g = ctx.createLinearGradient(x, 0, x + pw, 0);
    g.addColorStop(0, '#ececea');
    g.addColorStop(0.3, '#ffffff');
    g.addColorStop(0.7, '#dededa');
    g.addColorStop(1, '#b8b8b3');
    ctx.fillStyle = g;
    ctx.fillRect(x, 0, pw, ty + 0.15 * c);
  }
}

// Water mode piece: a coloured glass-like jelly brick with small rounded corners.
// It is dark and rich in the middle, brighter at the edges and the bottom, has a
// crisp white highlight along the top-left, and shows the lattice behind it bent
// by refraction.
function drawGlass(cells, s, corner, p, alpha = 1, sq = 0, ghost = false) {
  if (!cells.length) return;
  const { path, x0, x1, y0, y1 } = blobPath(cells, corner, 0.14);
  ctx.save();
  squashAt(sq, x0, x1, y1);
  if (ghost) {
    ctx.globalAlpha = 0.12 * alpha;
    ctx.fillStyle = '#ffffff';
    ctx.fill(path);
    ctx.globalAlpha = 0.45 * alpha;
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1.5;
    ctx.stroke(path);
    ctx.restore();
    return;
  }
  ctx.globalAlpha = alpha;
  const g = ctx.createLinearGradient(0, y0, 0, y1);
  g.addColorStop(0, p.dark + 'ea');
  g.addColorStop(0.55, p.base + 'e0');
  g.addColorStop(1, p.base + 'f0');
  ctx.fillStyle = g;
  ctx.fill(path);

  ctx.save();
  ctx.clip(path);
  // Lattice struts seen through the glass, in screen space and wobbled.
  const fy = H * 0.68, amp = s * 0.2;
  const d0 = ((-fy % LAT_SP) + LAT_SP) % LAT_SP;
  ctx.strokeStyle = p.dark + '90';
  ctx.lineWidth = Math.max(2, s * 0.16);
  ctx.beginPath();
  for (let d = d0 + Math.floor((x0 - y1 - d0) / LAT_SP) * LAT_SP; d <= x1 - y0; d += LAT_SP) {
    for (let y = y0; y <= y1 + 4; y += 4) {
      const x = d + y + Math.sin(y * 0.09 + d) * amp;
      if (y === y0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
  }
  for (let e = Math.floor((x0 + y0) / LAT_SP) * LAT_SP; e <= x1 + y1; e += LAT_SP) {
    for (let y = y0; y <= y1 + 4; y += 4) {
      const x = e - y + Math.sin(y * 0.09 + e) * amp;
      if (y === y0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
  }
  ctx.stroke();
  // Fresnel rim: brighter, more saturated colour where the edges catch the light.
  ctx.lineWidth = s * 0.26;
  ctx.strokeStyle = p.light + '58';
  ctx.stroke(path);
  // Crisp specular line just inside the top and left edges.
  ctx.translate(s * 0.06, s * 0.07);
  ctx.lineWidth = Math.max(1, s * 0.045);
  ctx.strokeStyle = 'rgba(255,255,255,0.85)';
  ctx.stroke(path);
  ctx.restore();

  ctx.lineWidth = 1;
  ctx.strokeStyle = p.dark + 'e6';
  ctx.stroke(path);
  ctx.restore();
}

// Water mode tank: the glass back (front = false), or the slate frame drawn over everything.
function drawTank(front) {
  const { c, bx, by, bw, bh } = L;
  if (!front) {
    ctx.drawImage(wall, bx * DPR, by * DPR, bw * DPR, bh * DPR, bx, by, bw, bh);
    return;
  }
  const t = 0.7 * c, tb = Math.max(t, Math.min(1.6 * c, H - (by + bh) - 44)); // keep clear of the Home link
  const g = ctx.createLinearGradient(0, by - t, 0, by + bh + tb);
  g.addColorStop(0, '#536170');
  g.addColorStop(1, '#3b4856');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.roundRect(bx - t, by - t, bw + 2 * t, bh + t + tb, t * 0.3);
  ctx.rect(bx, by, bw, bh);
  ctx.fill('evenodd');
  ctx.strokeStyle = 'rgba(255,255,255,0.14)'; // outer edge catching the light
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.roundRect(bx - t + 0.5, by - t + 0.5, bw + 2 * t - 1, bh + t + tb - 1, t * 0.3);
  ctx.stroke();
  ctx.strokeStyle = 'rgba(10,20,30,0.45)'; // recessed inner bezel around the glass
  ctx.lineWidth = 3;
  ctx.strokeRect(bx - 1.5, by - 1.5, bw + 3, bh + 3);
  ctx.fillStyle = 'rgba(255,255,255,0.06)'; // glint on the front glass
  ctx.fillRect(bx + 0.5 * c, by, 0.3 * c, bh);
  if (by + bh + tb <= H) text('T E T R I S', bx + bw / 2, by + bh + tb / 2, tb * 0.5, '#8ccbea', 'center', 800, bw);
}

function waterShape() {
  const { c, bx, by, bw, bh } = L;
  const sy = by + WATER_ROW * c;
  const surf = [];
  for (let i = 0; i < WN; i++) surf.push([bx + (i / (WN - 1)) * bw, sy + wave.h[i] * c]);
  const body = new Path2D();
  body.moveTo(bx, by + bh);
  for (const [x, y] of surf) body.lineTo(x, y);
  body.lineTo(bx + bw, by + bh);
  body.closePath();
  return { body, surf, sy };
}

// Behind the pieces: the background seen through the water, bent into moving waves.
function drawWaterBack() {
  const { c, bx, by, bw, bh } = L;
  const { body, sy } = waterShape();
  ctx.save();
  ctx.clip(body);
  for (let y = Math.floor(sy - 1.3 * c); y < by + bh; y += 3) {
    const off = Math.sin(y * 0.05 + clock * 1.7) * c * 0.25 + Math.sin(y * 0.13 - clock * 2.3) * c * 0.08;
    ctx.drawImage(wall, (bx + off) * DPR, y * DPR, bw * DPR, 3 * DPR, bx, y, bw, 3.5);
  }
  ctx.restore();
}

// In front of the pieces: a light tint, drifting caustics and a glossy surface.
function drawWaterFront() {
  const { c, bx, by, bw, bh } = L;
  const { body, surf, sy } = waterShape();
  let g = ctx.createLinearGradient(0, sy, 0, by + bh);
  g.addColorStop(0, 'rgba(190,235,255,0.10)');
  g.addColorStop(1, 'rgba(40,130,210,0.20)');
  ctx.fillStyle = g;
  ctx.fill(body);
  ctx.save();
  ctx.clip(body);
  g = ctx.createLinearGradient(0, sy - 0.3 * c, 0, sy + 0.8 * c);
  g.addColorStop(0, 'rgba(255,255,255,0.4)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(bx, sy - 1.5 * c, bw, 2.3 * c);
  ctx.strokeStyle = 'rgba(255,255,255,0.09)';
  ctx.lineWidth = Math.max(1.5, c * 0.07);
  for (let k = 0; k < 8; k++) {
    ctx.beginPath();
    const yk = sy + (k + 0.5) * ((by + bh - sy) / 8);
    for (let x = 0; x <= bw; x += c / 3) {
      const y = yk + Math.sin(x / c * 1.3 + clock * 1.6 + k * 2) * c * 0.3;
      if (x === 0) ctx.moveTo(bx + x, y); else ctx.lineTo(bx + x, y);
    }
    ctx.stroke();
  }
  ctx.restore();
  ctx.beginPath();
  surf.forEach(([x, y], i) => (i ? ctx.lineTo(x, y + 3) : ctx.moveTo(x, y + 3)));
  ctx.strokeStyle = 'rgba(20,70,110,0.35)';
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.beginPath();
  surf.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
  ctx.strokeStyle = 'rgba(255,255,255,0.95)';
  ctx.lineWidth = 2.5;
  ctx.stroke();
}

// Jelly mode piece: saturated, glossy jelly with soft corners, a white sheen on
// every upward-facing top, a crisp highlight along the top-left edge, and a
// brighter band inside the edges where light passes through.
function drawGloss(cells, s, corner, p, alpha = 1, sq = 0, ghost = false) {
  if (!cells.length) return;
  const { path, x0, x1, y0, y1 } = blobPath(cells, corner, 0.26);
  ctx.save();
  squashAt(sq, x0, x1, y1);
  if (ghost) {
    ctx.globalAlpha = 0.16 * alpha;
    ctx.fillStyle = p.base;
    ctx.fill(path);
    ctx.globalAlpha = 0.5 * alpha;
    ctx.strokeStyle = p.base;
    ctx.lineWidth = 1.5;
    ctx.stroke(path);
    ctx.restore();
    return;
  }
  ctx.globalAlpha = alpha;
  const g = ctx.createLinearGradient(0, y0, 0, y1);
  g.addColorStop(0, p.light + 'f2');
  g.addColorStop(0.3, p.base + 'ee');
  g.addColorStop(1, p.dark + 'f2');
  ctx.fillStyle = g;
  ctx.fill(path);

  ctx.save();
  ctx.clip(path);
  ctx.lineWidth = s * 0.34;
  ctx.strokeStyle = p.base + '99';
  ctx.stroke(path);
  // One sheen per run of side-by-side exposed tops, so there are no seams between cells.
  const has = new Set(cells.map(([c, r]) => `${c},${r}`));
  for (const [c, r] of cells) {
    if (has.has(`${c},${r - 1}`) || (has.has(`${c - 1},${r}`) && !has.has(`${c - 1},${r - 1}`))) continue;
    let end = c + 1;
    while (has.has(`${end},${r}`) && !has.has(`${end},${r - 1}`)) end++;
    const a = corner(c, r), b = corner(end, r), top = Math.min(a[1], b[1]);
    const sg = ctx.createLinearGradient(0, top, 0, top + s * 0.55);
    sg.addColorStop(0, 'rgba(255,255,255,0.6)');
    sg.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = sg;
    ctx.fillRect(a[0] - 1, top - 1, b[0] - a[0] + 2, s * 0.55 + 2);
  }
  ctx.translate(s * 0.07, s * 0.08);
  ctx.lineWidth = Math.max(1.2, s * 0.06);
  ctx.strokeStyle = 'rgba(255,255,255,0.9)';
  ctx.stroke(path);
  ctx.restore();

  ctx.lineWidth = 1;
  ctx.strokeStyle = p.dark + '77';
  ctx.stroke(path);
  ctx.restore();
}

// Jelly mode stage: tiled granite pillars and a granite ledge under the stack,
// on a dark marble table.
function drawGraniteStage() {
  const { c, bx, by, bw, bh } = L;
  const pw = (L.compact ? 0.58 : 0.9) * c, base = 0.75 * c, ty = by + bh, cx = bx + bw / 2;
  const rx = Math.min(bw / 2 + 4 * c, W / 2 + c), ry = 1.6 * c, tcy = ty + base + 0.4 * c;
  let g = ctx.createLinearGradient(0, tcy - ry, 0, tcy + ry);
  g.addColorStop(0, '#3a3b3f');
  g.addColorStop(1, '#17181a');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.ellipse(cx, tcy, rx, ry, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.save();
  ctx.clip();
  ctx.strokeStyle = 'rgba(230,230,235,0.12)'; // marble veins
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let k = 0; k < 6; k++) {
    const x = cx - rx + (k / 6) * 2 * rx;
    ctx.moveTo(x, tcy - ry);
    ctx.quadraticCurveTo(x + c, tcy, x + 0.4 * c, tcy + ry);
  }
  ctx.stroke();
  ctx.restore();

  ctx.fillStyle = granite;
  ctx.fillRect(bx - pw - 1, ty, bw + 2 * pw + 2, base);
  ctx.fillRect(bx - pw - 1, 0, pw, ty + base);
  ctx.fillRect(bx + bw + 1, 0, pw, ty + base);
  ctx.strokeStyle = 'rgba(190,190,198,0.35)'; // tile seams
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = bx; x < bx + bw; x += c) { ctx.moveTo(x + 0.5, ty); ctx.lineTo(x + 0.5, ty + base); }
  ctx.moveTo(bx - pw, ty + base / 2); ctx.lineTo(bx + bw + pw, ty + base / 2);
  for (const x of [bx - pw - 1, bx + bw + 1]) {
    for (let y = ty - 1.6 * c; y > -c; y -= 1.6 * c) { ctx.moveTo(x, y); ctx.lineTo(x + pw, y); }
    ctx.moveTo(x + pw * 0.3, 0); ctx.lineTo(x + pw * 0.3, ty);
  }
  ctx.stroke();
  ctx.fillStyle = 'rgba(255,255,255,0.14)'; // light catching the top of the ledge and the pillar edges
  ctx.fillRect(bx - pw, ty, bw + 2 * pw, 2);
  ctx.fillRect(bx - pw - 1, 0, 1.5, ty + base);
  ctx.fillRect(bx + bw + 1, 0, 1.5, ty + base);
  ctx.fillStyle = 'rgba(0,0,0,0.25)';
  ctx.fillRect(bx - 2.5, 0, 1.5, ty);
  ctx.fillRect(bx + bw + pw - 0.5, 0, 1.5, ty + base);
}

// Draws cells in the current mode's style.
function drawCells(cells, s, corner, type, alpha = 1, sq = 0, ghost = false, anchor) {
  const p = PALETTES[mode][type];
  if (mode === 'gummy') drawGummy(cells, s, corner, p, alpha, sq, ghost, anchor);
  else if (mode === 'water') drawGlass(cells, s, corner, p, alpha, sq, ghost);
  else drawGloss(cells, s, corner, p, alpha, sq, ghost);
}

// Jelly mode pieces are a little irregular, like real jelly: each corner gets a
// small fixed offset, chosen per piece in its own grid coordinates (ox, oy).
const jit = (id, x, y, k) => ((Math.imul(id * 31 + x * 17 + y * 7 + k, 2654435761) >>> 0) % 1000 / 1000 - 0.5) * 0.08;
function organic(corner, id, ox, oy) {
  if (mode !== 'jelly') return corner;
  return (x, y) => {
    const [px, py] = corner(x, y);
    return [px + jit(id, x - ox, y - oy, 1) * L.c, py + jit(id, x - ox, y - oy, 2) * L.c];
  };
}

function drawPreview(type, cx, cy, s, alpha = 1) {
  const cells = ROTS[type][0];
  const cs = cells.map(([c]) => c), rs = cells.map(([, r]) => r);
  const minC = Math.min(...cs), minR = Math.min(...rs);
  const w = (Math.max(...cs) - minC + 1) * s, h = (Math.max(...rs) - minR + 1) * s;
  const ox = cx - w / 2 - minC * s, oy = cy - h / 2 - minR * s;
  drawCells(cells, s, (x, y) => [ox + x * s, oy + y * s], type, alpha, 0, false, [ox, oy]);
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

function drawPanel(r, label) {
  ctx.fillStyle = 'rgba(10,6,30,0.65)';
  ctx.strokeStyle = 'rgba(255,255,255,0.12)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.roundRect(r.x + 0.5, r.y + 0.5, r.w - 1, r.h - 1, Math.min(12, L.c * 0.4));
  ctx.fill();
  ctx.stroke();
  if (label) text(label, r.x + r.w / 2, r.y + L.c * 0.6, Math.max(10, L.c * 0.42), 'rgba(255,255,255,0.6)', 'center', 700);
}

// Pixel origin of a piece's sugar pattern: its grid position plus a per-piece offset.
function sugarAnchor(id, x, y) {
  return [L.bx + x * L.c + (id * 37) % 97, L.by + (y - HIDDEN) * L.c + (id * 61) % 89];
}

function drawBoard() {
  const { c, bx, by, bw, bh } = L;
  const glass = mode === 'water';
  if (mode === 'gummy') drawStage();
  else if (glass) { drawTank(false); drawWaterBack(); }
  else drawGraniteStage();

  // Locked cells, merged into blobs by the piece they came from.
  const groups = new Map();
  for (let r = HIDDEN; r < ROWS + HIDDEN; r++) {
    for (let col = 0; col < COLS; col++) {
      const cell = board[r][col];
      if (!cell) continue;
      if (!groups.has(cell.id)) groups.set(cell.id, { type: cell.type, cells: [], cell });
      groups.get(cell.id).cells.push([col, r - HIDDEN]);
    }
  }
  const meshCorner = (x, y) => {
    const v = (y + HIDDEN) * VW + x;
    return [bx + (x + J.dx[v]) * c, by + (y + J.dy[v]) * c];
  };
  for (const [id, g] of groups) {
    const { ax, ay } = g.cell;
    drawCells(g.cells, c, organic(meshCorner, id, ax, ay - HIDDEN), g.type, 1, squish(id), false, sugarAnchor(id, ax, ay));
  }

  if (clearing) {
    const k = clearTimer / CLEAR_TIME;   // 1 → 0
    const t = 1 - k;                      // 0 → 1 (sweep progress)
    for (const r of clearing) {
      const y0 = by + (r - HIDDEN) * c;
      // Soft white wash that fades as the row clears.
      ctx.fillStyle = `rgba(255,255,255,${0.5 * k})`;
      ctx.fillRect(bx, y0, bw, c);
      // Bright band sweeping left → right across the row.
      const front = t * (bw + 2 * c) - c, w = c * 1.4;
      const g = ctx.createLinearGradient(bx + front - w, 0, bx + front + w, 0);
      g.addColorStop(0, 'rgba(255,240,170,0)');
      g.addColorStop(0.5, `rgba(255,252,215,${0.95 * k})`);
      g.addColorStop(1, 'rgba(255,240,170,0)');
      ctx.fillStyle = g;
      ctx.fillRect(bx + front - w, y0, w * 2, c);
    }
  }

  if (piece) {
    const cells = y => ROTS[piece.type][piece.rot].map(([pc, pr]) => [piece.x + pc, y + pr - HIDDEN]);
    const visible = y => cells(y).filter(([, r]) => r >= 0);
    // The falling piece breathes a little so it never looks rigid.
    const wobble = (x, y) => [
      bx + (x + 0.03 * Math.sin(clock * 5 + x * 1.7 + y)) * c,
      by + (y + 0.03 * Math.cos(clock * 6 + y * 1.3 + x)) * c,
    ];
    drawCells(visible(ghostY()), c, (x, y) => [bx + x * c, by + y * c], piece.type, 1, 0, true);
    drawCells(visible(piece.y), c, organic(wobble, piece.id, piece.x, piece.y - HIDDEN), piece.type, 1, squish(piece.id), false, sugarAnchor(piece.id, piece.x, piece.y));
  }

  if (glass) drawWaterFront();
  for (const p of particles) {
    ctx.globalAlpha = Math.max(0, p.life / p.max);
    ctx.beginPath();
    ctx.arc(bx + p.x * c, by + p.y * c, p.size * c, 0, Math.PI * 2);
    if (p.bubble || p.drop) {
      // Clear water: almost see-through with a bright rim.
      if (p.drop) { ctx.fillStyle = 'rgba(235,248,255,0.35)'; ctx.fill(); }
      ctx.strokeStyle = 'rgba(255,255,255,0.85)';
      ctx.lineWidth = 1.2;
      ctx.stroke();
    } else {
      ctx.fillStyle = p.color;
      ctx.fill();
    }
  }
  ctx.globalAlpha = 1;
  if (glass) drawTank(true);
  for (const f of floaters) {
    ctx.globalAlpha = Math.max(0, Math.min(1, f.life * 1.5));
    text(f.text, bx + bw / 2, by + bh * 0.35 + (f.oy - (1 - f.life) * 1.5) * c, Math.min(52, c * f.size * 1.4), f.color, 'center', 900, bw - 8);
  }
  ctx.globalAlpha = 1;
}

function drawSide() {
  const { c } = L;
  const lab = Math.max(10, c * 0.42), val = Math.max(14, c * 0.75);
  drawPanel(L.hold, 'HOLD');
  if (holdType) drawPreview(holdType, L.hold.x + L.hold.w / 2, L.hold.y + L.hold.h / 2 + c * 0.4, c * (L.compact ? 0.55 : 0.8), holdUsed ? 0.35 : 1);
  drawPanel(L.next, 'NEXT');
  if (L.compact) {
    if (queue[0]) drawPreview(queue[0], L.next.x + L.next.w / 2, L.next.y + L.next.h / 2 + c * 0.4, c * 0.55);
    const s = L.stats, cx = s.x + s.w / 2;
    text(String(score), cx, s.y + c * 1.1, val * 1.2, '#fff', 'center', 900, s.w);
    text(`LV ${level} · LINES ${lines}`, cx, s.y + c * 2.3, lab, 'rgba(255,255,255,0.75)', 'center', 700, s.w);
    text(`BEST ${Math.max(best, score)}`, cx, s.y + c * 3.2, lab, 'rgba(255,255,255,0.55)', 'center', 700, s.w);
  } else {
    queue.slice(0, 5).forEach((t, i) => drawPreview(t, L.next.x + L.next.w / 2, L.next.y + c * 2.4 + i * c * 2.5, c * (i ? 0.6 : 0.8)));
    drawPanel(L.stats);
    const rows = [['SCORE', score], ['BEST', Math.max(best, score)], ['LEVEL', level], ['LINES', lines]];
    rows.forEach(([k, v], i) => {
      const y = L.stats.y + c * (0.8 + i * 1.8);
      text(k, L.stats.x + L.stats.w / 2, y, lab, 'rgba(255,255,255,0.6)', 'center', 700);
      text(String(v), L.stats.x + L.stats.w / 2, y + c * 0.75, val, '#fff', 'center', 900, L.stats.w - 8);
    });
  }
}

function overlay(lines, extra = 0) {
  ctx.fillStyle = 'rgba(8,4,24,0.65)';
  ctx.fillRect(0, 0, W, H);
  let y = H / 2 - (lines.length - 1) * 22 - extra / 2;
  for (const [str, size, color] of lines) {
    text(str, W / 2, y, size, color, 'center', 800, W - 24);
    y += size + 18;
  }
  return y;
}

// Mode buttons; tapping one picks that mode and starts the game.
function drawModes(y) {
  const gap = 12, w = Math.min(170, (W - 32 - 2 * gap) / 3), h = 50;
  const names = [['jelly', '果冻 Jelly', '#b26bff'], ['gummy', '软糖 Gummy', '#ff38b4'], ['water', '水 Water', '#2f8fd0']];
  modeRects = names.map(([m, label, color], i) => {
    const r = { mode: m, x: W / 2 - 1.5 * w - gap + i * (w + gap), y, w, h };
    const on = mode === m;
    ctx.fillStyle = on ? color + '55' : 'rgba(255,255,255,0.08)';
    ctx.strokeStyle = on ? '#5dff9c' : 'rgba(255,255,255,0.3)';
    ctx.lineWidth = on ? 3 : 1.5;
    ctx.beginPath();
    ctx.roundRect(r.x, r.y, w, h, 14);
    ctx.fill();
    ctx.stroke();
    text(label, r.x + w / 2, r.y + h / 2, Math.min(20, w / 7), '#fff', 'center', 800, w - 12);
    return r;
  });
  return y + h;
}

function draw() {
  L = layout();
  ctx.drawImage(sky, 0, 0, W, H);
  drawBoard();
  drawSide();

  const small = Math.min(16, W / 28);
  modeRects = [];
  modeBtn = null;
  if (state === 'menu') {
    const y = overlay([
      ['JELLY TETRIS', Math.min(72, W / 8), '#ff7a8a'],
      ['← → move   ↑ rotate   ↓ soft drop', small, '#fff'],
      ['Space hard drop   C hold   P pause   G / 1 2 3 mode', small, '#fff'],
      ['Touch: drag to move, tap to rotate, flick ↓ drop, ↑ hold', small, '#ffd23f'],
    ], 110);
    const y2 = drawModes(y);
    text('Tap a mode to start, or press Space', W / 2, y2 + 32, small + 2, '#5dff9c', 'center', 800, W - 24);
  } else if (state === 'over') {
    const y = overlay([
      ['GAME OVER', Math.min(64, W / 7), '#ff4d5e'],
      [`Score ${score}`, 28, '#fff'],
      [score >= best && score > 0 ? 'New best!' : `Best ${best}`, 18, '#ffd23f'],
    ], 110);
    const y2 = drawModes(y);
    text('Tap a mode to play again, or press Space', W / 2, y2 + 32, small + 2, '#5dff9c', 'center', 800, W - 24);
  } else if (paused) {
    overlay([['PAUSED', 44, '#fff'], ['Click or press P to resume', small, 'rgba(255,255,255,0.8)']]);
  }

  // In-play mode switch button: a small pill in the top-right corner so touch
  // users can switch modes without a keyboard. Tapping it cycles to the next mode.
  if (state === 'play' && !paused) {
    const bw = 96, bh = 28, bx = W - bw - 8, by = 6;
    modeBtn = { x: bx, y: by, w: bw, h: bh };
    const colors = { jelly: '#b26bff', gummy: '#ff38b4', water: '#2f8fd0' };
    const labels = { jelly: '果冻', gummy: '软糖', water: '水' };
    ctx.fillStyle = (colors[mode] || '#888') + 'cc';
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.roundRect(bx, by, bw, bh, 14);
    ctx.fill();
    ctx.stroke();
    text(`🔄 ${labels[mode] || mode}`, bx + bw / 2, by + bh / 2, Math.min(13, bw / 8), '#fff', 'center', 700, bw - 8);
  }
}

// ---- Loop ----
let last = performance.now();
function frame(now) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  if (!paused) update(dt);
  draw();
  requestAnimationFrame(frame);
}

board = Array.from({ length: ROWS + HIDDEN }, emptyRow);
resize();
requestAnimationFrame(frame);
