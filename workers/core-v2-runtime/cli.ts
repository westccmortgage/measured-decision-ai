/* THE RUNTIME FROM THE COMMAND LINE — OFFLINE, AND SAYING SO EVERY TIME.
 *
 *   node --experimental-strip-types --no-warnings cli.ts --dry-run
 *   node --experimental-strip-types --no-warnings cli.ts --simulate
 *   node --experimental-strip-types --no-warnings cli.ts --simulate-postgres \
 *        --socket /var/tmp/pg/.s.PGSQL.5433 --database core_v2 --user mdai
 *   node --experimental-strip-types --no-warnings cli.ts --run          (refuses)
 *
 * --dry-run           plans one synthetic workflow and prints the bounded
 *                     assignments it would make and which executor domain
 *                     each would go to. Nothing is executed and no request
 *                     is built.
 * --simulate          runs the whole workflow in memory through the three
 *                     real provider adapters, answered inside this process.
 * --simulate-postgres runs it through the real dispatcher and the real
 *                     record, on a local cluster reached over a unix socket,
 *                     with the durable budget on the path.
 * --run               is the shape a paid run would take. It refuses, prints
 *                     every reason it refuses, and builds nothing.
 *
 * Every mode prints the same six facts before it starts — whether the
 * network is open, whether a paid call is authorised, which invented pack it
 * is about to read, which roles it plans, which executor domain each
 * provider is, and what it is allowed to spend — and the same five after:
 * how it ended, how many claims, disagreements and decisions there are, and
 * what it cost outside this process. That last number is $0.00 in every mode
 * this file can run, because no mode this file can run opens a socket to
 * anybody: the only transport it ever builds answers from a fixture, and the
 * sealed one is what a mode without a fixture would get.
 *
 * There is no flag that names a real customer, a project, a document, a key
 * or a production database, because none is used.
 */
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { SourceManifest, WorkPacket } from "../core-v2/kernel/contracts.ts";
import { InMemoryOrchestrationRepository } from "../core-v2/kernel/memory-repository.ts";
import { lookupOf, planDiscovery, specsToTasks, describeTasks } from "../core-v2/kernel/planning.ts";
import { DEFAULT_POLICY, budgetOf } from "../core-v2/kernel/policy.ts";
import { RoleRegistry } from "../core-v2/kernel/roles.ts";
import { Scheduler } from "../core-v2/kernel/scheduler.ts";
import { AgentRouter } from "../core-v2/kernel/router.ts";
import { INDEPENDENCE_GROUPS } from "../core-v2/kernel/domain.ts";
import { syntheticRecordSet } from "../core-v2/domains/synthetic-records/fixture.ts";
import { SyntheticRecordsPack } from "../core-v2/domains/synthetic-records/pack.ts";
import { PostgresOrchestrationRepository } from "../core-v2/postgres/repository.ts";
import { WireClient } from "../core-v2/postgres/wire.ts";

import { answerFromRequest } from "./local-agent/reading-agent.ts";
import { InMemoryMaterialResolver } from "./material/memory-resolver.ts";
import type { StoredMaterial } from "./material/memory-resolver.ts";
import { BudgetLedger, ceilingFor } from "./budget/ledger.ts";
import { meteredRepository } from "./budget/metered.ts";
import { Dispatcher, enqueueWorkflow } from "./dispatcher.ts";
import { compilePrompt } from "./prompt-compiler.ts";
import { DEMONSTRATION_CONFIG, DEMONSTRATION_ENVIRONMENT, DEMONSTRATION_ROUTING, NOT_A_CREDENTIAL } from "./providers/demonstration.ts";
import type { LocalQuestion } from "./providers/local-answers.ts";
import { LocalProviderTransport } from "./providers/local-answers.ts";
import { buildProviderRegistry } from "./providers/registry.ts";
import { NO_PAID_CALLS, paidCallRefusals } from "./runtime-config.ts";
import type { RuntimeConfig } from "./runtime-config.ts";
import { SealedTransport } from "./transport/transport.ts";

const AUTHORIZED_MAXIMUM = 10;
const PER_ATTEMPT_MAXIMUM = 1;

/* ─────────────────────────────────────────────────────────── the arguments */

export type Mode = "dry-run" | "simulate" | "simulate-postgres" | "run" | "help";
export type Trouble = "none" | "differ" | "agree";

export type Arguments = {
  mode: Mode;
  seed: string;
  trouble: Trouble;
  socket?: string;
  database?: string;
  user?: string;
};

