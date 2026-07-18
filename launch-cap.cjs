const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { exec } = require("child_process");
const { DatabaseSync } = require("node:sqlite");

const root = path.join(__dirname, "dist");
const isHosted = Boolean(process.env.PORT || process.env.RAILWAY_ENVIRONMENT || process.env.CAP_HOST);
const trustProxy = Boolean(process.env.CAP_TRUST_PROXY);
const dataDir = path.resolve(process.env.CAP_DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(__dirname, "data"));
const uploadDir = path.join(dataDir, "uploads");
const dbPath = process.env.CAP_DB_PATH ? path.resolve(process.env.CAP_DB_PATH) : path.join(dataDir, "cap.db");
const host = process.env.CAP_HOST || (isHosted ? "0.0.0.0" : "127.0.0.1");
const preferredPort = Number(process.env.PORT || process.env.CAP_PORT || 1420);
const logPath = process.env.CAP_LOG_PATH || (isHosted ? path.join(dataDir, "cap-launch.log") : path.join(__dirname, "cap-launch.log"));
const sessionCookieName = "cap_session";
const sessionDurationMs = 30 * 24 * 60 * 60 * 1000;
const maxJsonBytes = 2 * 1024 * 1024;
const maxUploadJsonBytes = 25 * 1024 * 1024;
const maxDecodedImageBytes = 15 * 1024 * 1024;
const authLimitWindowMs = 15 * 60 * 1000;
const authLimitMax = 20;
const authAttempts = new Map();
const discoveryCache = new Map();

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
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

function tableExists(name) {
  return Boolean(get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", [name]));
}

function columnNames(table) {
  return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name));
}

function indexNames(table) {
  return new Set(db.prepare(`PRAGMA index_list(${table})`).all().map((row) => row.name));
}

function backupDatabaseIfNeeded(reason) {
  if (!fs.existsSync(dbPath)) return;
  const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
  const backupPath = path.join(dataDir, `cap-pre-auth-${stamp}.db`);
  if (fs.existsSync(backupPath)) return;
  fs.copyFileSync(dbPath, backupPath);
  log(`Created database backup before ${reason}: ${backupPath}`);
}

function addColumnIfMissing(table, name, ddl) {
  if (!columnNames(table).has(name)) {
    backupDatabaseIfNeeded(`adding ${table}.${name}`);
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  }
}

function rebuildSavedCreatorsForUsers() {
  if (!tableExists("saved_creators")) return;
  const columns = columnNames("saved_creators");
  const indexes = indexNames("saved_creators");
  const needsRebuild = !columns.has("user_id") || !indexes.has("idx_saved_creators_user_creator");
  if (!needsRebuild) return;

  backupDatabaseIfNeeded("saved_creators ownership migration");
  db.exec(`
    PRAGMA foreign_keys = OFF;
    CREATE TABLE IF NOT EXISTS saved_creators_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      creator_id INTEGER NOT NULL REFERENCES creators(id) ON DELETE CASCADE,
      saved_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    INSERT OR IGNORE INTO saved_creators_new (user_id, creator_id, saved_at)
      SELECT NULL, creator_id, COALESCE(saved_at, CURRENT_TIMESTAMP) FROM saved_creators;
    DROP TABLE saved_creators;
    ALTER TABLE saved_creators_new RENAME TO saved_creators;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_saved_creators_user_creator
      ON saved_creators (COALESCE(user_id, -1), creator_id);
    PRAGMA foreign_keys = ON;
  `);
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

    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password_hash TEXT NOT NULL,
      display_name TEXT NOT NULL DEFAULT '',
      account_type TEXT NOT NULL DEFAULT 'creator',
      is_admin INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      last_login_at TEXT
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL UNIQUE,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      user_agent TEXT NOT NULL DEFAULT '',
      ip_address TEXT NOT NULL DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS creator_views (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      viewer_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      creator_id INTEGER NOT NULL REFERENCES creators(id) ON DELETE CASCADE,
      viewed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS creator_hides (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      creator_id INTEGER NOT NULL REFERENCES creators(id) ON DELETE CASCADE,
      hidden_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(user_id, creator_id)
    );

    CREATE TABLE IF NOT EXISTS creator_follows (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      follower_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      creator_id INTEGER NOT NULL REFERENCES creators(id) ON DELETE CASCADE,
      followed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(follower_user_id, creator_id)
    );
  `);

  const requiredCreatorColumns = [
    ["skills", "skills TEXT NOT NULL DEFAULT ''"],
    ["location", "location TEXT NOT NULL DEFAULT ''"],
    ["portfolio", "portfolio TEXT NOT NULL DEFAULT ''"],
    ["collaboration_interests", "collaboration_interests TEXT NOT NULL DEFAULT ''"],
    ["looking_for", "looking_for TEXT NOT NULL DEFAULT ''"],
    ["user_id", "user_id INTEGER REFERENCES users(id) ON DELETE SET NULL"]
  ];
  for (const [name, ddl] of requiredCreatorColumns) {
    addColumnIfMissing("creators", name, ddl);
  }

  addColumnIfMissing("creator_circles", "owner_user_id", "owner_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL");
  addColumnIfMissing("collaboration_requests", "requester_user_id", "requester_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL");
  addColumnIfMissing("messages", "sender_user_id", "sender_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL");
  addColumnIfMissing("messages", "recipient_user_id", "recipient_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL");
  addColumnIfMissing("contribution_activity", "user_id", "user_id INTEGER REFERENCES users(id) ON DELETE SET NULL");
  rebuildSavedCreatorsForUsers();
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_creators_user_id ON creators(user_id);
    CREATE INDEX IF NOT EXISTS idx_circles_owner_user_id ON creator_circles(owner_user_id);
    CREATE INDEX IF NOT EXISTS idx_collaborations_requester_user_id ON collaboration_requests(requester_user_id);
    CREATE INDEX IF NOT EXISTS idx_messages_sender_user_id ON messages(sender_user_id);
    CREATE INDEX IF NOT EXISTS idx_messages_recipient_user_id ON messages(recipient_user_id);
    CREATE INDEX IF NOT EXISTS idx_activity_user_id ON contribution_activity(user_id);
    CREATE INDEX IF NOT EXISTS idx_creator_views_viewer ON creator_views(viewer_user_id, creator_id);
    CREATE INDEX IF NOT EXISTS idx_creator_views_creator ON creator_views(creator_id, viewed_at);
    CREATE INDEX IF NOT EXISTS idx_creator_hides_user ON creator_hides(user_id, creator_id);
    CREATE INDEX IF NOT EXISTS idx_creator_follows_user ON creator_follows(follower_user_id, creator_id);
    CREATE INDEX IF NOT EXISTS idx_creator_follows_creator ON creator_follows(creator_id);
  `);
  initializeFounderUser();
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

function normalizeEmail(value) {
  return sanitizeText(value).toLowerCase();
}

function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || ""));
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const keyLength = 64;
  const n = 16384;
  const r = 8;
  const p = 1;
  const derived = crypto.scryptSync(String(password), salt, keyLength, { N: n, r, p });
  return `scrypt$N=${n},r=${r},p=${p},len=${keyLength}$${salt.toString("base64url")}$${derived.toString("base64url")}`;
}

