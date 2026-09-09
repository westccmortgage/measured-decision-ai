/* THE ONE PAID RUN, AND EVERY REASON IT DOES NOT HAPPEN YET.
 *
 *   node --experimental-strip-types --no-warnings canary.ts --preflight --registry <path>
 *   node --experimental-strip-types --no-warnings canary.ts --execute   --registry <path> \
 *        --allow-provider-network --socket <path> --database <name> --user <name>
 *
 * --preflight is the default and the safe one. It reads the operator's
 * declaration, works out what a whole canary could cost at the worst price
 * the declaration admits, and prints every reason the paid run may not
 * proceed. It reads no key — not even to see whether one exists, because a
 * key is read by the sealed executor and by nothing else — opens no socket,
 * builds no transport and writes no row.
 *
 * --execute is the run. It is deliberately awkward: a flag, an environment
 * variable, an operator's declaration, and a record on a unix socket on this
 * machine. There is no host flag and there never will be, so this cannot be
 * pointed at a hosted database; the record it writes is a throwaway cluster
 * with the migrations applied, which is where a canary's rows belong.
 *
 * What it will not do, at any flag: retry, fall back to another model,
 * dispatch the same task twice, or send anything after the first refusal,
 * protocol error, timeout, unknown outcome or accounting mismatch. The
 * authority is $5.00 and this file cannot raise it — the number is a
 * constant in the registry module and every path reads it from there.
 */
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { InMemoryMaterialResolver } from "../core-v2-runtime/material/memory-resolver.ts";
import type { StoredMaterial } from "../core-v2-runtime/material/memory-resolver.ts";
import { syntheticRecordSet } from "../core-v2/domains/synthetic-records/fixture.ts";
import { SyntheticRecordsPack } from "../core-v2/domains/synthetic-records/pack.ts";
import { RoleRegistry } from "../core-v2/kernel/roles.ts";
import { entityId } from "../core-v2/kernel/ids.ts";
import { PostgresOrchestrationRepository } from "../core-v2/postgres/repository.ts";
import { WireClient } from "../core-v2/postgres/wire.ts";
import type { WorkPacket } from "../core-v2/kernel/contracts.ts";

import { BudgetLedger } from "../core-v2-runtime/budget/ledger.ts";
import { meteredRepository } from "../core-v2-runtime/budget/metered.ts";
import { Dispatcher, enqueueWorkflow } from "../core-v2-runtime/dispatcher.ts";
import { compilePrompt } from "../core-v2-runtime/prompt-compiler.ts";
import { buildProviderRegistry } from "../core-v2-runtime/providers/registry.ts";
import type { RuntimeConfig } from "../core-v2-runtime/runtime-config.ts";
import { createHttpsTransport } from "../core-v2-runtime/transport/https.ts";
import {
  authorizedConfig, CANARY_AUTHORIZED, CANARY_CURRENCY, CANARY_MAXIMUM_SUBMISSIONS, CANARY_ID,
  loadOperatorRegistry, ORGANIZATION_VARIABLE, PAID_CALLS_VARIABLE, worstCase,
} from "./operator-registry.ts";
import type { CanaryGates, OperatorRegistry, WorstCase } from "./operator-registry.ts";

/* Re-exported so the one program and the one suite agree about where these
   live: the arithmetic and the authorization are the registry module's, and
   this file is the program that runs them. */
export { authorizedConfig, worstCase };

/* Attempt states that mean a provider may already have been asked, and so
   may already have charged. 'prepared' and the two refusals are not here. */
const MAY_HAVE_BEEN_BILLED = [
  "submitted", "response_received", "parsed", "succeeded",
  "failed_known", "output_limited", "outcome_unknown",
];

export type Mode = "preflight" | "execute" | "help";
export type Arguments = {
  mode: Mode;
  registry?: string;
  networkFlag: boolean;
  socket?: string;
  database?: string;
  user?: string;
};

