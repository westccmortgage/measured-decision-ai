
const root = document.documentElement;
const themeButton = document.querySelector(".theme-toggle");
const themeName = document.querySelector(".theme-name");
const themeThumb = document.querySelector(".theme-thumb");
const themeColor = document.querySelector('meta[name="theme-color"]');
const menuButton = document.querySelector(".menu-button");
const nav = document.querySelector(".main-nav");

function syncTheme() {
  const isDark = root.dataset.theme === "dark";
  if (themeName) themeName.textContent = isDark ? "Night" : "Day";
  if (themeThumb) themeThumb.textContent = isDark ? "☾" : "☼";
  if (themeButton) themeButton.setAttribute("aria-label", isDark ? "Switch to day mode" : "Switch to night mode");
  if (themeColor) themeColor.setAttribute("content", isDark ? "#060a14" : "#f7f6f2");
}

syncTheme();

themeButton?.addEventListener("click", () => {
  root.dataset.theme = root.dataset.theme === "dark" ? "light" : "dark";
  try { localStorage.setItem("mdai-theme", root.dataset.theme); } catch (_) {}
  syncTheme();
});

menuButton?.addEventListener("click", () => {
  const open = menuButton.getAttribute("aria-expanded") === "true";
  menuButton.setAttribute("aria-expanded", String(!open));
  nav?.classList.toggle("is-open", !open);
});

nav?.querySelectorAll("a").forEach((link) => {
  link.addEventListener("click", () => {
    menuButton?.setAttribute("aria-expanded", "false");
    nav.classList.remove("is-open");
  });
});
