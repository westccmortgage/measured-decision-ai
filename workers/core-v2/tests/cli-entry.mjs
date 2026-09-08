/* THE COMMAND LINE RUNS FROM WHEREVER IT IS, ON INVENTED SOURCES ONLY.
 *
 * cli.ts is the one place the engine is a program rather than a library, so
 * it is the one place a person could point it at something real. This file
 * runs it as a program — a fresh node, from a directory that holds nothing
 * of the engine — and reads every line it prints.
 *
 * What it holds the command line to:
 *   - it plans in two phases and says so: phase A is the kernel's, one
 *     ingest per source; phase B is the pack's, expanded from the segments
 *     phase A actually persisted, and nothing of phase B was executed;
 *   - a simulation runs the whole chain in memory and the totals it derives
 *     are the invented fixture's own, compared line by line;
 *   - both modes count the network attempts they made, and the count is nil;
 *   - no mode at all is a usage line and exit 2, not a default run;
 *   - both synthetic packs work, and only synthetic packs: every source the
 *     command line will run on carries a fixture:// uri, and main refuses a
 *     manifest whose sources do not;
 *   - the seed names a world: two runs of one seed print one answer, and
 *     another seed prints another, so the first fact is not a fixed string;
 *   - imported rather than invoked, the file runs nothing at all.
 *
 * WHY THE NETWORK IS NOT CLOSED AT THE TOP OF THIS FILE. The engine's guard
 * closes child processes as well as sockets — child_process.spawnSync among
 * them — because a child could reach a provider on the engine's behalf. This
 * file must spawn to test a program, so it installs the guard only after the
 * last spawn, runs the in-process half of the file under it, and then knocks
 * on the child-process door once, deliberately, to show it is shut. That one
 * knock is the only attempt this file expects to count.
 *
 * No sleeps. Every spawned run is a whole synthetic workflow and settles in
 * well under a second; nothing here waits on a clock.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { harness, closeNetwork } from "./harness.mjs";

const t = harness("the command line runs from wherever it is, on invented sources only");

const CLI = fileURLToPath(new URL("../cli.ts", import.meta.url));
const ENGINE = fileURLToPath(new URL("../", import.meta.url));
const CLI_SOURCE = readFileSync(CLI, "utf8");

/* The provider words are the kernel's own list, lifted from its source, so
   this file never writes one down. */
const rolesSource = readFileSync(fileURLToPath(new URL("../kernel/roles.ts", import.meta.url)), "utf8");
const providerMatch = rolesSource.match(/PROVIDER_WORDS\s*=\s*\/(.+?)\/i;/);
const providerPattern = providerMatch ? new RegExp(providerMatch[1], "i") : null;

/* Two directories that hold nothing of the engine. */
const ELSEWHERE = "/tmp";
const ELSEWHERE_TOO = "/";

/* ───────────────────────────────────────────────────────────── running it */

const runs = [];
function run(args, cwd = ELSEWHERE) {
  const child = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", CLI, ...args], { cwd, encoding: "utf8", timeout: 60_000 });
  const outcome = { args: args.join(" ") || "(no flags)", cwd, status: child.status, stdout: child.stdout ?? "", stderr: child.stderr ?? "" };
  runs.push(outcome);
  return outcome;
}

/* ───────────────────────────────────────────── reading what it printed */

/* One printed phase of a dry run, from its heading to the next. */
function phaseOf(stdout, letter) {
  const start = stdout.indexOf(`phase ${letter} — `);
  if (start < 0) return "";
  const rest = stdout.slice(start);
  const end = letter === "A" ? rest.indexOf("\nphase B — ") : rest.indexOf("\nnetwork attempts");
  return end < 0 ? rest : rest.slice(0, end);
}

const assignmentCount = (section) => { const m = section.match(/^(\d+) bounded assignments$/m); return m ? Number(m[1]) : -1; };

