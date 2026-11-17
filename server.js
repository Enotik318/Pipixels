const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const PORT = Number(process.env.PORT) || 3000;
const HOST = "0.0.0.0";
const W = 250;
const H = 250;
const COOLDOWN_MS = 1200;
const TOKEN_TTL_MS = 1000 * 60 * 60 * 24 * 30;
const ONLINE_MS = 1000 * 60 * 2;
const MAX_REG_PER_IP_HOUR = 15;
const BASE_STAMINA = 30;
const BASE_REGEN_MS = 25000;
const XP_PER_PIXEL = 12;

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const USERS_FILE = path.join(DATA_DIR, "users.json");
const CANVAS_FILE = path.join(DATA_DIR, "canvas.json");

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const LEGACY_DATA_DIR = path.join(__dirname, "data");
if (path.resolve(LEGACY_DATA_DIR) !== path.resolve(DATA_DIR)) {
  for (const name of ["users.json", "canvas.json"]) {
    const oldFile = path.join(LEGACY_DATA_DIR, name);
    const newFile = path.join(DATA_DIR, name);
    if (fs.existsSync(oldFile) && !fs.existsSync(newFile)) {
      fs.copyFileSync(oldFile, newFile);
    }
  }
}

function readJSON(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    const raw = fs.readFileSync(file, "utf8");
    return raw ? JSON.parse(raw) : fallback;
  } catch (err) {
    console.error("[readJSON]", file, err.message);
    return fallback;
  }
}

function writeJSON(file, value) {
  try {
    const temp = file + ".tmp";
    fs.writeFileSync(temp, JSON.stringify(value), "utf8");
    fs.renameSync(temp, file);
  } catch (err) {
    console.error("[writeJSON]", file, err.message);
  }
}

let store = readJSON(USERS_FILE, { users: {}, tokens: {} });
if (!store || typeof store !== "object") store = { users: {}, tokens: {} };
if (!store.users) store.users = {};
if (!store.tokens) store.tokens = {};

let canvas = readJSON(CANVAS_FILE, {});
if (!canvas || typeof canvas !== "object") canvas = {};

const presence = {};
const regByIp = {};

function saveUsers() {
  writeJSON(USERS_FILE, store);
}

function saveCanvas() {
  writeJSON(CANVAS_FILE, canvas);
}

function sha256(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
}

function hashPass(salt, pass) {
  return sha256(salt + ":" + pass);
}

function makeToken() {
  return crypto.randomBytes(24).toString("hex");
}

function dayKey() {
  return new Date().toISOString().slice(0, 10);
}

function clientIp(req) {
  const xf = req.headers["x-forwarded-for"];
  if (typeof xf === "string" && xf.length > 0) {
    return xf.split(",")[0].trim();
  }
  return req.socket.remoteAddress || "unknown";
}

function levelFromXp(xp) {
  xp = Math.max(0, Number(xp) || 0);
  return Math.floor(Math.sqrt(xp / 50)) + 1;
}

function xpToNext(level) {
  const L = Math.max(1, level);
  const need = 50 * L * L;
  const prev = 50 * (L - 1) * (L - 1);
  return { need, prev, into: need - prev };
}

function maxStamina(level) {
  return BASE_STAMINA + Math.max(0, level - 1) * 3;
}

function regenMs(level) {
  return Math.max(12000, BASE_REGEN_MS - Math.max(0, level - 1) * 800);
}

function ensureProgress(user) {
  if (!user.progress) {
    user.progress = {
      xp: 0,
      stamina: BASE_STAMINA,
      staminaUpdatedAt: Date.now(),
    };
  }
  if (typeof user.progress.xp !== "number") user.progress.xp = 0;
  if (typeof user.progress.stamina !== "number") user.progress.stamina = BASE_STAMINA;
  if (typeof user.progress.staminaUpdatedAt !== "number") {
    user.progress.staminaUpdatedAt = Date.now();
  }
  return user.progress;
}

function syncStamina(user) {
  const p = ensureProgress(user);
  const level = levelFromXp(p.xp);
  const max = maxStamina(level);
  const regen = regenMs(level);
  const now = Date.now();
  if (p.stamina < max) {
    const gained = Math.floor((now - p.staminaUpdatedAt) / regen);
    if (gained > 0) {
      p.stamina = Math.min(max, p.stamina + gained);
      p.staminaUpdatedAt += gained * regen;
    }
  } else {
    p.stamina = max;
    p.staminaUpdatedAt = now;
  }
  const nextIn = p.stamina >= max ? 0 : Math.max(0, regen - (now - p.staminaUpdatedAt));
  return {
    level,
    xp: p.xp,
    stamina: p.stamina,
    staminaMax: max,
    regenMs: regen,
    nextIn,
    ...xpToNext(level),
  };
}

function cleanTokens() {
  const now = Date.now();
  let changed = false;
  for (const [t, info] of Object.entries(store.tokens)) {
    if (!info || info.exp < now) {
      delete store.tokens[t];
      changed = true;
    }
  }
  if (changed) saveUsers();
}