export function parseArgs(argv: string[]): Arguments {
  const at = (flag: string): string | undefined => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : undefined; };
  const mode: Mode = argv.includes("--dry-run") ? "dry-run"
    : argv.includes("--simulate-postgres") ? "simulate-postgres"
      : argv.includes("--simulate") ? "simulate"
        : argv.includes("--run") ? "run" : "help";
  const asked = at("--trouble");
  const trouble: Trouble = asked === "none" ? "none" : asked === "agree" ? "agree" : "differ";
  return { mode, seed: at("--seed") ?? "cli/1", trouble, socket: at("--socket"), database: at("--database"), user: at("--user") };
}

/* ─────────────────────────────────────────────── the invented world */

const [, READER_B] = INDEPENDENCE_GROUPS;
const FALSE_QUANTITY = 999;

/* How an invented reader is told to MISREAD. The material it was handed is
   correct and verified; what is scripted is the mistake, which is what a
   model that gets it wrong actually does. "differ" is the ordinary case a
   comparison finds by itself; "agree" is the case this engine exists for,
   where both readings say the same wrong thing.

   The second lane is told apart by the model that is answering, because that
   is all a stand-in can see: two lanes are two providers, by construction. */
function troubleWith(trouble: Trouble, secondLaneModel: string) {
  return (question: LocalQuestion, base: Record<string, unknown>): Record<string, unknown> => {
    if (trouble === "none") return base;
    const claims = Array.isArray(base.claims) ? (base.claims as Record<string, unknown>[]) : [];
    for (const claim of claims) {
      if (claim.subjectKey !== "entry/E-001" || claim.predicate !== "quantity") continue;
      const value = claim.value as { quantity: number | null; text: string | null; known: boolean; attributes?: unknown };
      if (trouble === "agree") {
        claim.value = { ...value, quantity: FALSE_QUANTITY, text: `${FALSE_QUANTITY} ${claim.unit ?? ""}`.trim() };
      } else if (question.model === secondLaneModel) {
        const wrong = (value.quantity ?? 0) + 5;
        claim.value = { ...value, quantity: wrong, text: `${wrong} ${claim.unit ?? ""}`.trim() };
      }
    }
    return base;
  };
}

type World = {
  manifest: SourceManifest;
  pack: SyntheticRecordsPack;
  compile: (packet: WorkPacket) => { system: string; user: string };
  /* Where the bytes come from: the invented material, filed under the hash
     of itself. */
  resolver: InMemoryMaterialResolver;
  /* What answers. It is handed the request that was actually built and
     nothing else — no packet, no task id, no truth. */
  answer: (question: LocalQuestion) => unknown;
};

function inventAWorld(seed: string, trouble: Trouble): World {
  const truth = syntheticRecordSet({ seed, sources: 1, sheetsPerSource: 1, entriesPerTable: 3 });
  const pack = new SyntheticRecordsPack();
  const roles = new RoleRegistry(pack);
  const stored = new Map<string, StoredMaterial>();
  for (const [hash, item] of truth.material) stored.set(hash, { mediaKind: item.mediaKind, mimeType: item.mimeType, bytes: item.bytes });
  /* The second blind lane is the second configured provider. */
  const secondLane = DEMONSTRATION_CONFIG.providers[1];
  const misread = troubleWith(trouble, secondLane.defaultModel);
  return {
    manifest: truth.manifest,
    pack,
    compile: (packet: WorkPacket) => compilePrompt(packet, roles.role(packet.roleKey)),
    resolver: new InMemoryMaterialResolver(stored),
    answer: (question: LocalQuestion) => {
      try {
        return misread(question, answerFromRequest(question));
      } catch (error) {
        return new Error(`core-v2-runtime: the stand-in could not answer: ${(error as Error).message}`);
      }
    },
  };
}

/* ─────────────────────────────────────────────────────────── the printing */

const money = (amount: number, currency = "USD") => `${currency === "USD" ? "$" : `${currency} `}${amount.toFixed(2)}`;
const line = (label: string, value: string) => console.log(`  ${label.padEnd(18)}${value}`);

