const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");

const projectRoot = path.resolve(__dirname, "..");
const dir = path.join(os.tmpdir(), `cap-founder-control-test-${Date.now()}`);
fs.mkdirSync(dir, { recursive: true });

const envPort = String(22_000 + Math.floor(Math.random() * 10_000));
const env = {
  ...process.env,
  CAP_DATA_DIR: dir,
  CAP_FOUNDER_EMAIL: "founder@example.test",
  CAP_FOUNDER_PASSWORD: "FounderPassword123!",
  CAP_HOST: "127.0.0.1",
  PORT: envPort,
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

const base = `http://127.0.0.1:${envPort}`;
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
      // Keep retrying until the server is ready.
    }
    await wait(250);
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

function assertSafeFounderPayload(payload) {
  const text = JSON.stringify(payload).toLowerCase();
  for (const forbidden of ["password_hash", "session_token", "cap_session", "cap_founder_password"]) {
    assert(!text.includes(forbidden), `Founder response leaked ${forbidden}`);
  }
}

async function register(displayName, email) {
  const result = await request("/api/auth/register", {
    method: "POST",
    body: JSON.stringify({ displayName, email, password: "SamePassword123!" })
  });
  assert(result.response.status === 200 && result.body.user, `Registration failed for ${email}`);
  return { cookie: cookie(result.response), user: result.body.user };
}

async function login(email, password = "SamePassword123!") {
  const result = await request("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ email, password })
  });
  assert(result.response.status === 200 && result.body.user, `Login failed for ${email}`);
  return { cookie: cookie(result.response), user: result.body.user };
}

