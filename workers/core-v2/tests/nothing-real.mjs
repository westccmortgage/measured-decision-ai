/* Nothing of a client, nothing of a provider — checked over every byte in the
   directory, not just the files that happen to be code. */
import { harness } from "./harness.mjs";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, extname } from "node:path";
import { syntheticManifest } from "../fixtures/synthetic-project.ts";
import { simulate } from "../cli.ts";

const t = harness("nothing of a client, nothing of a provider");
const root = new URL("..", import.meta.url).pathname;

/* Every file, whatever it is called. Only these kinds may exist here. */
const ALLOWED_EXTENSIONS = new Set([".ts", ".mjs", ".json", ".md", ".sh"]);
const files = [];
const walk = (dir) => { for (const name of readdirSync(dir)) { const p = join(dir, name); if (statSync(p).isDirectory()) { if (name !== "node_modules") walk(p); } else files.push(p); } };
walk(root);

t.section("no client data in the engine or its fixture");
/* The words that must not appear are held here only as digests: a directory
   whose property is that it names no client should not name one in its own
   denylist either. A token is a run of letters or digits, compared lowercase. */
const FORBIDDEN_DIGESTS = new Set([
  "d3a61c684446b22fbc324502c1ad80e4387f0ed707feec1f1ab81a8b3fc65539",
  "b4c8ac20a87e493a3dd30a6f16094149771660c1ae17fbab1e4adfef86c76091",
  "ad05969625c093458a9e1df667770ccf71a19b58159126854bd4bda44f0fdaba",
  "38ff0b7c7cc0761a20be0eae460c39c3496f7924177abc89b3d37e8e274763aa",
  "204133432486031b0224cfc591ac17d8d6b49d4edef5eb3e9649352340fc79b0",
  "a9d1e780687ac78d0eff2fc993037b1dd95440913ae402eb2acb488ee9eb6c03",
]);
const digest = (s) => createHash("sha256").update(s).digest("hex");
const hits = [];
const unexpected = [];
for (const f of files) {
  const rel = f.replace(root, "");
  if (!ALLOWED_EXTENSIONS.has(extname(f))) { unexpected.push(rel); continue; }
  const text = readFileSync(f, "utf8");
  const tokens = new Set(text.toLowerCase().match(/[a-z0-9]+/g) ?? []);
  for (const token of tokens) if (FORBIDDEN_DIGESTS.has(digest(token))) hits.push(`${rel}: a forbidden token`);
}
t.check(`none of ${files.length} files names a client project — the fixture and this test included`, hits.length === 0, hits.join("; "));
t.check("no PDF, image, text dump, spreadsheet or other non-code file is checked in beside the engine", unexpected.length === 0, unexpected.join("; "));
const manifest = syntheticManifest();
t.check("the synthetic manifest is invented: every hash is a hash of its own label", manifest.documents.every((d) => d.contentHash.length === 64) && manifest.pages.every((p) => p.contentHash.length === 64));

t.section("no provider adapter is reachable from the engine");
/* Every way a module can be named: from "x", import "x", import("x"), require("x"). */
const uncommented = (text) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const specifiers = (text) => [...uncommented(text).matchAll(/(?:from\s+|import\s+|import\s*\(\s*|require\s*\(\s*)["']([^"']+)["']/g)].map((m) => m[1]);
const engineSources = files.filter((f) => f.endsWith(".ts") && !f.includes("/tests/"));
const badImports = [];
const nodeImports = [];
for (const f of engineSources) {
  const rel = f.replace(root, "");
  for (const spec of specifiers(readFileSync(f, "utf8"))) {
    if (/ai-providers|openai-transport|supabase|temporal|@anthropic|openai|@google|undici|ws$/.test(spec) || spec.startsWith("npm:") || spec.startsWith("http")) badImports.push(`${rel} → ${spec}`);
    if (!spec.startsWith(".")) nodeImports.push([rel, spec]);
  }
}
t.check("the engine imports no provider SDK, no transport, no Supabase client and no Temporal", badImports.length === 0, badImports.join("; "));
/* The engine proper depends on node:crypto and nothing else. Two files stand
   apart: the network guard imports the transports in order to close them,
   and the CLI imports fs and url to know whether it was run directly. */
const allowedFor = (rel) => rel === "network-guard.ts" ? /^node:(child_process|dns|http|https|module|net|tls)$/
  : rel === "cli.ts" ? /^node:(fs|url)$/ : /^node:crypto$/;
const stray = nodeImports.filter(([rel, spec]) => !allowedFor(rel).test(spec)).map(([rel, spec]) => `${rel} → ${spec}`);
t.check("the engine's only runtime dependency is node:crypto; the guard and the CLI import only what they must", stray.length === 0, stray.join("; "));
t.check("the transports are imported by the guard alone", nodeImports.every(([rel, spec]) => rel === "network-guard.ts" || !/^node:(http|https|net|tls|dns|child_process)$/.test(spec)));

t.section("what the simulation names");
const { summary, executors } = await simulate({ quiet: true });
t.check("the summary names abstract families, never a provider", summary.families.every((f) => !/openai|anthropic|google|claude|gemini|gpt/i.test(f)));
t.check("the summary reports zero network calls", summary.networkCallsAttempted === 0);
t.check("no packet that reached an executor names a provider", executors.packetsSeen.every((p) => !/openai|anthropic|google|claude|gemini|gpt/i.test(JSON.stringify(p))));
t.finish();