export function parseArgs(argv: string[]): Arguments {
  const at = (flag: string): string | undefined => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : undefined; };
  const mode: Mode = argv.includes("--execute") ? "execute" : argv.includes("--preflight") ? "preflight" : "help";
  return {
    mode,
    registry: at("--registry"),
    networkFlag: argv.includes("--allow-provider-network"),
    socket: at("--socket"),
    database: at("--database"),
    user: at("--user"),
  };
}

const money = (amount: number) => `$${amount.toFixed(5)}`;
const line = (label: string, value: string) => console.log(`  ${label.padEnd(22)}${value}`);

/* ─────────────────────────────────────────────────────────── the refusals */

export type Preflight = {
  registry: OperatorRegistry | null;
  worst: WorstCase | null;
  refusals: string[];
};

/* Every reason at once, in the order a person would fix them. Nothing here
   touches the environment for a key, opens a socket, or builds a transport. */
export function preflight(args: Arguments, environment: Record<string, string | undefined>): Preflight {
  const refusals: string[] = [];

  let registry: OperatorRegistry | null = null;
  if (!args.registry) {
    refusals.push("no --registry: this canary needs an operator's declaration of the three models, their addresses, their capabilities and their prices. Nothing in this repository may invent them, and the only configuration it ships is the invented one, which reaches nowhere.");
  } else {
    let text = "";
    try { text = readFileSync(args.registry, "utf8"); }
    catch (error) { refusals.push(`--registry ${args.registry}: cannot be read — ${(error as Error).message}`); }
    if (text) {
      const loaded = loadOperatorRegistry(text, args.registry);
      registry = loaded.registry;
      for (const problem of loaded.problems) refusals.push(`registry: ${problem}`);
    }
  }

  if (!args.networkFlag) refusals.push("not started with --allow-provider-network");
  if (environment[PAID_CALLS_VARIABLE] !== "true") refusals.push(`${PAID_CALLS_VARIABLE} is not "true" in the environment`);
  if (!environment[ORGANIZATION_VARIABLE]) refusals.push(`${ORGANIZATION_VARIABLE} is not set — every row this writes belongs to an organisation, and the schema refuses rows that belong to nobody`);
  if (args.mode === "execute") {
    if (!args.socket || !args.database || !args.user) refusals.push("--execute needs a record to write to: --socket <unix socket> --database <name> --user <name>. There is no host flag: a canary does not write to a hosted database.");
    else if (!args.socket.startsWith("/")) refusals.push("--socket must be a path on this machine");
  }

  let worst: WorstCase | null = null;
  if (registry) {
    worst = worstCase(registry.config);
    for (const problem of worst.problems) refusals.push(`pricing: ${problem}`);
    if (!worst.fits && worst.problems.length === 0) {
      refusals.push(`the arithmetic does not fit: ${CANARY_MAXIMUM_SUBMISSIONS} submissions at ${money(worst.perAttempt)} each is ${money(worst.wholeCanary)}, above the ${money(CANARY_AUTHORIZED)} authorised`);
    }
  }

  return { registry, worst, refusals };
}

/* ─────────────────────────────────────────────────────────── the printing */