function header(mode: Mode, world: World, registry: ReturnType<typeof buildProviderRegistry>, plannedRoles: string): void {
  const wouldRefuse = paidCallRefusals({ ...DEMONSTRATION_CONFIG, authorization: NO_PAID_CALLS });
  console.log(`core-v2 runtime · ${mode}`);
  console.log("");
  line("network", "disabled — every request is answered inside this process; the transport that could reach anybody is never built");
  line("paid calls", `disabled — nothing is sent, no key is read, nothing can be charged. A paid run refuses for ${wouldRefuse.length} reasons:`);
  for (const reason of wouldRefuse) console.log(`  ${" ".repeat(18)}· ${reason}`);
  line("keys", `none read — the adapters are handed the invented string "${NOT_A_CREDENTIAL}" in place of an environment`);
  line("domain pack", `${world.pack.id}@${world.pack.version} · ${world.manifest.sources.length} invented source${world.manifest.sources.length === 1 ? "" : "s"}, every uri fixture://`);
  line("roles in play", plannedRoles);
  for (const [family, providerId] of Object.entries(DEMONSTRATION_ROUTING)) {
    line(family === Object.keys(DEMONSTRATION_ROUTING)[0] ? "executor domains" : "", `${family.padEnd(20)} → ${providerId.padEnd(10)} ${registry.domainOfFamily(family) ?? "unrouted"}`);
  }
  const first = DEMONSTRATION_CONFIG.providers[0];
  const ceiling = ceilingFor(DEMONSTRATION_CONFIG, first.providerId, first.defaultModel);
  line("budget", `${money(AUTHORIZED_MAXIMUM)} authorised for the workflow, at most ${money(PER_ATTEMPT_MAXIMUM)} for one attempt`);
  line("", `each attempt holds $${(ceiling?.maximumCost ?? 0).toFixed(5)} — the most it could cost at the operator's price, not what it is expected to cost`);
  console.log("");
}

type Ending = {
  outcome: string;
  claims: Record<string, number>;
  disagreements: Record<string, number>;
  decisions: number;
  forAPerson: string[];
  requests: number;
};

function footer(ending: Ending): void {
  const total = (counts: Record<string, number>) => Object.values(counts).reduce((sum, x) => sum + x, 0);
  const detail = (counts: Record<string, number>) => Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(", ") || "none";
  console.log("");
  line("outcome", ending.outcome);
  line("claims", `${total(ending.claims)} — ${detail(ending.claims)}`);
  line("disagreements", `${total(ending.disagreements)} — ${detail(ending.disagreements)}`);
  line("decisions", String(ending.decisions));
  for (const [i, waiting] of ending.forAPerson.entries()) line(i === 0 ? "for a person" : "", waiting);
  line("external cost", ending.requests === 0
    ? `${money(0)} — nothing was sent, because nothing was run`
    : `${money(0)} — ${ending.requests} request${ending.requests === 1 ? "" : "s"}, every one of them answered in this process`);
}

const tally = <T>(items: T[], key: (item: T) => string): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const item of items) out[key(item)] = (out[key(item)] ?? 0) + 1;
  return out;
};

/* ─────────────────────────────────────────────────────────────── the modes */

export async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  if (args.mode === "help") {
    console.log("usage: cli.ts --dry-run | --simulate | --simulate-postgres --socket <path> --database <name> --user <name> | --run");
    console.log("       [--seed name] [--trouble none|differ|agree]");
    return 2;
  }

  if (args.mode === "run") return refuseToRun();

  const world = inventAWorld(args.seed, args.trouble);
  if (!world.manifest.sources.every((s) => s.uri.startsWith("fixture://"))) {
    throw new Error("core-v2-runtime: the command line runs on invented sources only");
  }

  /* The stand-in that answers, and the adapters over it. One adapter per
     provider, which is what makes each provider one independence domain. */
  const transport = new LocalProviderTransport({ answer: world.answer });
  const registry = buildProviderRegistry({
    config: DEMONSTRATION_CONFIG, transport, compilePrompt: world.compile, materialResolver: world.resolver,
    routing: DEMONSTRATION_ROUTING, environment: DEMONSTRATION_ENVIRONMENT,
  });

  const roles = new RoleRegistry(world.pack);
  const specs = planDiscovery(world.manifest, world.pack);
  const planned = specsToTasks(specs, world.manifest.workflowId, lookupOf(world.manifest, []), roles, DEFAULT_POLICY);
  const plannedRoles = [...new Set([...planned.tasks.map((t) => t.roleKey), ...roles.all().map((r) => r.roleKey)])].join(", ");

  header(args.mode, world, registry, plannedRoles);

  if (args.mode === "dry-run") {
    console.log("phase A — planned from the manifest, and not executed:");
    console.log(describeTasks(planned.tasks, lookupOf(world.manifest, [])));
    if (planned.refusals.length) console.log(`refused: ${planned.refusals.join("; ")}`);
    console.log("");
    console.log("  nothing was executed, no prompt was compiled and no request was built.");
    footer({ outcome: "nothing was run — this is a plan", claims: {}, disagreements: {}, decisions: 0, forAPerson: [], requests: transport.sent.length });
    return 0;
  }

  if (args.mode === "simulate") return await simulate(world, registry, transport);
  return await simulateOnPostgres(args, world, registry, transport);
}

