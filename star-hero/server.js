"use strict";

// Static file server plus a small JSON API with families and member accounts.
// A family owns one game state (data/states/<familyId>.json); every member of the
// family (爸爸, 妈妈, ...) logs in with their own account and shares that state.
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const PORT = Number(process.env.PORT) || 8080;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const USERS_FILE = path.join(DATA_DIR, "users.json");
const FAMILIES_FILE = path.join(DATA_DIR, "families.json");
const SESSIONS_FILE = path.join(DATA_DIR, "sessions.json");
const STATES_DIR = path.join(DATA_DIR, "states");
const SESSION_DAYS = 30;
const COOKIE = "sid";
const MAX_BODY = 5 * 1024 * 1024; // task images are stored inside the state
const STATIC = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/index.html": ["index.html", "text/html; charset=utf-8"],
  "/style.css": ["style.css", "text/css; charset=utf-8"],
  "/app.js": ["app.js", "text/javascript; charset=utf-8"],
};

/* ---------------- files ---------------- */

function readFile(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
}

function readFileBuffer(file) {
  try {
    return fs.readFileSync(file);
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
}

function readJson(file, fallback) {
  const text = readFile(file);
  return text === null ? fallback : JSON.parse(text);
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file); // atomic replace, so a crash never leaves half a file
}

const stateFile = (familyId) => path.join(STATES_DIR, `${familyId}.json`);

/* ---------------- accounts & sessions ---------------- */

// users.json:    { "<lowercased username>": { id, username, role, familyId, salt, hash, createdAt } }
// families.json: { "<familyId>": { id, name, createdAt } }
function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString("hex");
}

function passwordMatches(user, password) {
  const actual = Buffer.from(hashPassword(password, user.salt), "hex");
  return crypto.timingSafeEqual(actual, Buffer.from(user.hash, "hex"));
}

function newUser(creds, role, familyId) {
  const salt = crypto.randomBytes(16).toString("hex");
  return {
    id: crypto.randomUUID(),
    username: creds.username,
    role,
    familyId,
    salt,
    hash: hashPassword(creds.password, salt),
    createdAt: new Date().toISOString(),
  };
}

// sessions.json: { "<sha256 of token>": { userId, expires } }. Only hashes are stored on disk.
const tokenKey = (token) => crypto.createHash("sha256").update(token).digest("hex");

function createSession(userId) {
  const token = crypto.randomBytes(32).toString("base64url");
  const now = Date.now();
  const sessions = readJson(SESSIONS_FILE, {});
  for (const [k, s] of Object.entries(sessions)) if (s.expires < now) delete sessions[k];
  sessions[tokenKey(token)] = { userId, expires: now + SESSION_DAYS * 86400e3 };
  writeJson(SESSIONS_FILE, sessions);
  return token;
}

function deleteSessions(match) {
  const sessions = readJson(SESSIONS_FILE, {});
  for (const [k, s] of Object.entries(sessions)) if (match(k, s)) delete sessions[k];
  writeJson(SESSIONS_FILE, sessions);
}

