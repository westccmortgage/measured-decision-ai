/* NOTHING OF A CLIENT, NOTHING OF A PROVIDER, NOTHING OF A PROJECT.
 *
 * docs/core-v2.md §1: "The kernel is tested with two synthetic packs whose
 * sources, segments, subjects and predicates are invented and generic.
 * Nothing under `workers/core-v2/` names a client, a property, a drawing, or
 * a legacy fixture; `tests/nothing-real.mjs` proves it."
 *
 * So this file reads the tree rather than the engine: every file in it, every
 * token of every file, every import, and the two SQL files and the design
 * document that tell the same story. Then it runs the engine once, on an
 * invented record set, and reads every packet it handed out — because a rule
 * about what is written down is only half of it; the other half is what the
 * running engine puts in front of an executor.
 *
 * The client names this file must never find are held as digests and never as
 * words: the denylist can be published, read and diffed without printing
 * anybody's name. The provider names are assembled from pieces so this file
 * does not trip its own scan, and this file is the only file excluded from
 * it. Two lines of the kernel do write those names down — the denylist the
 * registry refuses a role by and the denylist a packet is refused by — and a
 * guard cannot ban a word without holding it. So they are not waved through:
 * they are located, counted, named, and one of them is fired to show it is a
 * working guard and not a leak.
 *
 * Nothing here reaches a network, a database or a provider. The clock is
 * manual; the scheduler is ticked by hand.
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { harness, closeNetwork } from "./harness.mjs";
import { syntheticRecordSet } from "../domains/synthetic-records/fixture.ts";
import { sha256Bytes } from "../kernel/ids.ts";
import { SyntheticRecordsPack } from "../domains/synthetic-records/pack.ts";
import { mockExecutors } from "../domains/synthetic-records/mocks.ts";
import { syntheticTranscriptSet } from "../domains/synthetic-transcripts/fixture.ts";
import { assemble, manualClock } from "../domains/simulate.ts";
import { TERMINAL_WORKFLOW_STATES } from "../kernel/transitions.ts";
import { forbiddenContent } from "../kernel/visibility.ts";

const tripped = closeNetwork();
const t = harness("nothing of a client, nothing of a provider, nothing of a project");

/* ───────────────────────────────────────────────────────────── the tree */

const ENGINE = fileURLToPath(new URL("../", import.meta.url));
const REPO = fileURLToPath(new URL("../../../", import.meta.url));
const SELF = fileURLToPath(import.meta.url);
const shortName = (path) => path.startsWith(ENGINE) ? path.slice(ENGINE.length) : path.slice(REPO.length);

function walk(dir, found = []) {
  for (const entry of readdirSync(dir).sort()) {
    if (entry === "node_modules") continue;
    const path = `${dir}${entry}`;
    if (statSync(path).isDirectory()) walk(`${path}/`, found);
    else found.push(path);
  }
  return found;
}

const engineFiles = walk(ENGINE);
const textOf = new Map(engineFiles.map((f) => [f, readFileSync(f, "utf8")]));
const linesOf = (path, text) => text.split("\n").map((line, i) => ({ where: `${shortName(path)}:${i + 1}`, line }));
const engineLines = engineFiles.flatMap((f) => linesOf(f, textOf.get(f)));

const DOC = `${REPO}docs/core-v2.md`;
const MIGRATION = `${REPO}supabase/migrations/058_core_v2_schema.sql`;
const SQL_FIXTURE = `${REPO}supabase/fixtures/core_v2_synthetic.sql`;
const INVARIANTS = `${REPO}supabase/tests/security_invariants.sql`;

/* The Core V2 section of the invariants file, and nothing of V1: from the
   banner to the line that hands the file back to what came before. */
const invariantLines = readFileSync(INVARIANTS, "utf8").split("\n");
const sectionStart = invariantLines.findIndex((l) => l.includes("CORE V2 · THE CHAIN"));
const sectionEnd = invariantLines.findIndex((l, i) => i > sectionStart && l.includes("V1 is where it was"));
const coreV2Section = sectionStart >= 0 && sectionEnd > sectionStart
  ? invariantLines.slice(sectionStart, sectionEnd + 1).map((line, i) => ({ where: `supabase/tests/security_invariants.sql:${sectionStart + i + 1}`, line }))
  : [];