function touchPresence(nick) {
  if (nick) presence[nick] = Date.now();
}

function onlineCount() {
  const now = Date.now();
  let n = 0;
  for (const [nick, ts] of Object.entries(presence)) {
    if (now - ts <= ONLINE_MS) n += 1;
    else delete presence[nick];
  }
  return n;
}

function getUserFromReq(req) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!token) return null;
  cleanTokens();
  const info = store.tokens[token];
  if (!info || info.exp < Date.now()) return null;
  const user = store.users[info.nick];
  if (!user) return null;
  return { nick: info.nick, user, token };
}

function publicUser(nick, user) {
  const stats = user.stats || { n: 0, days: {}, last: 0 };
  const day = dayKey();
  const prog = syncStamina(user);
  return {
    nick,
    since: user.since || 0,
    avatar: user.avatar || "",
    stats: {
      n: stats.n || 0,
      today: (stats.days && stats.days[day]) || 0,
      last: stats.last || 0,
    },
    progress: prog,
  };
}

function normalizeCell(val) {
  if (!val) return null;
  if (typeof val === "string") return { color: val.toLowerCase(), by: "", at: 0 };
  if (typeof val === "object" && val.color) {
    return {
      color: String(val.color).toLowerCase(),
      by: String(val.by || ""),
      at: Number(val.at || 0),
    };
  }
  return null;
}

function badNick(nick) {
  const low = nick.toLowerCase();
  if (/^\d+$/.test(nick)) return "Ник не может состоять только из цифр";
  if (/(.)\1{4,}/i.test(nick)) return "Слишком много одинаковых символов подряд";
  const banned = ["admin", "moderator", "moder", "owner", "system"];
  for (const w of banned) {
    if (low.includes(w)) return "Такой ник зарезервирован";
  }
  return "";
}

const app = express();
app.set("trust proxy", 1);
app.use(cors());
app.use(express.json({ limit: "512kb" }));

// Блокируем прямой доступ к исходникам и базе пользователей
app.use((req, res, next) => {
  const p = req.path.toLowerCase();
  if (
    p.startsWith("/data") ||
    p === "/server.js" ||
    p === "/package.json" ||
    p === "/package-lock.json" ||
    p.endsWith(".json") && !p.startsWith("/api/")
  ) {
    return res.status(404).end();
  }
  next();
});

app.use(express.static(__dirname, { index: "index.html" }));

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    w: W,
    h: H,
    pixels: Object.keys(canvas).length,
    online: onlineCount(),
    ts: Date.now(),
  });
});

app.get("/api/canvas", (req, res) => {
  const session = getUserFromReq(req);
  if (session) touchPresence(session.nick);
  res.json({
    w: W,
    h: H,
    pixels: canvas,
    online: onlineCount(),
    painted: Object.keys(canvas).length,
  });
});

app.post("/api/register", (req, res) => {
  const nick = String(req.body?.nick || "").trim();
  const pass = String(req.body?.pass || "");

  if (nick.length < 3 || nick.length > 16) {
    return res.status(400).json({ error: "Ник должен быть от 3 до 16 символов" });
  }
  if (!/^[a-zA-Zа-яА-ЯёЁ0-9_]+$/.test(nick)) {
    return res.status(400).json({ error: "Только латиница, кириллица, цифры и _" });
  }
  const nickErr = badNick(nick);
  if (nickErr) return res.status(400).json({ error: nickErr });

  if (pass.length < 4) {
    return res.status(400).json({ error: "Пароль минимум 4 символа" });
  }

  const ip = clientIp(req);
  const now = Date.now();
  regByIp[ip] = (regByIp[ip] || []).filter((t) => now - t < 60 * 60 * 1000);
  if (regByIp[ip].length >= MAX_REG_PER_IP_HOUR) {
    return res.status(429).json({ error: "Слишком много регистраций, попробуйте позже" });
  }

  const taken = Object.keys(store.users).some((k) => k.toLowerCase() === nick.toLowerCase());
  if (taken) {
    return res.status(409).json({ error: "Этот ник уже занят" });
  }

  const salt = crypto.randomBytes(8).toString("hex");
  store.users[nick] = {
    hash: hashPass(salt, pass),
    salt,
    since: now,
    avatar: "",
    stats: { n: 0, days: {}, last: 0 },
    lastPlace: 0,
    progress: { xp: 0, stamina: BASE_STAMINA, staminaUpdatedAt: now },
  };
  regByIp[ip].push(now);

  const token = makeToken();
  store.tokens[token] = { nick, exp: now + TOKEN_TTL_MS };
  saveUsers();
  touchPresence(nick);

  res.json({ token, user: publicUser(nick, store.users[nick]) });
});