function cookieToken(req) {
  const match = (req.headers.cookie || "").match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`));
  return match ? match[1] : null;
}

function currentUser(req) {
  const token = cookieToken(req);
  if (!token) return null;
  const session = readJson(SESSIONS_FILE, {})[tokenKey(token)];
  if (!session || session.expires < Date.now()) return null;
  return Object.values(readJson(USERS_FILE, {})).find((u) => u.id === session.userId) || null;
}

function sessionCookie(req, token, maxAge) {
  // Behind the HTTPS portal the cookie is Secure; plain localhost testing still works.
  const secure = req.headers["x-forwarded-proto"] === "https" ? "; Secure" : "";
  return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

function loginResponse(req, res, user) {
  const token = createSession(user.id);
  return sendJson(res, 200, profile(user), { "Set-Cookie": sessionCookie(req, token, SESSION_DAYS * 86400) });
}

function familyMembers(familyId) {
  return Object.values(readJson(USERS_FILE, {}))
    .filter((u) => u.familyId === familyId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

// The family's first account (whoever created the family) is its admin.
const isAdmin = (user) => familyMembers(user.familyId)[0]?.id === user.id;

function profile(user) {
  const family = readJson(FAMILIES_FILE, {})[user.familyId];
  return { username: user.username, role: user.role, admin: isAdmin(user), family: { name: family?.name || "" } };
}

/* ---------------- validation ---------------- */

const badRequest = (message) => Object.assign(new Error(message), { status: 400 });

function text(value, min, max, message) {
  const s = typeof value === "string" ? value.trim() : "";
  if (s.length < min || s.length > max) throw badRequest(message);
  return s;
}

function credentials(body) {
  const username = text(body.username, 2, 20, "用户名需要 2–20 个字，不能有空格");
  if (/\s/.test(username)) throw badRequest("用户名需要 2–20 个字，不能有空格");
  const password = typeof body.password === "string" ? body.password : "";
  if (password.length < 6 || password.length > 100) throw badRequest("密码至少 6 位");
  return { username, password };
}

const role = (body) => text(body.role, 1, 10, "请填写身份，比如爸爸、妈妈");

function isValidState(s) {
  return (
    s !== null &&
    typeof s === "object" &&
    !Array.isArray(s) &&
    Array.isArray(s.tasks) &&
    Array.isArray(s.rewards) &&
    Number.isFinite(s.balance)
  );
}

/* ---------------- http helpers ---------------- */

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size <= MAX_BODY) chunks.push(c);
    });
    req.on("end", () => {
      if (size > MAX_BODY) reject(Object.assign(new Error("文件太大了"), { status: 413 }));
      else resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", reject);
  });
}

async function readJsonBody(req) {
  const body = await readBody(req);
  try {
    return JSON.parse(body);
  } catch {
    throw badRequest("不是有效的 JSON 文件");
  }
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, { "Cache-Control": "no-store", ...headers });
  res.end(body);
}

function sendJson(res, status, obj, headers = {}) {
  send(res, status, JSON.stringify(obj), { "Content-Type": "application/json; charset=utf-8", ...headers });
}

/* ---------------- routes: accounts ---------------- */

async function handlePublic(req, res, pathname) {
  // Create a family together with its first member account, then log that member in.
  if (pathname === "/api/families" && req.method === "POST") {
    const body = await readJsonBody(req);
    const familyName = text(body.familyName, 1, 20, "请填写家庭名称");
    const creds = credentials(body);
    const memberRole = role(body);
    const users = readJson(USERS_FILE, {});
    if (users[creds.username.toLowerCase()]) return sendJson(res, 409, { error: "这个用户名已经被注册了" });

    const families = readJson(FAMILIES_FILE, {});
    const family = { id: crypto.randomUUID(), name: familyName, createdAt: new Date().toISOString() };
    families[family.id] = family;
    writeJson(FAMILIES_FILE, families);
    const user = newUser(creds, memberRole, family.id);
    users[creds.username.toLowerCase()] = user;
    writeJson(USERS_FILE, users);
    return loginResponse(req, res, user);
  }

  if (pathname === "/api/login" && req.method === "POST") {
    const creds = credentials(await readJsonBody(req));
    const user = readJson(USERS_FILE, {})[creds.username.toLowerCase()];
    if (!user || !passwordMatches(user, creds.password)) return sendJson(res, 401, { error: "用户名或密码不对" });
    return loginResponse(req, res, user);
  }

  if (pathname === "/api/logout" && req.method === "POST") {
    const token = cookieToken(req);
    if (token) deleteSessions((k) => k === tokenKey(token));
    return sendJson(res, 200, { ok: true }, { "Set-Cookie": sessionCookie(req, "", 0) });
  }

  return false;
}

async function handleFamily(req, res, pathname, user) {
  if (pathname === "/api/me" && req.method === "GET") return sendJson(res, 200, profile(user));

  // Change your own password. Other devices logged in to this account are logged out.
  if (pathname === "/api/password" && req.method === "POST") {
    const body = await readJsonBody(req);
    const oldPw = typeof body.oldPassword === "string" ? body.oldPassword : "";
    const newPw = typeof body.newPassword === "string" ? body.newPassword : "";
    if (newPw.length < 6 || newPw.length > 100) throw badRequest("新密码至少 6 位");
    const users = readJson(USERS_FILE, {});
    const me = users[user.username.toLowerCase()];
    if (!passwordMatches(me, oldPw)) return sendJson(res, 400, { error: "当前密码不对" });
    me.salt = crypto.randomBytes(16).toString("hex");
    me.hash = hashPassword(newPw, me.salt);
    writeJson(USERS_FILE, users);
    const current = tokenKey(cookieToken(req));
    deleteSessions((k, s) => s.userId === user.id && k !== current);
    return sendJson(res, 200, { ok: true });
  }

  if (pathname === "/api/family" && req.method === "GET") {
    const members = familyMembers(user.familyId).map((u, i) => ({ username: u.username, role: u.role, me: u.id === user.id, admin: i === 0 }));
    return sendJson(res, 200, { ...profile(user).family, members });
  }

  // Only the family admin can add another member (妈妈, 爷爷, ...) to the family.
  if (pathname === "/api/family/members" && req.method === "POST") {
    if (!isAdmin(user)) return sendJson(res, 403, { error: "只有管理员可以添加家庭成员" });
    const body = await readJsonBody(req);
    const creds = credentials(body);
    const memberRole = role(body);
    const users = readJson(USERS_FILE, {});
    if (users[creds.username.toLowerCase()]) return sendJson(res, 409, { error: "这个用户名已经被注册了" });
    users[creds.username.toLowerCase()] = newUser(creds, memberRole, user.familyId);
    writeJson(USERS_FILE, users);
    return sendJson(res, 200, { ok: true });
  }

  const remove = pathname.match(/^\/api\/family\/members\/([^/]+)$/);
  if (remove && req.method === "DELETE") {
    if (!isAdmin(user)) return sendJson(res, 403, { error: "只有管理员可以移除家庭成员" });
    const key = decodeURIComponent(remove[1]).toLowerCase();
    const users = readJson(USERS_FILE, {});
    const target = users[key];
    if (!target || target.familyId !== user.familyId) return sendJson(res, 404, { error: "没有这个家庭成员" });
    if (target.id === user.id) return sendJson(res, 400, { error: "不能移除自己" });
    delete users[key];
    writeJson(USERS_FILE, users);
    deleteSessions((_, s) => s.userId === target.id); // log the removed member out everywhere
    return sendJson(res, 200, { ok: true });
  }

  return false;
}

/* ---------------- routes: game data ---------------- */

// Every save carries the revision it was based on. If another family member saved in the
// meantime, the save is rejected with 409 and the latest state, instead of overwriting it.
async function saveState(req, res, user, { force = false } = {}) {
  const state = await readJsonBody(req);
  if (!isValidState(state)) return sendJson(res, 400, { error: "文件内容不是星星小勇士的数据" });
  const current = readJson(stateFile(user.familyId), null);
  const currentRev = current?.rev || 0;
  if (!force && (state.rev || 0) !== currentRev) return sendJson(res, 409, current);
  state.rev = currentRev + 1;
  writeJson(stateFile(user.familyId), state);
  sendJson(res, 200, state);
}

async function handleData(req, res, pathname, user) {
  if (pathname === "/api/state") {
    if (req.method === "GET") {
      const saved = readFile(stateFile(user.familyId));
      return saved ? send(res, 200, saved, { "Content-Type": "application/json; charset=utf-8" }) : send(res, 204, "");
    }
    // POST is accepted too so the browser can flush with navigator.sendBeacon when the page closes.
    if (req.method === "PUT" || req.method === "POST") return saveState(req, res, user);
  }

  if (pathname === "/api/export" && req.method === "GET") {
    const day = new Date().toISOString().slice(0, 10);
    return send(res, 200, readFile(stateFile(user.familyId)) || "{}", {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="star-hero-${day}.json"`,
    });
  }

  // Uploading a backup deliberately replaces whatever is there.
  if (pathname === "/api/import" && req.method === "POST") return saveState(req, res, user, { force: true });

  return false;
}

