const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");

const projectRoot = path.resolve(__dirname, "..");
const dir = path.join(os.tmpdir(), `cap-discovery-test-${Date.now()}`);
fs.mkdirSync(dir, { recursive: true });

const envPort = String(19_000 + Math.floor(Math.random() * 10_000));
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

async function register(displayName, email) {
  const result = await request("/api/auth/register", {
    method: "POST",
    body: JSON.stringify({ displayName, email, password: "SamePassword123!" })
  });
  assert(result.response.status === 200 && result.body.user, `Registration failed for ${email}`);
  return cookie(result.response);
}

async function login(email, password) {
  const result = await request("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ email, password })
  });
  assert(result.response.status === 200 && result.body.user, `Login failed for ${email}`);
  return cookie(result.response);
}

async function saveProfile(cookieValue, profile) {
  const result = await request("/api/my-profile", {
    method: "POST",
    headers: { Cookie: cookieValue },
    body: JSON.stringify(profile)
  });
  assert(result.response.status === 200 && result.body.currentUser?.creatorProfileId, `Profile save failed for ${profile.name}`);
  return result.body.currentUser.creatorProfileId;
}

async function addCreator(cookieValue, profile) {
  const result = await request("/api/creators", {
    method: "POST",
    headers: { Cookie: cookieValue },
    body: JSON.stringify(profile)
  });
  assert(result.response.status === 200, `Creator add failed for ${profile.name}: ${JSON.stringify(result.body)}`);
  const match = result.body.creators.find((creator) => creator.handle === profile.handle);
  assert(match, `Created profile not returned for ${profile.name}`);
  return match.id;
}

async function discovery(cookieValue, refresh = false) {
  const result = await request(`/api/discovery${refresh ? "?refresh=1" : ""}`, { headers: { Cookie: cookieValue } });
  assert(result.response.status === 200 && Array.isArray(result.body.recommendations), "Discovery endpoint failed");
  return result.body.recommendations;
}

