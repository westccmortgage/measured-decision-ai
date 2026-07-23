const root = document.documentElement;
const themeButton = document.querySelector(".theme-toggle");
const themeName = document.querySelector(".theme-name");
const themeThumb = document.querySelector(".theme-thumb");
const themeColor = document.querySelector('meta[name="theme-color"]');

function syncTheme() {
  const dark = root.dataset.theme === "dark";
  themeName.textContent = dark ? "Night" : "Day";
  themeThumb.textContent = dark ? "◐" : "☼";
  themeButton.setAttribute("aria-label", `Switch to ${dark ? "day" : "night"} mode`);
  themeColor.setAttribute("content", dark ? "#060a14" : "#f7f6f2");
}

syncTheme();
themeButton.addEventListener("click", () => {
  const next = root.dataset.theme === "dark" ? "light" : "dark";
  root.dataset.theme = next;
  localStorage.setItem("mdai-theme", next);
  syncTheme();
});

const menuButton = document.querySelector(".menu-button");
const navigation = document.querySelector(".main-nav");

menuButton.addEventListener("click", () => {
  const open = navigation.classList.toggle("is-open");
  menuButton.setAttribute("aria-expanded", String(open));
});

navigation.querySelectorAll("a").forEach((link) => {
  link.addEventListener("click", () => {
    navigation.classList.remove("is-open");
    menuButton.setAttribute("aria-expanded", "false");
  });
});

const heroVideo = document.querySelector(".hero-video");
const heroVideoToggle = document.querySelector(".hero-video-toggle");

if (heroVideo && heroVideoToggle) {
  const heroMedia = heroVideo.closest(".hero-media");
  heroVideo.muted = true;
  heroVideo.defaultMuted = true;
  heroVideo.loop = true;
  const syncHeroButton = () => {
    const paused = heroVideo.paused;
    heroVideoToggle.querySelector("span").textContent = paused ? "▶" : "Ⅱ";
    heroVideoToggle.setAttribute("aria-label", paused ? "Play hero video" : "Pause hero video");
  };

  const playHero = () => {
    const attempt = heroVideo.play();
    if (attempt && typeof attempt.catch === "function") {
      attempt.catch(syncHeroButton);
    }
  };

  if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
    heroVideo.pause();
  } else {
    playHero();
  }

  heroVideoToggle.addEventListener("click", () => {
    if (heroVideo.paused) playHero();
    else heroVideo.pause();
  });
  heroVideo.addEventListener("playing", () => {
    heroMedia?.classList.add("has-played");
    syncHeroButton();
  });
  heroVideo.addEventListener("pause", syncHeroButton);
  heroVideo.addEventListener("error", () => {
    heroMedia?.classList.remove("has-played");
    syncHeroButton();
  });
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && !matchMedia("(prefers-reduced-motion: reduce)").matches && heroVideo.paused) {
      playHero();
    }
  });
  syncHeroButton();
}

const filmPlayer = document.querySelector("#film-player");
const filmSource = document.querySelector("#film-source");
const filmCaption = document.querySelector("#film-caption");
const filmChoices = document.querySelectorAll(".film-choice");

if (filmPlayer && filmSource && filmCaption && filmChoices.length) {
  const category = document.querySelector("#film-category");
  const title = document.querySelector("#film-active-title");
  const description = document.querySelector("#film-active-description");
  const meta = document.querySelector("#film-active-meta");

  filmChoices.forEach((choice) => {
    choice.addEventListener("click", () => {
      if (choice.classList.contains("is-active")) return;
      filmPlayer.pause();
      filmChoices.forEach((item) => {
        const active = item === choice;
        item.classList.toggle("is-active", active);
        item.setAttribute("aria-pressed", String(active));
      });
      filmSource.src = choice.dataset.filmSrc;
      filmCaption.src = choice.dataset.filmCaption;
      filmPlayer.poster = choice.dataset.filmPoster;
      category.textContent = choice.dataset.filmCategory;
      title.textContent = choice.dataset.filmTitle;
      description.textContent = choice.dataset.filmDescription;
      meta.textContent = choice.dataset.filmMeta;
      filmPlayer.load();
      filmPlayer.addEventListener("loadedmetadata", () => {
        if (filmPlayer.textTracks.length) filmPlayer.textTracks[0].mode = "disabled";
        filmPlayer.play().catch(() => {});
      }, { once: true });
    });
  });
}