const server = http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url, "http://localhost");
  try {
    if (pathname.startsWith("/api/")) {
      if ((await handlePublic(req, res, pathname)) !== false) return;
      const user = currentUser(req);
      if (!user) return sendJson(res, 401, { error: "请先登录" });
      if ((await handleFamily(req, res, pathname, user)) !== false) return;
      if ((await handleData(req, res, pathname, user)) !== false) return;
      return send(res, 404, "Not found");
    }

    const file = STATIC[pathname];
    if (file && req.method === "GET") {
      return send(res, 200, fs.readFileSync(path.join(__dirname, file[0])), { "Content-Type": file[1] });
    }
    // Task celebration illustrations; the pattern keeps requests inside assets/anim.
    if (/^\/assets\/anim\/[a-z]+\.webp$/.test(pathname) && req.method === "GET") {
      const img = readFileBuffer(path.join(__dirname, pathname));
      if (img) return send(res, 200, img, { "Content-Type": "image/webp", "Cache-Control": "public, max-age=86400" });
    }
    send(res, 404, "Not found");
  } catch (err) {
    if (err.status) return sendJson(res, err.status, { error: err.message });
    console.error(err);
    sendJson(res, 500, { error: "服务器出错了" });
  }
});

server.listen(PORT, () => console.log(`星星小勇士 running on http://localhost:${PORT} (data: ${DATA_DIR})`));
