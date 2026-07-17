const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { exec } = require("child_process");
const { DatabaseSync } = require("node:sqlite");

const root = path.join(__dirname, "dist");
const isHosted = Boolean(process.env.PORT || process.env.RAILWAY_ENVIRONMENT || process.env.CAP_HOST);
const dataDir = path.resolve(process.env.CAP_DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(__dirname, "data"));
const uploadDir = path.join(dataDir, "uploads");
const dbPath = process.env.CAP_DB_PATH ? path.resolve(process.env.CAP_DB_PATH) : path.join(dataDir, "cap.db");
const host = process.env.CAP_HOST || (isHosted ? "0.0.0.0" : "127.0.0.1");
const preferredPort = Number(process.env.PORT || process.env.CAP_PORT || 1420);
const logPath = process.env.CAP_LOG_PATH || (isHosted ? path.join(dataDir, "cap-launch.log") : path.join(__dirname, "cap-launch.log"));

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ico": "image/x-icon"
};

fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(uploadDir, { recursive: true });
const db = new DatabaseSync(dbPath);

function log(message) {
  try {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.appendFileSync(logPath, `[${new Date().toISOString()}] ${message}\n`);
  } catch (error) {
    console.warn(`[CAP] ${message}`);
    console.warn(`[CAP] Could not write log: ${error.message}`);
  }
}