function verifyPassword(password, encoded) {
  try {
    const [algorithm, paramText, saltText, hashText] = String(encoded || "").split("$");
    if (algorithm !== "scrypt") return false;
    const params = Object.fromEntries(paramText.split(",").map((part) => part.split("=")));
    const expected = Buffer.from(hashText, "base64url");
    const actual = crypto.scryptSync(String(password), Buffer.from(saltText, "base64url"), Number(params.len), {
      N: Number(params.N),
      r: Number(params.r),
      p: Number(params.p)
    });
    return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

function tokenHash(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function parseCookies(request) {
  return Object.fromEntries(
    String(request.headers.cookie || "")
      .split(";")
      .map((part) => {
        const [key, ...rest] = part.trim().split("=");
        const raw = rest.join("=") || "";
        let value = raw;
        try {
          value = decodeURIComponent(raw);
        } catch {
          value = raw;
        }
        return [key, value];
      })
      .filter(([key]) => key)
  );
}

function cookieHeader(name, value, options = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`, "Path=/", "SameSite=Lax", "HttpOnly"];
  if (options.maxAge !== undefined) parts.push(`Max-Age=${options.maxAge}`);
  if (isHosted || options.secure) parts.push("Secure");
  return parts.join("; ");
}

function clearSessionCookie() {
  return cookieHeader(sessionCookieName, "", { maxAge: 0 });
}

function safeUser(row) {
  if (!row) return null;
  const creator = get("SELECT id, image FROM creators WHERE user_id = ? ORDER BY id LIMIT 1", [row.id]);
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    accountType: row.account_type,
    isAdmin: Boolean(row.is_admin),
    status: row.status,
    creatorProfileId: creator?.id || null,
    image: creator?.image || "",
    profileComplete: Boolean(creator?.id)
  };
}

function currentUserFromRequest(request) {
  const token = parseCookies(request)[sessionCookieName];
  if (!token) return null;
  const session = get(`
    SELECT s.id AS session_id, s.expires_at, u.*
    FROM sessions s
    JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ?
  `, [tokenHash(token)]);
  if (!session || session.status !== "active") return null;
  if (new Date(session.expires_at).getTime() <= Date.now()) {
    run("DELETE FROM sessions WHERE id = ?", [session.session_id]);
    return null;
  }
  run("UPDATE sessions SET last_seen_at = CURRENT_TIMESTAMP WHERE id = ?", [session.session_id]);
  return session;
}

function createSession(response, request, userId) {
  const token = crypto.randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + sessionDurationMs).toISOString();
  run("DELETE FROM sessions WHERE expires_at <= ?", [new Date().toISOString()]);
  run(
    "INSERT INTO sessions (user_id, token_hash, expires_at, user_agent, ip_address) VALUES (?, ?, ?, ?, ?)",
    [userId, tokenHash(token), expiresAt, sanitizeText(request.headers["user-agent"]), sanitizeText(request.socket.remoteAddress)]
  );
  response.setHeader("Set-Cookie", cookieHeader(sessionCookieName, token, { maxAge: Math.floor(sessionDurationMs / 1000) }));
}

function requireUser(request) {
  const user = currentUserFromRequest(request);
  if (!user) {
    const error = new Error("Authentication required.");
    error.status = 401;
    throw error;
  }
  return user;
}

function requireAdmin(user) {
  if (!user?.is_admin) {
    const error = new Error("Admin access required.");
    error.status = 403;
    throw error;
  }
}

function configuredFounderEmail() {
  const email = normalizeEmail(process.env.CAP_FOUNDER_EMAIL);
  if (!email) {
    log("Founder account not configured. CAP_FOUNDER_EMAIL is missing.");
    return "";
  }
  if (!isValidEmail(email)) {
    log("Founder account not configured. CAP_FOUNDER_EMAIL is invalid.");
    return "";
  }
  return email;
}

function bestFounderCreatorFor(user) {
  const owned = user?.id ? get("SELECT * FROM creators WHERE user_id = ? ORDER BY id LIMIT 1", [user.id]) : null;
  if (owned) return owned;

  const profile = get("SELECT * FROM founder_profile WHERE id = 1");
  const candidates = [];
  if (profile?.name) candidates.push(["lower(name) = lower(?)", profile.name]);
  if (profile?.handle) candidates.push(["lower(handle) = lower(?)", profile.handle]);
  candidates.push(["lower(name) = lower(?)", "Lorenzo Lewis"]);

  for (const [where, value] of candidates) {
    const creator = get(`
      SELECT c.*, u.account_type AS owner_account_type
      FROM creators c
      LEFT JOIN users u ON u.id = c.user_id
      WHERE ${where}
      ORDER BY c.id
      LIMIT 1
    `, [value]);
    if (creator && (!creator.user_id || creator.owner_account_type === "founder")) return creator;
  }
  return null;
}

function linkFounderCreator(user) {
  if (get("SELECT id FROM creators WHERE user_id = ? ORDER BY id LIMIT 1", [user.id])) return;
  const creator = bestFounderCreatorFor(user);
  if (creator && (!creator.user_id || Number(creator.user_id) !== Number(user.id))) {
    run("UPDATE creators SET user_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?", [user.id, creator.id]);
    log("Linked legacy founder creator profile to configured founder account.");
  }
}

function initializeFounderUser() {
  const email = configuredFounderEmail();
  const password = String(process.env.CAP_FOUNDER_PASSWORD || "");
  if (!email) return;

  let founderUser = get("SELECT * FROM users WHERE email = ?", [email]);
  if (founderUser) {
    if (founderUser.account_type !== "founder" || !founderUser.is_admin || founderUser.status !== "active") {
      run("UPDATE users SET account_type = 'founder', is_admin = 1, status = 'active', updated_at = CURRENT_TIMESTAMP WHERE id = ?", [founderUser.id]);
      log("Founder account promoted from existing configured user.");
      founderUser = get("SELECT * FROM users WHERE id = ?", [founderUser.id]);
    }
  } else {
    if (password.length < 10) {
      log("Founder account not created. CAP_FOUNDER_PASSWORD is required and must be at least 10 characters when the configured founder user does not exist.");
      return;
    }
    const founderCreator = bestFounderCreatorFor({ id: 0 });
    const displayName = founderCreator?.name || "Lorenzo Lewis";
    const result = run(
      "INSERT INTO users (email, password_hash, display_name, account_type, is_admin, status) VALUES (?, ?, ?, 'founder', 1, 'active')",
      [email, hashPassword(password), displayName]
    );
    founderUser = get("SELECT * FROM users WHERE id = ?", [Number(result.lastInsertRowid)]);
    log("Founder account created from CAP_FOUNDER_EMAIL.");
  }

  if (!founderUser) return;

  const duplicateFounders = all("SELECT id FROM users WHERE account_type = 'founder' AND id != ? ORDER BY id", [founderUser.id]);
  for (const duplicate of duplicateFounders) {
    run("UPDATE users SET account_type = 'creator', updated_at = CURRENT_TIMESTAMP WHERE id = ?", [duplicate.id]);
    log("Duplicate founder account demoted to creator account type.");
  }

  if (!founderUser.is_admin || founderUser.status !== "active" || founderUser.account_type !== "founder") {
    run("UPDATE users SET account_type = 'founder', is_admin = 1, status = 'active', updated_at = CURRENT_TIMESTAMP WHERE id = ?", [founderUser.id]);
    founderUser = get("SELECT * FROM users WHERE id = ?", [founderUser.id]);
  }

  linkFounderCreator(founderUser);
}

function assertNotFounderRegistrationEmail(email) {
  const founderEmail = normalizeEmail(process.env.CAP_FOUNDER_EMAIL);
  if (!founderEmail || !isValidEmail(founderEmail)) return;
  if (normalizeEmail(email) === founderEmail) {
    const error = new Error("The configured founder email cannot be registered publicly.");
    error.status = 409;
    throw error;
  }
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

function userSettingKey(user, key) {
  return user?.id ? `user:${user.id}:${key}` : key;
}

function setRecentActivity(type, id, label, user = null) {
  setSetting(userSettingKey(user, "lastActivity"), { type, id, label, at: new Date().toISOString() });
}

function markCreatorViewed(creatorId, user = null) {
  const settings = getSettings();
  let viewed = [];
  try {
    viewed = JSON.parse(settings[userSettingKey(user, "viewedCreators")] || settings.viewedCreators || "[]");
  } catch {
    viewed = [];
  }
  viewed = [Number(creatorId), ...viewed.filter((id) => Number(id) !== Number(creatorId))].slice(0, 50);
  setSetting(userSettingKey(user, "viewedCreators"), viewed);
}

function uploadError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function readJson(request, maxBytes = maxJsonBytes) {
  return new Promise((resolve, reject) => {
    const contentType = String(request.headers["content-type"] || "");
    if (!contentType.includes("application/json")) {
      const error = new Error("Expected application/json request body.");
      error.status = 415;
      reject(error);
      return;
    }
    let body = "";
    let tooLarge = false;
    request.on("data", (chunk) => {
      if (tooLarge) return;
      body += chunk;
      if (Buffer.byteLength(body) > maxBytes) {
        tooLarge = true;
        body = "";
      }
    });
    request.on("end", () => {
      try {
        if (tooLarge) throw uploadError("Request payload is too large.", 413);
        resolve(body ? JSON.parse(body) : {});
      } catch (error) {
        reject(error.status ? error : uploadError("Malformed upload payload."));
      }
    });
    request.on("error", reject);
  });
}

function json(response, status, payload, headers = {}) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-cache",
    ...headers
  });
  response.end(JSON.stringify(payload));
}

function notFound(response) {
  json(response, 404, { error: "Not found" });
}

function sanitizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function clientKey(request, scope) {
  const forwarded = String(request.headers["x-forwarded-for"] || "").split(",")[0].trim();
  const ip = isHosted && forwarded ? forwarded : (request.socket.remoteAddress || "local");
  return `${scope}:${ip}`;
}

function checkRateLimit(request, scope) {
  const now = Date.now();

  // Best-effort pruning to avoid unbounded growth.
  if (authAttempts.size > 1000) {
    for (const [key, entry] of authAttempts) {
      if (entry.resetAt <= now) authAttempts.delete(key);
    }
  }

  const key = clientKey(request, scope);
  const current = authAttempts.get(key) || { count: 0, resetAt: now + authLimitWindowMs };
  if (current.resetAt <= now) {
    current.count = 0;
    current.resetAt = now + authLimitWindowMs;
  }
  current.count += 1;
  authAttempts.set(key, current);
  if (current.count > authLimitMax) {
    const error = new Error("Too many attempts. Please try again later.");
    error.status = 429;
    throw error;
  }
}

function assertSafeMutationOrigin(request) {
  const method = request.method || "GET";
  if (!["POST", "PUT", "PATCH", "DELETE"].includes(method)) return;
  const origin = request.headers.origin;
  if (!origin) return;
  const requestHost = String(request.headers.host || "").toLowerCase();
  try {
    const originHost = new URL(origin).host.toLowerCase();
    if (originHost !== requestHost) {
      const error = new Error("Request origin is not allowed.");
      error.status = 403;
      throw error;
    }
  } catch (error) {
    if (error.status) throw error;
    const blocked = new Error("Request origin is not allowed.");
    blocked.status = 403;
    throw blocked;
  }
}

function imageTypeFromMime(mime) {
  const allowed = new Map([
    ["image/png", "png"],
    ["image/jpeg", "jpg"],
    ["image/jpg", "jpg"],
    ["image/webp", "webp"]
  ]);
  return allowed.get(sanitizeText(mime).toLowerCase()) || "";
}

function imageTypeFromExtension(name) {
  const extension = path.extname(sanitizeText(name)).toLowerCase().replace(".", "");
  if (extension === "jpeg") return "jpg";
  return ["png", "jpg", "webp"].includes(extension) ? extension : "";
}

function uploadExtension(name, type, dataMime) {
  const extensionType = imageTypeFromExtension(name);
  const declaredType = imageTypeFromMime(type);
  const dataType = imageTypeFromMime(dataMime);
  if (!declaredType || !dataType || !extensionType) return "";
  if (declaredType !== dataType) return "";
  if (extensionType !== dataType) return "";
  return dataType;
}

function saveUploadedImage(payload) {
  const dataUrl = sanitizeText(payload.data);
  const match = dataUrl.match(/^data:([^;]+);base64,([A-Za-z0-9+/=\r\n]*)$/);
  if (!match) throw uploadError("Malformed upload payload.");
  const extension = uploadExtension(payload.name, payload.type, match[1]);
  if (!extension) throw uploadError("Unsupported image type. Please choose a PNG, JPG, JPEG, or WebP image.");
  const imageBuffer = Buffer.from(match[2], "base64");
  if (!imageBuffer.length) throw uploadError("The selected image is empty.");
  if (imageBuffer.length > maxDecodedImageBytes) throw uploadError("Image must be 15 MB or smaller.", 413);
  const filename = `${Date.now()}-${crypto.randomUUID()}.${extension}`;
  const absolutePath = path.join(uploadDir, filename);
  try {
    fs.mkdirSync(uploadDir, { recursive: true });
    fs.writeFileSync(absolutePath, imageBuffer);
  } catch {
    throw uploadError("Upload storage write failed.", 500);
  }
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

function saveKeyValues(values, user = null) {
  for (const [key, value] of Object.entries(values)) {
    setSetting(userSettingKey(user, key), String(value ?? ""));
  }
}

function rowIdFromUrl(url, prefix) {
  const match = url.pathname.match(new RegExp(`^/api/${prefix}/(\\d+)(?:/(.*))?$`));
  return match ? { id: Number(match[1]), rest: match[2] || "" } : null;
}

function splitTerms(value) {
  return String(value || "")
    .split(/[\n,|]/)
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

function termMatches(a, b) {
  const left = splitTerms(a);
  const right = splitTerms(b);
  return [...new Set(left.filter((term) => right.some((other) => other.includes(term) || term.includes(other))))];
}

function platformTerms(creator) {
  if (!creator?.id) return "";
  return all("SELECT platform, url FROM platform_links WHERE creator_id = ? ORDER BY id", [creator.id])
    .flatMap((item) => [item.platform, item.url])
    .join(", ");
}

function invalidateDiscovery(user = null) {
  if (user?.id) discoveryCache.delete(user.id);
  else discoveryCache.clear();
}

function getDiscoveryQueue(user, force = false) {
  if (!user?.id) return [];
  if (!force && discoveryCache.has(user.id)) return discoveryCache.get(user.id);

  const myCreator = get("SELECT * FROM creators WHERE user_id = ? ORDER BY id LIMIT 1", [user.id]);
  const settings = getUserSettings(user);
  const myPlatforms = `${platformTerms(myCreator || {})} ${settings.platforms || ""}`;
  const saved = new Set(all("SELECT creator_id FROM saved_creators WHERE user_id = ?", [user.id]).map((row) => Number(row.creator_id)));
  const viewed = new Set(all("SELECT creator_id FROM creator_views WHERE viewer_user_id = ?", [user.id]).map((row) => Number(row.creator_id)));
  const hidden = new Set(all("SELECT creator_id FROM creator_hides WHERE user_id = ?", [user.id]).map((row) => Number(row.creator_id)));
  const followed = new Set(all("SELECT creator_id FROM creator_follows WHERE follower_user_id = ?", [user.id]).map((row) => Number(row.creator_id)));

  const rows = all(`
    SELECT c.*
    FROM creators c
    LEFT JOIN users u ON u.id = c.user_id
    WHERE COALESCE(u.status, 'active') = 'active'
    ORDER BY c.updated_at DESC, c.id DESC
  `);

  const recommendations = rows
    .filter((creator) => !(myCreator && creator.id === myCreator.id) && !hidden.has(creator.id))
    .map((creator) => {
      const reasons = [];
      let score = 0;
      if (viewed.has(creator.id)) score -= 20;
      if (saved.has(creator.id)) score -= 35;

      if (myCreator?.category && creator.category && myCreator.category.toLowerCase() === creator.category.toLowerCase()) {
        score += 40;
        reasons.push("same category");
      }
      const skills = termMatches(`${myCreator?.skills || ""},${settings.skills || ""}`, creator.skills);
      if (skills.length) {
        score += 30;
        reasons.push(`skills: ${skills.slice(0, 3).join(", ")}`);
      }
      const collabs = termMatches(`${myCreator?.collaboration_interests || ""},${settings.collaborationInterests || ""},${settings.collaborationNeeds || ""}`, `${creator.collaboration_interests} ${creator.looking_for} ${creator.description}`);
      if (collabs.length) {
        score += 25;
        reasons.push(`interests: ${collabs.slice(0, 3).join(", ")}`);
      }
      if ((myCreator?.location || settings.location) && creator.location && String(myCreator?.location || settings.location).trim().toLowerCase() === creator.location.trim().toLowerCase()) {
        score += 20;
        reasons.push("same location");
      }
      if (myCreator?.role && creator.role && myCreator.role.toLowerCase() === creator.role.toLowerCase()) {
        score += 15;
        reasons.push("same role");
      }
      const platforms = termMatches(myPlatforms, platformTerms(creator));
      if (platforms.length) {
        score += 10;
        reasons.push(`platforms: ${platforms.slice(0, 2).join(", ")}`);
      }

      return {
        ...creatorWithRelations(creator, user),
        score,
        discoveryScore: score,
        discoveryReasons: reasons,
        viewed: viewed.has(creator.id),
        followed: followed.has(creator.id)
      };
    })
    .sort((a, b) => b.score - a.score || new Date(b.updated_at || b.created_at).getTime() - new Date(a.updated_at || a.created_at).getTime());

  discoveryCache.set(user.id, recommendations);
  return recommendations;
}

function discoveryHomeWidgets(user) {
  const queue = getDiscoveryQueue(user);
  const myCreator = user ? get("SELECT * FROM creators WHERE user_id = ? ORDER BY id LIMIT 1", [user.id]) : null;
  const hidden = new Set(user ? all("SELECT creator_id FROM creator_hides WHERE user_id = ?", [user.id]).map((row) => Number(row.creator_id)) : []);
  const visible = (creator) => !(myCreator && Number(creator.id) === Number(myCreator.id)) && !hidden.has(Number(creator.id));
  const recent = all(`
    SELECT c.*
    FROM creators c
    LEFT JOIN users u ON u.id = c.user_id
    WHERE COALESCE(u.status, 'active') = 'active'
    ORDER BY c.created_at DESC, c.id DESC
    LIMIT 12
  `).filter(visible).slice(0, 4).map((row) => creatorWithRelations(row, user));
  return {
    recommendedCreators: queue.slice(0, 4),
    peopleNearYourInterests: queue.filter((creator) => (creator.discoveryReasons || []).some((reason) => /skills|interests|platforms/.test(reason))).slice(0, 4),
    newCreators: recent,
    recentlyJoined: recent,
    trendingCreators: all(`
      SELECT c.*, COUNT(v.id) + COUNT(f.id) * 2 + COUNT(s.id) AS trend_score
      FROM creators c
      LEFT JOIN users u ON u.id = c.user_id
      LEFT JOIN creator_views v ON v.creator_id = c.id
      LEFT JOIN creator_follows f ON f.creator_id = c.id
      LEFT JOIN saved_creators s ON s.creator_id = c.id
      WHERE COALESCE(u.status, 'active') = 'active'
      GROUP BY c.id
      ORDER BY trend_score DESC, c.updated_at DESC, c.id DESC
      LIMIT 12
    `).filter(visible).slice(0, 4).map((row) => creatorWithRelations(row, user))
  };
}

function creatorSocialContext(creator, user) {
  if (!creator) return {};
  const myCreator = user ? get("SELECT * FROM creators WHERE user_id = ? ORDER BY id LIMIT 1", [user.id]) : null;
  const followers = get("SELECT COUNT(*) AS count FROM creator_follows WHERE creator_id = ?", [creator.id]).count;
  const following = creator.user_id ? get("SELECT COUNT(*) AS count FROM creator_follows WHERE follower_user_id = ?", [creator.user_id]).count : 0;
  const myCircles = myCreator ? new Set(all("SELECT circle_id FROM circle_membership WHERE creator_id = ?", [myCreator.id]).map((row) => Number(row.circle_id))) : new Set();
  const theirCircles = all(`
    SELECT c.id, c.name
    FROM circle_membership m
    JOIN creator_circles c ON c.id = m.circle_id
    WHERE m.creator_id = ?
  `, [creator.id]);
  return {
    followers,
    following,
    mutualCircles: theirCircles.filter((circle) => myCircles.has(Number(circle.id))),
    mutualSkills: termMatches(myCreator?.skills || "", creator.skills),
    sharedInterests: termMatches(myCreator?.collaboration_interests || "", creator.collaboration_interests)
  };
}

function creatorWithRelations(row, user = null) {
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
    saved: Boolean(user ? get("SELECT creator_id FROM saved_creators WHERE user_id = ? AND creator_id = ?", [user.id, row.id]) : null),
    followed: Boolean(user ? get("SELECT creator_id FROM creator_follows WHERE follower_user_id = ? AND creator_id = ?", [user.id, row.id]) : null),
    ownedByCurrentUser: Boolean(user && row.user_id === user.id),
    social: creatorSocialContext(row, user)
  };
}

function getUserSettings(user) {
  const settings = getSettings();
  if (!user?.id) return settings;
  const scopedPrefix = `user:${user.id}:`;
  const scoped = {};
  for (const [key, value] of Object.entries(settings)) {
    if (key.startsWith(scopedPrefix)) scoped[key.slice(scopedPrefix.length)] = value;
  }
  return { ...settings, ...scoped };
}

function profileComplete(creator) {
  if (!creator) return false;
  return Boolean(creator.name && creator.handle && creator.role && creator.category && creator.description);
}

function getState(user) {
  const creators = all("SELECT * FROM creators ORDER BY created_at DESC, id DESC").map((row) => creatorWithRelations(row, user));
  const myCreator = user ? get("SELECT * FROM creators WHERE user_id = ? ORDER BY id LIMIT 1", [user.id]) : null;
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
    WHERE (? = 1 OR cr.requester_user_id = ? OR cr.creator_id = ?)
    ORDER BY cr.created_at DESC, cr.id DESC
  `, [user?.is_admin ? 1 : 0, user?.id || 0, myCreator?.id || 0]);
  const messages = all(`
    SELECT m.*, c.name AS creator_name
    FROM messages m
    LEFT JOIN creators c ON c.id = m.creator_id
    WHERE (? = 1 OR m.sender_user_id = ? OR m.recipient_user_id = ? OR m.creator_id = ?)
    ORDER BY m.created_at DESC, m.id DESC
  `, [user?.is_admin ? 1 : 0, user?.id || 0, user?.id || 0, myCreator?.id || 0]);
  const activity = all(`
    SELECT * FROM contribution_activity
    WHERE (? = 1 OR user_id = ? OR user_id IS NULL)
    ORDER BY created_at DESC, id DESC LIMIT 20
  `, [user?.is_admin ? 1 : 0, user?.id || 0]);
  const profile = get("SELECT * FROM founder_profile WHERE id = 1") || null;
  const savedCount = user ? get("SELECT COUNT(*) AS count FROM saved_creators WHERE user_id = ?", [user.id]).count : 0;
  const activeCollaborations = get(`
    SELECT COUNT(*) AS count FROM collaboration_requests
    WHERE status != 'Completed' AND (? = 1 OR requester_user_id = ? OR creator_id = ?)
  `, [user?.is_admin ? 1 : 0, user?.id || 0, myCreator?.id || 0]).count;
  const contributionPoints = get("SELECT COALESCE(SUM(points), 0) AS count FROM contribution_activity WHERE (? = 1 OR user_id = ?)", [user?.is_admin ? 1 : 0, user?.id || 0]).count;
  const circleCreators = myCreator ? get("SELECT COUNT(DISTINCT creator_id) AS count FROM circle_membership WHERE creator_id = ?", [myCreator.id]).count : 0;
  const settings = getUserSettings(user);
  const admin = user?.is_admin ? {
    users: {
      founderProfileComplete: Boolean(profile && profile.name),
      creatorProfiles: get("SELECT COUNT(*) AS count FROM creators").count,
      savedCreators: get("SELECT COUNT(*) AS count FROM saved_creators").count,
      registeredUsers: get("SELECT COUNT(*) AS count FROM users").count
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
      contributionPoints,
      mostViewedCreators: all(`
        SELECT c.id, c.name, COUNT(v.id) AS count
        FROM creator_views v
        JOIN creators c ON c.id = v.creator_id
        GROUP BY c.id
        ORDER BY count DESC, c.updated_at DESC
        LIMIT 5
      `),
      mostFollowedCreators: all(`
        SELECT c.id, c.name, COUNT(f.id) AS count
        FROM creator_follows f
        JOIN creators c ON c.id = f.creator_id
        GROUP BY c.id
        ORDER BY count DESC, c.updated_at DESC
        LIMIT 5
      `),
      mostSavedCreators: all(`
        SELECT c.id, c.name, COUNT(s.creator_id) AS count
        FROM saved_creators s
        JOIN creators c ON c.id = s.creator_id
        GROUP BY c.id
        ORDER BY count DESC, c.updated_at DESC
        LIMIT 5
      `),
      fastestGrowingCreators: all(`
        SELECT c.id, c.name, COUNT(f.id) + COUNT(v.id) AS count
        FROM creators c
        LEFT JOIN creator_follows f ON f.creator_id = c.id AND f.followed_at >= datetime('now', '-7 days')
        LEFT JOIN creator_views v ON v.creator_id = c.id AND v.viewed_at >= datetime('now', '-7 days')
        GROUP BY c.id
        ORDER BY count DESC, c.created_at DESC
        LIMIT 5
      `)
    },
    systemHealth: {
      dataDirectory: isHosted ? "configured persistent storage" : "local app data",
      status: "OK"
    }
  } : null;

  return {
    profile: user?.is_admin ? profile : {
      id: myCreator?.id || null,
      name: user?.display_name || "",
      handle: myCreator?.handle || "",
      role: myCreator?.role || "",
      bio: myCreator?.description || "",
      image: myCreator?.image || "",
      mission: settings.mission || ""
    },
    myCreator: myCreator ? creatorWithRelations(myCreator, user) : null,
    creators,
    discovery: getDiscoveryQueue(user),
    homeRecommendations: discoveryHomeWidgets(user),
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
    currentUser: safeUser(user),
    admin
  };
}

function saveProfile(payload, user = null) {
  if (user) requireAdmin(user);
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
    run("INSERT INTO contribution_activity (actor, action, points, user_id) VALUES (?, ?, ?, ?)", [
      sanitizeText(payload.name),
      "updated the founder profile",
      5,
      user?.id || null
    ]);
    setRecentActivity("settings", 1, "Founder profile", user);
  }
}

function saveCreator(payload, id = null, user = null, options = {}) {
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
    const existing = get("SELECT * FROM creators WHERE id = ?", [creatorId]);
    if (!existing) throw new Error("Creator was not found.");
    if (!options.admin && user) {
      if (!existing.user_id || existing.user_id !== user.id) {
        const error = new Error("You can only edit your own creator profile.");
        error.status = 403;
        throw error;
      }
    }
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
       (name, handle, role, category, description, image, banner, skills, location, portfolio, collaboration_interests, looking_for, user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [...values, user?.id || null]
    );
    creatorId = Number(result.lastInsertRowid);
  }

  for (const item of listFromLines(payload.platforms)) {
    run("INSERT INTO platform_links (creator_id, platform, url) VALUES (?, ?, ?)", [creatorId, item.platform, item.url]);
  }
  for (const item of videosFromLines(payload.videos)) {
    run("INSERT INTO featured_videos (creator_id, title, url) VALUES (?, ?, ?)", [creatorId, item.title, item.url]);
  }

  run("INSERT INTO contribution_activity (actor, action, points, user_id) VALUES (?, ?, ?, ?)", [values[0], id ? "updated a creator profile" : "joined the creator directory", id ? 3 : 10, user?.id || null]);
  setRecentActivity("creator", creatorId, values[0], user);
  return creatorId;
}

