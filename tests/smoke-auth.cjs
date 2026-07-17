const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");

const projectRoot = path.resolve(__dirname, "..");
const dir = path.join(os.tmpdir(), `cap-auth-test-${Date.now()}`);
fs.mkdirSync(dir, { recursive: true });

const env = {
  ...process.env,
  CAP_DATA_DIR: dir,
  CAP_FOUNDER_EMAIL: "founder@example.test",
  CAP_FOUNDER_PASSWORD: "FounderPassword123!",
  CAP_HOST: "127.0.0.1",
  PORT: "18320",
  CAP_NO_OPEN: "1"
};

const child = spawn(process.execPath, ["launch-cap.cjs"], {
  cwd: projectRoot,
  env,
  stdio: ["ignore", "pipe", "pipe"]
});

let output = "";
child.stdout.on("data", (data) => { output += data; });
child.stderr.on("data", (data) => { output += data; });

const base = "http://127.0.0.1:18320";
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function request(pathname, options = {}) {
  const response = await fetch(`${base}${pathname}`, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) }
  });
  const text = await response.text();
  let body = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { text };
  }
  return { response, body };
}

async function waitForServer() {
  for (let index = 0; index < 40; index += 1) {
    try {
      const health = await request("/health");
      if (health.response.ok) return;
    } catch {
      await wait(250);
    }
  }
  throw new Error(`CAP server did not start. ${output}`);
}

function cookie(response) {
  const value = response.headers.get("set-cookie");
  if (!value) throw new Error("Expected Set-Cookie header.");
  return value.split(";")[0];
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

(async () => {
  try {
    await waitForServer();
    const health = await request("/health");
    assert(health.response.status === 200 && health.body.status === "ok", "health endpoint failed");
    const background = await fetch(`${base}/assets/cap-background.png`);
    assert(background.status === 200, "background asset did not return 200");

    const regA = await request("/api/auth/register", {
      method: "POST",
      body: JSON.stringify({ displayName: "User A", email: "a@example.test", password: "SamePassword123!" })
    });
    const cookieA = cookie(regA.response);
    assert(regA.response.status === 200 && regA.body.user && !regA.body.user.password_hash, "User A registration failed or leaked password hash");

    const regB = await request("/api/auth/register", {
      method: "POST",
      body: JSON.stringify({ displayName: "User B", email: "b@example.test", password: "SamePassword123!" })
    });
    const cookieB = cookie(regB.response);
    assert(regB.response.status === 200 && regB.body.user, "User B registration failed");

    const profileA = await request("/api/my-profile", {
      method: "POST",
      headers: { Cookie: cookieA },
      body: JSON.stringify({ name: "User A Creator", handle: "usera", role: "Filmmaker", category: "Film", bio: "A bio", skills: "editing", location: "Denver" })
    });
    assert(profileA.response.status === 200 && profileA.body.currentUser.creatorProfileId, "User A profile failed");

    const profileB = await request("/api/my-profile", {
      method: "POST",
      headers: { Cookie: cookieB },
      body: JSON.stringify({ name: "User B Creator", handle: "userb", role: "Designer", category: "Design", bio: "B bio", skills: "branding", location: "Austin" })
    });
    assert(profileB.response.status === 200 && profileB.body.currentUser.creatorProfileId, "User B profile failed");

    const crossEdit = await request(`/api/creators/${profileA.body.currentUser.creatorProfileId}`, {
      method: "PUT",
      headers: { Cookie: cookieB },
      body: JSON.stringify({ name: "Hijack", handle: "x" })
    });
    assert(crossEdit.response.status === 403, "User B could edit User A");

    const adminDenied = await request("/api/admin/users", { headers: { Cookie: cookieA } });
    assert(adminDenied.response.status === 403, "Regular user reached admin endpoint");

    const founderLogin = await request("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ email: "founder@example.test", password: "FounderPassword123!" })
    });
    const founderCookie = cookie(founderLogin.response);
    const adminAllowed = await request("/api/admin/users", { headers: { Cookie: founderCookie } });
    assert(adminAllowed.response.status === 200 && Array.isArray(adminAllowed.body.users), "Founder could not reach admin endpoint");

    const logout = await request("/api/auth/logout", {
      method: "POST",
      headers: { Cookie: cookieA },
      body: JSON.stringify({})
    });
    assert(logout.response.status === 200, "Logout failed");
    const afterLogout = await request("/api/state", { headers: { Cookie: cookieA } });
    assert(afterLogout.response.status === 401, "Logged out cookie still authorized");

    const forged = await request("/api/state", { headers: { Cookie: "cap_session=forged" } });
    assert(forged.response.status === 401, "Forged cookie authorized");

    const db = new DatabaseSync(path.join(dir, "cap.db"));
    const users = db.prepare("SELECT email, password_hash FROM users ORDER BY email").all();
    assert(users.length === 3, "Expected founder plus two regular users");
    assert(users[0].password_hash !== users[1].password_hash, "Password hashes should differ");
    assert(db.prepare("SELECT COUNT(*) AS count FROM sessions").get().count >= 0, "sessions table missing");
    assert(db.prepare("PRAGMA table_info(creators)").all().some((column) => column.name === "user_id"), "creators.user_id missing");
    db.close();

    console.log("smoke-auth ok");
  } finally {
    child.kill();
  }
})().catch((error) => {
  child.kill();
  console.error(error.stack || error.message);
  process.exit(1);
});