function initializeDatabase() {
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS founder_profile (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      name TEXT NOT NULL DEFAULT '',
      handle TEXT NOT NULL DEFAULT '',
      role TEXT NOT NULL DEFAULT '',
      bio TEXT NOT NULL DEFAULT '',
      image TEXT NOT NULL DEFAULT '',
      mission TEXT NOT NULL DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS creators (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      handle TEXT NOT NULL DEFAULT '',
      role TEXT NOT NULL DEFAULT '',
      category TEXT NOT NULL DEFAULT '',
      description TEXT NOT NULL DEFAULT '',
      image TEXT NOT NULL DEFAULT '',
      banner TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS platform_links (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      creator_id INTEGER NOT NULL REFERENCES creators(id) ON DELETE CASCADE,
      platform TEXT NOT NULL,
      url TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS featured_videos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      creator_id INTEGER NOT NULL REFERENCES creators(id) ON DELETE CASCADE,
      title TEXT NOT NULL DEFAULT '',
      url TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS creator_circles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      detail TEXT NOT NULL DEFAULT '',
      accent TEXT NOT NULL DEFAULT 'violet',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS circle_membership (
      circle_id INTEGER NOT NULL REFERENCES creator_circles(id) ON DELETE CASCADE,
      creator_id INTEGER NOT NULL REFERENCES creators(id) ON DELETE CASCADE,
      joined_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (circle_id, creator_id)
    );

    CREATE TABLE IF NOT EXISTS saved_creators (
      creator_id INTEGER PRIMARY KEY REFERENCES creators(id) ON DELETE CASCADE,
      saved_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS collaboration_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      creator_id INTEGER REFERENCES creators(id) ON DELETE SET NULL,
      title TEXT NOT NULL,
      message TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'Requested',
      progress INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      creator_id INTEGER REFERENCES creators(id) ON DELETE SET NULL,
      subject TEXT NOT NULL DEFAULT '',
      body TEXT NOT NULL,
      direction TEXT NOT NULL DEFAULT 'sent',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS contribution_activity (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      actor TEXT NOT NULL,
      action TEXT NOT NULL,
      points INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS application_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL DEFAULT ''
    );
  `);

  const creatorColumns = new Set(db.prepare("PRAGMA table_info(creators)").all().map((column) => column.name));
  const requiredCreatorColumns = [
    ["skills", "skills TEXT NOT NULL DEFAULT ''"],
    ["location", "location TEXT NOT NULL DEFAULT ''"],
    ["portfolio", "portfolio TEXT NOT NULL DEFAULT ''"],
    ["collaboration_interests", "collaboration_interests TEXT NOT NULL DEFAULT ''"],
    ["looking_for", "looking_for TEXT NOT NULL DEFAULT ''"]
  ];
  for (const [name, ddl] of requiredCreatorColumns) {
    if (!creatorColumns.has(name)) db.exec(`ALTER TABLE creators ADD COLUMN ${ddl}`);
  }
}

function all(sql, params = []) {
  return db.prepare(sql).all(...params);
}

function get(sql, params = []) {
  return db.prepare(sql).get(...params);
}

function run(sql, params = []) {
  return db.prepare(sql).run(...params);
}

function setSetting(key, value) {
  run("INSERT INTO application_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [
    key,
    typeof value === "string" ? value : JSON.stringify(value)
  ]);
}

function getSettings() {
  return Object.fromEntries(all("SELECT key, value FROM application_settings").map((item) => [item.key, item.value]));
}

function setRecentActivity(type, id, label) {
  setSetting("lastActivity", { type, id, label, at: new Date().toISOString() });
}

function markCreatorViewed(creatorId) {
  const settings = getSettings();
  let viewed = [];
  try {
    viewed = JSON.parse(settings.viewedCreators || "[]");
  } catch {
    viewed = [];
  }
  viewed = [Number(creatorId), ...viewed.filter((id) => Number(id) !== Number(creatorId))].slice(0, 50);
  setSetting("viewedCreators", viewed);
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > 20_000_000) {
        request.destroy();
        reject(new Error("Request body is too large."));
      }
    });
    request.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (error) {
        reject(error);
      }
    });
    request.on("error", reject);
  });
}

function json(response, status, payload) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-cache"
  });
  response.end(JSON.stringify(payload));
}

function notFound(response) {
  json(response, 404, { error: "Not found" });
}

function sanitizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function uploadExtension(name, type, dataUrl) {
  const extension = path.extname(sanitizeText(name)).toLowerCase().replace(".", "");
  const mime = sanitizeText(type).toLowerCase() || (String(dataUrl).match(/^data:([^;]+);base64,/) || [])[1] || "";
  const allowed = new Map([
    ["png", "png"],
    ["jpg", "jpg"],
    ["jpeg", "jpg"],
    ["webp", "webp"],
    ["image/png", "png"],
    ["image/jpeg", "jpg"],
    ["image/jpg", "jpg"],
    ["image/webp", "webp"]
  ]);
  return allowed.get(extension) || allowed.get(mime) || "";
}

function saveUploadedImage(payload) {
  const dataUrl = sanitizeText(payload.data);
  const extension = uploadExtension(payload.name, payload.type, dataUrl);
  if (!extension) throw new Error("Please choose a PNG, JPG, JPEG, or WebP image.");
  const match = dataUrl.match(/^data:[^;]+;base64,(.+)$/);
  if (!match) throw new Error("The selected image could not be read.");
  const buffer = Buffer.from(match[1], "base64");
  if (!buffer.length) throw new Error("The selected image is empty.");
  fs.mkdirSync(uploadDir, { recursive: true });
  const filename = `${Date.now()}-${crypto.randomUUID()}.${extension}`;
  const absolutePath = path.join(uploadDir, filename);
  fs.writeFileSync(absolutePath, buffer);
  return `data/uploads/${filename}`;
}

function listFromLines(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => ({
      platform: sanitizeText(item.platform),
      url: sanitizeText(item.url)
    }))
    .filter((item) => item.platform || item.url);
}

function videosFromLines(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => ({
      title: sanitizeText(item.title),
      url: sanitizeText(item.url)
    }))
    .filter((item) => item.url);
}

function saveKeyValues(values) {
  for (const [key, value] of Object.entries(values)) {
    setSetting(key, String(value ?? ""));
  }
}

function rowIdFromUrl(url, prefix) {
  const match = url.pathname.match(new RegExp(`^/api/${prefix}/(\\d+)(?:/(.*))?$`));
  return match ? { id: Number(match[1]), rest: match[2] || "" } : null;
}

function creatorWithRelations(row) {
  if (!row) return null;
  return {
    ...row,
    platforms: all("SELECT id, platform, url FROM platform_links WHERE creator_id = ? ORDER BY id", [row.id]),
    videos: all("SELECT id, title, url FROM featured_videos WHERE creator_id = ? ORDER BY id", [row.id]),
    circles: all(`
      SELECT c.id, c.name, c.detail, c.accent, m.joined_at
      FROM circle_membership m
      JOIN creator_circles c ON c.id = m.circle_id
      WHERE m.creator_id = ?
      ORDER BY c.name
    `, [row.id]),
    projects: all(`
      SELECT id, title, message, status, progress, created_at
      FROM collaboration_requests
      WHERE creator_id = ?
      ORDER BY created_at DESC, id DESC
    `, [row.id]),
    saved: Boolean(get("SELECT creator_id FROM saved_creators WHERE creator_id = ?", [row.id]))
  };
}

function getState() {
  const creators = all("SELECT * FROM creators ORDER BY created_at DESC, id DESC").map(creatorWithRelations);
  const circles = all(`
    SELECT c.*, COUNT(m.creator_id) AS members
    FROM creator_circles c
    LEFT JOIN circle_membership m ON m.circle_id = c.id
    GROUP BY c.id
    ORDER BY c.created_at DESC, c.id DESC
  `);
  const circleMembership = all(`
    SELECT m.circle_id, m.creator_id, c.name AS creator_name
    FROM circle_membership m
    JOIN creators c ON c.id = m.creator_id
    ORDER BY c.name
  `);
  const collaborations = all(`
    SELECT cr.*, c.name AS creator_name
    FROM collaboration_requests cr
    LEFT JOIN creators c ON c.id = cr.creator_id
    ORDER BY cr.created_at DESC, cr.id DESC
  `);
  const messages = all(`
    SELECT m.*, c.name AS creator_name
    FROM messages m
    LEFT JOIN creators c ON c.id = m.creator_id
    ORDER BY m.created_at DESC, m.id DESC
  `);
  const activity = all("SELECT * FROM contribution_activity ORDER BY created_at DESC, id DESC LIMIT 20");
  const profile = get("SELECT * FROM founder_profile WHERE id = 1") || null;
  const savedCount = get("SELECT COUNT(*) AS count FROM saved_creators").count;
  const activeCollaborations = get("SELECT COUNT(*) AS count FROM collaboration_requests WHERE status != 'Completed'").count;
  const contributionPoints = get("SELECT COALESCE(SUM(points), 0) AS count FROM contribution_activity").count;
  const circleCreators = get("SELECT COUNT(DISTINCT creator_id) AS count FROM circle_membership").count;
  const settings = getSettings();
  const admin = {
    users: {
      founderProfileComplete: Boolean(profile && profile.name),
      creatorProfiles: get("SELECT COUNT(*) AS count FROM creators").count,
      savedCreators: savedCount
    },
    reports: {
      activityEvents: get("SELECT COUNT(*) AS count FROM contribution_activity").count,
      messages: get("SELECT COUNT(*) AS count FROM messages").count,
      collaborationRequests: get("SELECT COUNT(*) AS count FROM collaboration_requests").count
    },
    moderation: {
      creatorsMissingImages: get("SELECT COUNT(*) AS count FROM creators WHERE image = '' OR banner = ''").count,
      creatorsMissingDescriptions: get("SELECT COUNT(*) AS count FROM creators WHERE description = ''").count,
      openCollaborations: activeCollaborations
    },
    analytics: {
      circles: get("SELECT COUNT(*) AS count FROM creator_circles").count,
      circleMemberships: get("SELECT COUNT(*) AS count FROM circle_membership").count,
      contributionPoints
    },
    systemHealth: {
      databasePath: dbPath,
      creators,
      status: "OK"
    }
  };

  return {
    profile,
    creators,
    circles,
    circleMembership,
    collaborations,
    messages,
    activity,
    stats: {
      circleCreators,
      activeCollaborations,
      savedCreators: savedCount,
      contributionPoints
    },
    settings,
    currentUser: {
      accountType: "founder",
      isAdmin: true
    },
    admin
  };
}

function saveProfile(payload) {
  run(
    `INSERT INTO founder_profile (id, name, handle, role, bio, image, mission)
     VALUES (1, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name,
       handle = excluded.handle,
       role = excluded.role,
       bio = excluded.bio,
       image = excluded.image,
       mission = excluded.mission`,
    [
      sanitizeText(payload.name),
      sanitizeText(payload.handle),
      sanitizeText(payload.role),
      sanitizeText(payload.bio),
      sanitizeText(payload.image),
      sanitizeText(payload.mission)
    ]
  );
  if (sanitizeText(payload.name)) {
    run("INSERT INTO contribution_activity (actor, action, points) VALUES (?, ?, ?)", [
      sanitizeText(payload.name),
      "updated the founder profile",
      5
    ]);
    setRecentActivity("settings", 1, "Founder profile");
  }
}

function saveCreator(payload, id = null) {
  const values = [
    sanitizeText(payload.name),
    sanitizeText(payload.handle),
    sanitizeText(payload.role),
    sanitizeText(payload.category),
    sanitizeText(payload.description),
    sanitizeText(payload.image),
    sanitizeText(payload.banner),
    sanitizeText(payload.skills),
    sanitizeText(payload.location),
    sanitizeText(payload.portfolio),
    sanitizeText(payload.collaboration_interests ?? payload.collaborationInterests),
    sanitizeText(payload.looking_for ?? payload.lookingFor)
  ];

  if (!values[0]) throw new Error("Creator name is required.");

  let creatorId = id;
  if (creatorId) {
    run(
      `UPDATE creators
       SET name = ?, handle = ?, role = ?, category = ?, description = ?, image = ?, banner = ?,
           skills = ?, location = ?, portfolio = ?, collaboration_interests = ?, looking_for = ?,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [...values, creatorId]
    );
    run("DELETE FROM platform_links WHERE creator_id = ?", [creatorId]);
    run("DELETE FROM featured_videos WHERE creator_id = ?", [creatorId]);
  } else {
    const result = run(
      `INSERT INTO creators
       (name, handle, role, category, description, image, banner, skills, location, portfolio, collaboration_interests, looking_for)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      values
    );
    creatorId = Number(result.lastInsertRowid);
  }

  for (const item of listFromLines(payload.platforms)) {
    run("INSERT INTO platform_links (creator_id, platform, url) VALUES (?, ?, ?)", [creatorId, item.platform, item.url]);
  }
  for (const item of videosFromLines(payload.videos)) {
    run("INSERT INTO featured_videos (creator_id, title, url) VALUES (?, ?, ?)", [creatorId, item.title, item.url]);
  }

  run("INSERT INTO contribution_activity (actor, action, points) VALUES (?, ?, ?)", [values[0], id ? "updated a creator profile" : "joined the creator directory", id ? 3 : 10]);
  setRecentActivity("creator", creatorId, values[0]);
  return creatorId;
}

function saveMyProfile(payload) {
  const name = sanitizeText(payload.name);
  if (!name) throw new Error("Creator name is required.");

  saveProfile({
    name,
    handle: sanitizeText(payload.handle),
    role: sanitizeText(payload.role) || "Founder",
    bio: sanitizeText(payload.bio),
    image: sanitizeText(payload.image),
    mission: sanitizeText(payload.mission)
  });

  saveKeyValues({
    banner: sanitizeText(payload.banner),
    category: sanitizeText(payload.category),
    skills: sanitizeText(payload.skills),
    location: sanitizeText(payload.location),
    portfolio: sanitizeText(payload.portfolio),
    collaborationInterests: sanitizeText(payload.collaborationInterests),
    lookingFor: sanitizeText(payload.lookingFor),
    platforms: sanitizeText(payload.platformSearch),
    categories: sanitizeText(payload.category),
    interests: sanitizeText(payload.collaborationInterests),
    collaborationNeeds: sanitizeText(payload.lookingFor)
  });

  const settings = getSettings();
  const existingId = Number(settings.myCreatorId || 0);
  const creatorPayload = {
    name,
    handle: sanitizeText(payload.handle),
    role: sanitizeText(payload.role),
    category: sanitizeText(payload.category),
    description: sanitizeText(payload.bio),
    image: sanitizeText(payload.image),
    banner: sanitizeText(payload.banner),
    skills: sanitizeText(payload.skills),
    location: sanitizeText(payload.location),
    portfolio: sanitizeText(payload.portfolio),
    collaborationInterests: sanitizeText(payload.collaborationInterests),
    lookingFor: sanitizeText(payload.lookingFor),
    platforms: listFromLines(payload.platforms),
    videos: videosFromLines(payload.videos)
  };
  const creatorId = saveCreator(creatorPayload, existingId || null);
  setSetting("myCreatorId", String(creatorId));
  setRecentActivity("profile", creatorId, name);
}

function saveCircle(payload) {
  const name = sanitizeText(payload.name);
  if (!name) throw new Error("Circle name is required.");
  const result = run("INSERT INTO creator_circles (name, detail, accent) VALUES (?, ?, ?)", [
    name,
    sanitizeText(payload.detail),
    sanitizeText(payload.accent) || "violet"
  ]);
  run("INSERT INTO contribution_activity (actor, action, points) VALUES (?, ?, ?)", [name, "circle created", 8]);
  setRecentActivity("circle", Number(result.lastInsertRowid), name);
  return Number(result.lastInsertRowid);
}

async function handleApi(request, response, url) {
  try {
    if (request.method === "GET" && url.pathname === "/api/state") return json(response, 200, getState());

    if (request.method === "POST" && url.pathname === "/api/uploads") {
      const storedPath = saveUploadedImage(await readJson(request));
      return json(response, 200, { path: storedPath });
    }

    if (request.method === "POST" && url.pathname === "/api/profile") {
      saveProfile(await readJson(request));
      return json(response, 200, getState());
    }

    if (request.method === "POST" && url.pathname === "/api/my-profile") {
      saveMyProfile(await readJson(request));
      return json(response, 200, getState());
    }

    if (request.method === "POST" && url.pathname === "/api/creators") {
      saveCreator(await readJson(request));
      return json(response, 200, getState());
    }

    const creatorRoute = rowIdFromUrl(url, "creators");
    if (creatorRoute && request.method === "PUT") {
      saveCreator(await readJson(request), creatorRoute.id);
      return json(response, 200, getState());
    }
    if (creatorRoute && request.method === "DELETE") {
      run("DELETE FROM creators WHERE id = ?", [creatorRoute.id]);
      return json(response, 200, getState());
    }

    if (request.method === "POST" && url.pathname === "/api/circles") {
      saveCircle(await readJson(request));
      return json(response, 200, getState());
    }

    const circleRoute = rowIdFromUrl(url, "circles");
    if (circleRoute && request.method === "POST" && circleRoute.rest === "members") {
      const payload = await readJson(request);
      const creatorId = Number(payload.creatorId);
      if (!creatorId) throw new Error("Creator is required.");
      run("INSERT OR IGNORE INTO circle_membership (circle_id, creator_id) VALUES (?, ?)", [circleRoute.id, creatorId]);
      const circle = get("SELECT name FROM creator_circles WHERE id = ?", [circleRoute.id]);
      const creator = get("SELECT name FROM creators WHERE id = ?", [creatorId]);
      if (circle && creator) run("INSERT INTO contribution_activity (actor, action, points) VALUES (?, ?, ?)", [creator.name, `joined ${circle.name}`, 5]);
      if (circle) setRecentActivity("circle", circleRoute.id, circle.name);
      return json(response, 200, getState());
    }

    if (request.method === "POST" && url.pathname === "/api/saved") {
      const payload = await readJson(request);
      const creatorId = Number(payload.creatorId);
      if (!creatorId) throw new Error("Creator is required.");
      const existing = get("SELECT creator_id FROM saved_creators WHERE creator_id = ?", [creatorId]);
      if (existing) run("DELETE FROM saved_creators WHERE creator_id = ?", [creatorId]);
      else {
        run("INSERT INTO saved_creators (creator_id) VALUES (?)", [creatorId]);
        const creator = get("SELECT name FROM creators WHERE id = ?", [creatorId]);
        if (creator) run("INSERT INTO contribution_activity (actor, action, points) VALUES (?, ?, ?)", [creator.name, "saved for follow-up", 2]);
      }
      const creator = get("SELECT name FROM creators WHERE id = ?", [creatorId]);
      if (creator) setRecentActivity("creator", creatorId, creator.name);
      return json(response, 200, getState());
    }

    if (request.method === "POST" && url.pathname === "/api/viewed") {
      const payload = await readJson(request);
      const creatorId = Number(payload.creatorId);
      if (!creatorId) throw new Error("Creator is required.");
      const creator = get("SELECT name FROM creators WHERE id = ?", [creatorId]);
      if (creator) {
        markCreatorViewed(creatorId);
        setRecentActivity("creator", creatorId, creator.name);
      }
      return json(response, 200, getState());
    }

    if (request.method === "POST" && url.pathname === "/api/support") {
      const payload = await readJson(request);
      const creatorId = Number(payload.creatorId);
      if (!creatorId) throw new Error("Creator is required.");
      const creator = get("SELECT name FROM creators WHERE id = ?", [creatorId]);
      if (!creator) throw new Error("Creator was not found.");
      run("INSERT INTO contribution_activity (actor, action, points) VALUES (?, ?, ?)", [creator.name, "received creator support", 5]);
      run("INSERT INTO messages (creator_id, subject, body, direction) VALUES (?, ?, ?, ?)", [
        creatorId,
        "Creator support",
        "Support noted locally from the CAP homepage.",
        "sent"
      ]);
      setRecentActivity("creator", creatorId, creator.name);
      return json(response, 200, getState());
    }

    if (request.method === "POST" && url.pathname === "/api/collaborations") {
      const payload = await readJson(request);
      const title = sanitizeText(payload.title);
      if (!title) throw new Error("Collaboration title is required.");
      const creatorId = payload.creatorId ? Number(payload.creatorId) : null;
      run("INSERT INTO collaboration_requests (creator_id, title, message, status, progress) VALUES (?, ?, ?, ?, ?)", [
        creatorId,
        title,
        sanitizeText(payload.message),
        sanitizeText(payload.status) || "Requested",
        Math.max(0, Math.min(100, Number(payload.progress) || 0))
      ]);
      run("INSERT INTO contribution_activity (actor, action, points) VALUES (?, ?, ?)", [title, "collaboration request created", 12]);
      const row = get("SELECT id FROM collaboration_requests ORDER BY id DESC LIMIT 1");
      setRecentActivity("collaboration", row.id, title);
      return json(response, 200, getState());
    }

    if (request.method === "POST" && url.pathname === "/api/messages") {
      const payload = await readJson(request);
      const body = sanitizeText(payload.body);
      if (!body) throw new Error("Message body is required.");
      run("INSERT INTO messages (creator_id, subject, body, direction) VALUES (?, ?, ?, ?)", [
        payload.creatorId ? Number(payload.creatorId) : null,
        sanitizeText(payload.subject),
        body,
        sanitizeText(payload.direction) || "sent"
      ]);
      run("INSERT INTO contribution_activity (actor, action, points) VALUES (?, ?, ?)", [sanitizeText(payload.subject) || "Message", "local message sent", 2]);
      const row = get("SELECT id FROM messages ORDER BY id DESC LIMIT 1");
      setRecentActivity("message", row.id, sanitizeText(payload.subject) || "Message");
      return json(response, 200, getState());
    }

    if (request.method === "POST" && url.pathname === "/api/settings") {
      const payload = await readJson(request);
      for (const [key, value] of Object.entries(payload)) {
        run("INSERT INTO application_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [
          sanitizeText(key),
          String(value ?? "")
        ]);
      }
      setRecentActivity("settings", 1, "Application settings");
      return json(response, 200, getState());
    }

    return notFound(response);
  } catch (error) {
    log(`API error: ${error.stack || error.message}`);
    return json(response, 400, { error: error.message || "Request failed" });
  }
}

function serveMedia(url, response) {
  const relativePath = decodeURIComponent(url.pathname.replace(/^\/media\//, ""));
  const cleanPath = path.normalize(relativePath).replace(/^(\.\.[/\\])+/, "");
  const normalized = cleanPath.replace(/\\/g, "/");
  const filePath = normalized.startsWith("data/uploads/") || normalized.startsWith("uploads/")
    ? path.join(uploadDir, path.basename(normalized))
    : path.join(__dirname, cleanPath);
  const uploadRoot = path.resolve(uploadDir);
  const resolved = path.resolve(filePath);

  if (!resolved.startsWith(uploadRoot)) {
    response.writeHead(403);
    response.end("Forbidden");
    return;
  }

  fs.readFile(resolved, (error, data) => {
    if (error) {
      response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Image not found");
      return;
    }
    const extension = path.extname(resolved).toLowerCase();
    response.writeHead(200, {
      "Content-Type": mimeTypes[extension] || "application/octet-stream",
      "Cache-Control": "no-cache"
    });
    response.end(data);
  });
}

function serveFile(requestPath, response) {
  const urlPath = decodeURIComponent(requestPath.split("?")[0]);
  const cleanPath = path.normalize(urlPath).replace(/^(\.\.[/\\])+/, "");
  const filePath = path.join(root, cleanPath === "/" ? "index.html" : cleanPath);

  if (!filePath.startsWith(root)) {
    response.writeHead(403);
    response.end("Forbidden");
    return;
  }

  fs.readFile(filePath, (error, data) => {
    if (error) {
      fs.readFile(path.join(root, "index.html"), (indexError, indexData) => {
        if (indexError) {
          response.writeHead(404);
          response.end("CAP build files were not found.");
          return;
        }
        response.writeHead(200, { "Content-Type": mimeTypes[".html"] });
        response.end(indexData);
      });
      return;
    }

    const extension = path.extname(filePath).toLowerCase();
    response.writeHead(200, {
      "Content-Type": mimeTypes[extension] || "application/octet-stream",
      "Cache-Control": "no-cache"
    });
    response.end(data);
  });
}

function openBrowser(port) {
  if (process.env.CAP_NO_OPEN === "1" || isHosted) return;
  const url = `http://${host}:${port}`;
  const edgePaths = [
    path.join(process.env.ProgramFiles || "", "Microsoft", "Edge", "Application", "msedge.exe"),
    path.join(process.env["ProgramFiles(x86)"] || "", "Microsoft", "Edge", "Application", "msedge.exe")
  ];
  const edgePath = edgePaths.find((candidate) => candidate && fs.existsSync(candidate));

  if (edgePath) {
    exec(`start "" "${edgePath}" --app="${url}"`, { shell: "cmd.exe" });
    return;
  }

  exec(`start "" "${url}"`, { shell: "cmd.exe" });
}

function startServer(port) {
  initializeDatabase();
  log(`Starting CAP from ${root} with SQLite database ${dbPath}`);

  const server = http.createServer((request, response) => {
    const url = new URL(request.url || "/", `http://${host}:${port}`);
    if (request.method === "GET" && url.pathname === "/health") {
      return json(response, 200, {
        status: "ok",
        service: "CAP",
        database: dbPath,
        dataDir,
        uploads: uploadDir
      });
    }
    if (url.pathname.startsWith("/api/")) {
      handleApi(request, response, url);
      return;
    }
    if (url.pathname.startsWith("/media/")) {
      serveMedia(url, response);
      return;
    }
    serveFile(request.url || "/", response);
  });

  server.on("error", (error) => {
    if (error.code === "EADDRINUSE") {
      log(`Port ${port} is already in use; opening existing CAP server.`);
      openBrowser(port);
      process.exit(0);
    }
    log(`Server error: ${error.stack || error.message}`);
    throw error;
  });

  server.listen(port, host, () => {
    log(`CAP is running at http://${host}:${port}`);
    openBrowser(port);
  });
}

startServer(preferredPort);
