/* Pressing "Create project" did nothing at all — no error, no message, no row.
   A required City and State sat inside a permanently hidden block, so the
   browser refused the form and could not show the message, because the control
   it wanted to point at was not on the screen.

   Asserted in a real browser rather than by reading the markup: the question is
   whether the form the person is looking at actually submits. */
import { chromium } from "/opt/node22/lib/node_modules/playwright/index.mjs";
import path from "path";

const url = "file://" + path.resolve("studio/index.html");
const browser = await chromium.launch({
  executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
  args: ["--no-sandbox", "--no-proxy-server"],
});
const page = await browser.newPage();
await page.goto(url, { waitUntil: "domcontentloaded" });

let bad = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${detail ? `\n       ${detail}` : ""}`);
  if (!ok) bad++;
};

// Fill only what the person can actually see, exactly as the dialog presents it.
const result = await page.evaluate(() => {
  const form = document.querySelector("#property-form");
  const name = document.querySelector("#profile-property-name");
  name.value = "3001 Hutton";
  const invalid = [...form.querySelectorAll(":invalid")].map((el) => ({
    id: el.id,
    hidden: el.offsetParent === null,
    message: el.validationMessage,
  }));
  return { valid: form.checkValidity(), invalid };
});

check("the form submits with only the name filled in", result.valid,
  result.valid ? "" : `blocked by: ${result.invalid.map((f) => `#${f.id}${f.hidden ? " (hidden!)" : ""}`).join(", ")}`);

check("no required control is invisible to the person who must fill it",
  result.invalid.every((f) => !f.hidden),
  result.invalid.filter((f) => f.hidden).map((f) => `#${f.id}`).join(", "));

// The values the code still reads must survive being unasked for.
const defaults = await page.evaluate(() => ({
  city: document.querySelector("#profile-city").value,
  state: document.querySelector("#profile-state").value,
  type: document.querySelector("#profile-property-type").value,
}));
check("the hidden fields are still readable, so the defaults in code apply",
  defaults.city === "" && defaults.state === "" && defaults.type.length > 0,
  JSON.stringify(defaults));

await browser.close();
console.log(bad ? `\n${bad} FAILURES` : "\nALL OK");
process.exit(bad ? 1 : 0);