/* THE WHOLE CHAIN IN MEMORY, through the three real adapters. */
async function simulate(world: World, registry: ReturnType<typeof buildProviderRegistry>, transport: LocalProviderTransport): Promise<number> {
  const repo = new InMemoryOrchestrationRepository();
  const scheduler = new Scheduler(repo, world.manifest, world.pack, DEFAULT_POLICY, new AgentRouter(), registry.registry, { owner: "cli", leaseTtlMs: 60_000, now: () => Date.now() });
  await scheduler.plan();
  const report = await scheduler.runUntilQuiescent();
  const claims = await repo.listClaims({ workflowId: world.manifest.workflowId });
  const disagreements = await repo.listDisagreements(world.manifest.workflowId);
  const decisions = await repo.listDecisions(world.manifest.workflowId);
  console.log(`the workflow ran ${report.ticks} ticks; tasks ${JSON.stringify(report.tasks)}`);
  footer({
    outcome: `${report.workflow.state} — ${describeOutcome(report.workflow.state)}`,
    claims: tally(claims, (c) => c.status),
    disagreements: tally(disagreements, (d) => d.state),
    decisions: decisions.length,
    forAPerson: report.escalations,
    requests: transport.sent.length,
  });
  return 0;
}

/* THE WHOLE CHAIN THROUGH THE REAL DISPATCHER AND THE REAL RECORD, on a
   local cluster. A unix socket and nothing else: there is no flag for a host
   or a password, so this cannot be pointed at a server anywhere. */
async function simulateOnPostgres(args: Arguments, world: World, registry: ReturnType<typeof buildProviderRegistry>, transport: LocalProviderTransport): Promise<number> {
  if (!args.socket || !args.database || !args.user) {
    console.log("  --simulate-postgres needs a local cluster to write to:");
    console.log("      --socket <path to a unix socket>  --database <name>  --user <name>");
    console.log("  It writes a synthetic workflow into that database. There is no host or password flag,");
    console.log("  and there never will be: this mode is for a throwaway cluster on this machine.");
    return 2;
  }
  if (!args.socket.startsWith("/")) {
    console.log("  --socket must be a path on this machine. This mode does not open a socket to anywhere else.");
    return 2;
  }
  const organizationId = process.env.CORE_V2_CLI_ORGANIZATION ?? "";
  if (!organizationId) {
    console.log("  set CORE_V2_CLI_ORGANIZATION to the id of an organisation that exists in that database.");
    console.log("  Every row this writes belongs to it, and the schema will refuse rows that belong to nobody.");
    return 2;
  }

  const client = await WireClient.connect({ socketPath: args.socket, user: args.user, database: args.database, applicationName: "core-v2-runtime-cli" });
  const dispatcherClient = await WireClient.connect({ socketPath: args.socket, user: args.user, database: args.database, applicationName: "core-v2-runtime-cli" });
  try {
    const manifest = { ...world.manifest, organizationId };
    const producer = new PostgresOrchestrationRepository(client, { organizationId });
    await enqueueWorkflow(producer, manifest, world.pack);
    await new BudgetLedger(client, DEMONSTRATION_CONFIG).authorizeWorkflow({
      workflowId: manifest.workflowId, organizationId, currency: "USD",
      authorizedMaximum: AUTHORIZED_MAXIMUM, maximumPerAttempt: PER_ATTEMPT_MAXIMUM,
      maximumAttempts: 200, maximumConcurrentAttempts: 8,
    });
    console.log(`  a start command is on the outbox for workflow ${manifest.workflowId}; the dispatcher claims it below.`);
    console.log("");

    const dispatcher = new Dispatcher({
      name: DEMONSTRATION_CONFIG.dispatcherName,
      connect: async () => dispatcherClient,
      /* The connection this dispatcher is given back is the one it was
         handed above; naming it here rather than taking the callback's
         argument is what keeps the record typed as the record. */
      repository: () => meteredRepository(new PostgresOrchestrationRepository(dispatcherClient, { organizationId }), {
        ledger: new BudgetLedger(dispatcherClient, DEMONSTRATION_CONFIG), config: DEMONSTRATION_CONFIG,
        providerOfFamily: (family) => DEMONSTRATION_ROUTING[family] ?? null,
      }),
      pack: world.pack,
      executors: () => registry.registry,
      events: (event) => { console.log(`  ${JSON.stringify(event)}`); },
      now: () => Date.now(),
      backoff: { baseMs: 5, ceilingMs: 20, jitter: 0, random: () => 0 },
    });
    await dispatcher.drain();
    await dispatcher.stop();

    const record = new PostgresOrchestrationRepository(client, { organizationId });
    const workflow = await record.getWorkflow(manifest.workflowId);
    const claims = await record.listClaims({ workflowId: manifest.workflowId });
    const disagreements = await record.listDisagreements(manifest.workflowId);
    const decisions = await record.listDecisions(manifest.workflowId);
    const standing = await new BudgetLedger(client, DEMONSTRATION_CONFIG).standing(manifest.workflowId);
    console.log("");
    line("the ledger", standing
      ? `${money(standing.authorized)} authorised · ${money(standing.spent)} settled · ${money(standing.held)} still held${standing.stoppedReason ? ` · stopped: ${standing.stoppedReason}` : ""}`
      : "no budget row — nothing was authorised");
    line("", "that is what this run WOULD have cost. It cost nothing: nothing was sent.");
    footer({
      outcome: `${workflow?.state ?? "gone"} — ${describeOutcome(workflow?.state ?? "gone")}`,
      claims: tally(claims, (c) => c.status),
      disagreements: tally(disagreements, (d) => d.state),
      decisions: decisions.length,
      forAPerson: disagreements.filter((d) => d.state === "needs_human").map((d) => `${d.subjectSignature.subject_key ?? d.disagreementKey}: ${d.needsHumanReason ?? "a person decides"}`),
      requests: transport.sent.length,
    });
    return 0;
  } finally {
    await client.end().catch(() => {});
    await dispatcherClient.end().catch(() => {});
  }
}