function describe(args: Arguments, result: Preflight): void {
  console.log(`core-v2 canary · ${CANARY_ID} · ${args.mode}`);
  console.log("");
  line("authority", `${money(CANARY_AUTHORIZED)} ${CANARY_CURRENCY}, for this canary and nothing else. This program cannot raise it.`);
  line("submissions", `at most ${CANARY_MAXIMUM_SUBMISSIONS} for the whole canary, ever, under this id`);
  line("material", "the smallest synthetic record set: one source, one sheet, three entries, every uri fixture://");
  line("keys", "not read and not looked for. The sealed executor reads one, once, after every other check has passed.");
  if (result.registry) {
    line("declared by", `${result.registry.declaredBy} on ${result.registry.declaredAt}`);
    for (const [i, provider] of result.registry.config.providers.entries()) {
      line(i === 0 ? "providers" : "", `${provider.providerId.padEnd(12)} ${provider.defaultModel.padEnd(28)} key from $${provider.apiKeyEnvironmentVariable}`);
    }
    for (const [role, providerId] of Object.entries(result.registry.roles)) line(role === "readerA" ? "roles" : "", `${role.padEnd(10)} → ${providerId}`);
  }
  if (result.worst) {
    line("worst attempt", `${money(result.worst.perAttempt)} at the dearest declared rate, against the declared token ceilings`);
    line("worst canary", `${money(result.worst.wholeCanary)} — ${result.worst.fits ? "fits inside" : "does NOT fit inside"} ${money(CANARY_AUTHORIZED)}`);
  }
  console.log("");
  if (result.refusals.length === 0) {
    console.log("  Every gate this program can check is open.");
    return;
  }
  console.log(`  This canary does not proceed. ${result.refusals.length} reason${result.refusals.length === 1 ? "" : "s"}:`);
  for (const refusal of result.refusals) console.log(`    · ${refusal}`);
}

/* ─────────────────────────────────────────────────────────────── the modes */

export async function main(argv: string[], environment: Record<string, string | undefined> = process.env): Promise<number> {
  const args = parseArgs(argv);
  if (args.mode === "help") {
    console.log("usage: canary.ts --preflight --registry <path>");
    console.log("       canary.ts --execute --registry <path> --allow-provider-network \\");
    console.log("                 --socket <unix socket> --database <name> --user <name>");
    console.log("");
    console.log(`  --preflight reads no key, opens nothing and writes nothing. ${PAID_CALLS_VARIABLE}=true`);
    console.log("  and an operator's registry declaration are needed before --execute does anything.");
    return 2;
  }

  const result = preflight(args, environment);
  describe(args, result);
  if (result.refusals.length > 0) {
    console.log("");
    console.log("  Nothing was configured, nothing was built, no key was read and nothing was sent.");
    return 2;
  }
  if (args.mode === "preflight") {
    console.log("");
    console.log("  Preflight only. Nothing was sent. Add --execute to make the paid run.");
    return 0;
  }
  return await execute(args, result, environment);
}