(async () => {
  try {
    await waitForServer();

    const cookieA = await register("Founder Alpha", "alpha@example.test");
    const cookieB = await register("Founder Beta", "beta@example.test");
    const alphaId = await saveProfile(cookieA, {
      name: "Founder Alpha",
      handle: "alpha",
      role: "Filmmaker",
      category: "Film",
      bio: "Builds cinematic creator projects.",
      skills: "editing, directing, color",
      location: "Denver",
      collaborationInterests: "music videos, short films",
      lookingFor: "producers, designers",
      platforms: [{ platform: "YouTube", url: "https://youtube.com/@alpha" }]
    });
    const betaId = await saveProfile(cookieB, {
      name: "Founder Beta",
      handle: "beta",
      role: "Designer",
      category: "Design",
      bio: "Builds brand worlds.",
      skills: "branding, animation",
      location: "Austin",
      collaborationInterests: "visual identity, campaigns",
      lookingFor: "filmmakers",
      platforms: [{ platform: "Instagram", url: "https://instagram.com/beta" }]
    });

    const founderCookie = await login("founder@example.test", "FounderPassword123!");
    const creatorSpecs = [
      ["Denver Film Editor", "denver-film-editor", "Editor", "Film", "editing, color", "Denver", "music videos, short films", "YouTube"],
      ["Austin Brand Artist", "austin-brand-artist", "Designer", "Design", "branding, illustration", "Austin", "campaigns", "Instagram"],
      ["Denver Producer", "denver-producer", "Producer", "Film", "production, budgeting", "Denver", "short films", "Website"],
      ["Remote Musician", "remote-musician", "Musician", "Music", "songwriting, vocals", "Remote", "music videos", "TikTok"],
      ["LA Animator", "la-animator", "Animator", "Animation", "animation, motion", "Los Angeles", "visual identity", "YouTube"],
      ["Denver Camera Op", "denver-camera", "Camera Operator", "Film", "camera, lighting", "Denver", "short films", "YouTube"],
      ["Chicago Podcaster", "chicago-podcaster", "Host", "Podcast", "interviewing, editing", "Chicago", "guest swaps", "Spotify"],
      ["Austin Videographer", "austin-video", "Videographer", "Video", "camera, editing", "Austin", "campaigns", "Instagram"],
      ["Denver Strategist", "denver-strategist", "Strategist", "Marketing", "strategy, launch", "Denver", "creator growth", "Website"],
      ["Seattle Developer", "seattle-dev", "Software Developer", "Tech", "software, automation", "Seattle", "platform tools", "Website"]
    ];
    const creatorIds = [];
    for (const [name, handle, role, category, skills, location, interests, platform] of creatorSpecs) {
      creatorIds.push(await addCreator(founderCookie, {
        name,
        handle,
        role,
        category,
        description: `${name} profile`,
        skills,
        location,
        collaborationInterests: interests,
        lookingFor: "collaborators",
        platforms: [{ platform, url: `https://example.test/${handle}` }]
      }));
    }

    const db = new DatabaseSync(path.join(dir, "cap.db"));
    db.prepare("UPDATE users SET status = 'deactivated' WHERE id = (SELECT user_id FROM creators WHERE id = ?)").run(betaId);
    const alphaUserId = db.prepare("SELECT id FROM users WHERE email = ?").get("alpha@example.test").id;

    let queue = await discovery(cookieA, true);
    assert(queue.length >= 10, "Discovery did not return the created creators");
    assert(!queue.some((creator) => creator.id === alphaId), "Discovery recommended the signed-in creator");
    assert(!queue.some((creator) => creator.id === betaId), "Discovery recommended a deactivated creator");
    assert(queue[0].category === "Film" || queue[0].location === "Denver" || queue[0].discoveryReasons.length, "Top creator was not meaningfully scored");

    const topId = queue[0].id;
    const hide = await request("/api/hide", {
      method: "POST",
      headers: { Cookie: cookieA },
      body: JSON.stringify({ creatorId: topId })
    });
    assert(hide.response.status === 200, "Hide endpoint failed");
    queue = await discovery(cookieA, true);
    assert(!queue.some((creator) => creator.id === topId), "Hidden creator remained in queue");

    const followId = queue[0].id;
    const follow = await request("/api/follow", {
      method: "POST",
      headers: { Cookie: cookieA },
      body: JSON.stringify({ creatorId: followId })
    });
    assert(follow.response.status === 200, "Follow endpoint failed");
    assert(db.prepare("SELECT COUNT(*) AS count FROM creator_follows WHERE follower_user_id = ? AND creator_id = ?").get(alphaUserId, followId).count === 1, "Follow relationship was not stored");

    const view = await request("/api/view", {
      method: "POST",
      headers: { Cookie: cookieA },
      body: JSON.stringify({ creatorId: followId })
    });
    assert(view.response.status === 200, "View endpoint failed");
    assert(db.prepare("SELECT COUNT(*) AS count FROM creator_views WHERE viewer_user_id = ? AND creator_id = ?").get(alphaUserId, followId).count >= 1, "View relationship was not stored");

    const beforeSave = (await discovery(cookieA, true)).find((creator) => creator.id === followId).discoveryScore;
    const save = await request("/api/saved", {
      method: "POST",
      headers: { Cookie: cookieA },
      body: JSON.stringify({ creatorId: followId })
    });
    assert(save.response.status === 200, "Save endpoint failed");
    const afterSave = (await discovery(cookieA, true)).find((creator) => creator.id === followId).discoveryScore;
    assert(afterSave <= beforeSave - 35, "Saved creator score was not reduced");

    const beforeProfileEdit = (await discovery(cookieA, true))[0].id;
    await saveProfile(cookieA, {
      name: "Founder Alpha",
      handle: "alpha",
      role: "Designer",
      category: "Design",
      bio: "Now focused on brand design.",
      skills: "branding, animation",
      location: "Austin",
      collaborationInterests: "campaigns",
      lookingFor: "design partners",
      platforms: [{ platform: "Instagram", url: "https://instagram.com/alpha" }]
    });
    const afterProfileEditQueue = await discovery(cookieA, true);
    assert(afterProfileEditQueue[0].id !== beforeProfileEdit || afterProfileEditQueue[0].category === "Design", "Profile edits did not refresh scoring");

    const state = await request("/api/state", { headers: { Cookie: founderCookie } });
    assert(state.response.status === 200 && state.body.admin?.analytics, "Admin analytics missing");
    assert(state.body.admin.analytics.mostViewedCreators.some((row) => row.id === followId), "Most viewed analytics did not update");
    assert(state.body.admin.analytics.mostFollowedCreators.some((row) => row.id === followId), "Most followed analytics did not update");
    assert(state.body.admin.analytics.mostSavedCreators.some((row) => row.id === followId), "Most saved analytics did not update");
    assert(Array.isArray(state.body.admin.analytics.fastestGrowingCreators), "Fastest growing analytics missing");

    db.close();
    console.log("smoke-discovery ok");
  } finally {
    child.kill();
  }
})().catch((error) => {
  child.kill();
  console.error(error.stack || error.message);
  process.exit(1);
});
