const test = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");

async function freePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
}

test("admin/master/player hierarchy, points ledger and account controls", async t => {
  const root = path.join(__dirname, "..");
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "playzone-test-"));
  const port = await freePort();
  const setupKey = "test-setup-key-123456789";
  const env = {
    ...process.env,
    PORT: String(port),
    DATABASE_FILE: path.join(temp, "playzone.sqlite"),
    INITIAL_SETUP_KEY: setupKey,
    SESSION_SECRET: "test-session-secret-at-least-32-characters-long",
    NODE_ENV: "test"
  };
  const child = spawn(process.execPath, ["server.js"], { cwd: root, env, stdio: "ignore" });
  const base = `http://127.0.0.1:${port}`;
  let adminCookie = "";
  let masterCookie = "";
  let playerCookie = "";

  async function request(route, options = {}, cookie = "") {
    const headers = { "content-type": "application/json", ...(options.headers || {}) };
    if (cookie) headers.cookie = cookie;
    const response = await fetch(base + route, { ...options, headers });
    const body = await response.json().catch(() => ({}));
    return { response, body, setCookie: response.headers.get("set-cookie") || "" };
  }
  async function waitReady() {
    for (let i = 0; i < 80; i++) {
      if (child.exitCode !== null) throw new Error("Playzone server exited during startup");
      try {
        const r = await fetch(base + "/api/health");
        if (r.ok) return;
      } catch {}
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error("Playzone server did not become ready");
  }
  t.after(() => {
    child.kill("SIGTERM");
    fs.rmSync(temp, { recursive: true, force: true });
  });

  await waitReady();

  let r = await request("/api/setup", {
    method: "POST",
    body: JSON.stringify({ setupKey, displayName: "Main Admin", username: "mainadmin", password: "AdminPassword123" })
  });
  assert.equal(r.response.status, 201, JSON.stringify(r.body));
  adminCookie = r.setCookie.split(";")[0];
  assert.ok(adminCookie.startsWith("pz_session="));

  r = await request("/api/setup", {
    method: "POST",
    body: JSON.stringify({ setupKey, displayName: "Second Admin", username: "secondadmin", password: "AdminPassword456" })
  });
  assert.equal(r.response.status, 409, "a second Main Admin must be rejected");

  r = await request("/api/admin/masters", {
    method: "POST",
    body: JSON.stringify({ displayName: "Master One", username: "masterone", password: "MasterPassword123", allocation: 500 })
  }, adminCookie);
  assert.equal(r.response.status, 201, JSON.stringify(r.body));
  const masterId = r.body.user.id;

  r = await request("/api/login", {
    method: "POST",
    body: JSON.stringify({ username: "masterone", password: "MasterPassword123" })
  });
  assert.equal(r.response.status, 200);
  masterCookie = r.setCookie.split(";")[0];

  r = await request("/api/players", {
    method: "POST",
    body: JSON.stringify({ displayName: "Player One", username: "playerone", password: "PlayerPassword123", startingBalance: 0 })
  }, masterCookie);
  assert.equal(r.response.status, 201, JSON.stringify(r.body));
  const playerId = r.body.user.id;

  r = await request(`/api/players/${playerId}/points`, {
    method: "POST",
    body: JSON.stringify({ amount: 100, note: "Test credit" })
  }, masterCookie);
  assert.equal(r.response.status, 200, JSON.stringify(r.body));

  r = await request("/api/dashboard", {}, masterCookie);
  assert.equal(r.response.status, 200);
  assert.equal(r.body.players.find(p => p.id === playerId).balance, 100);
  assert.equal(r.body.history.length, 1);
  assert.equal(r.body.history[0].action, "PLAYER_CREDIT");
  assert.equal(r.body.history[0].to_user, "playerone");
  assert.equal(r.body.allocation.available, 400);

  r = await request("/api/login", {
    method: "POST",
    body: JSON.stringify({ username: "playerone", password: "PlayerPassword123" })
  });
  assert.equal(r.response.status, 200);
  playerCookie = r.setCookie.split(";")[0];
  r = await request("/api/dashboard", {}, playerCookie);
  assert.equal(r.body.balance, 100);
  assert.equal(r.body.history.length, 1);

  r = await request("/api/dashboard", {}, adminCookie);
  assert.equal(r.response.status, 200);
  assert.ok(r.body.ledger.some(x => x.action === "PLAYER_CREDIT"));
  assert.ok(r.body.ledger.some(x => x.action === "MASTER_ALLOCATION"));

  r = await request(`/api/accounts/${playerId}/password`, {
    method: "POST",
    body: JSON.stringify({ password: "NewPlayerPassword123" })
  }, masterCookie);
  assert.equal(r.response.status, 200);
  r = await request("/api/dashboard", {}, playerCookie);
  assert.equal(r.response.status, 401, "password reset must revoke existing sessions");

  r = await request(`/api/accounts/${playerId}/status`, {
    method: "POST",
    body: JSON.stringify({ active: false })
  }, masterCookie);
  assert.equal(r.response.status, 200);
  r = await request("/api/login", {
    method: "POST",
    body: JSON.stringify({ username: "playerone", password: "NewPlayerPassword123" })
  });
  assert.equal(r.response.status, 401, "disabled players must not sign in");

  r = await request("/api/admin/masters", {
    method: "POST",
    body: JSON.stringify({ displayName: "Master Two", username: "mastertwo", password: "MasterPassword456", allocation: 100 })
  }, adminCookie);
  assert.equal(r.response.status, 201, JSON.stringify(r.body));
  r = await request("/api/login", {
    method: "POST",
    body: JSON.stringify({ username: "mastertwo", password: "MasterPassword456" })
  });
  assert.equal(r.response.status, 200);
  const secondMasterCookie = r.setCookie.split(";")[0];
  r = await request("/api/players", {
    method: "POST",
    body: JSON.stringify({ displayName: "Player Two", username: "playertwo", password: "PlayerPassword456", startingBalance: 0 })
  }, secondMasterCookie);
  assert.equal(r.response.status, 201);
  const secondPlayerId = r.body.user.id;

  r = await request(`/api/accounts/${secondPlayerId}/status`, {
    method: "POST",
    body: JSON.stringify({ active: false })
  }, masterCookie);
  assert.equal(r.response.status, 403, "a master cannot manage another master's player");

  r = await request(`/api/accounts/${r.body.user.parentId}/status`, {
    method: "POST",
    body: JSON.stringify({ active: false })
  }, adminCookie);
  assert.equal(r.response.status, 200);
  r = await request("/api/login", {
    method: "POST",
    body: JSON.stringify({ username: "playertwo", password: "PlayerPassword456" })
  });
  assert.equal(r.response.status, 401, "players cannot sign in while their master is disabled");
});
