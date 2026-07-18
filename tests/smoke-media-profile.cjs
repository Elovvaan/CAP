const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const projectRoot = path.resolve(__dirname, "..");
const dir = path.join(os.tmpdir(), `cap-media-profile-test-${Date.now()}`);
fs.mkdirSync(dir, { recursive: true });

const envPort = String(21_000 + Math.floor(Math.random() * 10_000));
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

async function register(displayName, email) {
  const result = await request("/api/auth/register", {
    method: "POST",
    body: JSON.stringify({ displayName, email, password: "SamePassword123!" })
  });
  assert(result.response.status === 200 && result.body.user, `Registration failed for ${email}`);
  return cookie(result.response);
}

(async () => {
  try {
    await waitForServer();
    const cookieA = await register("Media Creator A", "media-a@example.test");
    const cookieB = await register("Media Creator B", "media-b@example.test");

    const videos = [
      { title: "The Greatest Story Ever Told", url: "https://www.youtube.com/watch?v=abc123XYZ_0" },
      { title: "Studio Reel", url: "https://vimeo.com/123456789" }
    ];
    const platforms = [
      { platform: "YouTube", handle: "@mediaa", url: "https://youtube.com/@mediaa" },
      { platform: "Instagram", handle: "@mediaa", url: "https://instagram.com/mediaa" },
      { platform: "TikTok", handle: "@mediaa", url: "https://tiktok.com/@mediaa" },
      { platform: "Website", handle: "", url: "https://mediaa.example.test" }
    ];

    const profile = await request("/api/my-profile", {
      method: "POST",
      headers: { Cookie: cookieA },
      body: JSON.stringify({
        name: "Media Creator A",
        handle: "media-a",
        role: "Filmmaker",
        category: "Film",
        bio: "Original biography",
        skills: "editing, directing",
        location: "Denver",
        collaborationInterests: "short films",
        lookingFor: "producers",
        platforms,
        videos
      })
    });
    assert(profile.response.status === 200, `Profile save failed: ${JSON.stringify(profile.body)}`);
    const creatorId = profile.body.currentUser.creatorProfileId;

    let state = await request("/api/state", { headers: { Cookie: cookieA } });
    assert(state.body.myCreator.videos.length === 2, "Both featured videos should persist after save");
    assert(state.body.myCreator.videos[0].title === videos[0].title, "Video title did not persist");
    assert(state.body.myCreator.platforms.length === 4, "All social platform rows should persist");
    assert(state.body.myCreator.platforms.some((item) => item.platform === "TikTok" && item.handle === "@mediaa"), "TikTok handle did not persist");
    assert(state.body.creators.find((creator) => creator.id === creatorId).videos.length === 2, "Public creator data did not include both videos");

    const biographyOnly = await request(`/api/creators/${creatorId}`, {
      method: "PUT",
      headers: { Cookie: cookieA },
      body: JSON.stringify({
        name: "Media Creator A",
        handle: "media-a",
        role: "Filmmaker",
        category: "Film",
        description: "Updated biography only"
      })
    });
    assert(biographyOnly.response.status === 200, "Biography-only update failed");
    state = await request("/api/state", { headers: { Cookie: cookieA } });
    assert(state.body.myCreator.videos.length === 2, "Biography-only update removed featured videos");

    const removeOne = await request("/api/my-profile", {
      method: "POST",
      headers: { Cookie: cookieA },
      body: JSON.stringify({
        name: "Media Creator A",
        handle: "media-a",
        role: "Filmmaker",
        category: "Film",
        bio: "Updated biography only",
        platforms,
        videos: [videos[0]]
      })
    });
    assert(removeOne.response.status === 200, "Intentional one-video update failed");
    state = await request("/api/state", { headers: { Cookie: cookieA } });
    assert(state.body.myCreator.videos.length === 1 && state.body.myCreator.videos[0].url === videos[0].url, "Intentional video removal did not persist");
    assert(state.body.myCreator.platforms.some((item) => item.platform === "Website" && item.url === "https://mediaa.example.test/"), "Website social link did not persist");

    const badVideo = await request("/api/my-profile", {
      method: "POST",
      headers: { Cookie: cookieA },
      body: JSON.stringify({
        name: "Media Creator A",
        handle: "media-a",
        role: "Filmmaker",
        category: "Film",
        bio: "Bad video attempt",
        videos: [{ title: "Bad", url: "javascript:alert(1)" }]
      })
    });
    assert(badVideo.response.status === 400 && /Featured video 1 URL must start with http or https/.test(badVideo.body.error), "javascript video URL was not rejected");

    const malformedVideo = await request("/api/my-profile", {
      method: "POST",
      headers: { Cookie: cookieA },
      body: JSON.stringify({
        name: "Media Creator A",
        handle: "media-a",
        role: "Filmmaker",
        category: "Film",
        bio: "Malformed video attempt",
        videos: [{ title: "Bad", url: "notaurl" }]
      })
    });
    assert(malformedVideo.response.status === 400 && /Featured video 1 URL is malformed/.test(malformedVideo.body.error), "Malformed video URL was not rejected");

    await request("/api/my-profile", {
      method: "POST",
      headers: { Cookie: cookieB },
      body: JSON.stringify({ name: "Media Creator B", handle: "media-b", role: "Designer", category: "Design", bio: "B bio" })
    });
    const crossEdit = await request(`/api/creators/${creatorId}`, {
      method: "PUT",
      headers: { Cookie: cookieB },
      body: JSON.stringify({
        name: "Hijacked",
        handle: "hijacked",
        videos: [{ title: "Stolen", url: "https://youtube.com/watch?v=zzzzzzzzzzz" }],
        platforms: [{ platform: "X", handle: "@bad", url: "https://x.com/bad" }]
      })
    });
    assert(crossEdit.response.status === 403, "One user could edit another user's media/social links");

    console.log("smoke-media-profile ok");
  } finally {
    child.kill();
  }
})().catch((error) => {
  child.kill();
  console.error(error.stack || error.message);
  process.exit(1);
});