async function execute(args: Arguments, result: Preflight, environment: Record<string, string | undefined>): Promise<number> {
  const registry = result.registry;
  const worst = result.worst;
  if (!registry || !worst) throw new Error("core-v2 canary: execute reached without a registry, which preflight should have refused");
  const organizationId = environment[ORGANIZATION_VARIABLE] as string;

  const config = authorizedConfig(registry, { networkFlag: args.networkFlag, environment });

  const workflowId = entityId("core-v2-canary-workflow", CANARY_ID);
  const truth = syntheticRecordSet({ seed: CANARY_ID, sources: 1, sheetsPerSource: 1, entriesPerTable: 3, organizationId, workflowId });
  if (!truth.manifest.sources.every((s) => s.uri.startsWith("fixture://"))) {
    throw new Error("core-v2 canary: the canary runs on invented sources only");
  }
  const pack = new SyntheticRecordsPack();
  const roles = new RoleRegistry(pack);
  const stored = new Map<string, StoredMaterial>();
  for (const [hash, item] of truth.material) stored.set(hash, { mediaKind: item.mediaKind, mimeType: item.mimeType, bytes: item.bytes });

  const client = await WireClient.connect({ socketPath: args.socket as string, user: args.user as string, database: args.database as string, applicationName: CANARY_ID });
  const dispatcherClient = await WireClient.connect({ socketPath: args.socket as string, user: args.user as string, database: args.database as string, applicationName: CANARY_ID });
  let submitted = 0;
  try {
    /* THE ONE-CANARY RULE. An id that has already asked somebody something
       has spent part of an authority that is not renewed, and a second run
       under the same name would spend it again. */
    const already = await client.query(
      `select count(*)::text as n from public.agent_attempts where workflow_id = $1 and state = any($2::text[])`,
      [workflowId, `{${MAY_HAVE_BEEN_BILLED.join(",")}}`],
    );
    const priorSubmissions = Number(already.rows[0]?.n ?? "0");
    if (priorSubmissions > 0) {
      console.log(`  ${CANARY_ID} has already submitted ${priorSubmissions} attempt${priorSubmissions === 1 ? "" : "s"} in this record.`);
      console.log("  A canary runs once. Nothing was sent.");
      return 2;
    }

    const ledger = new BudgetLedger(client, config);
    await enqueueWorkflow(new PostgresOrchestrationRepository(client, { organizationId }), truth.manifest, pack);
    await ledger.authorizeWorkflow({
      workflowId, organizationId, currency: CANARY_CURRENCY,
      authorizedMaximum: CANARY_AUTHORIZED,
      maximumPerAttempt: worst.perAttempt,
      maximumAttempts: CANARY_MAXIMUM_SUBMISSIONS,
      maximumConcurrentAttempts: 1,
      /* The token limits, stated rather than inherited: the highest either
         ceiling reaches across the declared providers, which is the number
         every reservation is priced under. */
      maximumInputTokens: Math.max(...config.providers.map((p) => p.maximumInputTokens)),
      maximumOutputTokens: Math.max(...config.providers.map((p) => p.maximumOutputTokens)),
    });

    /* The only door out of this process, built last and only now: its
       constructor refuses unless every authorization above is in place, and
       it can reach the declared origins and nothing else. */
    const transport = createHttpsTransport({ config });
    line("transport", `${transport.name} — may reach ${transport.allowedOrigins.join(", ")} and nowhere else`);

    const executors = buildProviderRegistry({
      config, transport, routing: registry.routing,
      compilePrompt: (packet: WorkPacket) => compilePrompt(packet, roles.role(packet.roleKey)),
      materialResolver: new InMemoryMaterialResolver(stored),
      /* No environment argument: the executor reads its own key, once, at
         submission, after every check. This file never holds one. */
    });

    const dispatcher = new Dispatcher({
      name: config.dispatcherName,
      connect: async () => dispatcherClient,
      repository: () => meteredRepository(new PostgresOrchestrationRepository(dispatcherClient, { organizationId }), {
        ledger: new BudgetLedger(dispatcherClient, config), config,
        providerOfFamily: (family) => registry.routing[family] ?? null,
      }),
      pack,
      executors: () => executors.registry,
      events: (event) => {
        console.log(`  ${JSON.stringify(event)}`);
        const kind = String((event as { kind?: unknown }).kind ?? "");
        if (kind.includes("submitted")) submitted += 1;
      },
      now: () => Date.now(),
      backoff: { baseMs: 50, ceilingMs: 200, jitter: 0, random: () => 0 },
    });
    await dispatcher.drain();
    await dispatcher.stop();

    /* Whatever happened, the unused authority is closed here, not left
       standing for a second run to find. */
    await ledger.stop(workflowId, "canary complete — unused authority closed");
    const standing = await ledger.standing(workflowId);
    console.log("");
    line("submissions", `${submitted} of at most ${CANARY_MAXIMUM_SUBMISSIONS}`);
    line("the ledger", standing
      ? `${money(standing.authorized)} authorised · ${money(standing.spent)} settled · ${money(standing.held)} still held · stopped: ${standing.stoppedReason ?? "no"}`
      : "no budget row");
    return 0;
  } finally {
    await client.end().catch(() => {});
    await dispatcherClient.end().catch(() => {});
  }
}

const entry = process.argv[1] ? realpathSync(process.argv[1]) : "";
if (entry && entry === realpathSync(fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (error) => { console.error(String((error as Error).message ?? error)); process.exitCode = 1; });
}