function saveMyProfile(payload, user) {
  const name = sanitizeText(payload.name);
  if (!name) throw new Error("Creator name is required.");

  if (user?.is_admin) saveProfile({
    name,
    handle: sanitizeText(payload.handle),
    role: sanitizeText(payload.role) || "Founder",
    bio: sanitizeText(payload.bio),
    image: sanitizeText(payload.image),
    mission: sanitizeText(payload.mission)
  });

  run("UPDATE users SET display_name = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?", [name, user.id]);
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
  }, user);

  const existing = get("SELECT id FROM creators WHERE user_id = ? ORDER BY id LIMIT 1", [user.id]);
  const existingId = Number(existing?.id || 0);
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
  const creatorId = saveCreator(creatorPayload, existingId || null, user);
  setRecentActivity("profile", creatorId, name, user);
  invalidateDiscovery(user);
}

function saveCircle(payload, user) {
  const name = sanitizeText(payload.name);
  if (!name) throw new Error("Circle name is required.");
  const result = run("INSERT INTO creator_circles (name, detail, accent, owner_user_id) VALUES (?, ?, ?, ?)", [
    name,
    sanitizeText(payload.detail),
    sanitizeText(payload.accent) || "violet",
    user?.id || null
  ]);
  run("INSERT INTO contribution_activity (actor, action, points, user_id) VALUES (?, ?, ?, ?)", [name, "circle created", 8, user?.id || null]);
  setRecentActivity("circle", Number(result.lastInsertRowid), name, user);
  return Number(result.lastInsertRowid);
}