const sha256 = (text) => createHash("sha256").update(text, "utf8").digest("hex");
/* A token: a run of lowercase letters and digits. Underscored identifiers are
   read both whole and in parts, so `plan_documents` is caught as itself and
   `page_count` is caught as `page`. */
function tokensOf(line) {
  const low = line.toLowerCase();
  return new Set([...(low.match(/[a-z0-9]+/g) ?? []), ...(low.match(/[a-z0-9_]+/g) ?? [])]);
}
const scanTokens = (lines, wanted) => lines.flatMap(({ where, line }) => [...tokensOf(line)].filter((tok) => wanted(tok)).map((tok) => `${where} (${tok})`));
const scanLines = (lines, pattern) => lines.filter(({ line }) => pattern.test(line)).map(({ where }) => where);
const list = (hits, limit = 8) => hits.length ? `${hits.slice(0, limit).join(", ")}${hits.length > limit ? ` … +${hits.length - limit}` : ""}` : "none";

/* ══════════════════════════════════ (1) what kinds of file the engine is */
t.section("(1) the engine is source, tests, one manifest, prose and a script — nothing else");

t.check("the walk found the engine's four parts and every file in them",
  ["kernel/", "domains/", "postgres/", "tests/"].every((part) => engineFiles.some((f) => shortName(f).startsWith(part))) && engineFiles.length >= 40,
  `${engineFiles.length} files`);

const ALLOWED_EXTENSIONS = [".ts", ".mjs", ".json", ".md", ".sh"];
const extensionOf = (path) => { const name = path.split("/").pop(); const dot = name.lastIndexOf("."); return dot <= 0 ? "" : name.slice(dot); };
const wrongExtension = engineFiles.filter((f) => !ALLOWED_EXTENSIONS.includes(extensionOf(f))).map(shortName);

t.check("every file under the engine is a .ts, .mjs, .json, .md or .sh — no build output, no binary, no archive, no data file",
  wrongExtension.length === 0, list(wrongExtension));

t.check("the extension rule is a rule, not a formality: it refuses an image, an archive, a key file and a file with no extension at all",
  ["fixture.png", "sources.zip", "service.pem", "Makefile"].every((name) => !ALLOWED_EXTENSIONS.includes(extensionOf(`${ENGINE}${name}`))));

t.check("the engine carries no installed dependency tree and its manifest declares no dependency — nothing from outside is here to name",
  !existsSync(`${ENGINE}node_modules`) && Object.keys(JSON.parse(textOf.get(`${ENGINE}package.json`)).dependencies ?? {}).length === 0);

/* ══════════════════════════════════════════ (2) no client is named at all */
t.section("(2) no client is named — in the engine, the design, the schema, the fixture or the invariants");

/* Held as digests so the denylist itself names nobody. */
const CLIENT_TOKENS = new Set([
  "d3a61c684446b22fbc324502c1ad80e4387f0ed707feec1f1ab81a8b3fc65539",
  "b4c8ac20a87e493a3dd30a6f16094149771660c1ae17fbab1e4adfef86c76091",
  "ad05969625c093458a9e1df667770ccf71a19b58159126854bd4bda44f0fdaba",
  "38ff0b7c7cc0761a20be0eae460c39c3496f7924177abc89b3d37e8e274763aa",
  "204133432486031b0224cfc591ac17d8d6b49d4edef5eb3e9649352340fc79b0",
  "a9d1e780687ac78d0eff2fc993037b1dd95440913ae402eb2acb488ee9eb6c03",
]);
const isClientToken = (tok) => CLIENT_TOKENS.has(sha256(tok));

t.check("the denylist is six distinct sha-256 digests and no word: this file can be published without publishing a client's name",
  CLIENT_TOKENS.size === 6 && [...CLIENT_TOKENS].every((d) => /^[0-9a-f]{64}$/.test(d)));

