const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");

const projectRoot = path.resolve(__dirname, "..");
const dir = path.join(os.tmpdir(), `cap-founder-upgrade-test-${Date.now()}`);
fs.mkdirSync(dir, { recursive: true });

let port = 20_000 + Math.floor(Math.random() * 10_000);
let child = null;
let output = "";

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const baseUrl = () => `http://127.0.0.1:${port}`;

async function request(pathname, options = {}) {
  const response = await fetch(`${baseUrl()}${pathname}`, {
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

async function start(extraEnv = {}) {
  port += 1;
  output = "";
  const env = {
    ...process.env,
    CAP_DATA_DIR: dir,
    CAP_HOST: "127.0.0.1",
    PORT: String(port),
    CAP_NO_OPEN: "1",
    ...extraEnv
  };
  child = spawn(process.execPath, ["launch-cap.cjs"], {
    cwd: projectRoot,
    env,
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.stdout.on("data", (data) => { output += data; });
  child.stderr.on("data", (data) => { output += data; });

  for (let index = 0; index < 50; index += 1) {
    try {
      const health = await request("/health");
      if (health.response.ok) return;
    } catch {
      // ignore and retry
    }
    await wait(200);
  }
  throw new Error(`CAP server did not start. ${output}`);
}

async function stop() {
  if (!child) return;
  const exiting = new Promise((resolve) => child.once("exit", resolve));
  child.kill();
  await Promise.race([exiting, wait(1500)]);
  child = null;
}

function cookie(response) {
  const value = response.headers.get("set-cookie");
  if (!value) throw new Error("Expected Set-Cookie header.");
  return value.split(";")[0];
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function register(displayName, email, password = "SamePassword123!", extras = {}) {
  const result = await request("/api/auth/register", {
    method: "POST",
    body: JSON.stringify({ displayName, email, password, ...extras })
  });
  assert(result.response.status === 200 && result.body.user, `Registration failed for ${email}: ${JSON.stringify(result.body)}`);
  return { cookie: cookie(result.response), user: result.body.user };
}

async function login(email, password = "SamePassword123!") {
  const result = await request("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ email, password })
  });
  assert(result.response.status === 200 && result.body.user, `Login failed for ${email}: ${JSON.stringify(result.body)}`);
  return { cookie: cookie(result.response), user: result.body.user };
}

async function saveProfile(cookieValue, profile) {
  const result = await request("/api/my-profile", {
    method: "POST",
    headers: { Cookie: cookieValue },
    body: JSON.stringify(profile)
  });
  assert(result.response.status === 200 && result.body.currentUser?.creatorProfileId, `Profile save failed: ${JSON.stringify(result.body)}`);
  return result.body.currentUser;
}

function db() {
  return new DatabaseSync(path.join(dir, "cap.db"));
}

(async () => {
  try {
    await start({ CAP_FOUNDER_EMAIL: "", CAP_FOUNDER_PASSWORD: "" });

    const existing = await register("Configured Founder", "founder@example.test");
    const profile = await saveProfile(existing.cookie, {
      name: "Configured Founder Creator",
      handle: "configured-founder",
      role: "Founder",
      category: "Film",
      bio: "Existing regular creator profile.",
      skills: "editing",
      location: "Denver"
    });

    let conn = db();
    const original = conn.prepare("SELECT id, password_hash FROM users WHERE email = ?").get("founder@example.test");
    conn.prepare("INSERT INTO users (email, password_hash, display_name, account_type, is_admin, status) VALUES (?, ?, ?, 'founder', 1, 'active')").run("legacy-founder@example.test", original.password_hash, "Legacy Founder");
    conn.prepare("INSERT INTO users (email, password_hash, display_name, account_type, is_admin, status) VALUES (?, ?, ?, 'creator', 1, 'active')").run("admin@example.test", original.password_hash, "Separate Admin");
    conn.close();

    await stop();
    await start({ CAP_FOUNDER_EMAIL: "founder@example.test", CAP_FOUNDER_PASSWORD: "" });

    const founderLogin = await login("founder@example.test");
    assert(founderLogin.user.id === original.id, "Founder promotion changed the user id");
    assert(founderLogin.user.accountType === "founder" && founderLogin.user.isAdmin === true, "Configured founder user was not promoted");
    assert(founderLogin.user.creatorProfileId === profile.creatorProfileId, "Founder creator profile was not preserved");

    conn = db();
    assert(conn.prepare("SELECT COUNT(*) AS count FROM users WHERE email = ?").get("founder@example.test").count === 1, "Duplicate configured founder account was created");
    assert(conn.prepare("SELECT COUNT(*) AS count FROM users WHERE account_type = 'founder'").get().count === 1, "Expected exactly one founder account");
    const legacy = conn.prepare("SELECT account_type, is_admin FROM users WHERE email = ?").get("legacy-founder@example.test");
    assert(legacy.account_type === "creator" && legacy.is_admin === 1, "Duplicate founder was not demoted while preserving admin access");
    const separateAdmin = conn.prepare("SELECT account_type, is_admin FROM users WHERE email = ?").get("admin@example.test");
    assert(separateAdmin.account_type === "creator" && separateAdmin.is_admin === 1, "Separate admin was incorrectly treated as founder");
    conn.close();

    await stop();
    await start({ CAP_FOUNDER_EMAIL: "founder@example.test", CAP_FOUNDER_PASSWORD: "" });
    const repeated = await login("founder@example.test");
    assert(repeated.user.id === original.id && repeated.user.accountType === "founder", "Repeated startup was not idempotent");

    const blockedFounderRegistration = await request("/api/auth/register", {
      method: "POST",
      body: JSON.stringify({ displayName: "Claim Founder", email: "founder@example.test", password: "SamePassword123!" })
    });
    assert(blockedFounderRegistration.response.status === 409, "Public registration did not reject configured founder email");

    const injected = await register("Injected User", "inject@example.test", "SamePassword123!", {
      account_type: "founder",
      accountType: "founder",
      is_admin: 1,
      isAdmin: true,
      status: "active",
      user_id: original.id
    });
    assert(injected.user.accountType === "creator" && injected.user.isAdmin === false, "Public registration accepted account privilege injection");

    const nextFounder = await register("Next Founder", "next-founder@example.test");
    await stop();
    await start({ CAP_FOUNDER_EMAIL: "next-founder@example.test", CAP_FOUNDER_PASSWORD: "" });

    const newFounderLogin = await login("next-founder@example.test");
    assert(newFounderLogin.user.id === nextFounder.user.id, "New configured founder user id changed");
    assert(newFounderLogin.user.accountType === "founder" && newFounderLogin.user.isAdmin === true, "New configured founder was not promoted");
    const oldFounderLogin = await login("founder@example.test");
    assert(oldFounderLogin.user.id === original.id, "Old founder account was deleted or replaced");
    assert(oldFounderLogin.user.accountType === "creator", "Old founder account type was not demoted after founder email change");

    conn = db();
    assert(conn.prepare("SELECT COUNT(*) AS count FROM users WHERE account_type = 'founder'").get().count === 1, "Founder email change left multiple founder accounts");
    assert(conn.prepare("SELECT COUNT(*) AS count FROM users").get().count === 5, "Founder email change deleted or duplicated users");
    conn.close();

    console.log("smoke-founder-upgrade ok");
  } finally {
    await stop();
  }
})().catch(async (error) => {
  await stop();
  console.error(error.stack || error.message);
  process.exit(1);
});