async function handleAuth(request, response, url) {
  if (request.method === "GET" && url.pathname === "/api/auth/me") {
    return json(response, 200, { user: safeUser(currentUserFromRequest(request)) });
  }

  if (request.method === "POST" && url.pathname === "/api/auth/register") {
    assertSafeMutationOrigin(request);
    checkRateLimit(request, "register");
    const payload = await readJson(request);
    const email = normalizeEmail(payload.email);
    const password = String(payload.password || "");
    const displayName = sanitizeText(payload.displayName);
    if (!isValidEmail(email)) throw new Error("Enter a valid email address.");
    assertNotFounderRegistrationEmail(email);
    if (!displayName) throw new Error("Display name is required.");
    if (password.length < 10) throw new Error("Password must be at least 10 characters.");
    if (get("SELECT id FROM users WHERE email = ?", [email])) {
      const error = new Error("An account with that email already exists.");
      error.status = 409;
      throw error;
    }
    const result = run(
      "INSERT INTO users (email, password_hash, display_name, account_type, is_admin) VALUES (?, ?, ?, 'creator', 0)",
      [email, hashPassword(password), displayName]
    );
    const userId = Number(result.lastInsertRowid);
    run("UPDATE users SET last_login_at = CURRENT_TIMESTAMP WHERE id = ?", [userId]);
    createSession(response, request, userId);
    return json(response, 200, { user: safeUser(get("SELECT * FROM users WHERE id = ?", [userId])) });
  }

  if (request.method === "POST" && url.pathname === "/api/auth/login") {
    assertSafeMutationOrigin(request);
    checkRateLimit(request, "login");
    const payload = await readJson(request);
    const email = normalizeEmail(payload.email);
    const password = String(payload.password || "");
    const user = get("SELECT * FROM users WHERE email = ?", [email]);
    if (!user || user.status !== "active" || !verifyPassword(password, user.password_hash)) {
      const error = new Error("Invalid email or password.");
      error.status = 401;
      throw error;
    }
    run("UPDATE users SET last_login_at = CURRENT_TIMESTAMP WHERE id = ?", [user.id]);
    createSession(response, request, user.id);
    return json(response, 200, { user: safeUser(user) });
  }

  if (request.method === "POST" && url.pathname === "/api/auth/logout") {
    assertSafeMutationOrigin(request);
    const token = parseCookies(request)[sessionCookieName];
    if (token) run("DELETE FROM sessions WHERE token_hash = ?", [tokenHash(token)]);
    return json(response, 200, { ok: true }, { "Set-Cookie": clearSessionCookie() });
  }

  return null;
}