{
  /* A name nobody has, planted in a line of the shape the scan reads. */
  const planted = "quernsley";
  const plantedList = new Set([sha256(planted)]);
  const scan = (lines) => scanTokens(lines, (tok) => plantedList.has(sha256(tok)));
  t.check("the scan catches a planted client name in a comment, in a string, in an identifier and in a SQL literal",
    scan([
      { where: "planted:1", line: `/* the ${planted} account */` },
      { where: "planted:2", line: `const label = "${planted} record set";` },
      { where: "planted:3", line: `const ${planted}_total = 4;` },
      { where: "planted:4", line: `insert into x(name) values ('${planted}');` },
    ]).length === 4);
  t.check("the scan reads whole tokens, so an invented word that merely contains the planted letters is not a client",
    scan([{ where: "planted:5", line: `const ${planted}ish = "harmless";` }]).length === 0);
}

const CORPUS = [
  ["the engine", engineLines],
  ["the design document", linesOf(DOC, readFileSync(DOC, "utf8"))],
  ["migration 058", linesOf(MIGRATION, readFileSync(MIGRATION, "utf8"))],
  ["the synthetic SQL fixture", linesOf(SQL_FIXTURE, readFileSync(SQL_FIXTURE, "utf8"))],
  ["the Core V2 section of the security invariants", coreV2Section],
];

t.check("the Core V2 section of the invariants was located by its own banner and ends where V1 begins",
  coreV2Section.length > 500 && coreV2Section.some(({ line }) => line.includes("core_v2")),
  `${coreV2Section.length} lines, ${sectionStart + 1}–${sectionEnd + 1}`);

for (const [name, lines] of CORPUS) {
  const hits = scanTokens(lines, isClientToken);
  t.check(`no client is named anywhere in ${name}`, hits.length === 0, list(hits));
}

t.check("the whole corpus was actually read: tokens were taken from every part of it",
  CORPUS.every(([, lines]) => lines.length > 20) && CORPUS.reduce((n, [, lines]) => n + lines.reduce((m, { line }) => m + tokensOf(line).size, 0), 0) > 50_000,
  CORPUS.map(([name, lines]) => `${name}: ${lines.length} lines`).join(" · "));

/* ══════════════════════════════════════════════ (3) no provider is named */
t.section("(3) no provider is named — a role is work, never a vendor");

/* Assembled from pieces, so this file's own source carries none of them. */
const PROVIDER_NAMES = [["open", "ai"], ["anthro", "pic"], ["gem", "ini"], ["cla", "ude"], ["chat", "g", "pt"], ["ver", "tex"], ["bed", "rock"], ["mist", "ral"], ["deep", "seek"]].map((p) => p.join(""));
const PROVIDER_ALTERNATIVES = [...PROVIDER_NAMES, `${["g", "pt"].join("")}-?\\d`];
const NAMES_A_PROVIDER = new RegExp(`(?:^|[^a-z0-9])(?:${PROVIDER_ALTERNATIVES.join("|")})(?:[^a-z0-9]|$)`, "i");

t.check("the provider matcher recognises each of the nine vendor names and a model family written with its number",
  [...PROVIDER_NAMES.map((n) => `routed to ${n} today`), `routed to ${["g", "pt"].join("")}-4 today`].every((line) => NAMES_A_PROVIDER.test(line)));

t.check("the provider matcher does not fire on the words the engine legitimately uses about models and vendors",
  ["the router picks a family and a configuration, never a vendor", "modelConfiguration: \"code\"", "provider cost is recorded on the attempt", "the budget is a limit, not a target"]
    .every((line) => !NAMES_A_PROVIDER.test(line)));

const providerHits = engineLines.filter(({ where }) => !where.startsWith(shortName(SELF))).filter(({ line }) => NAMES_A_PROVIDER.test(line));
const isDenylistLine = ({ line }) => /PROVIDER_WORDS\s*=/.test(line);
const strayProviderHits = providerHits.filter((hit) => !isDenylistLine(hit)).map((h) => h.where);
const denylistHits = providerHits.filter(isDenylistLine).map((h) => h.where);

t.check("no file in the engine names a provider, except on the lines where the kernel writes down the names it keeps out",
  strayProviderHits.length === 0, list(strayProviderHits));

t.check("those lines are exactly two, one per guard: the registry's, which refuses a role named after a vendor, and the packet's, which refuses a packet that names one",
  denylistHits.length === 2 && denylistHits.some((w) => w.startsWith("kernel/roles.ts:")) && denylistHits.some((w) => w.startsWith("kernel/visibility.ts:")),
  list(denylistHits));