function describeOutcome(state: string): string {
  switch (state) {
    case "completed": return "every subject was settled by machine, on evidence";
    case "partial": return "some subjects were settled and at least one is waiting for a person";
    case "needs_attention": return "the engine has nothing further it can do by itself";
    case "ready_for_decision": return "the evidence stands and a decision is waiting to be made";
    case "cancelled": return "somebody stopped it";
    case "failed": return "it could not be run";
    default: return "see the record";
  }
}

/* THE PAID RUN, WHICH DOES NOT RUN.
 *
 * This is deliberately not a mode with a missing flag. It is a mode that
 * refuses, prints every reason, and builds nothing — no configuration, no
 * transport, no adapter, no request. The four gates are not defaults to be
 * flipped here: they are a runtime flag, an environment variable, an amount
 * above zero and two allowlists, all of which come from an operator, and
 * none of which this file supplies. A key sitting in the environment cannot
 * turn this into a paid command, because this command reads no environment
 * and opens no door. */
function refuseToRun(): number {
  const asked: RuntimeConfig = { ...DEMONSTRATION_CONFIG, authorization: NO_PAID_CALLS };
  console.log("core-v2 runtime · run");
  console.log("");
  console.log("  This command would spend money. It refuses:");
  for (const reason of paidCallRefusals(asked)) console.log(`    · ${reason}`);
  console.log("");
  console.log("  All of these must be true at the same time before anything is sent:");
  console.log("    1. the run was started with --allow-provider-network");
  console.log("    2. CORE_V2_ALLOW_PAID_CALLS=true in the environment");
  console.log("    3. an explicit maximum authorised cost above zero");
  console.log("    4. a configured allowlist of providers and of models, and a price for each");
  console.log("  and a transport that can reach a provider has to be built and injected, which");
  console.log("  this file never does. Until a person authorises a canary explicitly, the only");
  console.log("  transport this package builds by default is the sealed one:");
  console.log(`    ${new SealedTransport().name} — refuses every request, and says so`);
  console.log("");
  console.log("  Nothing was configured, nothing was built and nothing was sent.");
  return 2;
}

/* Entry guard: runs only when this file is the program, from wherever it is. */
const entry = process.argv[1] ? realpathSync(process.argv[1]) : "";
if (entry && entry === realpathSync(fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (error) => { console.error(String((error as Error).message ?? error)); process.exitCode = 1; });
}
