(() => {
  let label = "Creator";
  let pending = false;

  function accountLabel(user) {
    if (user?.accountType === "founder") return "Founder";
    if (user?.isAdmin) return "Admin";
    return "Creator";
  }

  async function loadAccountLabel() {
    try {
      const response = await fetch("/api/auth/me", { credentials: "same-origin" });
      const payload = await response.json();
      label = accountLabel(payload.user);
      applyAccountLabel();
    } catch {
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

  function applyAccountLabel() {
    const sidebarLabel = document.querySelector(".profile-card .profile-copy span");
    if (sidebarLabel) sidebarLabel.textContent = label;

    const headings = [...document.querySelectorAll(".panel-header h2")];
    for (const heading of headings) {
      const text = heading.textContent.trim();
      if (text === "Account Settings") ensureLine(heading.closest(".panel")?.querySelector("form"), `Account type: ${label}`);
      if (text === "My Profile") ensureLine(heading.closest(".panel"), `Account type: ${label}`);
    }
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
