/* The day the prime domain moved, every edge function stopped answering.
 *
 * The site became measureddecision.ai. Every Supabase function still carried
 * an origin allowlist naming measureddecision.com and nothing else, and
 * handed back Access-Control-Allow-Origin: measureddecision.com to a page
 * served from .ai. The browser refuses that, so the call throws; every path
 * to a signed URL swallows its own failure and answers with an empty string;
 * and the viewer opened on nothing.
 *
 * Reported from the studio as "I open any file and nothing happens" — with a
 * screenshot of a 360 master showing a black rectangle and its own filename.
 * Nothing was wrong with the file, the record, or the viewer. The page simply
 * could not ask the cloud anything at all.
 *
 * The domain the browser is served from and the domains the functions admit
 * are one fact kept in two places. This holds them together.
 */
import fs from "fs"; import path from "path";

let bad = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "  ok  " : "  FAIL"} ${label}${detail ? `\n         ${detail}` : ""}`);
  if (!ok) bad++;
};

/* Where the site actually lives, read from the redirects rather than typed
   here — the two would drift apart otherwise, which is this whole bug. */
const netlify = fs.readFileSync("netlify.toml", "utf8");
const targets = [...netlify.matchAll(/to\s*=\s*"https:\/\/([a-z0-9.-]+)\/:splat"/gi)].map((m) => m[1]);
const prime = targets[0];
check("the redirects name a prime domain", Boolean(prime), prime || "(none found)");
/* Two prime domains is no prime domain: whichever one a person lands on is
   the one the cloud has to admit, and only one of them ever will. */
check("and only one of them", new Set(targets).size === 1, [...new Set(targets)].join(", "));

/* Every domain this site answers on must send people to the prime one.
   measureddecisionai.com served the whole site at 200 for a while — a second
   live copy on an origin no function admits, which is the "nothing opens"
   failure waiting to happen to whoever found that address. */
const sources = [...netlify.matchAll(/from\s*=\s*"https:\/\/([a-z0-9.-]+)\/\*"/gi)].map((m) => m[1]);
check("every other domain redirects to it",
  sources.length > 0 && !sources.includes(prime), sources.join(", "));
for (const host of sources) {
  const rule = netlify.slice(netlify.indexOf(`from = "https://${host}/*"`));
  check(`${host} is a forced permanent redirect`,
    /status\s*=\s*301/.test(rule.slice(0, 200)) && /force\s*=\s*true/.test(rule.slice(0, 200)),
    rule.split("[[redirects]]")[0].trim().replace(/\s+/g, " "));
}

/* A social card scraper does not follow redirects the way a browser does, so
   an absolute link to the old domain is a broken card, not a slow one. */
for (const page of ["index.html", "investors/index.html", "film-production/index.html",
  "team/index.html", "security/index.html", "construction-owner-oversight/index.html"]) {
  if (!fs.existsSync(page)) continue;
  const html = fs.readFileSync(page, "utf8");
  const links = [...html.matchAll(/(?:og:image|og:url|canonical)[^>]*?"(https:\/\/[a-z0-9.-]+)[^"]*"/gi)]
    .map((m) => m[1]);
  if (!links.length) continue;
  check(`${page} names the prime domain in its card`,
    links.every((url) => url === `https://${prime}`), links.join(", "));
}

const dir = "supabase/functions";
const functions = fs.readdirSync(dir)
  .filter((name) => fs.existsSync(path.join(dir, name, "index.ts")));
check("there are functions to check", functions.length > 0, `${functions.length} found`);

const browserFacing = [];
for (const name of functions) {
  const src = fs.readFileSync(path.join(dir, name, "index.ts"), "utf8");
  if (!/Access-Control-Allow-Origin/.test(src)) continue;
  browserFacing.push(name);
  check(`${name} admits the prime domain`,
    src.includes(`https://${prime}"`), "not in its origin allowlist");
  /* The fallback matters as much as the list: it is what a browser is handed
     when the origin is not recognised, and a fallback naming the old domain
     is a refusal dressed as an answer. */
  const fallbacks = [...src.matchAll(/Allow-Origin"\s*:\s*[^,]*?:\s*"(https:\/\/[a-z0-9.-]+)"/gi)]
    .map((m) => m[1]);
  check(`${name} falls back to the prime domain`,
    fallbacks.length > 0 && fallbacks.every((url) => url === `https://${prime}`),
    fallbacks.join(", ") || "(no fallback found)");
}
check("every browser-facing function was covered", browserFacing.length >= 8,
  `${browserFacing.length}: ${browserFacing.join(", ")}`);

/* Links the functions hand to a person — a capture portal, a field portal —
   must land on the live site too, not on a domain that only redirects. */
for (const name of functions) {
  const src = fs.readFileSync(path.join(dir, name, "index.ts"), "utf8");
  const links = [...src.matchAll(/"(https:\/\/[a-z0-9.-]*measureddecision[a-z0-9.-]*\/[a-z/]*)"/gi)]
    .map((m) => m[1]);
  if (!links.length) continue;
  check(`${name} sends people to the prime domain`,
    links.every((url) => url.startsWith(`https://${prime}/`)), links.join(", "));
}

console.log(bad ? `\n${bad} FAILURES` : "\nALL OK");
process.exit(bad ? 1 : 0);