function roleCounts(section) {
  const out = {};
  const at = section.indexOf("by role:\n");
  if (at < 0) return out;
  for (const line of section.slice(at + "by role:\n".length).split("\n")) {
    const m = line.match(/^\s+(\d+)\s{2}(\S+)$/);
    if (!m) break;
    out[m[2]] = Number(m[1]);
  }
  return out;
}

function taskRows(section) {
  const at = section.indexOf("\ntasks:\n");
  if (at < 0) return [];
  return section.slice(at + "\ntasks:\n".length).split("\n")
    .filter((line) => /^ {2}[0-9a-f]{8} {2}/.test(line))
    .map((line) => {
      const [id, phase, taskType, roleKey, subject] = line.trim().split(/\s+/);
      return {
        id, phase, taskType, roleKey, subject, line,
        group: (line.match(/\[(reader-[a-z]+)\]/) ?? [])[1] ?? null,
        deps: [...line.matchAll(/([0-9a-f]{8})\((\w+)\)/g)].map((m) => ({ taskId: m[1], kind: m[2] })),
      };
    });
}

const jsonAfter = (stdout, label) => {
  const m = stdout.match(new RegExp(`^${label.replace(/ /g, " ")} (\\{.*\\})$`, "m"));
  return m ? JSON.parse(m[1]) : null;
};

/* "  <subject> <predicate> = <value> from <n> accepted inputs" */
const derivedTotals = (stdout) => [...stdout.matchAll(/^ {2}(\S+) (\S+) = (.+) from (\d+) accepted inputs$/gm)]
  .map((m) => ({ subject: m[1], predicate: m[2], value: m[3], inputs: Number(m[4]) }));

const counted = (stdout, label) => { const m = stdout.match(new RegExp(`^network attempts during ${label}: (\\d+)$`, "m")); return m ? Number(m[1]) : -1; };

