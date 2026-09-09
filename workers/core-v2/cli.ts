/* THE ENGINE FROM THE COMMAND LINE — ON INVENTED SOURCES ONLY.
 *
 *   node --experimental-strip-types --no-warnings cli.ts --dry-run
 *   node --experimental-strip-types --no-warnings cli.ts --simulate [--pack records|transcripts] [--seed name]
 *
 * --dry-run  plans a synthetic workflow and prints the bounded assignments
 *            it would make, without running anything.
 * --simulate runs the whole workflow in memory against scripted executors
 *            and prints what the record holds at the end.
 *
 * Both close the network before doing anything and refuse to run on a
 * manifest that is not one of the synthetic fixtures. There is no flag that
 * names a provider, a key, a project or a database, because none is used.
 */
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { closeTheNetwork } from "./kernel/network-guard.ts";
import { lookupOf, planDiscovery, specsToTasks, describeTasks } from "./kernel/planning.ts";
import { DEFAULT_POLICY } from "./kernel/policy.ts";
import { RoleRegistry } from "./kernel/roles.ts";
import { assemble } from "./domains/simulate.ts";
import { syntheticRecordSet } from "./domains/synthetic-records/fixture.ts";
import { SyntheticRecordsPack } from "./domains/synthetic-records/pack.ts";
import { mockExecutors as recordExecutors } from "./domains/synthetic-records/mocks.ts";
import { syntheticTranscriptSet } from "./domains/synthetic-transcripts/fixture.ts";
import { SyntheticTranscriptsPack } from "./domains/synthetic-transcripts/pack.ts";
import { mockExecutors as transcriptExecutors } from "./domains/synthetic-transcripts/mocks.ts";

export function parseArgs(argv: string[]): { mode: "dry-run" | "simulate" | "help"; pack: "records" | "transcripts"; seed: string } {
  const mode = argv.includes("--simulate") ? "simulate" : argv.includes("--dry-run") ? "dry-run" : "help";
  const at = (flag: string) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : undefined; };
  const pack = at("--pack") === "transcripts" ? "transcripts" : "records";
  return { mode, pack, seed: at("--seed") ?? "cli/1" };
}

export function fixtureFor(pack: "records" | "transcripts", seed: string) {
  if (pack === "transcripts") {
    const truth = syntheticTranscriptSet({ seed, recordings: 2, scenesPerRecording: 3 });
    return { manifest: truth.manifest, pack: new SyntheticTranscriptsPack(), executors: () => transcriptExecutors(truth).registry, expected: truth.totals };
  }
  const truth = syntheticRecordSet({ seed, sources: 2, sheetsPerSource: 2, entriesPerTable: 3 });
  return { manifest: truth.manifest, pack: new SyntheticRecordsPack(), executors: () => recordExecutors(truth).registry, expected: truth.totals };
}

export async function main(argv: string[]): Promise<number> {
  const guard = closeTheNetwork();
  const args = parseArgs(argv);
  if (args.mode === "help") {
    console.log("usage: cli.ts --dry-run | --simulate [--pack records|transcripts] [--seed name]");
    return 2;
  }
  const fixture = fixtureFor(args.pack, args.seed);
  if (!fixture.manifest.sources.every((s) => s.uri.startsWith("fixture://"))) throw new Error("core-v2: the command line runs on synthetic fixtures only");

  if (args.mode === "dry-run") {
    /* Phase A from the manifest; then, with only the ingestion and discovery
       tasks executed against the scripted discoverers, phase B from what
       they persisted. No analyst runs in a dry run. */
    const registry = new RoleRegistry(fixture.pack);
    const problems = registry.assertConsistent();
    if (problems.length) { console.log(`the registry refuses: ${problems.join("; ")}`); return 1; }
    const lookup = lookupOf(fixture.manifest, []);
    const specs = planDiscovery(fixture.manifest, fixture.pack);
    const { tasks, refusals } = specsToTasks(specs, fixture.manifest.workflowId, lookup, registry, DEFAULT_POLICY);
    console.log(`pack ${fixture.pack.id}@${fixture.pack.version} · ${fixture.manifest.sources.length} synthetic sources`);
    console.log("");
    console.log("phase A — planned from the manifest:");
    console.log(describeTasks(tasks, lookup));
    if (refusals.length) { console.log(`refused: ${refusals.join("; ")}`); return 1; }
    const { scheduler, repo } = assemble({ manifest: fixture.manifest, pack: fixture.pack, executors: fixture.executors(), policy: { maximumConcurrentTasksPerRole: 64 } });
    await scheduler.plan();
    for (let i = 0; i < 8; i++) {
      const open = (await repo.listTasks(fixture.manifest.workflowId)).filter((t) => (t.phase === "ingest" || t.phase === "discover") && !["completed", "failed_known", "outcome_unknown", "cancelled", "superseded"].includes(t.state));
      if (open.length === 0) break;
      await scheduler.tick();
    }
    const all = await repo.listTasks(fixture.manifest.workflowId);
    const segments = await repo.listSegments(fixture.manifest.workflowId);
    const later = all.filter((t) => t.phase !== "ingest" && t.phase !== "discover");
    console.log("");
    console.log(`phase B — expanded by the pack from ${segments.length} persisted segments (nothing below was executed):`);
    console.log(describeTasks(later.map((t) => ({ ...t, dependsOn: [] })), lookupOf(fixture.manifest, segments)));
    console.log("");
    console.log(`network attempts during dry run: ${guard.tripped()}`);
    return 0;
  }

  const { scheduler, repo } = assemble({ manifest: fixture.manifest, pack: fixture.pack, executors: fixture.executors() });
  await scheduler.plan();
  const report = await scheduler.runUntilQuiescent();
  console.log(`workflow ${report.workflow.state} after ${report.ticks} ticks`);
  console.log(`tasks ${JSON.stringify(report.tasks)}`);
  console.log(`by phase ${JSON.stringify(report.byPhase)}`);
  console.log(`disagreements ${JSON.stringify(report.disagreements)}`);
  console.log(`decisions ${JSON.stringify(report.decisions)}`);
  const claims = await repo.listClaims({ workflowId: fixture.manifest.workflowId });
  const byStatus: Record<string, number> = {};
  for (const c of claims) byStatus[c.status] = (byStatus[c.status] ?? 0) + 1;
  console.log(`claims ${JSON.stringify(byStatus)}`);
  for (const c of claims.filter((c) => c.observationBasis === "derived" && c.status === "accepted" && c.inputClaimIds.length)) {
    console.log(`  ${c.subjectKey} ${c.predicate} = ${c.value.text ?? c.value.quantity} from ${c.inputClaimIds.length} accepted inputs`);
  }
  console.log(`expected by the fixture ${JSON.stringify(fixture.expected)}`);
  if (report.escalations.length) console.log(`for a person: ${report.escalations.join(" | ")}`);
  console.log(`network attempts during simulation: ${guard.tripped()}`);
  return 0;
}

/* Entry guard: runs only when this file is the program, from wherever it is. */
const entry = process.argv[1] ? realpathSync(process.argv[1]) : "";
if (entry && entry === realpathSync(fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (error) => { console.error(String((error as Error).message ?? error)); process.exitCode = 1; });
}
