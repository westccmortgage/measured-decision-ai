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

const proofStage = document.querySelector(".proof-stage");
const proofVideos = [...document.querySelectorAll(".proof-video")];
const proofTabs = [...document.querySelectorAll(".proof-stage-tab")];
const proofContext = document.querySelector(".proof-stage-context");
const heroVideoToggle = document.querySelector(".hero-video-toggle");
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");

if (proofStage && proofVideos.length && proofTabs.length && heroVideoToggle) {
  const contexts = {
    commercial: "Commercial environment",
    residential: "Field environment"
  };
  let activeName = "commercial";
  let transitionTimer;
  let userPaused = reducedMotion.matches;

  proofVideos.forEach((video) => {
    video.muted = true;
    video.defaultMuted = true;
  });

  const getVideo = (name) => proofVideos.find((video) => video.dataset.proofVideo === name);

  const syncHeroButton = () => {
    const activeVideo = getVideo(activeName);
    const paused = !activeVideo || activeVideo.paused;
    heroVideoToggle.querySelector("span").textContent = paused ? "▶" : "Ⅱ";
    heroVideoToggle.setAttribute("aria-label", paused ? "Play hero video" : "Pause hero video");
  };

  const playActive = () => {
    if (userPaused || reducedMotion.matches || document.hidden) {
      syncHeroButton();
      return;
    }
    const activeVideo = getVideo(activeName);
    const attempt = activeVideo?.play();
    if (attempt && typeof attempt.catch === "function") attempt.catch(syncHeroButton);
  };

  const setProof = (name, { restart = true } = {}) => {
    if (!getVideo(name)) return;
    const previous = getVideo(activeName);
    const next = getVideo(name);
    activeName = name;

    window.clearTimeout(transitionTimer);
    if (restart) next.currentTime = 0;
    next.classList.add("is-active");
    next.setAttribute("aria-hidden", "false");
    next.play().catch(syncHeroButton);
    proofStage.classList.add("has-played");

    proofVideos.forEach((video) => {
      if (video !== next) {
        video.classList.remove("is-active");
        video.setAttribute("aria-hidden", "true");
      }
    });
    transitionTimer = window.setTimeout(() => {
      if (previous && previous !== next) previous.pause();
    }, 850);

    proofTabs.forEach((tab) => {
      const active = tab.dataset.proofTarget === name;
      tab.classList.toggle("is-active", active);
      tab.setAttribute("aria-pressed", String(active));
    });
    if (proofContext) proofContext.textContent = contexts[name];
    syncHeroButton();
  };

  proofTabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      userPaused = false;
      setProof(tab.dataset.proofTarget);
    });
  });

  proofVideos.forEach((video) => {
    video.addEventListener("ended", () => {
      if (video.dataset.proofVideo !== activeName || userPaused) return;
      setProof(activeName === "commercial" ? "residential" : "commercial");
    });
    video.addEventListener("playing", () => {
      proofStage.classList.add("has-played");
      syncHeroButton();
    });
    video.addEventListener("pause", syncHeroButton);
    video.addEventListener("error", syncHeroButton);
  });

  heroVideoToggle.addEventListener("click", () => {
    const activeVideo = getVideo(activeName);
    if (!activeVideo) return;
    if (activeVideo.paused) {
      userPaused = false;
      activeVideo.play().catch(syncHeroButton);
    } else {
      userPaused = true;
      activeVideo.pause();
    }
    syncHeroButton();
  });

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) playActive();
    else proofVideos.forEach((video) => video.pause());
  });

  proofVideos.forEach((video) => video.setAttribute("aria-hidden", video.dataset.proofVideo === activeName ? "false" : "true"));
  if (reducedMotion.matches) {
    proofVideos.forEach((video) => video.pause());
  } else {
    playActive();
  }
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