app.post("/api/login", (req, res) => {
  const nickIn = String(req.body?.nick || "").trim();
  const pass = String(req.body?.pass || "");

  if (!nickIn || !pass) {
    return res.status(400).json({ error: "Введите ник и пароль" });
  }

  let found = null;
  for (const k of Object.keys(store.users)) {
    if (k.toLowerCase() === nickIn.toLowerCase()) {
      found = k;
      break;
    }
  }
  if (!found) {
    return res.status(401).json({ error: "Неверный ник или пароль" });
  }

  const user = store.users[found];
  if (hashPass(user.salt, pass) !== user.hash) {
    return res.status(401).json({ error: "Неверный ник или пароль" });
  }

  const token = makeToken();
  store.tokens[token] = { nick: found, exp: Date.now() + TOKEN_TTL_MS };
  saveUsers();
  touchPresence(found);

  res.json({ token, user: publicUser(found, user) });
});

app.get("/api/me", (req, res) => {
  const session = getUserFromReq(req);
  if (!session) return res.status(401).json({ error: "Нужен вход" });
  touchPresence(session.nick);
  const userPayload = publicUser(session.nick, session.user);
  saveUsers();
  res.json({ user: userPayload });
});

app.post("/api/logout", (req, res) => {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (token && store.tokens[token]) {
    const nick = store.tokens[token].nick;
    delete store.tokens[token];
    if (nick) delete presence[nick];
    saveUsers();
  }
  res.json({ ok: true });
});

app.post("/api/avatar", (req, res) => {
  const session = getUserFromReq(req);
  if (!session) return res.status(401).json({ error: "Нужен вход" });
  const avatar = String(req.body?.avatar || "");
  if (avatar && !avatar.startsWith("data:image/")) {
    return res.status(400).json({ error: "Нужна картинка (data URL)" });
  }
  if (avatar.length > 400000) {
    return res.status(400).json({ error: "Картинка слишком большая" });
  }
  session.user.avatar = avatar;
  saveUsers();
  touchPresence(session.nick);
  res.json({ user: publicUser(session.nick, session.user) });
});

app.post("/api/pixel", (req, res) => {
  const session = getUserFromReq(req);
  if (!session) {
    return res.status(401).json({ error: "Нужен аккаунт, чтобы ставить пиксели" });
  }

  const x = Number(req.body?.x);
  const y = Number(req.body?.y);
  const color = String(req.body?.color || "").toLowerCase();

  if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= W || y >= H) {
    return res.status(400).json({ error: "Неверные координаты" });
  }
  if (!/^#[0-9a-f]{6}$/.test(color)) {
    return res.status(400).json({ error: "Неверный цвет" });
  }

  const key = x + "," + y;
  const prev = normalizeCell(canvas[key]);
  const currentColor = prev ? prev.color : "#ffffff";

  if (currentColor === color) {
    return res.json({
      ok: true,
      unchanged: true,
      pixels: canvas,
      online: onlineCount(),
      user: publicUser(session.nick, session.user),
    });
  }

  const now = Date.now();
  const waitCd = COOLDOWN_MS - (now - (session.user.lastPlace || 0));
  if (waitCd > 0) {
    return res.status(429).json({ error: "Кулдаун", wait: waitCd });
  }

  const prog = syncStamina(session.user);
  if (prog.stamina < 1) {
    return res.status(429).json({
      error: "Нет стамины",
      wait: prog.nextIn,
      user: publicUser(session.nick, session.user),
    });
  }

  const p = ensureProgress(session.user);
  p.stamina = Math.max(0, prog.stamina - 1);
  p.staminaUpdatedAt = now;
  p.xp = (p.xp || 0) + XP_PER_PIXEL;

  canvas[key] = { color, by: session.nick, at: now };
  session.user.lastPlace = now;

  const day = dayKey();
  if (!session.user.stats) session.user.stats = { n: 0, days: {}, last: 0 };
  session.user.stats.days = session.user.stats.days || {};
  session.user.stats.n = (session.user.stats.n || 0) + 1;
  session.user.stats.days[day] = (session.user.stats.days[day] || 0) + 1;
  session.user.stats.last = now;

  saveCanvas();
  saveUsers();
  touchPresence(session.nick);

  res.json({
    ok: true,
    x,
    y,
    color,
    by: session.nick,
    pixels: canvas,
    online: onlineCount(),
    user: publicUser(session.nick, session.user),
  });
});

app.get("/favicon.svg", (_req, res) => {
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16">' +
    '<rect width="16" height="16" rx="4" fill="#111115"/>' +
    '<rect x="3" y="3" width="5" height="5" fill="#ff3b4e"/>' +
    '<rect x="8" y="3" width="5" height="5" fill="#ffc62e"/>' +
    '<rect x="3" y="8" width="5" height="5" fill="#38a3ff"/>' +
    '<rect x="8" y="8" width="5" height="5" fill="#2dce89"/>' +
    "</svg>";
  res.type("image/svg+xml").send(svg);
});

app.listen(PORT, HOST, () => {
  console.log(`[pixel-battle] ${W}x${H} listening on http://${HOST}:${PORT}`);
  console.log(`[pixel-battle] data dir: ${DATA_DIR}, pixels: ${Object.keys(canvas).length}`);
});