async function updateAccount(payload, user) {
  const displayName = sanitizeText(payload.displayName);
  const email = normalizeEmail(payload.email);
  if (!displayName) throw new Error("Display name is required.");
  if (!isValidEmail(email)) throw new Error("Enter a valid email address.");
  const duplicate = get("SELECT id FROM users WHERE email = ? AND id != ?", [email, user.id]);
  if (duplicate) {
    const error = new Error("That email address is already in use.");
    error.status = 409;
    throw error;
  }
  run("UPDATE users SET email = ?, display_name = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?", [email, displayName, user.id]);
  const currentPassword = String(payload.currentPassword || "");
  const newPassword = String(payload.newPassword || "");
  if (newPassword || currentPassword) {
    const current = get("SELECT password_hash FROM users WHERE id = ?", [user.id]);
    if (!verifyPassword(currentPassword, current.password_hash)) {
      const error = new Error("Current password is incorrect.");
      error.status = 403;
      throw error;
    }
    if (newPassword.length < 10) throw new Error("New password must be at least 10 characters.");
    run("UPDATE users SET password_hash = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?", [hashPassword(newPassword), user.id]);
  }
}

async function handleApi(request, response, url) {
  try {
    const authResult = await handleAuth(request, response, url);
    if (authResult !== null) return authResult;

    if (["POST", "PUT", "PATCH", "DELETE"].includes(request.method || "GET")) assertSafeMutationOrigin(request);
    const user = requireUser(request);

    if (request.method === "GET" && url.pathname === "/api/state") return json(response, 200, getState(user));

    if (request.method === "GET" && url.pathname === "/api/discovery") {
      return json(response, 200, { recommendations: getDiscoveryQueue(user, url.searchParams.get("refresh") === "1") });
    }

    if (request.method === "POST" && url.pathname === "/api/uploads") {
      const storedPath = saveUploadedImage(await readJson(request, maxUploadJsonBytes));
      return json(response, 200, { path: storedPath });
    }

    if (request.method === "POST" && url.pathname === "/api/profile") {
      saveProfile(await readJson(request), user);
      return json(response, 200, getState(user));
    }

    if (request.method === "POST" && url.pathname === "/api/my-profile") {
      saveMyProfile(await readJson(request), user);
      invalidateDiscovery(user);
      return json(response, 200, getState(user));
    }

    if (request.method === "POST" && url.pathname === "/api/creators") {
      saveCreator(await readJson(request), null, user);
      invalidateDiscovery();
      return json(response, 200, getState(user));
    }

    const creatorRoute = rowIdFromUrl(url, "creators");
    if (creatorRoute && request.method === "PUT") {
      saveCreator(await readJson(request), creatorRoute.id, user, { admin: Boolean(user.is_admin) });
      invalidateDiscovery();
      return json(response, 200, getState(user));
    }
    if (creatorRoute && request.method === "DELETE") {
      requireAdmin(user);
      run("DELETE FROM creators WHERE id = ?", [creatorRoute.id]);
      return json(response, 200, getState(user));
    }

    if (request.method === "POST" && url.pathname === "/api/circles") {
      saveCircle(await readJson(request), user);
      invalidateDiscovery();
      return json(response, 200, getState(user));
    }

    const circleRoute = rowIdFromUrl(url, "circles");
    if (circleRoute && request.method === "POST" && circleRoute.rest === "members") {
      const payload = await readJson(request);
      const creatorId = Number(payload.creatorId);
      if (!creatorId) throw new Error("Creator is required.");
      run("INSERT OR IGNORE INTO circle_membership (circle_id, creator_id) VALUES (?, ?)", [circleRoute.id, creatorId]);
      const circle = get("SELECT name FROM creator_circles WHERE id = ?", [circleRoute.id]);
      const creator = get("SELECT name FROM creators WHERE id = ?", [creatorId]);
      if (circle && creator) run("INSERT INTO contribution_activity (actor, action, points, user_id) VALUES (?, ?, ?, ?)", [creator.name, `joined ${circle.name}`, 5, user.id]);
      if (circle) setRecentActivity("circle", circleRoute.id, circle.name, user);
      invalidateDiscovery();
      return json(response, 200, getState(user));
    }

    if (request.method === "POST" && url.pathname === "/api/saved") {
      const payload = await readJson(request);
      const creatorId = Number(payload.creatorId);
      if (!creatorId) throw new Error("Creator is required.");
      const existing = get("SELECT creator_id FROM saved_creators WHERE user_id = ? AND creator_id = ?", [user.id, creatorId]);
      if (existing) run("DELETE FROM saved_creators WHERE user_id = ? AND creator_id = ?", [user.id, creatorId]);
      else {
        run("INSERT INTO saved_creators (user_id, creator_id) VALUES (?, ?)", [user.id, creatorId]);
        const creator = get("SELECT name FROM creators WHERE id = ?", [creatorId]);
        if (creator) run("INSERT INTO contribution_activity (actor, action, points, user_id) VALUES (?, ?, ?, ?)", [creator.name, "saved for follow-up", 2, user.id]);
      }
      const creator = get("SELECT name FROM creators WHERE id = ?", [creatorId]);
      if (creator) setRecentActivity("creator", creatorId, creator.name, user);
      invalidateDiscovery(user);
      return json(response, 200, getState(user));
    }

    if ((request.method === "POST" && url.pathname === "/api/viewed") || (request.method === "POST" && url.pathname === "/api/view")) {
      const payload = await readJson(request);
      const creatorId = Number(payload.creatorId);
      if (!creatorId) throw new Error("Creator is required.");
      const creator = get("SELECT name FROM creators WHERE id = ?", [creatorId]);
      if (creator) {
        run("INSERT INTO creator_views (viewer_user_id, creator_id) VALUES (?, ?)", [user.id, creatorId]);
        markCreatorViewed(creatorId, user);
        setRecentActivity("creator", creatorId, creator.name, user);
      }
      invalidateDiscovery(user);
      return json(response, 200, getState(user));
    }

    if (request.method === "POST" && url.pathname === "/api/follow") {
      const payload = await readJson(request);
      const creatorId = Number(payload.creatorId);
      if (!creatorId) throw new Error("Creator is required.");
      const myCreator = get("SELECT id FROM creators WHERE user_id = ? ORDER BY id LIMIT 1", [user.id]);
      if (myCreator && Number(myCreator.id) === creatorId) {
        const error = new Error("You cannot follow yourself.");
        error.status = 400;
        throw error;
      }
      const creator = get("SELECT name FROM creators WHERE id = ?", [creatorId]);
      if (!creator) throw new Error("Creator was not found.");
      const existing = get("SELECT id FROM creator_follows WHERE follower_user_id = ? AND creator_id = ?", [user.id, creatorId]);
      if (existing) run("DELETE FROM creator_follows WHERE id = ?", [existing.id]);
      else {
        run("INSERT INTO creator_follows (follower_user_id, creator_id) VALUES (?, ?)", [user.id, creatorId]);
        run("INSERT INTO contribution_activity (actor, action, points, user_id) VALUES (?, ?, ?, ?)", [creator.name, "gained a follower", 2, user.id]);
      }
      invalidateDiscovery(user);
      return json(response, 200, getState(user));
    }

    if (request.method === "POST" && url.pathname === "/api/hide") {
      const payload = await readJson(request);
      const creatorId = Number(payload.creatorId);
      if (!creatorId) throw new Error("Creator is required.");
      run("INSERT OR IGNORE INTO creator_hides (user_id, creator_id) VALUES (?, ?)", [user.id, creatorId]);
      invalidateDiscovery(user);
      return json(response, 200, getState(user));
    }

    if (request.method === "POST" && url.pathname === "/api/support") {
      const payload = await readJson(request);
      const creatorId = Number(payload.creatorId);
      if (!creatorId) throw new Error("Creator is required.");
      const creator = get("SELECT name FROM creators WHERE id = ?", [creatorId]);
      if (!creator) throw new Error("Creator was not found.");
      run("INSERT INTO contribution_activity (actor, action, points, user_id) VALUES (?, ?, ?, ?)", [creator.name, "received creator support", 5, user.id]);
      run("INSERT INTO messages (creator_id, sender_user_id, subject, body, direction) VALUES (?, ?, ?, ?, ?)", [
        creatorId,
        user.id,
        "Creator support",
        "Support noted locally from the CAP homepage.",
        "sent"
      ]);
      setRecentActivity("creator", creatorId, creator.name, user);
      return json(response, 200, getState(user));
    }

    if (request.method === "POST" && url.pathname === "/api/collaborations") {
      const payload = await readJson(request);
      const title = sanitizeText(payload.title);
      if (!title) throw new Error("Collaboration title is required.");
      const creatorId = payload.creatorId ? Number(payload.creatorId) : null;
      run("INSERT INTO collaboration_requests (creator_id, requester_user_id, title, message, status, progress) VALUES (?, ?, ?, ?, ?, ?)", [
        creatorId,
        user.id,
        title,
        sanitizeText(payload.message),
        sanitizeText(payload.status) || "Requested",
        Math.max(0, Math.min(100, Number(payload.progress) || 0))
      ]);
      run("INSERT INTO contribution_activity (actor, action, points, user_id) VALUES (?, ?, ?, ?)", [title, "collaboration request created", 12, user.id]);
      const row = get("SELECT id FROM collaboration_requests ORDER BY id DESC LIMIT 1");
      setRecentActivity("collaboration", row.id, title, user);
      invalidateDiscovery();
      return json(response, 200, getState(user));
    }

    if (request.method === "POST" && url.pathname === "/api/messages") {
      const payload = await readJson(request);
      const body = sanitizeText(payload.body);
      if (!body) throw new Error("Message body is required.");
      run("INSERT INTO messages (creator_id, sender_user_id, subject, body, direction) VALUES (?, ?, ?, ?, ?)", [
        payload.creatorId ? Number(payload.creatorId) : null,
        user.id,
        sanitizeText(payload.subject),
        body,
        sanitizeText(payload.direction) || "sent"
      ]);
      run("INSERT INTO contribution_activity (actor, action, points, user_id) VALUES (?, ?, ?, ?)", [sanitizeText(payload.subject) || "Message", "local message sent", 2, user.id]);
      const row = get("SELECT id FROM messages ORDER BY id DESC LIMIT 1");
      setRecentActivity("message", row.id, sanitizeText(payload.subject) || "Message", user);
      return json(response, 200, getState(user));
    }

    if (request.method === "POST" && url.pathname === "/api/settings") {
      const payload = await readJson(request);
      for (const [key, value] of Object.entries(payload)) {
        run("INSERT INTO application_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [
          userSettingKey(user, sanitizeText(key)),
          String(value ?? "")
        ]);
      }
      setRecentActivity("settings", 1, "Application settings", user);
      invalidateDiscovery(user);
      return json(response, 200, getState(user));
    }

    if (request.method === "POST" && url.pathname === "/api/account") {
      await updateAccount(await readJson(request), user);
      return json(response, 200, { user: safeUser(get("SELECT * FROM users WHERE id = ?", [user.id])) });
    }

    if (request.method === "GET" && url.pathname === "/api/admin/users") {
      requireAdmin(user);
      return json(response, 200, {
        users: all("SELECT id, email, display_name AS displayName, account_type AS accountType, is_admin AS isAdmin, status, created_at AS createdAt, last_login_at AS lastLoginAt FROM users ORDER BY created_at DESC")
      });
    }

    return notFound(response);
  } catch (error) {
    log(`API error: ${error.stack || error.message}`);
    return json(response, error.status || 400, { error: error.message || "Request failed" });
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
        service: "CAP"
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
