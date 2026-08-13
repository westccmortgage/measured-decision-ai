const root = document.documentElement;
const themeButton = document.querySelector(".theme-toggle");
const themeColor = document.querySelector('meta[name="theme-color"]');

function syncTheme() {
  const dark = root.dataset.theme === "dark";
  themeButton.querySelector("span").textContent = dark ? "◐" : "☼";
  themeButton.setAttribute("aria-label", `Switch to ${dark ? "day" : "night"} mode`);
  themeColor.setAttribute("content", dark ? "#060a14" : "#f4f4f0");
}

syncTheme();
themeButton.addEventListener("click", () => {
  root.dataset.theme = root.dataset.theme === "dark" ? "light" : "dark";
  localStorage.setItem("mdai-investor-theme", root.dataset.theme);
  syncTheme();
});

const player = document.querySelector("#investor-player");
const source = document.querySelector("#investor-source");
const activeNumber = document.querySelector("#active-number");
const activeTitle = document.querySelector("#active-title");
const activeDuration = document.querySelector("#active-duration");
const chapters = [...document.querySelectorAll(".chapter")];

chapters.forEach((chapter) => {
  chapter.addEventListener("click", () => {
    if (chapter.classList.contains("is-active")) {
      player.play().catch(() => {});
      return;
    }

    chapters.forEach((item) => {
      const active = item === chapter;
      item.classList.toggle("is-active", active);
      item.setAttribute("aria-pressed", String(active));
    });

    player.pause();
    source.src = chapter.dataset.src;
    player.poster = chapter.dataset.poster;
    activeNumber.textContent = chapter.dataset.number;
    activeTitle.textContent = chapter.dataset.title;
    activeDuration.textContent = chapter.dataset.duration;
    player.load();
    player.play().catch(() => {});
  });
});

const qualificationForm = document.querySelector("#investor-qualification");
const qualificationStatus = document.querySelector("#qualification-status");

qualificationForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const submit = qualificationForm.querySelector('button[type="submit"]');
  submit.disabled = true;
  qualificationStatus.textContent = "Submitting your request…";

  try {
    const response = await fetch("/", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(new FormData(qualificationForm)).toString(),
    });

    if (!response.ok) throw new Error("The request could not be submitted.");
    qualificationForm.reset();
    qualificationStatus.textContent = "Thank you. Your investor access request has been received.";
  } catch (_) {
    qualificationStatus.textContent = "We could not submit the form. Please email hello@measureddecision.com.";
  } finally {
    submit.disabled = false;
  }
});