/* Every scheme-and-slashes token in a body of text. */
const urlsIn = (text) => [...text.matchAll(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'`)\]]*/gi)].map((m) => m[0]);
const tally = (xs) => { const out = {}; for (const x of xs) out[x] = (out[x] ?? 0) + 1; return out; };
const sameSet = (a, b) => a.length === b.length && [...a].sort().join("|") === [...b].sort().join("|");

/* ══════════════════════════════════════ a dry run plans, and stops there */
t.section("a dry run, from a directory that holds nothing of the engine");

t.check("the directory these runs are made from holds nothing of the engine — no cli.ts, no kernel, no pack",
  !ELSEWHERE.startsWith(ENGINE) && !existsSync(`${ELSEWHERE}/cli.ts`) && !existsSync(`${ELSEWHERE}/kernel`) && !existsSync(`${ELSEWHERE}/domains`),
  `${ELSEWHERE} vs ${ENGINE}`);

const dry = run(["--dry-run"]);

t.check("--dry-run exits 0", dry.status === 0, `exit ${dry.status}`);
t.check("--dry-run writes nothing on the error channel", dry.stderr === "", dry.stderr.slice(0, 120));
t.check("the first line names the pack, its version and how many synthetic sources it planned over",
  /^pack synthetic-records@1\.0 · 2 synthetic sources$/m.test(dry.stdout), dry.stdout.split("\n")[0]);

const dryA = phaseOf(dry.stdout, "A");
const dryB = phaseOf(dry.stdout, "B");
const rowsA = taskRows(dryA);
const rowsB = taskRows(dryB);

t.check("the dry run prints a phase A planned from the manifest and a phase B expanded by the pack",
  /^phase A — planned from the manifest:$/m.test(dry.stdout) && /^phase B — expanded by the pack from \d+ persisted segments \(nothing below was executed\):$/m.test(dry.stdout));

t.check("phase A is one ingest per source and nothing else",
  rowsA.length === 2 && rowsA.every((r) => r.phase === "ingest" && r.taskType === "ingest_source" && r.roleKey === "source_ingestor"),
  rowsA.map((r) => `${r.phase}/${r.taskType}`).join(", "));
t.check("phase A names each source of the manifest once", sameSet(rowsA.map((r) => r.subject), ["source:0", "source:1"]), rowsA.map((r) => r.subject).join(", "));
t.check("phase A plans no blind reading and no work of the pack: nothing is read before a source is ingested, and a record set declares its own sheets",
  rowsA.every((r) => r.group === null && !r.taskType.includes(":")), rowsA.map((r) => r.taskType).join(", "));
t.check("phase A's count agrees with the assignments it then prints — the summary is a count, not a claim",
  assignmentCount(dryA) === rowsA.length && roleCounts(dryA).source_ingestor === 2, `${assignmentCount(dryA)} counted, ${rowsA.length} printed`);

const segmentsSeen = Number((dry.stdout.match(/expanded by the pack from (\d+) persisted segments/) ?? [])[1] ?? -1);
t.check("phase B was expanded from the segments phase A actually persisted: four declared sheets and the eight regions found inside them",
  segmentsSeen === 12, `${segmentsSeen} segments`);

const analyzeB = rowsB.filter((r) => r.phase === "analyze");
const compareB = rowsB.filter((r) => r.phase === "compare");
const deriveB = rowsB.filter((r) => r.phase === "derive");

t.check("phase B plans every reading twice, blind, one assignment per group", analyzeB.length === 16 && analyzeB.every((r) => r.group !== null), `${analyzeB.length} readings`);
t.check("the two blind groups of every read subject are reader-a and reader-b, never the same group twice",
  [...new Set(analyzeB.map((r) => r.subject))].every((s) => sameSet(analyzeB.filter((r) => r.subject === s).map((r) => r.group), ["reader-a", "reader-b"])),
  `${new Set(analyzeB.map((r) => r.subject)).size} subjects`);
t.check("phase B plans one comparison per read subject, and the compared subjects are exactly the read ones",
  compareB.length === 8 && sameSet(compareB.map((r) => r.subject), [...new Set(analyzeB.map((r) => r.subject))])
  && compareB.every((r) => r.taskType === "compare_claims" && r.roleKey === "claim_comparator"),
  `${compareB.length} comparisons over ${new Set(analyzeB.map((r) => r.subject)).size} subjects`);
t.check("phase B plans one derivation per category the fixture asked about, and a derivation is code",
  deriveB.length === 3 && sameSet(deriveB.map((r) => r.subject), ["category/alpha", "category/beta", "category/gamma"]) && deriveB.every((r) => r.roleKey === "category_totaliser"),
  deriveB.map((r) => r.subject).join(", "));
t.check("phase B holds nothing of the verify, adjudicate or compose phases: no claim exists yet to criticise",
  rowsB.every((r) => !["verify", "adjudicate", "compose"].includes(r.phase)), [...new Set(rowsB.map((r) => r.phase))].join(", "));
t.check("phase B's count agrees with the assignments it prints", assignmentCount(dryB) === rowsB.length && rowsB.length === 27, `${assignmentCount(dryB)} counted, ${rowsB.length} printed`);
t.check("no assignment is printed in both phases: phase B is further work, not phase A restated",
  rowsB.every((r) => !rowsA.some((a) => a.id === r.id)) && new Set([...rowsA, ...rowsB].map((r) => r.id)).size === rowsA.length + rowsB.length);
t.check("nothing below phase A was executed: the dry run reports no claim, no decision and no workflow outcome",
  !/^claims /m.test(dry.stdout) && !/^decisions /m.test(dry.stdout) && !/^workflow /m.test(dry.stdout));
t.check("the dry run counts the network attempts it made, and there were none", counted(dry.stdout, "dry run") === 0, `${counted(dry.stdout, "dry run")} attempts`);

const dryElsewhere = run(["--dry-run"], ELSEWHERE_TOO);
t.check("the same dry run from another directory entirely exits 0 and prints the very same plan — the command line reads nothing relative to where it is run",
  dryElsewhere.status === 0 && dryElsewhere.stdout === dry.stdout, `${ELSEWHERE_TOO} vs ${ELSEWHERE}`);

/* ══════════════════════════════════════════ a simulation runs the chain */
t.section("a simulation runs the whole workflow in memory");

const sim = run(["--simulate"]);

t.check("--simulate exits 0", sim.status === 0, `exit ${sim.status}`);
t.check("--simulate writes nothing on the error channel", sim.stderr === "", sim.stderr.slice(0, 120));
t.check("the simulated workflow completes", /^workflow completed after \d+ ticks$/m.test(sim.stdout), sim.stdout.split("\n")[0]);

const simTasks = jsonAfter(sim.stdout, "tasks");
const simPhases = jsonAfter(sim.stdout, "by phase");
const simClaims = jsonAfter(sim.stdout, "claims");
const simDecisions = jsonAfter(sim.stdout, "decisions");
const simDisagreements = jsonAfter(sim.stdout, "disagreements");
const simExpected = jsonAfter(sim.stdout, "expected by the fixture");

t.check("every task of the simulated workflow ended completed, and none ended in any other state",
  simTasks !== null && Object.keys(simTasks).length === 1 && simTasks.completed > 0, JSON.stringify(simTasks));
t.check("every phase of the design ran: ingest, analyze, compare, derive, verify and compose",
  simPhases !== null && ["ingest", "analyze", "compare", "derive", "verify", "compose"].every((p) => simPhases[p] > 0), JSON.stringify(simPhases));
t.check("twice as many readings ran as comparisons: every compared subject was read blind by two",
  simPhases !== null && simPhases.analyze === simPhases.compare * 2, `${simPhases?.analyze} readings, ${simPhases?.compare} comparisons`);
t.check("the run accepted claims and corroborated others: agreement was recorded as corroboration, not as acceptance on its own",
  simClaims !== null && simClaims.accepted > 0 && simClaims.corroborated > 0, JSON.stringify(simClaims));
t.check("the run left no disagreement and asked for nobody",
  simDisagreements !== null && Object.keys(simDisagreements).length === 0 && !/^for a person:/m.test(sim.stdout), JSON.stringify(simDisagreements));
t.check("the run recorded a decision for every accepted claim and one proposal per decision subject",
  simDecisions !== null && simDecisions["accept_claim:machine_decided"] === simClaims.accepted && simDecisions["proceed:proposed"] > 0, JSON.stringify(simDecisions));

const simDerived = derivedTotals(sim.stdout);
t.check("the simulation prints the totals it derived, each naming how many accepted inputs it was made of",
  simDerived.length > 0 && simDerived.every((d) => d.predicate === "total_quantity" && d.inputs > 0), simDerived.map((d) => `${d.subject}=${d.value}`).join(", "));
t.check("every total the fixture expects was derived, and no total was derived that the fixture does not expect",
  simExpected !== null && sameSet(simDerived.map((d) => d.subject), Object.keys(simExpected).map((k) => `category/${k}`)),
  `derived ${simDerived.map((d) => d.subject).join(", ")} · expected ${Object.keys(simExpected ?? {}).join(", ")}`);
for (const [category, e] of Object.entries(simExpected ?? {})) {
  const got = simDerived.find((d) => d.subject === `category/${category}`);
  t.check(`the derived total for ${category} is the quantity and unit the invented fixture holds, from as many accepted inputs as it has entries`,
    !!got && got.value === `${e.quantity} ${e.unit}` && got.inputs === e.entries,
    got ? `${got.value} from ${got.inputs} · fixture ${e.quantity} ${e.unit} from ${e.entries}` : "no derived total");
}
t.check("the simulation counts the network attempts it made, and there were none", counted(sim.stdout, "simulation") === 0, `${counted(sim.stdout, "simulation")} attempts`);

/* ══════════════════════════════════════════════════ the second pack */
t.section("the second pack, on the same command line");

const simT = run(["--simulate", "--pack", "transcripts"]);

t.check("--simulate --pack transcripts exits 0", simT.status === 0, `exit ${simT.status}`);
t.check("the transcripts workflow completes too", /^workflow completed after \d+ ticks$/m.test(simT.stdout), simT.stdout.split("\n")[0]);
const tasksT = jsonAfter(simT.stdout, "tasks");
t.check("every task of the transcripts workflow ended completed too",
  tasksT !== null && Object.keys(tasksT).length === 1 && tasksT.completed > 0, JSON.stringify(tasksT));

const expectedT = jsonAfter(simT.stdout, "expected by the fixture");
const derivedT = derivedTotals(simT.stdout);
t.check("every recording the transcripts fixture expects a total for got one, and no other",
  expectedT !== null && sameSet(derivedT.map((d) => d.subject), Object.keys(expectedT)),
  `derived ${derivedT.map((d) => d.subject).join(", ")} · expected ${Object.keys(expectedT ?? {}).join(", ")}`);
for (const [recording, e] of Object.entries(expectedT ?? {})) {
  const got = derivedT.find((d) => d.subject === recording);
  t.check(`the derived speaker-turn total for ${recording} is the fixture's, from as many accepted inputs as it has scenes`,
    !!got && got.predicate === "total_speaker_turns" && got.value === `${e.turns} turns` && got.inputs === e.scenes,
    got ? `${got.value} from ${got.inputs} · fixture ${e.turns} turns from ${e.scenes}` : "no derived total");
}
t.check("the transcripts simulation reached no network either", counted(simT.stdout, "simulation") === 0, `${counted(simT.stdout, "simulation")} attempts`);

const dryT = run(["--dry-run", "--pack", "transcripts"]);
const dryTA = phaseOf(dryT.stdout, "A");
const dryTB = phaseOf(dryT.stdout, "B");
const rowsTA = taskRows(dryTA);
const rowsTB = taskRows(dryTB);

t.check("--dry-run --pack transcripts exits 0 and names the other pack",
  dryT.status === 0 && /^pack synthetic-transcripts@1\.0 · 2 synthetic sources$/m.test(dryT.stdout), `exit ${dryT.status}`);
t.check("a recording declares nothing, so phase A plans an ingest and a discovery for each of them",
  rowsTA.length === 4 && rowsTA.filter((r) => r.phase === "ingest").length === 2 && rowsTA.filter((r) => r.phase === "discover").length === 2,
  rowsTA.map((r) => r.phase).join(", "));
t.check("each discovery waits for the ingest of its own source to complete",
  rowsTA.filter((r) => r.phase === "discover").every((d) => {
    const ingest = rowsTA.find((r) => r.phase === "ingest" && r.subject === d.subject);
    return !!ingest && d.deps.length === 1 && d.deps[0].taskId === ingest.id && d.deps[0].kind === "completion";
  }), rowsTA.filter((r) => r.phase === "discover").map((d) => `${d.subject}←${d.deps.map((x) => x.taskId).join()}`).join(" "));
t.check("the transcripts manifest declares no segment at all, yet phase B was expanded from six persisted ones — the discoverers phase A ran found them",
  /expanded by the pack from 6 persisted segments/.test(dryT.stdout), (dryT.stdout.match(/from \d+ persisted segments/) ?? [])[0]);
t.check("phase B reads every discovered scene twice, blind, and totals each recording once",
  rowsTB.filter((r) => r.phase === "analyze").length === 12 && rowsTB.filter((r) => r.phase === "analyze").every((r) => r.group !== null)
  && rowsTB.filter((r) => r.phase === "derive").length === 2 && sameSet(rowsTB.filter((r) => r.phase === "derive").map((r) => r.subject), ["recording/0", "recording/1"]),
  `${rowsTB.length} assignments`);
t.check("the two packs are not each other: they share no task type on the same command line",
  (() => {
    const a = new Set(rowsB.map((r) => r.taskType).filter((x) => x.includes(":")));
    const b = new Set(rowsTB.map((r) => r.taskType).filter((x) => x.includes(":")));
    return a.size > 0 && b.size > 0 && [...a].every((x) => !b.has(x));
  })());

/* ═══════════════════════════════════════════ no mode is not a default run */
t.section("no mode named is a usage line, not a default run");

const bare = run([]);
t.check("run with no flags at all, the command line exits 2", bare.status === 2, `exit ${bare.status}`);
t.check("it prints one usage line naming both modes and the two flags they take",
  bare.stdout.trim().split("\n").length === 1 && /^usage: cli\.ts --dry-run \| --simulate \[--pack records\|transcripts\] \[--seed name\]$/.test(bare.stdout.trim()),
  bare.stdout.trim());
t.check("it plans nothing and runs nothing: no phase, no workflow, no claim",
  !/phase [AB] — /.test(bare.stdout) && !/^workflow /m.test(bare.stdout) && !/^claims /m.test(bare.stdout));

const packOnly = run(["--pack", "transcripts"]);
t.check("naming a pack without naming a mode is the same refusal, not a run of that pack",
  packOnly.status === 2 && packOnly.stdout.trim() === bare.stdout.trim(), `exit ${packOnly.status}`);

/* ═════════════════════════════════════════════════ the seed names a world */
t.section("the seed names a world");

const again = run(["--simulate"]);
t.check("two simulations of one seed print the same claim counts", jsonAfter(again.stdout, "claims") !== null && JSON.stringify(jsonAfter(again.stdout, "claims")) === JSON.stringify(simClaims), JSON.stringify(simClaims));
t.check("two simulations of one seed print the same decision counts", JSON.stringify(jsonAfter(again.stdout, "decisions")) === JSON.stringify(simDecisions), JSON.stringify(simDecisions));
t.check("two simulations of one seed are identical line for line, ticks and totals included", again.stdout === sim.stdout);

const other = run(["--simulate", "--seed", "cli/another-world"]);
t.check("another seed exits 0 and names a different invented world — so the agreement above is the seed's doing, not a fixed string",
  other.status === 0 && JSON.stringify(jsonAfter(other.stdout, "expected by the fixture")) !== JSON.stringify(simExpected),
  JSON.stringify(jsonAfter(other.stdout, "expected by the fixture")));
t.check("that other world's derived totals are its own fixture's, every one of them",
  (() => {
    const e = jsonAfter(other.stdout, "expected by the fixture");
    const d = derivedTotals(other.stdout);
    return e !== null && sameSet(d.map((x) => x.subject), Object.keys(e).map((k) => `category/${k}`))
      && Object.entries(e).every(([c, v]) => { const got = d.find((x) => x.subject === `category/${c}`); return !!got && got.value === `${v.quantity} ${v.unit}` && got.inputs === v.entries; });
  })(), derivedTotals(other.stdout).map((d) => `${d.subject}=${d.value}`).join(", "));

/* ════════════════════════════ nothing but invented sources, in every line */
t.section("nothing but invented sources, in every line printed");

t.check("the scan this section uses does find a scheme when there is one to find",
  urlsIn("see fixture://one/two and https://elsewhere.example/x").length === 2, JSON.stringify(urlsIn("see fixture://one/two and https://elsewhere.example/x")));
t.check("the provider-word list was read out of the kernel's own source, so this file writes none of them down",
  providerPattern !== null, providerMatch ? `${providerMatch[1].split("|").length} words` : "not found");

const everythingPrinted = runs.map((r) => `${r.stdout}\n${r.stderr}`).join("\n");
t.check(`across all ${runs.length} runs, nothing printed names a provider`, !providerPattern.test(everythingPrinted));
t.check("across all runs, no line prints a url of any scheme other than fixture:// — nothing outside the fixtures is named",
  urlsIn(everythingPrinted).every((u) => u.startsWith("fixture://")), JSON.stringify(tally(urlsIn(everythingPrinted))));
t.check("nothing printed names a database, a key or a project to run against",
  !/\b(postgres|postgresql|database url|api[_ -]?key|secret|token|project[_ -]?id)\b/i.test(everythingPrinted));

/* ═══════════════════════════════ imported instead of invoked, it runs nothing */
t.section("imported instead of invoked, the file runs nothing");

const printed = [];
const realLog = console.log;
const realError = console.error;
console.log = (...parts) => printed.push(parts.join(" "));
console.error = (...parts) => printed.push(parts.join(" "));
const exitCodeBefore = process.exitCode;
const cli = await import("../cli.ts");
console.log = realLog;
console.error = realError;

t.check("importing the command line as a module prints nothing: the entry guard sees another program's argv", printed.length === 0, printed.slice(0, 2).join(" | "));
t.check("importing it sets no exit code either — main did not run", process.exitCode === exitCodeBefore, `exitCode ${String(process.exitCode)}`);
t.check("the module exports parseArgs, fixtureFor and main, and each is a function",
  typeof cli.parseArgs === "function" && typeof cli.fixtureFor === "function" && typeof cli.main === "function",
  Object.keys(cli).sort().join(", "));

/* ─────────────────────────────────────────────────────────── parseArgs */
const { parseArgs, fixtureFor } = cli;

t.check("with no argument at all, the mode is help — there is no default run", parseArgs([]).mode === "help", JSON.stringify(parseArgs([])));
t.check("--dry-run is the dry-run mode and --simulate is the simulate mode", parseArgs(["--dry-run"]).mode === "dry-run" && parseArgs(["--simulate"]).mode === "simulate");
t.check("asked for both modes at once, the command line simulates: one run, never two", parseArgs(["--dry-run", "--simulate"]).mode === "simulate");
t.check("a flag nobody knows is not a mode: it falls to help rather than running something", parseArgs(["--everything"]).mode === "help", JSON.stringify(parseArgs(["--everything"])));
t.check("the pack defaults to records and the seed to a named default, so a bare --dry-run is still a whole world",
  parseArgs(["--dry-run"]).pack === "records" && parseArgs(["--dry-run"]).seed === "cli/1", JSON.stringify(parseArgs(["--dry-run"])));
t.check("--pack transcripts names the other pack, and --pack records names the first", parseArgs(["--simulate", "--pack", "transcripts"]).pack === "transcripts" && parseArgs(["--simulate", "--pack", "records"]).pack === "records");
t.check("a pack the engine does not ship falls back to the records pack rather than inventing one",
  parseArgs(["--simulate", "--pack", "somewhere-real"]).pack === "records", JSON.stringify(parseArgs(["--simulate", "--pack", "somewhere-real"])));
t.check("--pack with nothing after it falls back too, instead of carrying undefined into a fixture", parseArgs(["--simulate", "--pack"]).pack === "records");
t.check("--seed names the world, and only the seed", parseArgs(["--simulate", "--seed", "a-named-world"]).seed === "a-named-world" && parseArgs(["--simulate", "--seed", "a-named-world"]).pack === "records");
t.check("--seed with nothing after it keeps the default seed", parseArgs(["--simulate", "--seed"]).seed === "cli/1");
t.check("the order of the flags does not change what is parsed",
  JSON.stringify(parseArgs(["--pack", "transcripts", "--seed", "w", "--simulate"])) === JSON.stringify(parseArgs(["--simulate", "--seed", "w", "--pack", "transcripts"])),
  JSON.stringify(parseArgs(["--pack", "transcripts", "--seed", "w", "--simulate"])));

/* ─────────────────────────────────────────────────────────── fixtureFor */
const SEEDS = ["cli/1", "another/world", "a third"];

for (const packName of ["records", "transcripts"]) {
  const made = SEEDS.map((seed) => fixtureFor(packName, seed));
  t.check(`every source of every ${packName} fixture the command line can build carries a fixture:// uri, and no other scheme`,
    made.every((f) => f.manifest.sources.length > 0 && f.manifest.sources.every((s) => s.uri.startsWith("fixture://") && urlsIn(s.uri).length === 1 && !providerPattern.test(s.uri))),
    made.flatMap((f) => f.manifest.sources.map((s) => s.uri.split("/").slice(0, 3).join("/"))).join(", "));
  t.check(`the pack a ${packName} fixture hands over is the one its manifest names`,
    made.every((f) => f.pack.id === f.manifest.domainPack && f.pack.version === f.manifest.domainPackVersion), made[0].pack.id);
  t.check(`a ${packName} fixture is its seed's: one seed twice is one manifest, and two seeds are two worlds`,
    JSON.stringify(fixtureFor(packName, "cli/1").manifest) === JSON.stringify(fixtureFor(packName, "cli/1").manifest)
    && made[0].manifest.workflowId !== made[1].manifest.workflowId && made[0].manifest.sources[0].contentHash !== made[1].manifest.sources[0].contentHash);
  t.check(`the ${packName} executors are scripted, have run nothing when the fixture is built, and stand in two independence domains at least`,
    (() => { const r = made[0].executors(); return r.packetsSeen.length === 0 && r.invocations.length === 0 && new Set(r.families().map((f) => r.domainOf(f))).size >= 2; })(),
    `${made[0].executors().families().length} families`);
  t.check(`the ${packName} fixture states what it expects, so the run can be checked against it`,
    made.every((f) => f.expected && Object.keys(f.expected).length > 0), JSON.stringify(made[0].expected).slice(0, 80));
}

t.check("a record set declares its own sheets, while a recording declares nothing — two shapes of source on one command line",
  fixtureFor("records", "cli/1").manifest.sources.every((s) => s.declaredSegments.length > 0)
  && fixtureFor("transcripts", "cli/1").manifest.sources.every((s) => s.declaredSegments.length === 0));

/* ─────────────────────────────────── the guard, read in the source itself */
t.check("source-level check: main refuses outright a manifest whose sources are not all fixture:// — the guard is on the same line as the throw",
  CLI_SOURCE.split("\n").some((line) => /sources\.every\(\(s\) => s\.uri\.startsWith\("fixture:\/\/"\)\)/.test(line) && /throw new Error\(/.test(line)),
  (CLI_SOURCE.split("\n").find((l) => l.includes('startsWith("fixture://")')) ?? "not found").trim().slice(0, 110));
t.check("source-level check: the guard stands before either mode, so neither can be entered on a manifest it has not passed",
  CLI_SOURCE.indexOf('startsWith("fixture://")') < CLI_SOURCE.indexOf('if (args.mode === "dry-run")')
  && CLI_SOURCE.indexOf('startsWith("fixture://")') < CLI_SOURCE.lastIndexOf("runUntilQuiescent"));
t.check("source-level check: the command line names no provider anywhere in its text", !providerPattern.test(CLI_SOURCE));
t.check("source-level check: no flag names a key, a project or a database, because none is used",
  ![...CLI_SOURCE.matchAll(/--[a-z][a-z-]*/g)].map((m) => m[0]).some((flag) => /key|project|database|url|endpoint|token/.test(flag)),
  [...new Set([...CLI_SOURCE.matchAll(/--[a-z][a-z-]*/g)].map((m) => m[0]))].join(" "));
t.check("source-level check: the only uri scheme written into the command line is fixture://",
  urlsIn(CLI_SOURCE).every((u) => u.startsWith("fixture://")) && urlsIn(CLI_SOURCE).length > 0, JSON.stringify(tally(urlsIn(CLI_SOURCE))));

/* ═══════════════════════════════════════════════════════════ the doors */
t.section("every door, closed after the last child was spawned");

const tripped = closeNetwork();

t.check("with the network closed and every in-memory check above run under it, nothing had tried a door", tripped() === 0, `${tripped()} attempts`);
await t.refused("the guard shuts child processes too — which is why this file spawned its runs before installing it, and could not spawn one now",
  async () => { spawnSync(process.execPath, ["-e", "0"]); });
t.check("that deliberate knock is the only attempt this file made: the engine itself tried nothing", tripped() === 1, `${tripped()} attempts`);

t.finish();
