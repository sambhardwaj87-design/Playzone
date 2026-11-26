const express = require("express");
const { Pool, types } = require("pg");
types.setTypeParser(20, value => Number(value));
const crypto = require("node:crypto");
const path = require("node:path");

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required (Neon PostgreSQL).");
if (process.env.NODE_ENV === "production" && (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32)) {
  throw new Error("Set SESSION_SECRET to at least 32 characters in production.");
}
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 5, idleTimeoutMillis: 10000, connectionTimeoutMillis: 10000 });
const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "20kb" }));
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Content-Security-Policy", "default-src 'self'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'");
  if (req.path.startsWith("/api/")) res.setHeader("Cache-Control", "no-store");
  next();
});
const attempts = new Map();
function throttle(max, windowMs) {
  return (req, res, next) => {
    const key = req.ip + "|" + req.path, now = Date.now();
    let entry = attempts.get(key);
    if (!entry || now - entry.start >= windowMs) { entry = { start: now, count: 0 }; attempts.set(key, entry); }
    if (++entry.count > max) return res.status(429).json({ error: "Too many attempts. Please wait and try again." });
    next();
  };
}
const cookie = "pz_session";
const hash = s => crypto.createHash("sha256").update(s).digest("hex");
const passwordHash = (p, salt = crypto.randomBytes(16).toString("hex")) => salt + ":" + crypto.scryptSync(p, salt, 64).toString("hex");
function passwordOK(p, stored) {
  if (typeof p !== "string" || typeof stored !== "string") return false;
  const [salt, hex] = stored.split(":");
  if (!salt || !hex) return false;
  const a = crypto.scryptSync(p, salt, 64), b = Buffer.from(hex, "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function getCookie(req) {
  const part = (req.headers.cookie || "").split(";").map(x => x.trim()).find(x => x.startsWith(cookie + "="));
  return part ? decodeURIComponent(part.slice(cookie.length + 1)) : null;
}
function sessionCookie(res, token) {
  res.cookie(cookie, token, { httpOnly: true, sameSite: "strict", secure: process.env.NODE_ENV === "production", path: "/", maxAge: 43200000 });
}
const usernameOK = s => typeof s === "string" && /^[A-Za-z0-9_.-]{3,24}$/.test(s);
const passwordOKFormat = s => typeof s === "string" && s.length >= 10 && s.length <= 200;
const safe = u => ({ id: u.id, username: u.username, displayName: u.display_name, role: u.role, parentId: u.parent_id, balance: u.balance, active: !!u.active });
const roles = (...allowed) => (req, res, next) => allowed.includes(req.user.role) ? next() : res.status(403).json({ error: "Not allowed." });
async function audit(client, actor, from, to, amount, action, note = "") {
  await client.query("INSERT INTO ledger(actor_id,from_user_id,to_user_id,amount,action,note) VALUES($1,$2,$3,$4,$5,$6)",
    [actor, from || null, to || null, amount, action, String(note).slice(0, 160)]);
}
async function inTransaction(fn) {
  const client = await pool.connect();
  try { await client.query("BEGIN"); const result = await fn(client); await client.query("COMMIT"); return result; }
  catch (e) { await client.query("ROLLBACK"); throw e; }
  finally { client.release(); }
}
async function loginSession(id, res) {
  const token = crypto.randomBytes(32).toString("base64url");
  await pool.query("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,$3)", [hash(token), id, Date.now() + 43200000]);
  sessionCookie(res, token);
}
async function adminExists() {
  return (await pool.query("SELECT 1 FROM users WHERE role='admin' LIMIT 1")).rowCount > 0;
}
async function initDatabase() {
  const schema = `
    CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS users(
      id BIGSERIAL PRIMARY KEY, username TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL, password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('admin','master','player')),
      parent_id BIGINT REFERENCES users(id), balance BIGINT NOT NULL DEFAULT 0 CHECK(balance>=0),
      active BOOLEAN NOT NULL DEFAULT TRUE, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS master_limits(
      master_id BIGINT PRIMARY KEY REFERENCES users(id), allocated BIGINT NOT NULL CHECK(allocated>=0),
      available BIGINT NOT NULL CHECK(available>=0 AND available<=allocated)
    );
    CREATE TABLE IF NOT EXISTS ledger(
      id BIGSERIAL PRIMARY KEY, actor_id BIGINT NOT NULL REFERENCES users(id),
      from_user_id BIGINT REFERENCES users(id), to_user_id BIGINT REFERENCES users(id),
      amount BIGINT NOT NULL CHECK(amount>0), action TEXT NOT NULL, note TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS sessions(
      token_hash TEXT PRIMARY KEY,user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at BIGINT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS one_main_admin ON users(role) WHERE role='admin';
    CREATE INDEX IF NOT EXISTS users_parent_idx ON users(parent_id);
    CREATE INDEX IF NOT EXISTS ledger_actor_idx ON ledger(actor_id,id DESC);
    CREATE INDEX IF NOT EXISTS sessions_expiry_idx ON sessions(expires_at);
  `;
  for (const statement of schema.split(";").map(part => part.trim()).filter(Boolean)) {
    await pool.query(statement);
  }
  await pool.query("INSERT INTO settings(key,value) VALUES('reserve','1000000') ON CONFLICT(key) DO NOTHING");
}
const asyncRoute = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
app.use(asyncRoute(async (req, res, next) => {
  if (!req.path.startsWith("/api/") || ["/api/health", "/api/setup-status", "/api/setup", "/api/login"].includes(req.path)) return next();
  const token = getCookie(req);
  if (!token) return res.status(401).json({ error: "Please sign in." });
  const result = await pool.query(`SELECT u.id,u.username,u.display_name,u.role,u.parent_id,u.balance,u.active
    FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>$2
    AND (u.role<>'player' OR EXISTS(SELECT 1 FROM users p WHERE p.id=u.parent_id AND p.active=TRUE))`, [hash(token), Date.now()]);
  const u = result.rows[0];
  if (!u || !u.active) return res.status(401).json({ error: "Session expired or account disabled." });
  req.user = u; next();
}));
app.get("/api/health", asyncRoute(async (req, res) => {
  await pool.query("SELECT 1");
  res.json({ ok: true, app: "PLAYZONE", database: "connected" });
}));
app.get("/api/setup-status", asyncRoute(async (req, res) => res.json({ needsAdmin: !(await adminExists()) })));
app.post("/api/setup", throttle(5, 15 * 60 * 1000), asyncRoute(async (req, res) => {
  const { setupKey, username, displayName, password } = req.body || {};
  if (await adminExists()) return res.status(409).json({ error: "Main Admin already exists." });
  if (!process.env.INITIAL_SETUP_KEY || setupKey !== process.env.INITIAL_SETUP_KEY) return res.status(403).json({ error: "Invalid setup key. Configure INITIAL_SETUP_KEY in the deployment environment." });
  if (!usernameOK(username) || !passwordOKFormat(password) || typeof displayName !== "string" || displayName.trim().length < 2)
    return res.status(400).json({ error: "Enter a valid username, display name and password of at least 10 characters." });
  try {
    const result = await pool.query("INSERT INTO users(username,display_name,password_hash,role) VALUES($1,$2,$3,'admin') RETURNING id",
      [username, displayName.trim().slice(0, 60), passwordHash(password)]);
    await loginSession(result.rows[0].id, res);
    const user = await pool.query("SELECT * FROM users WHERE id=$1", [result.rows[0].id]);
    res.status(201).json({ user: safe(user.rows[0]) });
  } catch (e) { res.status(400).json({ error: "Could not create Main Admin. Username may already exist." }); }
}));
app.post("/api/login", throttle(10, 15 * 60 * 1000), asyncRoute(async (req, res) => {
  const { username, password } = req.body || {};
  const result = await pool.query("SELECT * FROM users WHERE username=$1", [String(username || "")]);
  const u = result.rows[0];
  let parentActive = true;
  if (u?.role === "player") {
    const parent = await pool.query("SELECT active FROM users WHERE id=$1", [u.parent_id]);
    parentActive = !!parent.rows[0]?.active;
  }
  if (!u || !u.active || !parentActive || !passwordOK(password, u.password_hash)) return res.status(401).json({ error: "Invalid username or password." });
  await loginSession(u.id, res); res.json({ user: safe(u) });
}));
app.post("/api/logout", asyncRoute(async (req, res) => {
  const token = getCookie(req); if (token) await pool.query("DELETE FROM sessions WHERE token_hash=$1", [hash(token)]);
  res.clearCookie(cookie, { httpOnly: true, sameSite: "strict", secure: process.env.NODE_ENV === "production", path: "/" });
  res.json({ ok: true });
}));
app.get("/api/me", asyncRoute(async (req, res) => {
  const r = await pool.query("SELECT * FROM users WHERE id=$1", [req.user.id]); res.json({ user: safe(r.rows[0]) });
}));
app.post("/api/admin/masters", roles("admin"), asyncRoute(async (req, res) => {
  const { username, displayName, password, allocation } = req.body || {};
  if (!usernameOK(username) || !passwordOKFormat(password) || typeof displayName !== "string" || displayName.trim().length < 2 || !Number.isSafeInteger(allocation) || allocation < 0)
    return res.status(400).json({ error: "Invalid master details or allocation." });
  try {
    const user = await inTransaction(async c => {
      const r = await c.query("INSERT INTO users(username,display_name,password_hash,role) VALUES($1,$2,$3,'master') RETURNING id,username,display_name,role,parent_id,balance,active",
        [username, displayName.trim().slice(0, 60), passwordHash(password)]);
      const id = r.rows[0].id;
      await c.query("INSERT INTO master_limits(master_id,allocated,available) VALUES($1,$2,$2)", [id, allocation]);
      if (allocation) await audit(c, req.user.id, null, id, allocation, "MASTER_ALLOCATION", "Initial master quota");
      return r.rows[0];
    });
    res.status(201).json({ user: safe(user) });
  } catch (e) { res.status(400).json({ error: "Could not create master. Username may already exist." }); }
}));
app.post("/api/admin/masters/:id/allocation", roles("admin"), asyncRoute(async (req, res) => {
  const id = Number(req.params.id), amount = req.body?.amount;
  if (!Number.isInteger(id) || !Number.isSafeInteger(amount) || amount === 0) return res.status(400).json({ error: "Enter a non-zero whole number." });
  try {
    await inTransaction(async c => {
      const r = await c.query("SELECT * FROM master_limits WHERE master_id=$1 FOR UPDATE", [id]);
      const limit = r.rows[0]; if (!limit) throw Error("Master not found.");
      if (Number(limit.available) + amount < 0 || Number(limit.allocated) + amount < 0) throw Error("Cannot recall points already distributed.");
      await c.query("UPDATE master_limits SET allocated=allocated+$1,available=available+$1 WHERE master_id=$2", [amount, id]);
      await audit(c, req.user.id, null, id, Math.abs(amount), amount > 0 ? "MASTER_ALLOCATION" : "MASTER_RECALL", "Admin quota adjustment");
    });
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
}));
app.post("/api/players", roles("admin", "master"), asyncRoute(async (req, res) => {
  const { username, displayName, password, startingBalance = 0, masterId } = req.body || {};
  if (!usernameOK(username) || !passwordOKFormat(password) || typeof displayName !== "string" || displayName.trim().length < 2 || !Number.isSafeInteger(startingBalance) || startingBalance < 0)
    return res.status(400).json({ error: "Invalid player details." });
  const parent = req.user.role === "master" ? req.user.id : Number(masterId);
  try {
    const user = await inTransaction(async c => {
      const m = await c.query("SELECT u.id,l.available FROM users u JOIN master_limits l ON l.master_id=u.id WHERE u.id=$1 AND u.role='master' AND u.active=TRUE FOR UPDATE OF l", [parent]);
      const master = m.rows[0]; if (!master) throw Error("Select a valid active master.");
      if (startingBalance > Number(master.available)) throw Error("Starting points exceed available master quota.");
      const r = await c.query("INSERT INTO users(username,display_name,password_hash,role,parent_id,balance) VALUES($1,$2,$3,'player',$4,$5) RETURNING id,username,display_name,role,parent_id,balance,active",
        [username, displayName.trim().slice(0, 60), passwordHash(password), parent, startingBalance]);
      if (startingBalance) {
        await c.query("UPDATE master_limits SET available=available-$1 WHERE master_id=$2", [startingBalance, parent]);
        await audit(c, req.user.id, null, r.rows[0].id, startingBalance, "PLAYER_CREDIT", "Starting points");
      }
      return r.rows[0];
    });
    res.status(201).json({ user: safe(user) });
  } catch (e) { res.status(400).json({ error: e.message === "duplicate key value violates unique constraint \"users_username_key\"" ? "Username may already exist." : e.message }); }
}));
app.post("/api/players/:id/points", roles("admin", "master"), asyncRoute(async (req, res) => {
  const id = Number(req.params.id), amount = req.body?.amount, note = req.body?.note || "";
  if (!Number.isInteger(id) || !Number.isSafeInteger(amount) || amount === 0 || Math.abs(amount) > 100000000) return res.status(400).json({ error: "Enter a non-zero whole-number adjustment." });
  try {
    await inTransaction(async c => {
      const pr = await c.query("SELECT * FROM users WHERE id=$1 AND role='player' AND active=TRUE FOR UPDATE", [id]);
      const p = pr.rows[0]; if (!p) throw Error("Player not found.");
      if (req.user.role === "master" && Number(p.parent_id) !== Number(req.user.id)) throw Error("You can only manage your own players.");
      const lr = await c.query("SELECT * FROM master_limits WHERE master_id=$1 FOR UPDATE", [p.parent_id]);
      const lim = lr.rows[0]; if (!lim) throw Error("Master allocation not found.");
      if (amount > 0) {
        if (amount > Number(lim.available)) throw Error("Insufficient master allocation.");
        await c.query("UPDATE master_limits SET available=available-$1 WHERE master_id=$2", [amount, p.parent_id]);
        await c.query("UPDATE users SET balance=balance+$1 WHERE id=$2", [amount, id]);
        await audit(c, req.user.id, null, id, amount, "PLAYER_CREDIT", note);
      } else {
        const debit = -amount; if (debit > Number(p.balance)) throw Error("Player balance is too low.");
        await c.query("UPDATE users SET balance=balance-$1 WHERE id=$2", [debit, id]);
        await c.query("UPDATE master_limits SET available=available+$1 WHERE master_id=$2", [debit, p.parent_id]);
        await audit(c, req.user.id, id, null, debit, "PLAYER_DEBIT", note);
      }
    });
    res.json({ ok: true });
  } catch (e) { res.status(e.message.includes("only manage") ? 403 : 400).json({ error: e.message }); }
}));
app.post("/api/accounts/:id/status", roles("admin", "master"), asyncRoute(async (req, res) => {
  const id = Number(req.params.id), active = req.body?.active;
  if (!Number.isInteger(id) || typeof active !== "boolean") return res.status(400).json({ error: "Invalid account status." });
  const r = await pool.query("SELECT id,role,parent_id FROM users WHERE id=$1", [id]), target = r.rows[0];
  if (!target || target.role === "admin") return res.status(404).json({ error: "Account not found." });
  if (req.user.role === "master" && (target.role !== "player" || Number(target.parent_id) !== Number(req.user.id))) return res.status(403).json({ error: "You can only manage your own players." });
  await inTransaction(async c => { await c.query("UPDATE users SET active=$1 WHERE id=$2", [active, id]); if (!active) await c.query("DELETE FROM sessions WHERE user_id=$1", [id]); });
  res.json({ ok: true, active });
}));
app.post("/api/accounts/:id/password", roles("admin", "master"), asyncRoute(async (req, res) => {
  const id = Number(req.params.id), password = req.body?.password;
  if (!Number.isInteger(id) || !passwordOKFormat(password)) return res.status(400).json({ error: "Password must be at least 10 characters." });
  const r = await pool.query("SELECT id,role,parent_id FROM users WHERE id=$1", [id]), target = r.rows[0];
  if (!target || target.role === "admin") return res.status(404).json({ error: "Account not found." });
  if (req.user.role === "master" && (target.role !== "player" || Number(target.parent_id) !== Number(req.user.id))) return res.status(403).json({ error: "You can only manage your own players." });
  await inTransaction(async c => { await c.query("UPDATE users SET password_hash=$1 WHERE id=$2", [passwordHash(password), id]); await c.query("DELETE FROM sessions WHERE user_id=$1", [id]); });
  res.json({ ok: true });
}));
app.get("/api/transactions.csv", asyncRoute(async (req, res) => {
  const select = `SELECT l.id,l.created_at,l.action,l.amount,l.note,a.username actor,f.username from_user,t.username to_user
    FROM ledger l JOIN users a ON a.id=l.actor_id LEFT JOIN users f ON f.id=l.from_user_id LEFT JOIN users t ON t.id=l.to_user_id`;
  let result;
  if (req.user.role === "admin") result = await pool.query(select + " ORDER BY l.id DESC");
  else if (req.user.role === "master") result = await pool.query(select + ` WHERE
    l.from_user_id IN (SELECT id FROM users WHERE parent_id=$1 AND role='player')
    OR l.to_user_id IN (SELECT id FROM users WHERE parent_id=$1 AND role='player') ORDER BY l.id DESC`, [req.user.id]);
  else result = await pool.query(select + " WHERE l.from_user_id=$1 OR l.to_user_id=$1 ORDER BY l.id DESC", [req.user.id]);
  const cell = value => { let s = String(value ?? ""); if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; return '"' + s.replace(/"/g, '""') + '"'; };
  const columns = ["id","created_at","action","actor","from_user","to_user","amount","note"];
  const lines = [columns.join(","), ...result.rows.map(row => columns.map(key => cell(row[key])).join(","))];
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="playzone-transactions-${req.user.role}.csv"`);
  res.send("\uFEFF" + lines.join("\r\n"));
}));
app.get("/api/dashboard", asyncRoute(async (req, res) => {
  if (req.user.role === "admin") {
    const counts = (await pool.query("SELECT COUNT(*)::int total,COUNT(*) FILTER (WHERE role='master')::int masters,COUNT(*) FILTER (WHERE role='player')::int players FROM users")).rows[0];
    const masters = (await pool.query(`SELECT u.id,u.username,u.display_name,u.active,l.allocated,l.available,
      (SELECT COUNT(*)::int FROM users p WHERE p.parent_id=u.id AND p.role='player') players
      FROM users u JOIN master_limits l ON l.master_id=u.id WHERE u.role='master' ORDER BY u.id DESC`)).rows;
    const ledger = (await pool.query("SELECT l.*,a.username actor,f.username from_user,t.username recipient FROM ledger l JOIN users a ON a.id=l.actor_id LEFT JOIN users f ON f.id=l.from_user_id LEFT JOIN users t ON t.id=l.to_user_id ORDER BY l.id DESC LIMIT 100")).rows;
    return res.json({ role: "admin", counts, reserve: "UNLIMITED", masters, ledger });
  }
  if (req.user.role === "master") {
    const allocation = (await pool.query("SELECT * FROM master_limits WHERE master_id=$1", [req.user.id])).rows[0];
    const players = (await pool.query("SELECT id,username,display_name,balance,active FROM users WHERE parent_id=$1 AND role='player' ORDER BY id DESC", [req.user.id])).rows;
    const history = (await pool.query(`SELECT l.id,l.action,l.amount,l.note,l.created_at,a.username actor,f.username from_user,t.username to_user
      FROM ledger l LEFT JOIN users a ON a.id=l.actor_id LEFT JOIN users f ON f.id=l.from_user_id LEFT JOIN users t ON t.id=l.to_user_id
      WHERE l.from_user_id IN (SELECT id FROM users WHERE parent_id=$1 AND role='player')
      OR l.to_user_id IN (SELECT id FROM users WHERE parent_id=$1 AND role='player') ORDER BY l.id DESC LIMIT 100`, [req.user.id])).rows;
    return res.json({ role: "master", allocation, players, history });
  }
  const history = (await pool.query("SELECT action,amount,note,created_at FROM ledger WHERE to_user_id=$1 OR from_user_id=$1 ORDER BY id DESC LIMIT 25", [req.user.id])).rows;
  res.json({ role: "player", balance: req.user.balance, history });
}));
app.use(express.static(path.join(__dirname, "public")));
app.get("*", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));
app.use((err, req, res, next) => {
  console.error("PLAYZONE request failed:", err.message);
  if (!res.headersSent) res.status(500).json({ error: "An unexpected server error occurred." });
});
const port = Number(process.env.PORT || 3000);
initDatabase().then(() => app.listen(port, "0.0.0.0", () => console.log("PLAYZONE PostgreSQL server running on port " + port)))
  .catch(err => { console.error("Database initialization failed:", err); process.exit(1); });
process.on("SIGTERM", async () => { await pool.end(); process.exit(0); });
