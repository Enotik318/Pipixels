const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 3000;
const N = 50;
const COOLDOWN_MS = 2000;
const TOKEN_TTL_MS = 1000 * 60 * 60 * 24 * 30; // 30 days
const DATA_DIR = path.join(__dirname, "data");
const USERS_FILE = path.join(DATA_DIR, "users.json");
const CANVAS_FILE = path.join(DATA_DIR, "canvas.json");

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function readJSON(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJSON(file, value) {
  fs.writeFileSync(file, JSON.stringify(value), "utf8");
}

/** @type {{users: Record<string, any>, tokens: Record<string, any>}} */
let store = readJSON(USERS_FILE, { users: {}, tokens: {} });
/** @type {Record<string, string>} */
let canvas = readJSON(CANVAS_FILE, {});

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

function getUserFromReq(req) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
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
  const day = new Date().toISOString().slice(0, 10);
  return {
    nick,
    since: user.since || 0,
    stats: {
      n: stats.n || 0,
      today: (stats.days && stats.days[day]) || 0,
      last: stats.last || 0,
    },
  };
}

const app = express();
app.use(cors());
app.use(express.json({ limit: "32kb" }));
app.use(express.static(path.join(__dirname, "public")));

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, size: N, pixels: Object.keys(canvas).length });
});

app.get("/api/canvas", (_req, res) => {
  res.json({ n: N, pixels: canvas });
});

app.post("/api/register", (req, res) => {
  let nick = String(req.body?.nick || "").trim();
  const pass = String(req.body?.pass || "");

  if (nick.length < 2 || nick.length > 16) {
    return res.status(400).json({ error: "Ник: 2–16 символов" });
  }
  if (!/^[a-zA-Zа-яА-ЯёЁ0-9_]+$/.test(nick)) {
    return res.status(400).json({ error: "Только буквы, цифры и _" });
  }
  if (pass.length < 4) {
    return res.status(400).json({ error: "Пароль от 4 символов" });
  }

  const taken = Object.keys(store.users).some(
    (k) => k.toLowerCase() === nick.toLowerCase()
  );
  if (taken) return res.status(409).json({ error: "Ник занят" });

  const salt = crypto.randomBytes(8).toString("hex");
  store.users[nick] = {
    hash: hashPass(salt, pass),
    salt,
    since: Date.now(),
    stats: { n: 0, days: {}, last: 0 },
    lastPlace: 0,
  };

  const token = makeToken();
  store.tokens[token] = { nick, exp: Date.now() + TOKEN_TTL_MS };
  saveUsers();

  res.json({ token, user: publicUser(nick, store.users[nick]) });
});

app.post("/api/login", (req, res) => {
  const nickIn = String(req.body?.nick || "").trim();
  const pass = String(req.body?.pass || "");

  let found = null;
  for (const k of Object.keys(store.users)) {
    if (k.toLowerCase() === nickIn.toLowerCase()) {
      found = k;
      break;
    }
  }
  if (!found) return res.status(401).json({ error: "Неверный ник или пароль" });

  const user = store.users[found];
  if (hashPass(user.salt, pass) !== user.hash) {
    return res.status(401).json({ error: "Неверный ник или пароль" });
  }

  const token = makeToken();
  store.tokens[token] = { nick: found, exp: Date.now() + TOKEN_TTL_MS };
  saveUsers();
  res.json({ token, user: publicUser(found, user) });
});

app.get("/api/me", (req, res) => {
  const session = getUserFromReq(req);
  if (!session) return res.status(401).json({ error: "Нужен вход" });
  res.json({ user: publicUser(session.nick, session.user) });
});

app.post("/api/logout", (req, res) => {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (token && store.tokens[token]) {
    delete store.tokens[token];
    saveUsers();
  }
  res.json({ ok: true });
});

app.post("/api/pixel", (req, res) => {
  const session = getUserFromReq(req);
  if (!session) return res.status(401).json({ error: "Нужен аккаунт, чтобы ставить пиксели" });

  const x = Number(req.body?.x);
  const y = Number(req.body?.y);
  let color = String(req.body?.color || "").toLowerCase();

  if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= N || y >= N) {
    return res.status(400).json({ error: "Неверные координаты" });
  }
  if (!/^#[0-9a-f]{6}$/.test(color)) {
    return res.status(400).json({ error: "Неверный цвет" });
  }

  const now = Date.now();
  const wait = COOLDOWN_MS - (now - (session.user.lastPlace || 0));
  if (wait > 0) {
    return res.status(429).json({ error: "Кулдаун", wait });
  }

  const key = x + "," + y;
  if (canvas[key] === color) {
    return res.json({ ok: true, unchanged: true, pixels: canvas });
  }

  canvas[key] = color;
  session.user.lastPlace = now;

  const day = new Date().toISOString().slice(0, 10);
  if (!session.user.stats) session.user.stats = { n: 0, days: {}, last: 0 };
  session.user.stats.n = (session.user.stats.n || 0) + 1;
  session.user.stats.days = session.user.stats.days || {};
  session.user.stats.days[day] = (session.user.stats.days[day] || 0) + 1;
  session.user.stats.last = now;

  saveCanvas();
  saveUsers();

  res.json({
    ok: true,
    x,
    y,
    color,
    by: session.nick,
    pixels: canvas,
    user: publicUser(session.nick, session.user),
  });
});

// SPA-ish fallback for known pages
app.get(["/", "/index.html", "/profile.html"], (req, res, next) => {
  next();
});

app.listen(PORT, () => {
  console.log(`[pixel-battle] ${N}x${N} on http://127.0.0.1:${PORT}`);
  console.log(`[pixel-battle] pixels: ${Object.keys(canvas).length}`);
});