t.check("the packet guard's denylist is a working guard: it refuses a packet whose objective names a vendor, and passes the same packet without the name",
  forbiddenContent({ objective: `read the source with ${PROVIDER_NAMES[0]}`, context: { claims: [] } }).some((p) => /names a provider/.test(p))
  && forbiddenContent({ objective: "read the source", context: { claims: [] } }).length === 0);

t.check("nothing outside the kernel names a provider at all — not a pack, not an executor, not a test, not the command line, not the README",
  providerHits.every(({ where }) => where.startsWith("kernel/")),
  list(providerHits.filter(({ where }) => !where.startsWith("kernel/")).map((h) => h.where)));

/* ═══════════════════════════════ (4) the kernel speaks no domain's language */
t.section("(4) the kernel knows sources, segments, claims and subjects — and no domain's nouns");

const kernelLines = engineLines.filter(({ where }) => where.startsWith("kernel/"));
/* Nouns that name somebody's domain. "material" is deliberately absent: the
   kernel's own rule is that every *material* attribute of a value is compared,
   and that is the English adjective, not the domain's noun. A word list that
   cannot tell the two apart makes the check unreadable rather than strict. */
const DOMAIN_WORDS = [
  "drawing", "drawings", "blueprint", "legend", "symbol", "symbols", "dimension", "dimensions", "takeoff",
  "contractor", "invoice", "property", "properties", "project_documents", "ai_runs", "evidence_items",
  "page", "pages", "sheet", "sheets", "schedule", "schedules", "materials", "construction",
];

{
  const planted = scanTokens([
    { where: "planted:1", line: "/* one drawing per sheet */" },
    { where: "planted:2", line: "type Takeoff = { pages: number };" },
    { where: "planted:3", line: "select * from public.project_documents;" },
  ], (tok) => DOMAIN_WORDS.includes(tok));
  t.check("the domain-word scan is a scan: a noun planted in a comment, in a type and in a table name is found in all three, whatever case it is written in",
    planted.length === 5 && new Set(planted.map((h) => h.split(" ")[0])).size === 3, list(planted));
}

t.check("the domain-word scan leaves the kernel's own nouns alone",
  scanTokens([{ where: "planted:4", line: "const segment = { sourceId, segmentKind, contentHash, locator, subjectKey };" }], (tok) => DOMAIN_WORDS.includes(tok)).length === 0);

for (const word of DOMAIN_WORDS) {
  const hits = scanTokens(kernelLines, (tok) => tok === word).map((h) => h.replace(` (${word})`, ""));
  t.check(`${hits.length ? "KERNEL DEFECT: " : ""}the kernel never says "${word}" — that noun belongs to a pack, not to the kernel`,
    hits.length === 0, list(hits, 14));
}

/* ═════════════════════════════════ (5) what the engine is allowed to import */
t.section("(5) the kernel imports node and itself; nothing here imports anything outside the engine");

/* Every module specifier in a source file. A specifier is a built-in, a
   relative path, or a package name — never prose about the word the reader
   looks for, and never a fragment of a regular expression that quotes it. */