(async () => {
  try {
    await waitForServer();

    const creator = await register("Creator User", "creator@example.test");
    const admin = await register("Admin User", "admin@example.test");
    const db = new DatabaseSync(path.join(dir, "cap.db"));
    db.prepare("UPDATE users SET is_admin = 1, account_type = 'creator' WHERE email = ?").run("admin@example.test");
    const adminId = db.prepare("SELECT id FROM users WHERE email = ?").get("admin@example.test").id;
    db.close();

    const founder = await login("founder@example.test", "FounderPassword123!");
    assert(founder.user.accountType === "founder" && founder.user.isAdmin === true, "Founder login did not use configured founder identity");

    const founderControl = await request("/api/founder/control", { headers: { Cookie: founder.cookie } });
    assert(founderControl.response.status === 200 && founderControl.body.founderControl?.overview, "Founder Control Center did not load for founder");
    assert(Array.isArray(founderControl.body.founderControl.users), "Founder Control user management data missing");
    assert(!JSON.stringify(founderControl.body).includes("password_hash"), "Founder Control leaked password hashes");
    assert(!JSON.stringify(founderControl.body).includes("cap_session"), "Founder Control leaked session tokens");

    const creatorDenied = await request("/api/founder/control", { headers: { Cookie: creator.cookie } });
    assert(creatorDenied.response.status === 403, "Creator reached founder-only control endpoint");

    const adminLogin = await login("admin@example.test");
    const adminDenied = await request("/api/founder/control", { headers: { Cookie: adminLogin.cookie } });
    assert(adminDenied.response.status === 403, "Admin reached founder-only control endpoint");

    const profileUpdate = await request("/api/my-profile", {
      method: "POST",
      headers: { Cookie: creator.cookie },
      body: JSON.stringify({
        name: "Creator User",
        handle: "@creator",
        role: "Director",
        category: "Film",
        bio: "Builds community stories.",
        skills: "editing, camera",
        location: "Denver",
        collaborationInterests: "documentary",
        lookingFor: "producers"
      })
    });
    assert(profileUpdate.response.status === 200, "Creator profile setup failed");
    const creatorId = profileUpdate.body.profile.id;

    const circleCreate = await request("/api/circles", {
      method: "POST",
      headers: { Cookie: founder.cookie },
      body: JSON.stringify({ name: "Founder Review Circle", detail: "Operational review group", accent: "violet" })
    });
    assert(circleCreate.response.status === 200, "Circle setup failed");
    const circleId = circleCreate.body.circles[0].id;

    const collaborationCreate = await request("/api/collaborations", {
      method: "POST",
      headers: { Cookie: creator.cookie },
      body: JSON.stringify({ creatorId, title: "Review Collaboration", message: "Please review.", status: "Requested", progress: 15 })
    });
    assert(collaborationCreate.response.status === 200, "Collaboration setup failed");
    const collaborationId = collaborationCreate.body.collaborations[0].id;

    const updateUser = await request("/api/founder/users", {
      method: "POST",
      headers: { Cookie: founder.cookie },
      body: JSON.stringify({ userId: adminId, displayName: "Operations Admin", status: "active", isAdmin: true })
    });
    assert(updateUser.response.status === 200, "Founder could not manage users");
    assert(updateUser.body.founderControl.users.some((user) => user.id === adminId && user.displayName === "Operations Admin" && user.isAdmin), "Founder user update did not persist");

    const adminUserUpdate = await request("/api/founder/users", {
      method: "POST",
      headers: { Cookie: adminLogin.cookie },
      body: JSON.stringify({ userId: creator.user.id, status: "deactivated" })
    });
    assert(adminUserUpdate.response.status === 403, "Admin could use founder user management endpoint");

    const creatorDeniedAction = await request("/api/founder/creators", {
      method: "POST",
      headers: { Cookie: creator.cookie },
      body: JSON.stringify({ creatorId, action: "hide" })
    });
    assert(creatorDeniedAction.response.status === 403, "Creator could use founder creator management endpoint");

    const adminDeniedAction = await request("/api/founder/creators", {
      method: "POST",
      headers: { Cookie: adminLogin.cookie },
      body: JSON.stringify({ creatorId, action: "hide" })
    });
    assert(adminDeniedAction.response.status === 403, "Admin could use founder creator management endpoint");

    const resetSessions = await request("/api/founder/users", {
      method: "POST",
      headers: { Cookie: founder.cookie },
      body: JSON.stringify({ action: "reset-sessions", userId: adminId })
    });
    assert(resetSessions.response.status === 200, "Founder could not reset sessions");

    const creatorReview = await request("/api/founder/creators", {
      method: "POST",
      headers: { Cookie: founder.cookie },
      body: JSON.stringify({ creatorId, action: "review", note: "Founder review note" })
    });
    assert(creatorReview.response.status === 200, "Founder could not place creator under review");
    assert(creatorReview.body.founderControl.creators.some((item) => item.id === creatorId && item.moderationStatus === "under_review"), "Creator review status did not persist");

    const creatorHide = await request("/api/founder/creators", {
      method: "POST",
      headers: { Cookie: founder.cookie },
      body: JSON.stringify({ creatorId, action: "hide", note: "Hidden during review" })
    });
    assert(creatorHide.response.status === 200, "Founder could not hide creator");
    assert(creatorHide.body.founderControl.creators.some((item) => item.id === creatorId && item.visibilityStatus === "hidden"), "Creator hide status did not persist");

    const creatorEdit = await request("/api/founder/creators", {
      method: "POST",
      headers: { Cookie: founder.cookie },
      body: JSON.stringify({ creatorId, action: "edit", name: "Creator User Updated", role: "Producer", category: "Film", location: "Denver" })
    });
    assert(creatorEdit.response.status === 200, "Founder could not edit creator");
    assert(creatorEdit.body.founderControl.creators.some((item) => item.id === creatorId && item.name === "Creator User Updated"), "Founder creator edit did not persist");

    const reportCreate = await request("/api/founder/reports", {
      method: "POST",
      headers: { Cookie: founder.cookie },
      body: JSON.stringify({ action: "create", targetType: "creator", targetId: String(creatorId), reason: "Smoke report" })
    });
    assert(reportCreate.response.status === 200 && reportCreate.body.founderControl.reportQueue.some((report) => report.reason === "Smoke report"), "Founder report creation failed");
    const reportId = reportCreate.body.founderControl.reportQueue.find((report) => report.reason === "Smoke report").id;

    const reportResolve = await request("/api/founder/reports", {
      method: "POST",
      headers: { Cookie: founder.cookie },
      body: JSON.stringify({ action: "resolve", reportId, resolution: "Handled by smoke test" })
    });
    assert(reportResolve.response.status === 200 && reportResolve.body.founderControl.reportQueue.some((report) => report.id === reportId && report.status === "resolved"), "Founder report resolution failed");

    const moderationLog = await request("/api/founder/moderation", {
      method: "POST",
      headers: { Cookie: founder.cookie },
      body: JSON.stringify({ targetType: "creator", targetId: String(creatorId), action: "logged smoke moderation", note: "No sensitive data" })
    });
    assert(moderationLog.response.status === 200 && moderationLog.body.founderControl.auditLog.some((entry) => /logged smoke moderation/.test(entry.action)), "Founder moderation audit failed");

    const circleManage = await request("/api/founder/circles", {
      method: "POST",
      headers: { Cookie: founder.cookie },
      body: JSON.stringify({ circleId, status: "paused", detail: "Paused by smoke test" })
    });
    assert(circleManage.response.status === 200 && circleManage.body.founderControl.circles.some((circle) => circle.id === circleId && circle.status === "paused"), "Founder circle management failed");

    const collaborationClose = await request("/api/founder/collaborations", {
      method: "POST",
      headers: { Cookie: founder.cookie },
      body: JSON.stringify({ collaborationId, action: "close-spam", note: "Smoke spam close" })
    });
    assert(collaborationClose.response.status === 200 && collaborationClose.body.founderControl.collaborations.some((item) => item.id === collaborationId && item.moderationStatus === "spam"), "Founder collaboration moderation failed");

    const settings = await request("/api/founder/settings", {
      method: "POST",
      headers: { Cookie: founder.cookie },
      body: JSON.stringify({ workspaceName: "CAP Founder Lab", mission: "Build together.", notes: "Founder-only note." })
    });
    assert(settings.response.status === 200 && settings.body.founderControl.platformSettings.workspaceName === "CAP Founder Lab", "Founder platform settings did not save");

    const maintenance = await request("/api/founder/maintenance", {
      method: "POST",
      headers: { Cookie: founder.cookie },
      body: JSON.stringify({ action: "clear-discovery-cache" })
    });
    assert(maintenance.response.status === 200, "Founder maintenance action failed");
    assert(maintenance.body.founderControl.auditLog.some((entry) => /cleared discovery cache/.test(entry.action)), "Founder audit log did not record maintenance");

    for (const action of ["cleanup-expired-sessions", "verify-uploads", "backup-database"]) {
      const maintenanceAction = await request("/api/founder/maintenance", {
        method: "POST",
        headers: { Cookie: founder.cookie },
        body: JSON.stringify({ action })
      });
      assert(maintenanceAction.response.status === 200, `Founder maintenance action failed: ${action}`);
      assertSafeFounderPayload(maintenanceAction.body);
    }

    const creatorState = await request("/api/state", { headers: { Cookie: creator.cookie } });
    assert(creatorState.response.status === 200 && creatorState.body.currentUser.accountType === "creator", "Creator dashboard state failed");

    const appScript = fs.readFileSync(path.join(projectRoot, "dist", "assets", "cap-local.js"), "utf8");
    assert(appScript.includes("Founder Control Center") && appScript.includes("Creator Mode") && appScript.includes("founderMode"), "Founder Control UI switch is not present in built app");
    assert(appScript.includes("data-founder-user-action") && appScript.includes("founder-nav-group") && appScript.includes("Create Safe Backup"), "Founder workspace UI controls are not present in built app");
    assertSafeFounderPayload(founderControl.body);

    console.log("smoke-founder-control ok");
  } finally {
    child.kill();
  }
})().catch((error) => {
  child.kill();
  console.error(error.stack || error.message);
  process.exit(1);
});
