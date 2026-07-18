(() => {
  let label = "Creator";
  let accountType = "creator";
  let pending = false;

  const creatorRoleSuggestions = [
    "Creator",
    "Content Creator",
    "Filmmaker",
    "Director",
    "Producer",
    "Music Artist",
    "Designer",
    "Developer",
    "Photographer",
    "Writer",
    "Editor",
    "Animator"
  ];

  function accountLabel(user) {
    if (user?.accountType === "founder") return "Founder";
    if (user?.isAdmin) return "Admin";
    return "Creator";
  }

  async function loadAccountLabel() {
    try {
      const response = await fetch("/api/auth/me", { credentials: "same-origin" });
      const payload = await response.json();
      accountType = payload.user?.accountType || "creator";
      label = accountLabel(payload.user);
      applyAccountLabel();
    } catch {
      accountType = "creator";
      label = "Creator";
    }
  }

  function ensureLine(container, text) {
    if (!container) return;
    let line = container.querySelector("[data-account-type-label]");
    if (!line) {
      line = document.createElement("p");
      line.className = "empty-copy slim full";
      line.dataset.accountTypeLabel = "true";
      container.prepend(line);
    }
    line.textContent = text;
  }

  function ensureRoleSuggestions() {
    const roleInput = document.querySelector('#my-profile-form input[name="role"]');
    if (!roleInput) return;

    roleInput.autocomplete = "off";
    roleInput.setAttribute("list", "cap-creator-role-options");

    let datalist = document.getElementById("cap-creator-role-options");
    if (!datalist) {
      datalist = document.createElement("datalist");
      datalist.id = "cap-creator-role-options";
      document.body.appendChild(datalist);
    }

    const suggestions = accountType === "founder"
      ? ["Founder", ...creatorRoleSuggestions]
      : creatorRoleSuggestions;

    datalist.innerHTML = suggestions
      .map((role) => `<option value="${role.replace(/&/g, "&amp;").replace(/"/g, "&quot;")}"></option>`)
      .join("");

    const validateReservedRole = () => {
      const isReserved = accountType !== "founder" && roleInput.value.trim().toLowerCase() === "founder";
      roleInput.setCustomValidity(isReserved ? "Founder is reserved for the CAP founder account. Choose your creator profession or specialty." : "");
    };

    if (!roleInput.dataset.founderRoleGuard) {
      roleInput.dataset.founderRoleGuard = "true";
      roleInput.addEventListener("input", validateReservedRole);
      roleInput.addEventListener("change", validateReservedRole);
      roleInput.closest("form")?.addEventListener("submit", validateReservedRole, true);
    }

    validateReservedRole();
  }

  function applyAccountLabel() {
    const sidebarLabel = document.querySelector(".profile-card .profile-copy span");
    if (sidebarLabel) sidebarLabel.textContent = label;

    const headings = [...document.querySelectorAll(".panel-header h2")];
    for (const heading of headings) {
      const text = heading.textContent.trim();
      if (text === "Account Settings") ensureLine(heading.closest(".panel")?.querySelector("form"), `Account type: ${label}`);
      if (text === "My Profile") ensureLine(heading.closest(".panel"), `Account type: ${label}`);
    }

    ensureRoleSuggestions();
  }

  function scheduleApply() {
    if (pending) return;
    pending = true;
    requestAnimationFrame(() => {
      pending = false;
      applyAccountLabel();
    });
  }

  new MutationObserver(scheduleApply).observe(document.documentElement, { childList: true, subtree: true });
  loadAccountLabel();
})();
