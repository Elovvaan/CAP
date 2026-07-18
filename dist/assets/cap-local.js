(() => {
  const navItems = [
    ["Home", "Home", "H"],
    ["Directory", "Creator Directory", "D"],
    ["Circles", "Creator Circles", "C"],
    ["Discovery", "Discovery Queue", "Q"],
    ["Collaborations", "Collaborations", "W"],
    ["Messages", "Messages", "M"],
    ["Settings", "Settings", "S"]
  ];
  const state = { active: "Home", query: "", data: null, viewingCreator: null, discoveryIndex: 0, status: "", authUser: null, authMode: "signin", authReady: false, founderMode: null, founderSection: "Overview", founderControl: null, founderQuery: "" };
  const maxImageBytes = 15 * 1024 * 1024;
  const socialPlatforms = ["YouTube", "Instagram", "TikTok", "Facebook", "X", "Vimeo", "Twitch", "Spotify", "SoundCloud", "LinkedIn", "Website", "Other"];
  const root = document.getElementById("root");

  const iconMap = {
    Home: "H", Directory: "D", Circles: "C", Discovery: "Q", Collaborations: "W", Messages: "M", Settings: "S",
    Users: "U", Handshake: "W", Sparkles: "*", Star: "*", Play: ">", Plus: "+", Bell: "!"
  };

  const founderGroups = [
    ["Platform", ["Overview", "Analytics", "Settings"]],
    ["People", ["Users", "Creators", "Moderation", "Reports"]],
    ["Community", ["Circles", "Collaborations"]],
    ["System", ["Health", "Maintenance", "Audit"]]
  ];
  const founderSections = founderGroups.flatMap(([, sections]) => sections);

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
  }

  function initials(name) {
    const parts = String(name || "CAP").trim().split(/\s+/).filter(Boolean);
    return (parts[0]?.[0] || "C") + (parts[1]?.[0] || "");
  }

  function imageSrc(value) {
    const source = String(value || "").trim();
    if (!source) return "";
    if (/^(https?:|data:|\.\/|\/assets\/)/i.test(source)) return source;
    if (source.startsWith("data/uploads/")) return `/media/${encodeURIComponent(source)}`;
    return `/media/${encodeURIComponent(source)}`;
  }

  function imageWithFallback(value, imgClass, alt, fallbackClass, fallbackText) {
    const source = imageSrc(value);
    const fallback = `<div class="${fallbackClass}">${escapeHtml(fallbackText)}</div>`;
    if (!source) return fallback;
    return `<span class="image-fallback-shell"><img class="${imgClass}" src="${escapeHtml(source)}" alt="${escapeHtml(alt)}" onerror="this.parentElement.classList.add('image-load-failed')">${fallback.replace('class="', 'class="image-fallback-hidden ')}</span>`;
  }

  function relativeTime(value) {
    if (!value) return "";
    const delta = Math.max(0, Date.now() - new Date(value.replace(" ", "T") + "Z").getTime());
    const minutes = Math.floor(delta / 60000);
    if (minutes < 1) return "now";
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    return `${Math.floor(hours / 24)}d ago`;
  }

  async function api(path, options = {}) {
    const response = await fetch(path, {
      ...options,
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", ...(options.headers || {}) }
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "Request failed.");
    return payload;
  }

  async function refresh() {
    const auth = await api("/api/auth/me", { method: "GET" });
    state.authUser = auth.user || null;
    state.authReady = true;
    if (!state.authUser) {
      state.data = null;
      render();
      return;
    }
    state.data = await api("/api/state", { method: "GET" });
    state.authUser = state.data.currentUser;
    if (state.authUser?.accountType === "founder" && state.founderMode === null) state.founderMode = true;
    if (state.authUser?.accountType !== "founder") state.founderMode = false;
    if (state.authUser?.accountType === "founder" && state.founderMode) {
      const founder = await api("/api/founder/control", { method: "GET" });
      state.founderControl = founder.founderControl || null;
    }
    render();
  }

  async function submit(path, payload, method = "POST") {
    try {
      state.data = await api(path, { method, body: JSON.stringify(payload) });
      state.status = "Saved.";
      render();
    } catch (error) {
      state.status = error.message;
      render(true);
    }
  }

  async function refreshFounderControl() {
    const payload = await api("/api/founder/control", { method: "GET" });
    state.founderControl = payload.founderControl || null;
  }

  function filteredCreators() {
    const creators = state.data?.creators || [];
    const query = state.query.toLowerCase();
    if (!query) return creators;
    return creators.filter((creator) => [creator.name, creator.handle, creator.role, creator.category, creator.description, ...(creator.platforms || []).map((p) => `${p.platform} ${p.url}`)]
      .join(" ").toLowerCase().includes(query));
  }

  function filteredCircles() {
    const circles = state.data?.circles || [];
    const query = state.query.toLowerCase();
    if (!query) return circles;
    return circles.filter((circle) => [circle.name, circle.detail].join(" ").toLowerCase().includes(query));
  }

  function settingList(key) {
    return String(state.data?.settings?.[key] || "")
      .split(/[,|\n]/)
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean);
  }

  function viewedCreatorIds() {
    try {
      return JSON.parse(state.data?.settings?.viewedCreators || "[]").map(Number);
    } catch {
      return [];
    }
  }

  function profileCompleteness(creator) {
    const checks = [creator.name, creator.handle, creator.role, creator.category, creator.description, creator.image, creator.banner];
    const relationCount = (creator.platforms?.length ? 1 : 0) + (creator.videos?.length ? 1 : 0);
    return checks.filter(Boolean).length + relationCount;
  }

  function searchableCreatorText(creator) {
    return [
      creator.name,
      creator.handle,
      creator.role,
      creator.category,
      creator.description,
      ...(creator.platforms || []).map((item) => `${item.platform} ${item.url}`),
      ...(creator.videos || []).map((item) => `${item.title} ${item.url}`)
    ].join(" ").toLowerCase();
  }

  function getFeaturedCreator() {
    const viewed = new Set(viewedCreatorIds());
    const creators = [...(state.data?.creators || [])];
    if (!creators.length) return null;
    return creators
      .sort((a, b) => {
        const viewedDelta = Number(viewed.has(a.id)) - Number(viewed.has(b.id));
        if (viewedDelta) return viewedDelta;
        const completeDelta = profileCompleteness(b) - profileCompleteness(a);
        if (completeDelta) return completeDelta;
        return new Date(b.updated_at || b.created_at).getTime() - new Date(a.updated_at || a.created_at).getTime();
      })[0];
  }

  function getOpportunities() {
    const data = state.data;
    const opportunities = [];
    for (const item of data.collaborations.filter((collab) => collab.status !== "Completed").slice(0, 4)) {
      opportunities.push({
        type: "collaboration",
        title: item.title,
        text: `${item.status}${item.creator_name ? ` with ${item.creator_name}` : ""}`,
        nav: "Collaborations"
      });
    }
    for (const creator of data.creators) {
      const text = searchableCreatorText(creator);
      if (/(seeking|needs|looking for|collab|collaboration|support|help)/i.test(text)) {
        opportunities.push({
          type: "creator",
          title: creator.name,
          text: creator.description || creator.role || "Creator profile has collaboration signals.",
          creatorId: creator.id
        });
      }
    }
    for (const circle of data.circles.filter((circle) => Number(circle.members || 0) === 0 || /(support|growth|help|members|collab)/i.test(`${circle.name} ${circle.detail}`))) {
      opportunities.push({
        type: "circle",
        title: circle.name,
        text: Number(circle.members || 0) === 0 ? "Circle needs its first members." : circle.detail,
        nav: "Circles"
      });
    }
    return opportunities.slice(0, 6);
  }

  function getRadarMatches() {
    const terms = [
      ...settingList("skills"),
      ...settingList("interests"),
      ...settingList("location"),
      ...settingList("platforms"),
      ...settingList("categories"),
      ...settingList("collaborationNeeds")
    ];
    if (!terms.length) return [];
    const matches = [];
    for (const creator of state.data.creators) {
      const text = searchableCreatorText(creator);
      const hits = [...new Set(terms.filter((term) => text.includes(term)))];
      if (hits.length) matches.push({ kind: "creator", title: creator.name, text: creator.role || creator.category || creator.description, hits, creatorId: creator.id });
    }
    for (const circle of state.data.circles) {
      const text = `${circle.name} ${circle.detail}`.toLowerCase();
      const hits = [...new Set(terms.filter((term) => text.includes(term)))];
      if (hits.length) matches.push({ kind: "circle", title: circle.name, text: circle.detail || `${Number(circle.members || 0)} members`, hits, nav: "Circles" });
    }
    for (const collab of state.data.collaborations.filter((item) => item.status !== "Completed")) {
      const text = `${collab.title} ${collab.message} ${collab.creator_name}`.toLowerCase();
      const hits = [...new Set(terms.filter((term) => text.includes(term)))];
      if (hits.length) matches.push({ kind: "project", title: collab.title, text: collab.message || collab.status, hits, nav: "Collaborations" });
    }
    return matches.sort((a, b) => b.hits.length - a.hits.length).slice(0, 6);
  }

  function platformLabel(item) {
    const explicit = String(item.platform || "").trim();
    const url = String(item.url || "").toLowerCase();
    if (explicit) return explicit;
    if (url.includes("youtube.com") || url.includes("youtu.be")) return "YouTube";
    if (url.includes("instagram.com")) return "Instagram";
    if (url.includes("facebook.com") || url.includes("fb.com")) return "Facebook";
    if (url.includes("tiktok.com")) return "TikTok";
    if (url.includes("x.com") || url.includes("twitter.com")) return "X";
    if (url.includes("vimeo.com")) return "Vimeo";
    if (url.includes("spotify.com")) return "Spotify";
    if (url) return "Website";
    return "Platform";
  }

  function inferSocialHandle(item) {
    const handle = String(item.handle || "").trim();
    if (handle) return handle;
    try {
      const url = new URL(String(item.url || ""));
      const host = url.hostname.toLowerCase();
      const first = url.pathname.split("/").map((part) => part.trim()).filter(Boolean)[0] || "";
      if (!first) return "";
      if (host.includes("youtube.com") && first.startsWith("@")) return first;
      if (host.includes("instagram.com") || host.includes("tiktok.com") || host.includes("x.com") || host.includes("twitter.com")) return `@${first.replace(/^@/, "")}`;
      if (host.includes("facebook.com") || host.includes("twitch.tv") || host.includes("soundcloud.com")) return first;
      return "";
    } catch {
      return "";
    }
  }

  function platformDisplay(item) {
    const label = platformLabel(item);
    const handle = inferSocialHandle(item);
    if (handle) return `${label} Â· ${handle}`;
    if (["Website", "Other"].includes(label)) return item.url || label;
    return label;
  }

  function platformButtons(creator) {
    const links = (creator.platforms || []).filter((item) => item.url);
    if (!links.length) return `<p class="platforms">No platform links yet</p>`;
    return `<div class="platform-buttons">${links.map((item) => `<button class="platform-button" data-open="${escapeHtml(item.url)}">${escapeHtml(platformDisplay(item))}</button>`).join("")}</div>`;
  }

  function coverImage(creator) {
    const source = imageSrc(creator.banner || creator.image);
    if (!source) return "";
    return `<img class="creator-cover-image" src="${escapeHtml(source)}" alt="${escapeHtml(creator.name)} cover" onerror="this.style.display='none'"><div class="creator-cover-scrim"></div>`;
  }

  function uniqueTerms(values) {
    return [...new Set(values.flatMap((value) => String(value || "").split(/[,|\n]/)).map((item) => item.trim().toLowerCase()).filter(Boolean))];
  }

  function getWelcomeMatches() {
    const nicheTerms = uniqueTerms([
      state.data.settings.category,
      state.data.settings.categories,
      state.data.settings.interests,
      state.data.settings.collaborationInterests
    ]);
    const skillTerms = uniqueTerms([state.data.settings.skills]);
    const locationTerms = uniqueTerms([state.data.settings.location]);
    const areaEnabled = locationTerms.length > 0;

    const creatorMatches = state.data.creators
      .map((creator) => ({ creator, text: searchableCreatorText(creator) }))
      .filter((item) => nicheTerms.some((term) => item.text.includes(term)))
      .slice(0, 4);
    const areaMatches = areaEnabled
      ? state.data.creators
        .map((creator) => ({ creator, text: searchableCreatorText(creator) }))
        .filter((item) => locationTerms.some((term) => item.text.includes(term)))
        .slice(0, 4)
      : [];
    const skillSeekers = state.data.creators
      .map((creator) => ({ creator, text: searchableCreatorText(creator) }))
      .filter((item) => /(seeking|needs|looking for|support|help|collab|collaboration)/i.test(item.text) && skillTerms.some((term) => item.text.includes(term)))
      .slice(0, 4);
    const activeCollaborations = state.data.collaborations
      .filter((item) => item.status !== "Completed")
      .filter((item) => {
        const text = `${item.title} ${item.message} ${item.creator_name}`.toLowerCase();
        const terms = [...nicheTerms, ...skillTerms, ...locationTerms];
        return !terms.length || terms.some((term) => text.includes(term));
      })
      .slice(0, 4);
    const relevantCircles = state.data.circles
      .filter((circle) => {
        const text = `${circle.name} ${circle.detail}`.toLowerCase();
        const terms = [...nicheTerms, ...skillTerms, ...locationTerms];
        return terms.some((term) => text.includes(term));
      })
      .slice(0, 4);

    return {
      areaEnabled,
      creatorMatches,
      areaMatches,
      activeCollaborations,
      relevantCircles,
      skillSeekers,
      hasMatches: Boolean(creatorMatches.length || areaMatches.length || activeCollaborations.length || relevantCircles.length || skillSeekers.length)
    };
  }

  function pageTitle() {
    if (state.active === "Home") return state.data?.profile?.name ? `Welcome back, ${state.data.profile.name}` : "Welcome to CAP";
    if (state.active === "MyProfile") return "My Profile";
    if (state.active === "Account") return "Account Settings";
    if (state.active === "CreatorProfile") return state.viewingCreator?.name || "Creator Profile";
    return navItems.find(([key]) => key === state.active)?.[1] || "CAP";
  }

  function authView(error = false) {
    const isCreate = state.authMode === "create";
    return `<main class="auth-screen">
      <section class="auth-card panel">
        <div class="brand-block auth-brand">
          <div class="brand-mark logo-mark"><img src="./assets/cap-logo.jpg" alt="CAP logo"></div>
          <div><strong>CAP</strong><span>Creator Association Platform</span></div>
        </div>
        <div class="welcome-copy">
          <h2>${isCreate ? "Create your CAP account" : "Sign in to CAP"}</h2>
          <p>You're no longer building alone. CAP connects creators, opportunities, and communities around real member records.</p>
        </div>
        <div class="status-line ${error ? "error" : ""}">${escapeHtml(state.status)}</div>
        <form id="${isCreate ? "register-form" : "login-form"}" class="form-grid auth-form">
          ${isCreate ? field("displayName", "Display name", "") : ""}
          ${field("email", "Email", "")}
          ${field("password", "Password", "", "", "password")}
          ${isCreate ? field("confirmPassword", "Confirm password", "", "", "password") : ""}
          ${isCreate ? `<p class="empty-copy slim full">Use at least 10 characters. CAP stores only a salted scrypt password hash.</p>` : ""}
          <div class="form-actions full">
            <button class="primary-button" type="submit">${isCreate ? "Create Account" : "Sign In"}</button>
            <button class="secondary-button" type="button" data-auth-toggle>${isCreate ? "Back to Sign In" : "Create Account"}</button>
          </div>
        </form>
      </section>
    </main>`;
  }

  function bindAuthForms() {
    root.querySelector("[data-auth-toggle]")?.addEventListener("click", () => {
      state.authMode = state.authMode === "create" ? "signin" : "create";
      state.status = "";
      render();
    });
    root.querySelector("#login-form")?.addEventListener("submit", async (event) => {
      event.preventDefault();
      const payload = formData(event.currentTarget);
      try {
        state.status = "Signing in...";
        await api("/api/auth/login", { method: "POST", body: JSON.stringify(payload) });
        state.status = "";
        await refresh();
      } catch (error) {
        state.status = "Invalid email or password.";
        render(true);
      }
    });
    root.querySelector("#register-form")?.addEventListener("submit", async (event) => {
      event.preventDefault();
      const payload = formData(event.currentTarget);
      try {
        if (payload.password !== payload.confirmPassword) throw new Error("Passwords do not match.");
        if (String(payload.password || "").length < 10) throw new Error("Password must be at least 10 characters.");
        state.status = "Creating account...";
        await api("/api/auth/register", { method: "POST", body: JSON.stringify(payload) });
        state.status = "Account created. Start your profile.";
        state.active = "MyProfile";
        await refresh();
      } catch (error) {
        state.status = error.message;
        render(true);
      }
    });
  }

  function render(error = false) {
    if (!state.authReady) {
      root.innerHTML = `<section class="empty-page"><div class="empty-icon">CAP</div><h2>Loading CAP</h2><p>Checking your session...</p></section>`;
      return;
    }
    if (!state.authUser) {
      root.innerHTML = authView(error);
      bindAuthForms();
      return;
    }
    if (state.authUser?.accountType === "founder" && state.founderMode) {
      root.innerHTML = founderControlShell(error);
      bindFounderControl();
      return;
    }
    const data = state.data || { creators: [], circles: [], activity: [], collaborations: [], messages: [], stats: {}, profile: null, circleMembership: [] };
    const profile = data.profile;
    root.innerHTML = `
      <div class="app-shell">
        <aside class="sidebar">
          <div class="brand-block">
            <div class="brand-mark logo-mark"><img src="./assets/cap-logo.jpg" alt="CAP logo"></div>
            <div><strong>CAP</strong><span>Creator Association Platform</span></div>
          </div>
          <nav class="nav-list">
            ${navItems.map(([key, label, icon]) => `<button class="${state.active === key ? "nav-item active" : "nav-item"}" data-nav="${key}"><span>${icon}</span><span>${label}</span></button>`).join("")}
          </nav>
          <button class="profile-card profile-card-button" data-my-profile>
            ${imageWithFallback(profile?.image, "profile-image", profile?.name || "CAP", "avatar founder", initials(profile?.name || "CAP"))}
            <div class="profile-copy"><strong>${escapeHtml(profile?.name || "Create profile")}</strong><span>${escapeHtml(profile?.role || "Founder")}</span></div>
            <span class="profile-more">...</span>
          </button>
          <div class="mission-card">
            <strong>CAP Mission</strong>
            <p>${escapeHtml(profile?.mission || "Set your CAP mission in Settings.")}</p>
          </div>
        </aside>
        <main class="main-content">
          <header class="topbar">
            <div><h1>${escapeHtml(pageTitle())}</h1><p>Build together. Grow together.</p></div>
            <div class="top-actions">
              <label class="search-box"><span>?</span><input id="global-search" value="${escapeHtml(state.query)}" placeholder="Search creators, skills, circles..."></label>
              <button class="icon-button" aria-label="Notifications">${iconMap.Bell}</button>
              ${state.authUser?.accountType === "founder" ? `<button class="secondary-button" data-founder-control>Founder Control</button>` : ""}
              <button class="secondary-button" data-account>Account Settings</button>
              <button class="secondary-button" data-sign-out>Sign Out</button>
              <button class="primary-button" data-quick><span>${iconMap.Plus}</span> Quick Action</button>
            </div>
          </header>
          <div class="status-line ${error ? "error" : ""}">${escapeHtml(state.status)}</div>
          ${view()}
        </main>
      </div>`;
    bindGlobal();
  }

  function view() {
    switch (state.active) {
      case "Directory": return directoryView();
      case "Circles": return circlesView();
      case "Discovery": return discoveryView(true);
      case "Collaborations": return collaborationsView();
      case "Messages": return messagesView();
      case "MyProfile": return myProfileView();
      case "Account": return accountView();
      case "CreatorProfile": return creatorProfileView();
      case "Settings": return settingsView();
      default: return homeView();
    }
  }

  function stat(icon, value, label) {
    return `<article class="stat-card"><div class="stat-icon">${icon}</div><div><strong>${Number(value || 0)}</strong><span>${label}</span></div></article>`;
  }

  function panelHeader(title, action, nav) {
    return `<div class="panel-header"><h2>${title}</h2>${action ? `<button data-nav="${nav || ""}">${action}</button>` : ""}</div>`;
  }

  function founderControlShell(error = false) {
    const profile = state.data?.profile || {};
    return `<div class="app-shell founder-shell">
      <aside class="sidebar founder-sidebar">
        <div class="brand-block">
          <div class="brand-mark logo-mark"><img src="./assets/cap-logo.jpg" alt="CAP logo"></div>
          <div><strong>CAP</strong><span>Founder Control Center</span></div>
        </div>
        <nav class="nav-list founder-nav-list">
          ${founderGroups.map(([group, sections]) => `<div class="founder-nav-group"><span class="founder-nav-heading">${escapeHtml(group)}</span>${sections.map((section) => `<button class="${state.founderSection === section ? "nav-item active" : "nav-item"}" data-founder-section="${section}"><span>${section[0]}</span><span>${section}</span></button>`).join("")}</div>`).join("")}
        </nav>
        <button class="profile-card profile-card-button" data-creator-mode>
          ${imageWithFallback(profile?.image, "profile-image", profile?.name || "CAP", "avatar founder", initials(profile?.name || "CAP"))}
          <div class="profile-copy"><strong>${escapeHtml(profile?.name || "Founder")}</strong><span>Switch to Creator Mode</span></div>
          <span class="profile-more">...</span>
        </button>
      </aside>
      <main class="main-content">
        <header class="topbar">
          <div><h1>Founder Control Center</h1><p>Platform operations, governance, and health for CAP.</p></div>
          <div class="top-actions">
            <input id="founder-search" class="founder-search" value="${escapeHtml(state.founderQuery)}" placeholder="Search founder records..." aria-label="Search founder records">
            <button class="secondary-button" data-creator-mode>Creator Mode</button>
            <button class="secondary-button" data-sign-out>Sign Out</button>
          </div>
        </header>
        <div class="status-line ${error ? "error" : ""}">${escapeHtml(state.status)}</div>
        ${founderControlView()}
      </main>
    </div>`;
  }

  function founderMatches(row) {
    const query = state.founderQuery.trim().toLowerCase();
    if (!query) return true;
    return Object.values(row || {}).join(" ").toLowerCase().includes(query);
  }

  function founderSearchable(rows) {
    return (rows || []).filter(founderMatches);
  }

  function founderMetric(title, value, detail, section = "") {
    const action = section ? ` role="button" tabindex="0" data-founder-card="${escapeHtml(section)}"` : "";
    return `<article class="stat-card founder-stat${section ? " founder-clickable-card" : ""}"${action}><div class="stat-icon">*</div><div><strong>${escapeHtml(value)}</strong><span>${escapeHtml(title)}</span><small>${escapeHtml(detail || "")}</small></div></article>`;
  }

  function founderRecord(title, detail, meta = "") {
    return `<article class="record-card"><header><h3>${escapeHtml(title)}</h3>${meta ? `<span class="mini-pill">${escapeHtml(meta)}</span>` : ""}</header><p>${escapeHtml(detail || "No detail recorded.")}</p></article>`;
  }

  function founderRanking(title, rows) {
    return `<div class="panel">${panelHeader(title, "")}<div class="records-list">${rows?.length ? rows.map((row) => founderRecord(row.name, `${Number(row.count || 0)} signals`, `#${row.id}`)).join("") : `<p class="empty-copy">No analytics yet.</p>`}</div></div>`;
  }

  function founderControlView() {
    const control = state.founderControl || {};
    switch (state.founderSection) {
      case "Users": return founderUsersView(control.users || []);
      case "Creators": return founderCreatorsView(control.creators || []);
      case "Moderation": return founderModerationView(control);
      case "Reports": return founderReportsView(control);
      case "Analytics": return founderAnalyticsView(control.analytics || {});
      case "Circles": return founderCirclesView(control.circles || []);
      case "Collaborations": return founderCollaborationsView(control.collaborations || []);
      case "Settings": return founderSettingsView(control.platformSettings || {});
      case "Health": return founderMetricGrid(control.systemHealth || {}, "System Health");
      case "Maintenance": return founderMaintenanceView(control.maintenanceTools || {});
      case "Audit": return founderAuditView(control.auditLog || []);
      default: return founderOverviewView(control);
    }
  }

  function founderMetricGrid(items, title) {
    const entries = Object.entries(items || {});
    return `<section class="content-grid directory-only"><div class="panel">${panelHeader(title, "")}<div class="stats-grid founder-grid">${entries.length ? entries.map(([key, value]) => founderMetric(key.replace(/([A-Z])/g, " $1"), value, "")).join("") : `<p class="empty-copy">No ${escapeHtml(title.toLowerCase())} records yet.</p>`}</div></div></section>`;
  }

  function founderOverviewView(control) {
    const overview = control.overview || {};
    return `<section class="founder-dashboard">
      <div class="stats-grid founder-grid">
        ${founderMetric("Users", overview.totalUsers || 0, `${overview.activeUsers || 0} active`, "Users")}
        ${founderMetric("Creators", overview.totalCreators || 0, `${overview.completeCreators || 0} complete`, "Creators")}
        ${founderMetric("Circles", overview.totalCircles || 0, "growth communities", "Circles")}
        ${founderMetric("Collaborations", overview.activeCollaborations || 0, "active requests", "Collaborations")}
      </div>
      <section class="dashboard-grid">
        ${founderRanking("Most Viewed Creators", control.analytics?.mostViewedCreators || [])}
        ${founderListView("Recent Users", (control.users || []).slice(0, 5), (item) => founderRecord(item.displayName || item.email, item.email, item.accountType))}
        ${founderListView("System Health", [control.systemHealth || {}], (item) => founderRecord(item.status || "Unknown", `${item.database || "SQLite"} - ${item.storage || ""}`, item.hostMode || ""))}
      </section>
    </section>`;
  }

  function founderUsersView(users) {
    const rows = founderSearchable(users);
    return `<section class="content-grid directory-only"><div class="panel">${panelHeader("User Management", "")}<div class="records-list">${rows.length ? rows.map((user) => `<article class="record-card founder-user-card">
      <header><h3>${escapeHtml(user.displayName || user.email)}</h3><span class="mini-pill">${escapeHtml(user.accountType || "creator")}${user.isAdmin && user.accountType !== "founder" ? " - admin" : ""}</span></header>
      <p>${escapeHtml(user.email)} - ${escapeHtml(user.status || "active")} - last login ${escapeHtml(relativeTime(user.lastLoginAt) || "not recorded")}</p>
      <form class="inline-buttons founder-user-form" data-founder-user="${user.id}">
        <input name="displayName" value="${escapeHtml(user.displayName || "")}" aria-label="Display name">
        <select name="status" aria-label="Status"><option value="active" ${user.status === "active" ? "selected" : ""}>active</option><option value="deactivated" ${user.status === "deactivated" ? "selected" : ""}>deactivated</option></select>
        <label class="mini-toggle"><input type="checkbox" name="isAdmin" ${user.isAdmin ? "checked" : ""} ${user.accountType === "founder" ? "disabled" : ""}> Admin</label>
        <button class="secondary-button" type="submit">Save</button>
      </form>
      <div class="inline-buttons"><button class="secondary-button" data-founder-user-action="reset-sessions" data-founder-user="${user.id}">Reset Sessions</button></div>
    </article>`).join("") : `<p class="empty-copy">No users match the current search.</p>`}</div></div></section>`;
  }

  function founderCreatorsView(creators) {
    const rows = founderSearchable(creators);
    return `<section class="content-grid directory-only"><div class="panel">${panelHeader("Creator Profile Management", "")}<div class="records-list">${rows.length ? rows.map((creator) => `<article class="record-card founder-creator-card">
      <header><h3>${escapeHtml(creator.name || "Unnamed creator")}</h3><span class="mini-pill">${escapeHtml(creator.visibilityStatus || "visible")}${creator.moderationStatus ? ` - ${escapeHtml(creator.moderationStatus)}` : ""}</span></header>
      <p>${escapeHtml(creator.handle || "No handle")} - ${escapeHtml(creator.ownerEmail || "No owner")} - ${escapeHtml(creator.location || "No location")}</p>
      <form class="founder-inline-form founder-creator-form" data-founder-creator="${creator.id}">
        <input name="name" value="${escapeHtml(creator.name || "")}" aria-label="Creator name">
        <input name="role" value="${escapeHtml(creator.role || "")}" aria-label="Role">
        <input name="category" value="${escapeHtml(creator.category || "")}" aria-label="Category">
        <input name="location" value="${escapeHtml(creator.location || "")}" aria-label="Location">
        <button class="secondary-button" type="submit">Save Edit</button>
      </form>
      <div class="inline-buttons">
        <button class="secondary-button" data-view-profile="${creator.id}">View</button>
        <button class="secondary-button" data-founder-creator-action="${creator.visibilityStatus === "hidden" ? "unhide" : "hide"}" data-founder-creator="${creator.id}">${creator.visibilityStatus === "hidden" ? "Unhide" : "Hide"}</button>
        <button class="secondary-button" data-founder-creator-action="${creator.moderationStatus === "under_review" ? "clear-review" : "review"}" data-founder-creator="${creator.id}">${creator.moderationStatus === "under_review" ? "Clear Review" : "Review"}</button>
      </div>
    </article>`).join("") : `<p class="empty-copy">No creator profiles match the current search.</p>`}</div></div></section>`;
  }

  function founderModerationView(control) {
    const moderation = control.moderation || {};
    const reviewCreators = founderSearchable((control.creators || []).filter((creator) => creator.moderationStatus === "under_review" || creator.visibilityStatus === "hidden"));
    const flaggedCollaborations = founderSearchable((control.collaborations || []).filter((item) => item.moderationStatus));
    return `<section class="content-grid">
      <div class="panel">${panelHeader("Moderation", "")}<div class="stats-grid founder-grid">${Object.entries(moderation).map(([key, value]) => founderMetric(key.replace(/([A-Z])/g, " $1"), value, "")).join("")}</div>
        <form class="founder-inline-form founder-moderation-form">
          <select name="targetType" aria-label="Target type"><option value="creator">creator</option><option value="collaboration">collaboration</option><option value="circle">circle</option><option value="user">user</option></select>
          <input name="targetId" placeholder="Target ID" aria-label="Target ID">
          <input name="action" placeholder="Action" aria-label="Moderation action">
          <input name="note" placeholder="Safe note" aria-label="Moderation note">
          <button class="secondary-button" type="submit">Log Action</button>
        </form>
      </div>
      ${founderListView("Creators Under Review or Hidden", reviewCreators, (creator) => founderRecord(creator.name || "Unnamed creator", `${creator.ownerEmail || "No owner"} - ${creator.moderationNote || "No note"}`, creator.moderationStatus || creator.visibilityStatus))}
      ${founderListView("Flagged Collaborations", flaggedCollaborations, (item) => founderRecord(item.title || "Untitled collaboration", `${item.creatorName || "No creator"} - ${item.moderationNote || "No note"}`, item.moderationStatus))}
    </section>`;
  }

  function founderReportsView(control) {
    const reports = founderSearchable(control.reportQueue || []);
    return `<section class="content-grid directory-only"><div class="panel">${panelHeader("Reports", "")}<div class="stats-grid founder-grid">${Object.entries(control.reports || {}).map(([key, value]) => founderMetric(key.replace(/([A-Z])/g, " $1"), value, "")).join("")}</div>
      <form class="founder-inline-form founder-report-form">
        <input name="targetType" placeholder="Target type" aria-label="Target type">
        <input name="targetId" placeholder="Target ID" aria-label="Target ID">
        <input name="reason" placeholder="Reason" aria-label="Report reason">
        <button class="secondary-button" type="submit">Create Report</button>
      </form>
      <div class="records-list">${reports.length ? reports.map((report) => `<article class="record-card">
        <header><h3>${escapeHtml(report.targetType || "report")} #${escapeHtml(report.targetId || "")}</h3><span class="mini-pill">${escapeHtml(report.status || "open")}</span></header>
        <p>${escapeHtml(report.reason || "No reason recorded.")}</p>
        <div class="inline-buttons"><button class="secondary-button" data-founder-report-action="resolve" data-founder-report="${report.id}">Resolve</button><button class="secondary-button" data-founder-report-action="dismiss" data-founder-report="${report.id}">Dismiss</button></div>
      </article>`).join("") : `<p class="empty-copy">No reports match the current search.</p>`}</div></div></section>`;
  }

  function founderAnalyticsView(analytics) {
    return `<section class="content-grid">
      ${founderRanking("Most Viewed Creators", analytics.mostViewedCreators || [])}
      ${founderRanking("Most Followed Creators", analytics.mostFollowedCreators || [])}
      ${founderRanking("Most Saved Creators", analytics.mostSavedCreators || [])}
      ${founderRanking("Fastest Growing Creators", analytics.fastestGrowingCreators || [])}
    </section>`;
  }

  function founderListView(title, rows, renderer) {
    return `<section class="content-grid directory-only"><div class="panel">${panelHeader(title, "")}<div class="records-list">${rows.length ? rows.map(renderer).join("") : `<p class="empty-copy">No records yet.</p>`}</div></div></section>`;
  }

  function founderCirclesView(circles) {
    const rows = founderSearchable(circles);
    return `<section class="content-grid directory-only"><div class="panel">${panelHeader("Circles", "")}<div class="records-list">${rows.length ? rows.map((circle) => `<article class="record-card founder-circle-card">
      <header><h3>${escapeHtml(circle.name || "Unnamed circle")}</h3><span class="mini-pill">${Number(circle.members || 0)} members</span></header>
      <p>${escapeHtml(circle.detail || "No details recorded.")}</p>
      <form class="founder-inline-form founder-circle-form" data-founder-circle="${circle.id}">
        <input name="name" value="${escapeHtml(circle.name || "")}" aria-label="Circle name">
        <input name="detail" value="${escapeHtml(circle.detail || "")}" aria-label="Circle details">
        <select name="status" aria-label="Circle status"><option value="active" ${circle.status === "active" ? "selected" : ""}>active</option><option value="paused" ${circle.status === "paused" ? "selected" : ""}>paused</option><option value="archived" ${circle.status === "archived" ? "selected" : ""}>archived</option></select>
        <button class="secondary-button" type="submit">Save</button>
      </form>
    </article>`).join("") : `<p class="empty-copy">No circles match the current search.</p>`}</div></div></section>`;
  }

  function founderCollaborationsView(collaborations) {
    const rows = founderSearchable(collaborations);
    return `<section class="content-grid directory-only"><div class="panel">${panelHeader("Collaborations", "")}<div class="records-list">${rows.length ? rows.map((item) => `<article class="record-card">
      <header><h3>${escapeHtml(item.title || "Untitled collaboration")}</h3><span class="mini-pill">${escapeHtml(item.status || "Requested")}</span></header>
      <p>${escapeHtml(item.creatorName || "No creator")} - ${escapeHtml(item.requesterEmail || "No requester")} - ${Number(item.progress || 0)}%</p>
      <div class="inline-buttons"><button class="secondary-button" data-founder-collab-action="close-spam" data-founder-collab="${item.id}">Close Spam</button><button class="secondary-button" data-founder-collab-action="close-abuse" data-founder-collab="${item.id}">Close Abuse</button></div>
    </article>`).join("") : `<p class="empty-copy">No collaborations match the current search.</p>`}</div></div></section>`;
  }

  function founderSettingsView(settings) {
    return `<section class="content-grid directory-only"><div class="panel">${panelHeader("Platform Settings", "")}<form id="founder-settings-form" class="form-grid">
      ${field("workspaceName", "Workspace name", settings.workspaceName || "CAP")}
      ${area("mission", "Platform mission", settings.mission || "", "full")}
      ${area("notes", "Founder notes", settings.notes || "", "full")}
      <div class="form-actions full"><button class="primary-button" type="submit">Save Platform Settings</button></div>
    </form></div></section>`;
  }

  function founderMaintenanceView(tools) {
    return `<section class="content-grid directory-only"><div class="panel">${panelHeader("Maintenance Tools", "")}<div class="records-list">
      ${founderRecord("Discovery cache", `${Number(tools.discoveryCacheUsers || 0)} user queues currently cached`, "cache")}
      ${founderRecord("Expired sessions", `${Number(tools.staleSessions || 0)} expired sessions can be pruned naturally`, "sessions")}
      ${founderRecord("Upload verification", `${Number(tools.uploadsChecked || 0)} checked, ${Number(tools.uploadsMissing || 0)} missing`, "uploads")}
      ${founderRecord("Safe backups", `${Number(tools.databaseBackups || 0)} backups recorded`, "backup")}
      <div class="inline-buttons">
        <button class="secondary-button" data-maintenance-action="clear-discovery-cache">Clear Discovery Cache</button>
        <button class="secondary-button" data-maintenance-action="cleanup-expired-sessions">Clean Expired Sessions</button>
        <button class="secondary-button" data-maintenance-action="verify-uploads">Verify Uploads</button>
        <button class="secondary-button" data-maintenance-action="backup-database">Create Safe Backup</button>
      </div>
    </div></div></section>`;
  }

  function founderAuditView(auditLog) {
    const rows = founderSearchable(auditLog);
    return founderListView("Founder Audit Log", rows, (item) => founderRecord(item.action, `${item.targetType || "system"} ${item.targetId || ""} - ${item.detail || ""}`, relativeTime(item.createdAt)));
  }

  function homeView() {
    const data = state.data;
    return `
      <section class="stats-grid">
        ${stat(iconMap.Users, data.stats.circleCreators, "Creators in Your Circles")}
        ${stat(iconMap.Handshake, data.stats.activeCollaborations, "Active Collaborations")}
        ${stat(iconMap.Sparkles, data.stats.savedCreators, "Saved Creators")}
        ${stat(iconMap.Star, data.stats.contributionPoints, "Contribution Points")}
      </section>
      <section class="dashboard-grid">
        <div class="panel circles-panel">
          ${panelHeader("Your Circles", "View All Circles", "Circles")}
          ${circleList(data.circles.slice(0, 4))}
        </div>
        <div class="panel discovery-panel">
          ${panelHeader("Discovery Queue", "View Full Queue", "Discovery")}
          ${discoveryCard()}
        </div>
        <div class="panel activity-panel">
          ${panelHeader("Community Activity", "View All", "Settings")}
          ${activityList(data.activity.slice(0, 6))}
        </div>
        <div class="panel projects-panel">
          ${panelHeader("Recent Collaborations", "View All Projects", "Collaborations")}
          ${projectGrid(data.collaborations.slice(0, 3))}
        </div>
      </section>
      <section class="homepage-flow">
        <div class="panel welcome-panel">${welcomePanel()}</div>
        <div class="panel">${panelHeader("Today's Opportunities", "")}${opportunitiesView()}</div>
        <div class="panel">${panelHeader("Continue Where You Left Off", "")}${continueView()}</div>
        <div class="panel featured-home">${panelHeader("Featured Creator", "")}${featuredCreatorView()}</div>
        <div class="panel">${panelHeader("Community Activity", "")}${activityList(data.activity.slice(0, 8))}</div>
        <div class="panel radar-home">${panelHeader("Creator Radar", "")}${radarView()}</div>
        ${homeDiscoveryWidgets()}
      </section>`;
  }

  function welcomeMatchGroup(title, items, renderItem) {
    if (!items.length) return "";
    return `<div class="welcome-group"><h3>${escapeHtml(title)}</h3><div class="pill-row">${items.map(renderItem).join("")}</div></div>`;
  }

  function welcomePanel() {
    const matches = getWelcomeMatches();
    const body = matches.hasMatches
      ? `
        <div class="welcome-groups">
          ${welcomeMatchGroup("Creators matching your niche", matches.creatorMatches, (item) => `<button class="mini-pill" data-view-profile="${item.creator.id}">${escapeHtml(item.creator.name)}</button>`)}
          ${matches.areaEnabled ? welcomeMatchGroup("Creators in your area", matches.areaMatches, (item) => `<button class="mini-pill" data-view-profile="${item.creator.id}">${escapeHtml(item.creator.name)}</button>`) : ""}
          ${welcomeMatchGroup("Active collaboration opportunities", matches.activeCollaborations, (item) => `<button class="mini-pill" data-nav="Collaborations">${escapeHtml(item.title)}</button>`)}
          ${welcomeMatchGroup("Relevant Growth Circles", matches.relevantCircles, (item) => `<button class="mini-pill" data-nav="Circles">${escapeHtml(item.name)}</button>`)}
          ${welcomeMatchGroup("Creators seeking your skills", matches.skillSeekers, (item) => `<button class="mini-pill" data-view-profile="${item.creator.id}">${escapeHtml(item.creator.name)}</button>`)}
        </div>`
      : `<p class="empty-copy welcome-empty">CAP will begin matching creators, opportunities, and communities as real member profiles, circles, and collaboration records grow.</p>`;

    return `
      <div class="welcome-copy">
        <h2>You're no longer building alone.</h2>
        <p>Welcome to CAP. We've already found creators, opportunities, and communities that match your interests.</p>
      </div>
      ${body}
      <div class="form-actions welcome-actions"><button class="primary-button" data-find-first-circle>Find My First Circle</button></div>`;
  }

  function opportunitiesView() {
    const items = getOpportunities();
    if (!items.length) return `<p class="empty-copy">No live opportunities yet. CAP will show active requests, creators seeking support, new projects, and circles needing members once those records exist.</p>`;
    return `<div class="records-list">${items.map((item) => `<article class="record-card"><header><h3>${escapeHtml(item.title)}</h3><span class="mini-pill">${escapeHtml(item.type)}</span></header><p>${escapeHtml(item.text)}</p><div class="inline-buttons">${item.creatorId ? `<button class="secondary-button" data-view-profile="${item.creatorId}">View Profile</button><button class="secondary-button" data-work="${item.creatorId}">Let's Work Together</button>` : `<button class="secondary-button" data-nav="${item.nav}">Open</button>`}</div></article>`).join("")}</div>`;
  }

  function continueView() {
    const last = safeJson(state.data.settings.lastActivity, null);
    if (last?.type) {
      return `<div class="records-list"><article class="record-card"><header><h3>${escapeHtml(last.label || "Recent item")}</h3><span class="mini-pill">${escapeHtml(last.type)}</span></header><p>Last touched ${escapeHtml(last.at ? relativeTime(last.at.replace("T", " ").replace("Z", "")) : "recently")}.</p><button class="secondary-button" data-continue-type="${escapeHtml(last.type)}" data-continue-id="${Number(last.id || 0)}">Continue</button></article></div>`;
    }
    const tasks = [];
    if (!state.data.profile) tasks.push({ title: "Create your profile", text: "Finish your identity, links, interests, and member profile.", nav: "MyProfile" });
    if (!state.data.creators.length) tasks.push({ title: "Publish your creator profile", text: "Creator records power discovery, radar, and opportunities.", nav: "MyProfile" });
    if (!state.data.circles.length) tasks.push({ title: "Create a creator circle", text: "Circles organize collaboration and membership.", nav: "Circles" });
    if (!tasks.length) return `<p class="empty-copy">No unfinished setup task or recent activity yet. Your next real action will appear here.</p>`;
    return `<div class="records-list">${tasks.map((task) => `<article class="record-card"><header><h3>${escapeHtml(task.title)}</h3><span class="mini-pill">setup</span></header><p>${escapeHtml(task.text)}</p><button class="secondary-button" data-nav="${task.nav}">Continue</button></article>`).join("")}</div>`;
  }

  function safeJson(value, fallback) {
    try {
      return value ? JSON.parse(value) : fallback;
    } catch {
      return fallback;
    }
  }

  function featuredCreatorView() {
    const creator = getFeaturedCreator();
    if (!creator) return `<p class="empty-copy">No featured creator yet. Add real creators with profile details, platform links, and videos to activate this card.</p>`;
    const video = creator.videos?.[0];
    return `<div class="records-list"><article class="record-card">
      <div class="record-main">
        ${imageWithFallback(creator.image, "directory-avatar", creator.name, "directory-avatar placeholder", initials(creator.name))}
        <div><h3>${escapeHtml(creator.name)}</h3><p>${escapeHtml(creator.role || creator.category || "Creator")}</p><small>${escapeHtml(creator.handle || "")}</small></div>
      </div>
      <p>${escapeHtml(creator.description || "No description entered yet.")}</p>
      <div class="pill-row"><span class="mini-pill">profile ${profileCompleteness(creator)}/9</span>${creator.saved ? `<span class="mini-pill">saved</span>` : ""}</div>
      <div class="inline-buttons">
        ${video ? `<button class="watch-button" data-open="${escapeHtml(video.url)}">${iconMap.Play} Watch</button>` : ""}
        <button class="secondary-button" data-support="${creator.id}">Support</button>
        <button class="secondary-button" data-save="${creator.id}">${creator.saved ? "Saved" : "Save"}</button>
        <button class="secondary-button" data-view-profile="${creator.id}">View Profile</button>
        <button class="secondary-button" data-work="${creator.id}">Let's Work Together</button>
      </div>
    </article></div>`;
  }

  function radarView() {
    const matches = getRadarMatches();
    if (!matches.length) return `<p class="empty-copy">No radar matches yet. Add your skills, interests, location, platforms, categories, and collaboration needs in Settings, then add real creators, circles, or collaboration requests.</p>`;
    return `<div class="records-list">${matches.map((match) => `<article class="record-card"><header><h3>${escapeHtml(match.title)}</h3><span class="mini-pill">${escapeHtml(match.kind)}</span></header><p>${escapeHtml(match.text || "Matched CAP record.")}</p><div class="pill-row">${match.hits.map((hit) => `<span class="mini-pill">${escapeHtml(hit)}</span>`).join("")}</div><div class="inline-buttons">${match.creatorId ? `<button class="secondary-button" data-view-profile="${match.creatorId}">View Profile</button><button class="secondary-button" data-work="${match.creatorId}">Let's Work Together</button>` : `<button class="secondary-button" data-nav="${match.nav}">Open</button>`}</div></article>`).join("")}</div>`;
  }

  function creatorMiniCards(creators, empty) {
    if (!creators?.length) return `<p class="empty-copy">${escapeHtml(empty)}</p>`;
    return `<div class="records-list">${creators.map((creator) => `<article class="record-card">
      <div class="record-main">
        ${imageWithFallback(creator.image, "directory-avatar", creator.name, "directory-avatar placeholder", initials(creator.name))}
        <div><h3>${escapeHtml(creator.name)}</h3><p>${escapeHtml(creator.role || creator.category || "Creator")}</p><small>${escapeHtml((creator.discoveryReasons || []).slice(0, 2).join(" - "))}</small></div>
      </div>
      <div class="inline-buttons"><button class="secondary-button" data-view-profile="${creator.id}">View Profile</button><button class="secondary-button" data-follow="${creator.id}">${creator.followed ? "Following" : "Follow"}</button></div>
    </article>`).join("")}</div>`;
  }

  function homeDiscoveryWidgets() {
    const widgets = state.data.homeRecommendations || {};
    return `
      <div class="panel">${panelHeader("Recommended Creators", "")}${creatorMiniCards(widgets.recommendedCreators, "No recommendations yet. CAP will rank creators as profiles gain skills, interests, and activity.")}</div>
      <div class="panel">${panelHeader("People Near Your Interests", "")}${creatorMiniCards(widgets.peopleNearYourInterests, "No interest matches yet.")}</div>
      <div class="panel">${panelHeader("New Creators", "")}${creatorMiniCards(widgets.newCreators, "No new creators yet.")}</div>
      <div class="panel">${panelHeader("Recently Joined", "")}${creatorMiniCards(widgets.recentlyJoined, "No recent joins yet.")}</div>
      <div class="panel">${panelHeader("Trending Creators", "")}${creatorMiniCards(widgets.trendingCreators, "No trending creators yet.")}</div>`;
  }

  function circleList(circles) {
    if (!circles.length) return `<p class="empty-copy">No creator circles yet. Create a circle to start grouping creators by community, topic, or collaboration goal.</p>`;
    return `<div class="circle-list">${circles.map((circle) => `
      <article class="circle-row">
        <div class="circle-icon ${escapeHtml(circle.accent || "violet")}">U</div>
        <div class="circle-copy"><strong>${escapeHtml(circle.name)}</strong><span>${Number(circle.members || 0)} members - ${escapeHtml(circle.detail || "No description yet")}</span></div>
        <button class="secondary-button" data-nav="Circles">Open</button>
      </article>`).join("")}</div>`;
  }

  function discoveryCard() {
    const creators = state.data.discovery || [];
    if (!creators.length) return `<p class="empty-copy">No recommended creators right now. CAP will refresh the queue as new creators, skills, follows, saves, and activity appear.</p>`;
    const creator = creators[state.discoveryIndex % creators.length];
    const video = creator.videos?.[0];
    return `
      <div class="discovery-media-card" data-view-profile="${creator.id}" role="button" tabindex="0" aria-label="Open ${escapeHtml(creator.name)} profile">
        <div class="creator-banner ${creator.banner || creator.image ? "" : "placeholder"}">
          ${coverImage(creator)}
        </div>
        <div class="creator-content">
          ${imageWithFallback(creator.image, "creator-avatar", creator.name, "creator-avatar placeholder", initials(creator.name))}
          <div><h2>${escapeHtml(creator.name)}</h2><span>${escapeHtml(creator.handle)}</span></div>
          ${creator.category ? `<span class="category-pill">${escapeHtml(creator.category)}</span>` : ""}
          <p class="creator-role">${escapeHtml(creator.role || "No role entered")}</p>
          <p class="creator-description">${escapeHtml(creator.description || "No description entered yet.")}</p>
          ${creator.discoveryReasons?.length ? `<div class="pill-row">${creator.discoveryReasons.slice(0, 3).map((reason) => `<span class="mini-pill">${escapeHtml(reason)}</span>`).join("")}</div>` : ""}
          ${platformButtons(creator)}
          ${video ? embedVideo(video.url) : ""}
          <div class="creator-buttons">
            ${video ? `<button class="watch-button" data-open="${escapeHtml(video.url)}">${iconMap.Play} Watch Featured Work</button>` : ""}
            <button class="secondary-button" data-view-profile="${creator.id}">View Profile</button>
            <button class="secondary-button" data-follow="${creator.id}">${creator.followed ? "Following" : "Follow"}</button>
            <button class="secondary-button" data-save="${creator.id}">${creator.saved ? "Saved" : "Save"}</button>
            <button class="secondary-button" data-work="${creator.id}">Let's Work Together</button>
            <button class="secondary-button" data-hide="${creator.id}">Hide</button>
            <button class="secondary-button" data-next>Next</button>
          </div>
        </div>
      </div>`;
  }

  function embedVideo(url) {
    const youtube = String(url).match(/(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/shorts\/)([A-Za-z0-9_-]+)/);
    if (youtube) return `<iframe class="video-frame" src="https://www.youtube.com/embed/${escapeHtml(youtube[1])}" title="Featured video" loading="lazy" allowfullscreen></iframe>`;
    const vimeo = String(url).match(/vimeo\.com\/(\d+)/);
    if (vimeo) return `<iframe class="video-frame" src="https://player.vimeo.com/video/${escapeHtml(vimeo[1])}" title="Featured video" loading="lazy" allowfullscreen></iframe>`;
    return "";
  }

  function videoPlatformName(url) {
    return platformLabel({ url });
  }

  function activityList(items) {
    if (!items.length) return `<p class="empty-copy">No contribution activity yet. CAP will record creator, circle, message, save, and collaboration actions here.</p>`;
    return items.map((item) => `<div class="activity-row"><div class="activity-avatar">${escapeHtml(initials(item.actor))}</div><div><strong>${escapeHtml(item.actor)}</strong><span>${escapeHtml(item.action)}${item.points ? ` - ${item.points} pts` : ""}</span></div><time>${escapeHtml(relativeTime(item.created_at))}</time></div>`).join("");
  }

  function projectGrid(items) {
    if (!items.length) return `<p class="empty-copy">No collaboration requests yet. Use Discovery or Collaborations to create the first request.</p>`;
    return `<div class="project-grid">${items.map((item) => `<article class="project-card"><div class="project-icon">W</div><div class="project-title"><strong>${escapeHtml(item.title)}</strong><span>${escapeHtml(item.status)}</span></div><div class="progress-track"><span style="width:${Number(item.progress || 0)}%"></span></div><small>${Number(item.progress || 0)}%</small></article>`).join("")}</div>`;
  }

  function directoryView() {
    const creators = filteredCreators();
    return `<section class="content-grid directory-only">
      <div class="panel">
        ${panelHeader("Creator Records", "")}
        <div class="records-list">
          ${creators.length ? creators.map(creatorRecord).join("") : `<p class="empty-copy">No registered creator profiles yet. Profiles will appear here after members complete My Profile.</p>`}
        </div>
      </div>
    </section>`;
  }

  function field(name, label, value, required = false, type = "text") {
    return `<label class="field"><span>${label}</span><input name="${name}" type="${type}" value="${escapeHtml(value)}" ${required ? "required" : ""}></label>`;
  }

  function area(name, label, value, extra = "") {
    return `<label class="field ${extra}"><span>${label}</span><textarea name="${name}">${escapeHtml(value)}</textarea></label>`;
  }

  function uploadPreview(target, value, label) {
    const source = imageSrc(value);
    return `<div class="upload-preview" data-upload-preview="${target}">${source ? `<img src="${escapeHtml(source)}" alt="${escapeHtml(label)}" onerror="this.parentElement.classList.add('missing')">` : `<span>No image selected</span>`}</div>`;
  }

  function creatorRecord(creator) {
    return `<article class="record-card">
      <div class="record-main">
        ${imageWithFallback(creator.image, "directory-avatar", creator.name, "directory-avatar placeholder", initials(creator.name))}
        <div><h3>${escapeHtml(creator.name)}</h3><p>${escapeHtml(creator.role || creator.category || "No role entered")}</p><small>${escapeHtml(creator.handle || "")}</small></div>
      </div>
      <p>${escapeHtml(creator.description || "No description entered.")}</p>
      ${platformButtons(creator)}
      <div class="inline-buttons"><button class="secondary-button" data-view-profile="${creator.id}">View Profile</button><button class="secondary-button" data-save="${creator.id}">${creator.saved ? "Unsave" : "Save"}</button><button class="secondary-button" data-work="${creator.id}">Let's Work Together</button></div>
    </article>`;
  }

  function circlesView() {
    const creators = state.data.creators;
    return `<section class="content-grid">
      <div class="panel">${panelHeader("Create Circle", "")}
        <form id="circle-form" class="form-grid">
          ${field("name", "Circle name", "", true)}
          ${field("detail", "Detail", "")}
          <label class="field"><span>Accent</span><select name="accent"><option>violet</option><option>red</option><option>green</option><option>blue</option></select></label>
          <div class="form-actions full"><button class="primary-button" type="submit">Create Circle</button></div>
        </form>
        <div class="select-row">
          <label class="field"><span>Add creator to selected circle</span><select id="member-creator">${creators.map((c) => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join("")}</select></label>
          <button class="secondary-button" data-add-member>Add</button>
        </div>
      </div>
      <div class="panel">${panelHeader("Creator Circles", "")}${circleRecords(filteredCircles())}</div>
    </section>`;
  }

  function circleRecords(circles) {
    if (!circles.length) return `<p class="empty-copy">No circles yet. Create circles to organize creators and track membership.</p>`;
    const memberships = state.data.circleMembership;
    return `<div class="records-list">${circles.map((circle) => {
      const members = memberships.filter((m) => m.circle_id === circle.id);
      return `<article class="record-card" data-circle="${circle.id}"><header><h3>${escapeHtml(circle.name)}</h3><span class="mini-pill">${Number(circle.members || 0)} members</span></header><p>${escapeHtml(circle.detail || "No description yet.")}</p><div class="pill-row">${members.length ? members.map((m) => `<span class="mini-pill">${escapeHtml(m.creator_name)}</span>`).join("") : `<small>No members yet.</small>`}</div><button class="secondary-button" data-select-circle="${circle.id}">Select</button></article>`;
    }).join("")}</div>`;
  }

  function discoveryView(full) {
    return `<section class="dashboard-grid"><div class="panel discovery-panel" style="grid-column: 1 / span 2">${panelHeader("Discovery Queue", "")}${discoveryCard()}</div><div class="panel activity-panel">${panelHeader("Saved Creators", "")}${savedCreators()}</div></section>`;
  }

  function savedCreators() {
    const saved = state.data.creators.filter((creator) => creator.saved);
    if (!saved.length) return `<p class="empty-copy">No saved creators yet. Save creators from Discovery or the Directory.</p>`;
    return `<div class="records-list">${saved.map(creatorRecord).join("")}</div>`;
  }

  function collaborationsView() {
    return `<section class="content-grid">
      <div class="panel">${panelHeader("Create Collaboration Request", "")}
        <form id="collab-form" class="form-grid">
          ${creatorSelect()}
          ${field("title", "Project title", "", true)}
          ${area("message", "Request message", "", "full")}
          <label class="field"><span>Status</span><select name="status"><option>Requested</option><option>In Progress</option><option>Planning</option><option>Completed</option></select></label>
          ${field("progress", "Progress", "0", false, "number")}
          <div class="form-actions full"><button class="primary-button" type="submit">Create Request</button></div>
        </form>
      </div>
      <div class="panel">${panelHeader("Collaboration Records", "")}${collabRecords()}</div>
    </section>`;
  }

  function creatorSelect() {
    return `<label class="field"><span>Creator</span><select name="creatorId"><option value="">No creator selected</option>${state.data.creators.map((c) => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join("")}</select></label>`;
  }

  function collabRecords() {
    const items = state.data.collaborations;
    if (!items.length) return `<p class="empty-copy">No collaboration requests yet. Create one here or use Let's Work Together on a creator.</p>`;
    return `<div class="records-list">${items.map((item) => `<article class="record-card"><header><h3>${escapeHtml(item.title)}</h3><span class="mini-pill">${escapeHtml(item.status)}</span></header><p>${escapeHtml(item.message || "No message entered.")}</p><small>${escapeHtml(item.creator_name || "No creator")} - ${escapeHtml(relativeTime(item.created_at))}</small><div class="progress-track"><span style="width:${Number(item.progress || 0)}%"></span></div></article>`).join("")}</div>`;
  }

  function messagesView() {
    return `<section class="content-grid">
      <div class="panel">${panelHeader("Send Local Message", "")}
        <form id="message-form" class="form-grid">
          ${creatorSelect()}
          ${field("subject", "Subject", "")}
          ${area("body", "Message", "", "full")}
          <div class="form-actions full"><button class="primary-button" type="submit">Send Message</button></div>
        </form>
      </div>
      <div class="panel">${panelHeader("Message Records", "")}${messageRecords()}</div>
    </section>`;
  }

  function messageRecords() {
    const items = state.data.messages;
    if (!items.length) return `<p class="empty-copy">No local messages yet. Send a message to create the first record.</p>`;
    return `<div class="records-list">${items.map((item) => `<article class="record-card"><header><h3>${escapeHtml(item.subject || "Untitled message")}</h3><small>${escapeHtml(relativeTime(item.created_at))}</small></header><p class="message-body">${escapeHtml(item.body)}</p><small>${escapeHtml(item.creator_name || "No creator selected")}</small></article>`).join("")}</div>`;
  }

  function socialPlatformRow(item = {}) {
    const platform = platformLabel(item);
    const handle = inferSocialHandle(item);
    return `<div class="social-platform-row" data-social-row>
      <label class="field"><span>Platform</span><select data-social-platform>${socialPlatforms.map((choice) => `<option value="${escapeHtml(choice)}" ${choice === platform ? "selected" : ""}>${escapeHtml(choice)}</option>`).join("")}</select></label>
      <label class="field"><span>Handle or username</span><input data-social-handle value="${escapeHtml(handle)}"></label>
      <label class="field"><span>Profile URL</span><input data-social-url value="${escapeHtml(item.url || "")}"></label>
      <button class="secondary-button social-remove-button" type="button" data-remove-social>Remove</button>
    </div>`;
  }

  function socialPlatformEditor(platforms) {
    const rows = (platforms || []).length ? platforms : [{}];
    return `<div class="social-platform-editor full">
      <div class="form-section-heading"><h3>Social Platforms</h3></div>
      <div data-social-rows>${rows.map(socialPlatformRow).join("")}</div>
      <div class="form-actions inline-form-actions"><button class="secondary-button" type="button" data-add-social>+ Add Social Platform</button></div>
    </div>`;
  }

  function myCreator() {
    return state.data?.myCreator || null;
  }

  function myProfileView() {
    const p = state.data.profile || {};
    const mine = myCreator();
    const socialRows = mine?.platforms || safeJson(state.data.settings.profilePlatforms, []);
    const videoLines = (mine?.videos || safeJson(state.data.settings.profileVideos, []) || []).map((item) => `${item.title || ""}|${item.url || ""}`).join("\n");
    return `<section class="profile-page">
      <div class="panel profile-editor-panel">
        ${panelHeader("My Profile", "")}
        <form id="my-profile-form" class="form-grid">
          ${field("name", "Creator name", p.name || mine?.name || "", true)}
          ${field("handle", "Handle", p.handle || mine?.handle || "")}
          ${field("role", "Role", p.role || mine?.role || "")}
          ${field("category", "Category", state.data.settings.category || mine?.category || "")}
          ${field("image", "Profile image URL or uploaded image", p.image || mine?.image || "")}
          <label class="field"><span>Upload profile image</span><input type="file" accept="image/png,image/jpeg,image/webp" data-file-target="image">${uploadPreview("image", p.image || mine?.image || "", "Profile image preview")}</label>
          ${field("banner", "Banner image URL or uploaded image", state.data.settings.banner || mine?.banner || "")}
          <label class="field"><span>Upload banner image</span><input type="file" accept="image/png,image/jpeg,image/webp" data-file-target="banner">${uploadPreview("banner", state.data.settings.banner || mine?.banner || "", "Banner image preview")}</label>
          ${area("bio", "Biography", p.bio || mine?.description || "", "full")}
          ${field("skills", "Skills", state.data.settings.skills || "")}
          ${field("location", "Location", state.data.settings.location || "")}
          ${socialPlatformEditor(socialRows)}
          ${area("videos", "Featured videos, one per line: Title|URL", videoLines, "full")}
          ${area("portfolio", "Portfolio", state.data.settings.portfolio || "", "full")}
          ${area("collaborationInterests", "Collaboration interests", state.data.settings.collaborationInterests || "", "full")}
          ${area("lookingFor", "What you are looking for", state.data.settings.lookingFor || "", "full")}
          ${area("mission", "CAP mission", p.mission || "", "full")}
          <div class="form-actions full"><button class="primary-button" type="submit">Save My Profile</button></div>
        </form>
      </div>
      ${state.data.currentUser?.isAdmin ? adminSection() : ""}
    </section>`;
  }

  function adminMetric(title, value, detail) {
    return `<article class="record-card"><header><h3>${escapeHtml(title)}</h3><span class="mini-pill">${escapeHtml(value)}</span></header><p>${escapeHtml(detail)}</p></article>`;
  }

  function adminRanking(title, rows) {
    return `<article class="record-card"><header><h3>${escapeHtml(title)}</h3><span class="mini-pill">${Number(rows?.length || 0)}</span></header>${rows?.length ? `<div class="records-list compact-records">${rows.map((row) => `<p>${escapeHtml(row.name)} - ${Number(row.count || 0)}</p>`).join("")}</div>` : `<p>No activity yet.</p>`}</article>`;
  }

  function adminSection() {
    const admin = state.data.admin || {};
    return `<div class="panel admin-panel">
      ${panelHeader("Admin", "")}
      <div class="admin-grid">
        <div>
          <h3>User Management</h3>
          ${adminMetric("Founder profile", admin.users?.founderProfileComplete ? "complete" : "incomplete", "Local founder account authorization and profile status.")}
          ${adminMetric("Creator profiles", admin.users?.creatorProfiles || 0, "Registered creator profiles published from member profile records.")}
          ${adminMetric("Saved creators", admin.users?.savedCreators || 0, "Creator profiles saved by the current account.")}
        </div>
        <div>
          <h3>Reports</h3>
          ${adminMetric("Activity events", admin.reports?.activityEvents || 0, "Recorded database activity events.")}
          ${adminMetric("Messages", admin.reports?.messages || 0, "Local message records.")}
          ${adminMetric("Collaboration requests", admin.reports?.collaborationRequests || 0, "Collaboration request records.")}
        </div>
        <div>
          <h3>Moderation</h3>
          ${adminMetric("Missing images", admin.moderation?.creatorsMissingImages || 0, "Creator profiles missing profile or banner images.")}
          ${adminMetric("Missing descriptions", admin.moderation?.creatorsMissingDescriptions || 0, "Creator profiles missing biography/description content.")}
          ${adminMetric("Open collaborations", admin.moderation?.openCollaborations || 0, "Collaboration requests not marked completed.")}
        </div>
        <div>
          <h3>Analytics</h3>
          ${adminMetric("Circles", admin.analytics?.circles || 0, "Creator circle records.")}
          ${adminMetric("Memberships", admin.analytics?.circleMemberships || 0, "Circle membership records.")}
          ${adminMetric("Contribution points", admin.analytics?.contributionPoints || 0, "Total points generated by real activity.")}
          ${adminRanking("Most viewed creators", admin.analytics?.mostViewedCreators || [])}
          ${adminRanking("Most followed creators", admin.analytics?.mostFollowedCreators || [])}
          ${adminRanking("Most saved creators", admin.analytics?.mostSavedCreators || [])}
          ${adminRanking("Fastest growing creators", admin.analytics?.fastestGrowingCreators || [])}
        </div>
        <div>
          <h3>Platform Settings</h3>
          <form id="admin-settings-form" class="form-grid compact-form">
            ${field("workspaceName", "Workspace name", state.data.settings.workspaceName || "CAP")}
            ${area("notes", "Admin notes", state.data.settings.notes || "", "full")}
            <div class="form-actions full"><button class="secondary-button" type="submit">Save Platform Settings</button></div>
          </form>
        </div>
        <div>
          <h3>System Health</h3>
          ${adminMetric("Database", admin.systemHealth?.status || "Unknown", admin.systemHealth?.databasePath || "")}
          ${adminMetric("Runtime", "local", "CAP is running from the local Node and SQLite desktop launcher.")}
        </div>
      </div>
    </div>`;
  }

  function splitProfileItems(value) {
    return String(value || "").split(/[\n,|]/).map((item) => item.trim()).filter(Boolean);
  }

  function profileTextSection(title, value, empty) {
    const text = String(value || "").trim();
    return `<section class="profile-section"><h3>${escapeHtml(title)}</h3>${text ? `<p>${escapeHtml(text)}</p>` : `<p class="empty-copy slim">${escapeHtml(empty)}</p>`}</section>`;
  }

  function profilePillSection(title, value, empty) {
    const items = splitProfileItems(value);
    return `<section class="profile-section"><h3>${escapeHtml(title)}</h3>${items.length ? `<div class="pill-row">${items.map((item) => `<span class="mini-pill">${escapeHtml(item)}</span>`).join("")}</div>` : `<p class="empty-copy slim">${escapeHtml(empty)}</p>`}</section>`;
  }

  function profilePortfolioSection(creator) {
    const lines = String(creator.portfolio || "").split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
    if (!lines.length) return `<section class="profile-section"><h3>Portfolio</h3><p class="empty-copy slim">No portfolio items added yet.</p></section>`;
    return `<section class="profile-section"><h3>Portfolio</h3><div class="records-list compact-records">${lines.map((line) => {
      const isUrl = /^https?:\/\//i.test(line);
      return `<article class="record-card"><p>${escapeHtml(line)}</p>${isUrl ? `<button class="secondary-button" data-open="${escapeHtml(line)}">Open</button>` : ""}</article>`;
    }).join("")}</div></section>`;
  }

  function profileVideoSection(creator) {
    const videos = creator.videos || [];
    if (!videos.length) return `<section class="profile-section"><h3>Featured Videos</h3><p class="empty-copy slim">No featured videos added yet.</p></section>`;
    return `<section class="profile-section full-span"><h3>Featured Videos</h3><div class="profile-video-grid">${videos.map((video) => `<article class="record-card profile-video-card"><h4>${escapeHtml(video.title || "Featured video")}</h4>${embedVideo(video.url) || `<div class="video-link-card"><span>${escapeHtml(videoPlatformName(video.url))}</span><button class="watch-button" data-open="${escapeHtml(video.url)}">${iconMap.Play} Watch</button></div>`}</article>`).join("")}</div></section>`;
  }

  function profileCircleSection(creator) {
    const circles = creator.circles || state.data.circleMembership.filter((item) => item.creator_id === creator.id).map((item) => state.data.circles.find((circle) => circle.id === item.circle_id)).filter(Boolean);
    if (!circles.length) return `<section class="profile-section"><h3>Circles</h3><p class="empty-copy slim">This creator has not joined any circles yet.</p></section>`;
    return `<section class="profile-section"><h3>Circles</h3><div class="records-list compact-records">${circles.map((circle) => `<article class="record-card"><header><h4>${escapeHtml(circle.name)}</h4><span class="mini-pill">${Number(circle.members || 0)} members</span></header><p>${escapeHtml(circle.detail || "No circle description yet.")}</p><button class="secondary-button" data-nav="Circles">Open Circle</button></article>`).join("")}</div></section>`;
  }

  function profileProjectSection(creator) {
    const projects = creator.projects || state.data.collaborations.filter((item) => item.creator_id === creator.id);
    if (!projects.length) return `<section class="profile-section"><h3>Projects</h3><p class="empty-copy slim">No collaboration projects connected to this creator yet.</p></section>`;
    return `<section class="profile-section"><h3>Projects</h3><div class="records-list compact-records">${projects.map((project) => `<article class="record-card"><header><h4>${escapeHtml(project.title)}</h4><span class="mini-pill">${escapeHtml(project.status || "Requested")}</span></header><p>${escapeHtml(project.message || "No project details added yet.")}</p><div class="progress-track"><span style="width:${Number(project.progress || 0)}%"></span></div></article>`).join("")}</div></section>`;
  }

  function creatorSocialSection(creator) {
    const social = creator.social || {};
    const mutualCircles = social.mutualCircles || [];
    const mutualSkills = social.mutualSkills || [];
    const sharedInterests = social.sharedInterests || [];
    return `<section class="profile-section full-span"><h3>Community Context</h3>
      <div class="stats-grid">
        ${stat(iconMap.Users, social.followers || 0, "Followers")}
        ${stat(iconMap.Handshake, social.following || 0, "Following")}
      </div>
      <div class="pill-row">
        ${mutualCircles.map((circle) => `<span class="mini-pill">${escapeHtml(circle.name)}</span>`).join("")}
        ${mutualSkills.map((skill) => `<span class="mini-pill">Skill: ${escapeHtml(skill)}</span>`).join("")}
        ${sharedInterests.map((interest) => `<span class="mini-pill">Interest: ${escapeHtml(interest)}</span>`).join("")}
      </div>
      ${!(mutualCircles.length || mutualSkills.length || sharedInterests.length) ? `<p class="empty-copy slim">No mutual circles, skills, or shared interests yet.</p>` : ""}
    </section>`;
  }

  function creatorProfileView() {
    const creator = state.viewingCreator;
    if (!creator) return `<section class="empty-page"><div class="empty-icon">!</div><h2>Creator not found</h2><p>Select a creator from the Directory or Discovery queue.</p><button class="primary-button" data-nav="Directory">Back to Directory</button></section>`;
    const video = creator.videos?.[0];
    return `<section class="profile-page public-profile-page">
      <div class="panel">
        ${panelHeader("Creator Profile", "Back to Directory", "Directory")}
        <div class="public-profile-hero">
          <div class="creator-banner ${creator.banner || creator.image ? "" : "placeholder"}">${coverImage(creator)}</div>
          <div class="public-profile-identity">
            ${imageWithFallback(creator.image, "creator-avatar", creator.name, "creator-avatar placeholder", initials(creator.name))}
            <div class="public-profile-title">
              <h2>${escapeHtml(creator.name)}</h2>
              <span>${escapeHtml(creator.handle || "")}</span>
              <div class="pill-row">${creator.category ? `<span class="category-pill">${escapeHtml(creator.category)}</span>` : ""}${creator.role ? `<span class="mini-pill">${escapeHtml(creator.role)}</span>` : ""}${creator.location ? `<span class="mini-pill">${escapeHtml(creator.location)}</span>` : ""}</div>
            </div>
          </div>
        </div>
        <div class="public-profile-actions">
          ${video ? `<button class="watch-button" data-open="${escapeHtml(video.url)}">${iconMap.Play} Watch</button>` : ""}
          <button class="secondary-button" data-support="${creator.id}">Support</button>
          <button class="secondary-button" data-save="${creator.id}">${creator.saved ? "Saved" : "Save"}</button>
          <button class="secondary-button" data-work="${creator.id}">Let's Work Together</button>
        </div>
        <div class="public-profile-grid">
          ${profileTextSection("Biography", creator.description, "No biography added yet.")}
          ${profilePillSection("Skills", creator.skills, "No skills added yet.")}
          ${profileTextSection("Location", creator.location, "No location added yet.")}
          <section class="profile-section"><h3>Platforms</h3>${platformButtons(creator)}</section>
          ${profileVideoSection(creator)}
          ${profilePortfolioSection(creator)}
          ${profileTextSection("Collaboration Interests", creator.collaboration_interests, "No collaboration interests added yet.")}
          ${profileTextSection("Looking For", creator.looking_for, "No collaboration needs added yet.")}
          ${creatorSocialSection(creator)}
          ${profileCircleSection(creator)}
          ${profileProjectSection(creator)}
        </div>
      </div>
    </section>`;
  }

  function settingsView() {
    return `<section class="content-grid">
      <div class="panel">${panelHeader("Application Settings", "")}
        <form id="settings-form" class="form-grid">
          ${field("workspaceName", "Workspace name", state.data.settings.workspaceName || "CAP")}
          ${area("notes", "Local notes", state.data.settings.notes || "", "full")}
          <div class="form-actions full"><button class="primary-button" type="submit">Save Settings</button></div>
        </form>
      </div>
    </section>`;
  }

  function accountView() {
    const user = state.data.currentUser || state.authUser || {};
    return `<section class="content-grid directory-only">
      <div class="panel">${panelHeader("Account Settings", "")}
        <form id="account-form" class="form-grid">
          ${field("displayName", "Display name", user.displayName || "")}
          ${field("email", "Email", user.email || "")}
          ${field("currentPassword", "Current password", "", false, "password")}
          ${field("newPassword", "New password", "", false, "password")}
          <p class="empty-copy slim full">Leave password fields blank unless you want to change your password.</p>
          <div class="form-actions full">
            <button class="primary-button" type="submit">Save Account</button>
            <button class="secondary-button" type="button" data-sign-out>Sign Out</button>
          </div>
        </form>
      </div>
    </section>`;
  }

  function parseVideoLines(value) {
    return String(value || "").split(/\r?\n/).map((line) => {
      const [first, ...rest] = line.split("|");
      return { title: (first || "").trim(), url: rest.join("|").trim() };
    }).filter((item) => item.url || item.title);
  }

  function collectSocialPlatforms(form) {
    return [...form.querySelectorAll("[data-social-row]")].map((row) => ({
      platform: row.querySelector("[data-social-platform]")?.value || "",
      handle: row.querySelector("[data-social-handle]")?.value || "",
      url: row.querySelector("[data-social-url]")?.value || ""
    })).filter((item) => item.platform || item.handle || item.url);
  }

  function formData(form) {
    return Object.fromEntries(new FormData(form).entries());
  }

  function validateSelectedImage(file) {
    if (!file) return "";
    if (!["image/png", "image/jpeg", "image/webp"].includes(file.type)) return "Choose a PNG, JPG, JPEG, or WebP image.";
    if (file.size > maxImageBytes) return "Image must be 15 MB or smaller.";
    return "";
  }

  function readFile(input) {
    return new Promise((resolve) => {
      const file = input.files?.[0];
      if (!file) return resolve("");
      const validationError = validateSelectedImage(file);
      if (validationError) {
        input.value = "";
        throw new Error(validationError);
      }
      const reader = new FileReader();
      reader.onload = () => resolve({ file, data: reader.result });
      reader.readAsDataURL(file);
    });
  }

  async function uploadSelectedImage(input) {
    const selected = await readFile(input);
    if (!selected) return "";
    const result = await api("/api/uploads", {
      method: "POST",
      body: JSON.stringify({
        name: selected.file.name,
        type: selected.file.type,
        data: selected.data
      })
    });
    return result.path;
  }

  async function applyUploads(form, payload) {
    for (const input of form.querySelectorAll("[data-file-target]")) {
      try {
        const storedPath = await uploadSelectedImage(input);
        if (storedPath) payload[input.dataset.fileTarget] = storedPath;
      } catch (error) {
        throw new Error(`Image upload failed: ${error.message}`);
      }
    }
  }

  function isValidImageReference(value) {
    const source = String(value || "").trim();
    if (!source) return true;
    if (source.startsWith("data/uploads/")) return true;
    if (/^https?:\/\//i.test(source)) {
      try {
        new URL(source);
        return true;
      } catch {
        return false;
      }
    }
    return false;
  }

  function validateImageReferences(payload) {
    if (!isValidImageReference(payload.image)) throw new Error("Profile Image URL must be a valid http or https URL, or choose an upload file instead.");
    if (!isValidImageReference(payload.banner)) throw new Error("Banner Image URL must be a valid http or https URL, or choose an upload file instead.");
  }

  function bindUploadPreviews() {
    root.querySelectorAll("[data-file-target]").forEach((input) => {
      input.addEventListener("change", async () => {
        const file = input.files?.[0];
        const target = input.dataset.fileTarget;
        const preview = root.querySelector(`[data-upload-preview="${target}"]`);
        const textInput = root.querySelector(`input[name="${target}"]`);
        if (!preview || !file) return;
        const validationError = validateSelectedImage(file);
        if (validationError) {
          preview.innerHTML = `<span>${escapeHtml(validationError)}</span>`;
          preview.classList.add("missing");
          input.value = "";
          return;
        }
        const selected = await readFile(input);
        preview.classList.remove("missing");
        preview.innerHTML = `<img src="${escapeHtml(selected.data)}" alt="Selected image preview">`;
        if (textInput) textInput.value = file.name;
      });
    });
  }

  function bindGlobal() {
    root.querySelectorAll("[data-nav]").forEach((button) => button.addEventListener("click", () => { state.active = button.dataset.nav; state.status = ""; render(); }));
    root.querySelectorAll("[data-founder-control]").forEach((button) => button.addEventListener("click", async () => {
      state.founderMode = true;
      state.founderSection = "Overview";
      state.status = "";
      await refreshFounderControl();
      render();
    }));
    root.querySelector("[data-my-profile]")?.addEventListener("click", () => { state.active = "MyProfile"; state.status = ""; render(); });
    root.querySelector("[data-account]")?.addEventListener("click", () => { state.active = "Account"; state.status = ""; render(); });
    root.querySelectorAll("[data-sign-out]").forEach((button) => button.addEventListener("click", async () => {
      await api("/api/auth/logout", { method: "POST", body: JSON.stringify({}) });
      state.authUser = null;
      state.data = null;
      state.founderMode = null;
      state.founderControl = null;
      state.active = "Home";
      state.status = "Signed out.";
      render();
    }));
    root.querySelector("#global-search")?.addEventListener("input", (event) => { state.query = event.target.value; render(); });
    root.querySelector("[data-quick]")?.addEventListener("click", () => { state.active = "MyProfile"; state.status = ""; render(); });
    root.querySelector("[data-find-first-circle]")?.addEventListener("click", () => {
      state.active = "Circles";
      const matches = getWelcomeMatches();
      if (matches.relevantCircles[0]) state.selectedCircle = matches.relevantCircles[0].id;
      state.status = "";
      render();
    });
    root.querySelector("[data-next]")?.addEventListener("click", async (event) => {
      event.stopPropagation();
      const queue = state.data.discovery || [];
      if (queue.length && state.discoveryIndex + 1 >= queue.length) {
        const payload = await api("/api/discovery?refresh=1", { method: "GET" });
        state.data.discovery = payload.recommendations || [];
        state.discoveryIndex = 0;
      } else {
        state.discoveryIndex += 1;
      }
      render();
    });
    root.querySelectorAll("[data-open]").forEach((button) => button.addEventListener("click", (event) => {
      event.stopPropagation();
      const opened = window.open(button.dataset.open, "_blank", "noopener,noreferrer");
      if (opened) opened.opener = null;
    }));
    root.querySelectorAll("[data-save]").forEach((button) => button.addEventListener("click", (event) => { event.stopPropagation(); submit("/api/saved", { creatorId: Number(button.dataset.save) }); }));
    root.querySelectorAll("[data-follow]").forEach((button) => button.addEventListener("click", (event) => { event.stopPropagation(); submit("/api/follow", { creatorId: Number(button.dataset.follow) }); }));
    root.querySelectorAll("[data-hide]").forEach((button) => button.addEventListener("click", async (event) => {
      event.stopPropagation();
      try {
        state.data = await api("/api/hide", { method: "POST", body: JSON.stringify({ creatorId: Number(button.dataset.hide) }) });
        state.discoveryIndex = 0;
        state.status = "Hidden from your queue.";
        render();
      } catch (error) {
        state.status = error.message;
        render(true);
      }
    }));
    root.querySelectorAll("[data-support]").forEach((button) => button.addEventListener("click", (event) => { event.stopPropagation(); submit("/api/support", { creatorId: Number(button.dataset.support) }); }));
    root.querySelectorAll("[data-view-profile]").forEach((button) => button.addEventListener("click", async (event) => {
      event.stopPropagation();
      const creatorId = Number(button.dataset.viewProfile);
      await submit("/api/viewed", { creatorId });
      state.viewingCreator = state.data.creators.find((item) => item.id === creatorId) || null;
      state.active = "CreatorProfile";
      state.status = "";
      render();
    }));
    root.querySelectorAll("[data-continue-type]").forEach((button) => button.addEventListener("click", () => {
      const type = button.dataset.continueType;
      const id = Number(button.dataset.continueId);
      if (type === "creator" || type === "profile") {
        state.viewingCreator = state.data.creators.find((item) => item.id === id) || null;
        state.active = type === "profile" ? "MyProfile" : "CreatorProfile";
      } else if (type === "circle") {
        state.selectedCircle = id;
        state.active = "Circles";
      } else if (type === "collaboration") {
        state.active = "Collaborations";
      } else if (type === "message") {
        state.active = "Messages";
      } else {
        state.active = "Settings";
      }
      state.status = "";
      render();
    }));
    root.querySelectorAll("[data-work]").forEach((button) => button.addEventListener("click", (event) => {
      event.stopPropagation();
      const creator = state.data.creators.find((item) => item.id === Number(button.dataset.work));
      if (!creator) return;
      submit("/api/collaborations", { creatorId: creator.id, title: `Collaboration with ${creator.name}`, message: "Let's work together.", status: "Requested", progress: 0 });
    }));
    root.querySelector("[data-add-social]")?.addEventListener("click", () => {
      const rows = root.querySelector("[data-social-rows]");
      if (rows) rows.insertAdjacentHTML("beforeend", socialPlatformRow({ platform: "YouTube", handle: "", url: "" }));
    });
    root.querySelector("[data-social-rows]")?.addEventListener("click", (event) => {
      const button = event.target.closest("[data-remove-social]");
      if (!button) return;
      const row = button.closest("[data-social-row]");
      if (row) row.remove();
    });
    root.querySelectorAll("[data-select-circle]").forEach((button) => button.addEventListener("click", () => { state.selectedCircle = Number(button.dataset.selectCircle); state.status = "Circle selected."; render(); }));
    root.querySelector("[data-add-member]")?.addEventListener("click", () => {
      const circleId = state.selectedCircle || state.data.circles[0]?.id;
      const creatorId = Number(root.querySelector("#member-creator")?.value);
      if (!circleId) { state.status = "Create or select a circle first."; render(true); return; }
      submit(`/api/circles/${circleId}/members`, { creatorId });
    });
    bindUploadPreviews();
    bindForms();
  }

  function bindFounderControl() {
    const postFounder = async (path, payload, message) => {
      try {
        const result = await api(path, { method: "POST", body: JSON.stringify(payload) });
        state.founderControl = result.founderControl || null;
        state.status = message;
        render();
      } catch (error) {
        state.status = error.message;
        render(true);
      }
    };
    root.querySelector("#founder-search")?.addEventListener("input", (event) => {
      state.founderQuery = event.target.value;
      render();
    });
    root.querySelectorAll("[data-founder-card]").forEach((card) => card.addEventListener("click", () => {
      state.founderSection = card.dataset.founderCard;
      state.status = "";
      render();
    }));
    root.querySelectorAll("[data-founder-card]").forEach((card) => card.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      state.founderSection = card.dataset.founderCard;
      state.status = "";
      render();
    }));
    root.querySelectorAll("[data-founder-section]").forEach((button) => button.addEventListener("click", () => {
      state.founderSection = button.dataset.founderSection;
      state.status = "";
      render();
    }));
    root.querySelectorAll("[data-creator-mode]").forEach((button) => button.addEventListener("click", () => {
      state.founderMode = false;
      state.active = "Home";
      state.status = "Creator Mode active.";
      render();
    }));
    root.querySelectorAll("[data-sign-out]").forEach((button) => button.addEventListener("click", async () => {
      await api("/api/auth/logout", { method: "POST", body: JSON.stringify({}) });
      state.authUser = null;
      state.data = null;
      state.founderMode = null;
      state.founderControl = null;
      state.active = "Home";
      state.status = "Signed out.";
      render();
    }));
    root.querySelectorAll(".founder-user-form").forEach((form) => form.addEventListener("submit", async (event) => {
      event.preventDefault();
      try {
        const payload = formData(form);
        const result = await api("/api/founder/users", {
          method: "POST",
          body: JSON.stringify({
            userId: Number(form.dataset.founderUser),
            displayName: payload.displayName,
            status: payload.status,
            isAdmin: Boolean(form.querySelector('input[name="isAdmin"]')?.checked)
          })
        });
        state.founderControl = result.founderControl || null;
        state.status = "User updated.";
        render();
      } catch (error) {
        state.status = error.message;
        render(true);
      }
    }));
    root.querySelectorAll("[data-founder-user-action]").forEach((button) => button.addEventListener("click", () => {
      postFounder("/api/founder/users", { action: button.dataset.founderUserAction, userId: Number(button.dataset.founderUser) }, "User sessions reset.");
    }));
    root.querySelectorAll(".founder-creator-form").forEach((form) => form.addEventListener("submit", (event) => {
      event.preventDefault();
      postFounder("/api/founder/creators", { ...formData(form), action: "edit", creatorId: Number(form.dataset.founderCreator) }, "Creator profile updated.");
    }));
    root.querySelectorAll("[data-founder-creator-action]").forEach((button) => button.addEventListener("click", () => {
      postFounder("/api/founder/creators", { action: button.dataset.founderCreatorAction, creatorId: Number(button.dataset.founderCreator) }, "Creator moderation updated.");
    }));
    root.querySelector(".founder-moderation-form")?.addEventListener("submit", (event) => {
      event.preventDefault();
      postFounder("/api/founder/moderation", formData(event.currentTarget), "Moderation action logged.");
    });
    root.querySelector(".founder-report-form")?.addEventListener("submit", (event) => {
      event.preventDefault();
      postFounder("/api/founder/reports", { ...formData(event.currentTarget), action: "create" }, "Report created.");
    });
    root.querySelectorAll("[data-founder-report-action]").forEach((button) => button.addEventListener("click", () => {
      postFounder("/api/founder/reports", { action: button.dataset.founderReportAction, reportId: Number(button.dataset.founderReport), resolution: "Founder reviewed." }, "Report updated.");
    }));
    root.querySelectorAll(".founder-circle-form").forEach((form) => form.addEventListener("submit", (event) => {
      event.preventDefault();
      postFounder("/api/founder/circles", { ...formData(form), circleId: Number(form.dataset.founderCircle) }, "Circle updated.");
    }));
    root.querySelectorAll("[data-founder-collab-action]").forEach((button) => button.addEventListener("click", () => {
      postFounder("/api/founder/collaborations", { action: button.dataset.founderCollabAction, collaborationId: Number(button.dataset.founderCollab), note: "Founder reviewed." }, "Collaboration reviewed.");
    }));
    root.querySelector("#founder-settings-form")?.addEventListener("submit", async (event) => {
      event.preventDefault();
      try {
        const result = await api("/api/founder/settings", { method: "POST", body: JSON.stringify(formData(event.currentTarget)) });
        state.founderControl = result.founderControl || null;
        state.status = "Platform settings saved.";
        render();
      } catch (error) {
        state.status = error.message;
        render(true);
      }
    });
    root.querySelectorAll("[data-maintenance-action]").forEach((button) => button.addEventListener("click", async () => {
      try {
        const result = await api("/api/founder/maintenance", { method: "POST", body: JSON.stringify({ action: button.dataset.maintenanceAction }) });
        state.founderControl = result.founderControl || null;
        state.status = "Maintenance action completed.";
        render();
      } catch (error) {
        state.status = error.message;
        render(true);
      }
    }));
  }

  function bindForms() {
    root.querySelector("#my-profile-form")?.addEventListener("submit", async (event) => {
      event.preventDefault();
      try {
        const form = event.currentTarget;
        const payload = formData(form);
        payload.platforms = collectSocialPlatforms(form);
        payload.videos = parseVideoLines(payload.videos);
        payload.platformSearch = payload.platforms.map((item) => `${item.platform} ${item.handle}`.trim()).filter(Boolean).join(", ");
        await applyUploads(form, payload);
        validateImageReferences(payload);
        await submit("/api/my-profile", payload);
        state.active = "MyProfile";
      } catch (error) {
        state.status = error.message;
        render(true);
      }
    });
    root.querySelector("#circle-form")?.addEventListener("submit", (event) => {
      event.preventDefault();
      submit("/api/circles", formData(event.currentTarget));
    });
    root.querySelector("#collab-form")?.addEventListener("submit", (event) => {
      event.preventDefault();
      submit("/api/collaborations", formData(event.currentTarget));
    });
    root.querySelector("#message-form")?.addEventListener("submit", (event) => {
      event.preventDefault();
      submit("/api/messages", formData(event.currentTarget));
    });
    root.querySelector("#settings-form")?.addEventListener("submit", (event) => {
      event.preventDefault();
      submit("/api/settings", formData(event.currentTarget));
    });
    root.querySelector("#admin-settings-form")?.addEventListener("submit", (event) => {
      event.preventDefault();
      submit("/api/settings", formData(event.currentTarget));
    });
    root.querySelector("#account-form")?.addEventListener("submit", async (event) => {
      event.preventDefault();
      try {
        await api("/api/account", { method: "POST", body: JSON.stringify(formData(event.currentTarget)) });
        state.status = "Account updated.";
        await refresh();
      } catch (error) {
        state.status = error.message;
        render(true);
      }
    });
  }

  refresh().catch((error) => {
    root.innerHTML = `<section class="empty-page"><div class="empty-icon">!</div><h2>CAP could not start</h2><p>${escapeHtml(error.message)}</p></section>`;
  });
})();