const PACKAGE_LIKE = /^@?[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9._-]+)*$/;
const isBuiltin = (spec) => spec.startsWith("node:");
const isRelative = (spec) => spec.startsWith("./") || spec.startsWith("../");
function specifiersOf(text) {
  return [...text.matchAll(/from\s*["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)|require\(\s*["']([^"']+)["']\s*\)/g)]
    .map((m) => m[1] ?? m[2] ?? m[3])
    .filter((spec) => !/\s/.test(spec) && (isBuiltin(spec) || isRelative(spec) || PACKAGE_LIKE.test(spec)));
}
const sourceFiles = engineFiles.filter((f) => /\.(ts|mjs)$/.test(f));
const imports = sourceFiles.flatMap((f) => specifiersOf(textOf.get(f)).map((spec) => ({ from: shortName(f), spec })));
const resolveSpec = (from, spec) => new URL(spec, new URL(from, `file://${ENGINE}`)).pathname;

/* Built letter by letter so this file itself carries no import of a package
   and no import that reaches outside the engine — the scan below reads this
   file too. */
const FROM = ["fr", "om"].join("");
const plantedSource = [`import x ${FROM} "some-package";`, `import { y } ${FROM} "../../../app/y.ts";`, `import { z } ${FROM} "node:crypto";`].join("\n");

t.check("the import reader found the engine's imports, reads a planted package import, a planted reach outside the engine and a planted built-in, and is fooled neither by prose nor by a regular expression that quotes the word it looks for",
  imports.length > 80 && specifiersOf(plantedSource).length === 3
  && specifiersOf(`/* one reading differs ${FROM} "another reading" */`).length === 0
  && specifiersOf(`const found = text.match(/${FROM} "([^"]+)"/g);`).length === 0,
  `${imports.length} imports across ${sourceFiles.length} source files`);

const bareImports = imports.filter(({ spec }) => !isBuiltin(spec) && !isRelative(spec));
t.check("nothing in the engine imports a package: every import is a node built-in or a file of this engine",
  bareImports.length === 0, list(bareImports.map((i) => `${i.from} -> ${i.spec}`)));

const outsideEngine = imports.filter(({ from, spec }) => isRelative(spec) && !resolveSpec(from, spec).startsWith(ENGINE));
t.check("no import reaches outside workers/core-v2 — not into the application, not into another worker",
  outsideEngine.length === 0, list(outsideEngine.map((i) => `${i.from} -> ${i.spec}`)));

const missingTargets = imports.filter(({ from, spec }) => isRelative(spec) && !existsSync(resolveSpec(from, spec)));
t.check("every relative import names a file that exists, with its extension written out — the engine runs unbuilt",
  missingTargets.length === 0, list(missingTargets.map((i) => `${i.from} -> ${i.spec}`)));

const kernelImports = imports.filter(({ from }) => from.startsWith("kernel/"));
const kernelStrays = kernelImports.filter(({ spec }) => !isBuiltin(spec) && !/^\.\/[a-z-]+\.ts$/.test(spec));
t.check("the kernel imports only node built-ins and its own sibling files: no pack, no adapter, no test",
  kernelStrays.length === 0 && kernelImports.length > 40, list(kernelStrays.map((i) => `${i.from} -> ${i.spec}`)));

const outerStrays = imports
  .filter(({ from }) => from.startsWith("domains/") || from.startsWith("postgres/"))
  .filter(({ from, spec }) => {
    if (isBuiltin(spec)) return false;
    const target = shortName(resolveSpec(from, spec));
    const own = from.startsWith("domains/") ? "domains/" : "postgres/";
    return !target.startsWith("kernel/") && !target.startsWith(own);
  });
t.check("a pack and the database adapter import node built-ins, the kernel and themselves — a pack never imports the adapter, and neither imports a test",
  outerStrays.length === 0, list(outerStrays.map((i) => `${i.from} -> ${i.spec}`)));

const TRANSPORTS = ["node:http", "node:https", "node:net", "node:tls", "node:dns", "node:child_process"];
const transportImporters = [...new Set(imports.filter(({ spec }) => TRANSPORTS.includes(spec)).map((i) => i.from))].sort();
t.check("the only kernel file that may open a socket, resolve a name or start a process is the guard that closes all three — no other kernel file imports a transport module",
  transportImporters.filter((f) => f.startsWith("kernel/")).join(", ") === "kernel/network-guard.ts",
  transportImporters.filter((f) => f.startsWith("kernel/")).join(", ") || "none");

/* Two kinds of file outside the kernel may name a transport: the database
   adapter, which has to open a socket to a local cluster, and a test that
   proves the guard has sealed one. Nothing that carries the work — no pack,
   no fixture, no scripted executor — may name one at all. */
const outsideTransport = transportImporters.filter((f) => !f.startsWith("kernel/"));
t.check("outside the kernel a transport is named only by the database adapter and by the tests that prove the doors are shut — never by a pack, a fixture or a scripted executor",
  outsideTransport.every((f) => f === "postgres/wire.ts" || f.startsWith("tests/")),
  list(outsideTransport));
t.check("no file under domains/ names a transport module at all",
  transportImporters.filter((f) => f.startsWith("domains/")).length === 0,
  list(transportImporters.filter((f) => f.startsWith("domains/"))));

{
  const guard = textOf.get(`${ENGINE}kernel/network-guard.ts`);
  const guardTransports = specifiersOf(guard).filter((spec) => TRANSPORTS.includes(spec));
  const unsealed = guardTransports.filter((spec) => !new RegExp(`seal\\(\\s*${spec.slice("node:".length)}\\b`).test(guard));
  t.check("the guard imports every transport module there is, and imports each one only to replace it: each import it makes, it seals, by a definition that cannot be written back",
    guardTransports.length === TRANSPORTS.length && unsealed.length === 0 && /writable: false, configurable: false/.test(guard),
    unsealed.length ? `not sealed: ${unsealed.join(", ")}` : guardTransports.join(", "));
}

/* ═════════════════════════════════ (6) a live run, and what it hands out */
t.section("(6) a whole run on invented records: no packet carries a place to fetch from or a way in");

const truth = syntheticRecordSet({ seed: "nothing-real/records", sources: 1, sheetsPerSource: 2, entriesPerTable: 3 });
const { registry } = mockExecutors(truth);
const live = assemble({ manifest: truth.manifest, pack: new SyntheticRecordsPack(), executors: registry, clock: manualClock() });
await live.scheduler.plan();
for (let i = 0; i < 80; i++) {
  const report = await live.scheduler.tick();
  if (report.dispatched.length === 0 && report.released === 0 && report.stopped === 0 && report.reconciled === 0 && live.scheduler.inFlight.size === 0) break;
}
const liveReport = await live.scheduler.runUntilQuiescent();
const liveTasks = await live.repo.listTasks(truth.manifest.workflowId);
const liveClaims = await live.repo.listClaims({ workflowId: truth.manifest.workflowId });
const packets = registry.packetsSeen;
const packetText = packets.map((p) => ({ where: `packet ${p.roleKey}/${p.taskId.slice(0, 8)}`, line: JSON.stringify(p) }));

t.check("the run really ran: sources were ingested, subjects were read blind, claims were made and the workflow reached a terminal state",
  liveTasks.filter((x) => x.state === "completed").length >= 6 && liveClaims.length > 0 && packets.length >= 6
  && TERMINAL_WORKFLOW_STATES.includes(liveReport.workflow.state),
  `${packets.length} packets, ${liveTasks.length} tasks, ${liveClaims.length} claims, workflow ${liveReport.workflow.state}`);

const URL_IN_TEXT = /https?:\/\//i;
const KEY_IN_TEXT = /api[_-]?key|access[_-]?token|[?&]token=|bearer\s+[a-z0-9]|"secret[a-z_]*"\s*:|x-amz-signature/i;

t.check("the packet scanners are scanners: a planted link, a planted key, a planted bearer header, a planted signed link and a planted secret are each found",
  URL_IN_TEXT.test('{"uri":"https://example.invalid/a.pdf"}')
  && ['{"api_key":"x"}', '{"a":"?token=abc"}', '{"h":"bearer 8fa2"}', '{"secret_key":"x"}', '{"u":"x-amz-signature=9"}'].every((line) => KEY_IN_TEXT.test(line)));

t.check("and neither scanner fires on the words a packet legitimately carries: a fixture scheme, a subject called a token of speech, a segment counted in pages",
  !URL_IN_TEXT.test('{"uri":"fixture://synthetic-records/1"}')
  && !KEY_IN_TEXT.test('{"subjectKey":"turn/4","predicate":"token_count","value":{"quantity":812}}'));

t.check("no packet the engine handed out carries an http or https link — a source is named by id and hash, never by a place to fetch it from",
  scanLines(packetText, URL_IN_TEXT).length === 0, list(scanLines(packetText, URL_IN_TEXT)));

t.check("no packet carries a key, a token, a bearer header or a signed link",
  scanLines(packetText, KEY_IN_TEXT).length === 0, list(scanLines(packetText, KEY_IN_TEXT)));

t.check("the manifest the run started from does carry a fixture uri per source, and no packet carries any uri at all — the scan had something to find and did not find it",
  truth.manifest.sources.every((s) => typeof s.uri === "string" && s.uri.length > 0)
  && packets.every((p) => p.sources.every((s) => !("uri" in s)))
  && scanLines(packetText, /fixture:\/\//).length === 0);

t.check("every source in every packet is identified by an id and a content hash, which is all an executor is given to work from",
  packets.flatMap((p) => p.sources).length > 0 && packets.every((p) => p.sources.every((s) => typeof s.sourceId === "string" && s.sourceId.length > 0 && typeof s.contentHash === "string" && s.contentHash.length > 0)));

t.check("no packet names a provider either — the running engine hands out no vendor name",
  scanLines(packetText, NAMES_A_PROVIDER).length === 0, list(scanLines(packetText, NAMES_A_PROVIDER)));

t.check("no packet names a client",
  scanTokens(packetText, isClientToken).length === 0, list(scanTokens(packetText, isClientToken)));

/* ══════════════════════════════════════════ (7) the fixtures are invented */
t.section("(7) the fixtures are invented: a scheme nothing can fetch, hashes of nothing that exists");

const recordsA = syntheticRecordSet({ seed: "nothing-real/seed-a", sources: 2, sheetsPerSource: 2 });
const recordsB = syntheticRecordSet({ seed: "nothing-real/seed-b", sources: 2, sheetsPerSource: 2 });
const recordsAgain = syntheticRecordSet({ seed: "nothing-real/seed-a", sources: 2, sheetsPerSource: 2 });
const transcripts = syntheticTranscriptSet({ seed: "nothing-real/recordings", recordings: 2, scenesPerRecording: 3 });

const recordHashes = (set) => [
  ...set.manifest.sources.map((s) => s.contentHash),
  ...set.manifest.sources.flatMap((s) => s.declaredSegments.map((d) => d.contentHash)),
  ...set.sheets.map((s) => s.contentHash),
  ...set.sheets.flatMap((s) => s.regions.map((r) => r.contentHash)),
];
const transcriptHashes = (set) => [...set.manifest.sources.map((s) => s.contentHash), ...set.recordings.flatMap((r) => [r.contentHash, ...r.scenes.map((sc) => sc.contentHash)])];

t.check("every source of both synthetic packs is addressed under a scheme nothing can fetch: fixture://",
  [...recordsA.manifest.sources, ...recordsB.manifest.sources, ...transcripts.manifest.sources].every((s) => s.uri.startsWith("fixture://"))
  && [...recordsA.manifest.sources, ...transcripts.manifest.sources].every((s) => s.uri.split("://")[0] === "fixture"),
  recordsA.manifest.sources[0].uri);

/* The record fixture's hashes are the sha-256 of material it invented and
   holds: that is what lets a runtime check that what a resolver handed it is
   what an assignment named. So the test is no longer "they are marked as
   invented" but the stronger "each one is the hash of bytes this fixture
   made up, and the bytes are here". */
t.check("every content hash in the record fixture is the sha-256 of material the fixture invented, and the material is in the fixture",
  recordHashes(recordsA).length >= 12
  && recordHashes(recordsA).every((h) => /^[0-9a-f]{64}$/.test(h))
  && [...recordsA.material].every(([hash, item]) => sha256Bytes(item.bytes) === hash)
  && recordHashes(recordsA).filter((h) => recordsA.material.has(h)).length >= 4,
  `${recordHashes(recordsA).length} hashes over ${recordsA.material.size} pieces of material`);

t.check("every content hash in the recording fixture is invented too, marked fx-",
  transcriptHashes(transcripts).length >= 8 && transcriptHashes(transcripts).every((h) => h.startsWith("fx-")), `${transcriptHashes(transcripts).length} hashes`);

{
  const a = new Set(recordHashes(recordsA));
  const shared = recordHashes(recordsB).filter((h) => a.has(h));
  t.check("two seeds are two different worlds: they share no content hash at all",
    shared.length === 0 && recordHashes(recordsB).length === recordHashes(recordsA).length, list(shared));
  const crossed = transcriptHashes(transcripts).filter((h) => a.has(h));
  t.check("the two packs are two different worlds as well: no hash of a recording is a hash of a record set", crossed.length === 0, list(crossed));
}

t.check("one seed is one world: asked twice, the fixture returns exactly the same hashes in exactly the same order",
  recordHashes(recordsAgain).join("|") === recordHashes(recordsA).join("|"));

t.check("one seed names the same ids too: the workflow, the organisation and the sources are derived from the seed, never drawn at random",
  recordsAgain.manifest.workflowId === recordsA.manifest.workflowId
  && recordsAgain.manifest.organizationId === recordsA.manifest.organizationId
  && recordsAgain.manifest.sources.map((s) => s.sourceId).join("|") === recordsA.manifest.sources.map((s) => s.sourceId).join("|"));

t.check("two seeds name two different workflows, so no run of one can be mistaken for a run of the other",
  recordsA.manifest.workflowId !== recordsB.manifest.workflowId);

t.check("the fixtures say so about themselves: every source is marked a fixture and every manifest records which seed made it",
  [...recordsA.manifest.sources, ...transcripts.manifest.sources].every((s) => s.media?.fixture === true)
  && recordsA.manifest.requestedScope.fixture === "nothing-real/seed-a" && transcripts.manifest.requestedScope.fixture === "nothing-real/recordings");

{
  const sqlFixture = readFileSync(SQL_FIXTURE, "utf8");
  const uris = [...sqlFixture.matchAll(/'([a-z]+:\/\/[^']*)'/g)].map((m) => m[1]);
  const hashes = [...sqlFixture.matchAll(/'(fixture-[a-z-]+-hash-[a-z0-9-]+)'/g)].map((m) => m[1]);
  t.check("the SQL fixture is invented in the same way: every uri it inserts is a fixture:// one and every hash it inserts says it is a fixture's",
    uris.length >= 2 && uris.every((u) => u.startsWith("fixture://")) && hashes.length >= 2, `${uris.length} uris, ${hashes.length} hashes`);
}

/* ═════════════════════════ (8) the schema names no table an old project owns */
t.section("(8) migration 058 and its fixture name the kernel's tables and no legacy one");

const LEGACY_EXACT = ["properties", "project_documents", "evidence_items", "ai_runs"];
const isLegacyTable = (tok) => LEGACY_EXACT.includes(tok) || /^plan_[a-z0-9_]+$/.test(tok) || /^vision_[a-z0-9_]+$/.test(tok);

t.check("the legacy-table scan is a scan: it catches each named table, a plan_ table and a vision_ table wherever they are written",
  scanTokens([
    { where: "planted:1", line: "insert into public.properties(id) values (1);" },
    { where: "planted:2", line: "  references public.project_documents(id) on delete cascade," },
    { where: "planted:3", line: "select * from public.plan_pages join public.vision_releases using (id);" },
    { where: "planted:4", line: "delete from public.evidence_items where ai_runs is null;" },
  ], isLegacyTable).length === 6);

t.check("and leaves the kernel's own tables alone",
  scanTokens([{ where: "planted:5", line: "insert into public.evidence_claims(id, workflow_id) select id, workflow_id from public.workflow_tasks;" }], isLegacyTable).length === 0);

for (const [name, path] of [["migration 058", MIGRATION], ["the synthetic SQL fixture", SQL_FIXTURE]]) {
  const hits = scanTokens(linesOf(path, readFileSync(path, "utf8")), isLegacyTable);
  t.check(`${name} names no properties, project_documents, evidence_items or ai_runs table, and nothing beginning plan_ or vision_`, hits.length === 0, list(hits));
}

{
  const migration = readFileSync(MIGRATION, "utf8");
  const created = [...migration.matchAll(/create\s+table\s+(?:if\s+not\s+exists\s+)?public\.([a-z0-9_]+)/gi)].map((m) => m[1].toLowerCase());
  const fixtureTargets = [...new Set([...readFileSync(SQL_FIXTURE, "utf8").matchAll(/insert\s+into\s+public\.([a-z0-9_]+)/gi)].map((m) => m[1].toLowerCase()))];
  t.check("migration 058 creates the kernel's own tables, and not one of them is a legacy table",
    created.length >= 15 && created.every((table) => !isLegacyTable(table)), `${created.length} tables: ${created.slice(0, 5).join(", ")} …`);
  t.check("every table the synthetic SQL fixture writes to is one migration 058 creates — the fixture points at the new schema and nothing else",
    fixtureTargets.length > 0 && fixtureTargets.every((table) => created.includes(table)), fixtureTargets.join(", "));
}

/* ═══════════════════════════════════════════════════ (9) the doors again */
t.section("(9) every door stayed closed, including during the live run");

t.check("nothing in this file — the tree walk, the scans, or the whole simulated run — tried the network",
  tripped() === 0, `${tripped()} attempts`);

t.finish();
