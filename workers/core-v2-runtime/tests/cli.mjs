/* THE OPERATOR'S COMMANDS, RUN AS PROGRAMS.
 *
 * cli.ts is the one place the runtime is a program rather than a library, so
 * it is the one place a person could point it at something real. This file
 * runs it as a program — a fresh node, from a directory that holds nothing
 * of it — and reads every line it prints.
 *
 * What the commands are held to:
 *   · every offline mode says, before it starts, that the network is
 *     disabled and that a paid call is not authorised, and it says why in
 *     the words a person would need to open those gates on purpose;
 *   · every offline mode names the invented pack, the roles it plans, the
 *     independence domain each provider is, and what it is allowed to spend;
 *   · every offline mode ends by saying how the workflow ended, how many
 *     claims, disagreements and decisions there are, and that the cost
 *     outside this process was nothing;
 *   · the paid mode refuses, gives every reason at once, and builds nothing;
 *   · the mode that writes to a record refuses anything but a path on this
 *     machine — there is no host flag and no password flag;
 *   · nothing any mode prints is a key, and no mode reads one.
 *
 * The database mode is run for real, against the same throwaway cluster the
 * rest of the suite uses, and the rows it claims to have written are read
 * back here rather than taken on trust.
 *
 * The network is not sealed in this process: it has to spawn to test a
 * program, and the engine's guard shuts child processes too. What is checked
 * instead is what every command reports about itself, and that the only
 * addresses any of them holds are under .invalid, which resolves nowhere.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { harness } from "../../core-v2/tests/harness.mjs";
import { ensureCluster, withThrowawayDatabase, HARNESS_LOCATION } from "../../core-v2/tests/postgres-harness.mjs";
import { NOT_A_CREDENTIAL, DEMONSTRATION_CONFIG } from "../providers/demonstration.ts";

const t = harness("the operator's commands, run as programs");

const CLI = fileURLToPath(new URL("../cli.ts", import.meta.url));
const ELSEWHERE = "/tmp";

const runs = [];
function run(args, environment = {}) {
  const child = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", CLI, ...args], {
    cwd: ELSEWHERE, encoding: "utf8", timeout: 120_000, env: { ...process.env, ...environment },
  });
  const outcome = { args: args.join(" ") || "(no flags)", status: child.status, out: `${child.stdout ?? ""}${child.stderr ?? ""}` };
  runs.push(outcome);
  return outcome;
}

const says = (outcome, pattern) => (pattern instanceof RegExp ? pattern.test(outcome.out) : outcome.out.includes(pattern));

/* Everything an offline mode must state before it starts and after it ends. */
function saysTheSixThings(label, outcome) {
  t.check(`${label}: it says the network is disabled`, says(outcome, /network\s+disabled/));
  t.check(`${label}: it says paid calls are disabled, and why one would refuse`,
    says(outcome, /paid calls\s+disabled/) && says(outcome, /--allow-provider-network/) && says(outcome, /CORE_V2_ALLOW_PAID_CALLS/)
    && says(outcome, /no maximum authorised cost/) && says(outcome, /authorised list/));
  t.check(`${label}: it names the invented pack it is about to read`, says(outcome, /domain pack\s+synthetic-records@/) && says(outcome, "fixture://"));
  t.check(`${label}: it says which roles are in play`, says(outcome, /roles in play\s+\S/));
  t.check(`${label}: it says which independence domain each provider is`,
    says(outcome, /executor domains/) && (outcome.out.match(/domain:[0-9a-f]{12}/g) ?? []).length >= 3,
    [...new Set(outcome.out.match(/domain:[0-9a-f]{12}/g) ?? [])].join(" "));
  t.check(`${label}: it says what it is allowed to spend, and what one attempt holds`,
    says(outcome, /budget\s+\$10\.00 authorised/) && says(outcome, /each attempt holds \$0\.\d+/));
  t.check(`${label}: it says how the run ended`, says(outcome, /outcome\s+\S/));
  t.check(`${label}: it counts the claims, the disagreements and the decisions`,
    says(outcome, /claims\s+\d+/) && says(outcome, /disagreements\s+\d+/) && says(outcome, /decisions\s+\d+/));
  t.check(`${label}: it says the cost outside this process was nothing`, says(outcome, /external cost\s+\$0\.00/));
  t.check(`${label}: and it prints no key`, !says(outcome, NOT_A_CREDENTIAL.slice(0, 20)) || says(outcome, /keys\s+none read/));
}

/* ═══════════════════════════════════════════ 1 · no mode, and the paid mode */

t.section("no mode is a usage line, and the mode that would spend money refuses");
{
  const none = run([]);
  t.check("with no flags it prints how to use it and exits 2, rather than running something",
    none.status === 2 && says(none, "usage: cli.ts") && !says(none, "executor domains"), `exit ${none.status}`);

  const paid = run(["--run"], { CORE_V2_ALLOW_PAID_CALLS: "true", CORE_V2_DEMONSTRATION_KEY_ALPHA: "a-key-shaped-string-that-is-not-one" });
  t.check("the paid mode refuses and exits 2, even with the environment gate set and a key in the environment",
    paid.status === 2 && says(paid, "It refuses"), `exit ${paid.status}`);
  t.check("it gives every reason at once rather than the first",
    ["--allow-provider-network", "CORE_V2_ALLOW_PAID_CALLS", "maximum authorised cost", "provider is on the authorised list", "model is on the authorised list"]
      .every((reason) => says(paid, reason)));
  t.check("it names all four gates as things a person must do on purpose",
    ["1.", "2.", "3.", "4."].every((n) => says(paid, n)) && says(paid, "at the same time"));
  t.check("and it built nothing: no pack, no domains, no request",
    !says(paid, "executor domains") && !says(paid, "domain pack") && says(paid, "Nothing was configured, nothing was built and nothing was sent"));
  t.check("the key that was in its environment is not in its output", !says(paid, "a-key-shaped-string-that-is-not-one"));
}

/* ═══════════════════════════════════════════════════════ 2 · the dry run */

t.section("a dry run plans and prints, and executes nothing");
{
  const dry = run(["--dry-run"]);
  t.check("it exits 0", dry.status === 0, `exit ${dry.status}`);
  saysTheSixThings("dry run", dry);
  t.check("dry run: it says plainly that nothing was executed and no request was built",
    says(dry, "nothing was executed, no prompt was compiled and no request was built"));
  t.check("dry run: it made no requests at all", says(dry, /external cost\s+\$0\.00 — nothing was sent/));
  t.check("dry run: it printed the assignments it would make", says(dry, /bounded assignments/) && says(dry, "source_ingestor"));
}

/* ═════════════════════════════════════════════ 3 · the simulation in memory */

t.section("a simulation runs the whole chain through the three adapters, answered in this process");
{
  const differ = run(["--simulate"]);
  t.check("it exits 0", differ.status === 0, `exit ${differ.status}`);
  saysTheSixThings("simulation", differ);
  t.check("simulation: the workflow ran to a machine-settled end", says(differ, /outcome\s+completed/), (differ.out.match(/outcome\s+.*/) ?? [])[0]);
  t.check("simulation: something was accepted, something was rejected, and a disagreement was resolved",
    says(differ, /claims\s+\d+ — .*accepted/) && says(differ, "rejected") && says(differ, /disagreements\s+1 — 1 resolved/),
    (differ.out.match(/claims\s+.*/) ?? [])[0]);
  t.check("simulation: requests were made, and every one of them was answered in this process",
    says(differ, /external cost\s+\$0\.00 — \d+ requests, every one of them answered in this process/));

  const agree = run(["--simulate", "--trouble", "agree"]);
  t.check("told to make both readers agree on a falsehood, it does not end as if it had finished",
    agree.status === 0 && says(agree, /outcome\s+partial/), (agree.out.match(/outcome\s+.*/) ?? [])[0]);
  t.check("and it says what a person has to look at, in a sentence",
    says(agree, /for a person\s+entry\/E-001: /), (agree.out.match(/for a person\s+.*/) ?? [])[0]);
  t.check("nothing was accepted on the strength of two readings matching",
    says(agree, /disagreements\s+1 — 1 needs_human/), (agree.out.match(/disagreements\s+.*/) ?? [])[0]);

  const seeded = run(["--simulate", "--seed", "another-world"]);
  t.check("a seed names a world: another seed is another run, not a fixed string",
    seeded.status === 0 && seeded.out !== differ.out);
}

/* ══════════════════════════════════════ 4 · the simulation against a record */

t.section("the mode that writes to a record refuses anything but a path on this machine");
{
  const missing = run(["--simulate-postgres"]);
  t.check("without a cluster to write to it says what it needs and exits 2",
    missing.status === 2 && says(missing, "--socket") && says(missing, "--database") && says(missing, "--user"), `exit ${missing.status}`);
  t.check("and it says there is no host flag and no password flag, and never will be",
    says(missing, "There is no host or password flag"));

  const remote = run(["--simulate-postgres", "--socket", "db.example.com:5432", "--database", "d", "--user", "u"]);
  t.check("given something that is not a path, it refuses",
    remote.status === 2 && says(remote, "must be a path on this machine"), `exit ${remote.status}`);
}

await withThrowawayDatabase(async ({ client, organizationId, databaseName }) => {
  const { socketPath } = await ensureCluster();
  t.section("and against a throwaway cluster it writes the record it says it writes");

  const noOrganisation = run(["--simulate-postgres", "--socket", socketPath, "--database", databaseName, "--user", HARNESS_LOCATION.user],
    { CORE_V2_CLI_ORGANIZATION: "" });
  t.check("without an organisation to write for, it refuses rather than inventing one",
    noOrganisation.status === 2 && says(noOrganisation, "CORE_V2_CLI_ORGANIZATION"), `exit ${noOrganisation.status}`);

  const real = run(["--simulate-postgres", "--socket", socketPath, "--database", databaseName, "--user", HARNESS_LOCATION.user, "--seed", "cli/postgres"],
    { CORE_V2_CLI_ORGANIZATION: organizationId });
  t.check("it exits 0", real.status === 0, `exit ${real.status}: ${real.out.slice(-400)}`);
  saysTheSixThings("record", real);
  t.check("record: it put a start command on the outbox and the dispatcher claimed it",
    says(real, "a start command is on the outbox") && says(real, '"event":"outbox.claimed"'));
  t.check("record: it reported what the run would have cost, and that it cost nothing",
    says(real, /the ledger\s+\$10\.00 authorised · \$0\.0\d+ settled/) && says(real, "It cost nothing: nothing was sent"),
    (real.out.match(/the ledger\s+.*/) ?? [])[0]);

  const rows = async (sql) => Number((await client.query(sql, [organizationId])).rows[0].n);
  const written = {
    workflows: await rows(`select count(*) n from public.intelligence_workflows where organization_id = $1`),
    attempts: await rows(`select count(*) n from public.agent_attempts where organization_id = $1`),
    claims: await rows(`select count(*) n from public.evidence_claims where organization_id = $1`),
    decisions: await rows(`select count(*) n from public.decisions where organization_id = $1`),
    reservations: await rows(`select count(*) n from public.attempt_cost_reservations where organization_id = $1`),
  };
  t.check("the rows it says it wrote are in the database, read back here rather than taken on trust",
    Object.values(written).every((x) => x > 0), Object.entries(written).map(([k, v]) => `${k}=${v}`).join(" "));
  const counted = Number((real.out.match(/claims\s+(\d+)/) ?? [])[1]);
  t.check("and the number of claims it printed is the number of claims there are",
    counted === written.claims, `${counted} printed, ${written.claims} on the record`);
  const settled = await client.query(`select count(*) n from public.attempt_cost_reservations where organization_id = $1 and state = 'settled'`, [organizationId]);
  t.check("every hold it took was settled at what the answering stand-in reported",
    Number(settled.rows[0].n) === written.reservations, `${settled.rows[0].n} of ${written.reservations}`);
});

/* ═════════════════════════════════════════════ 5 · what the file itself is */

t.section("what the command line is, read rather than run");
{
  const source = readFileSync(CLI, "utf8");
  t.check("there is no flag that names a host, a password, a key, a customer, a project or a document",
    !/--host|--password|--api-key|--token|--customer|--project|--document/.test(source));
  t.check("every address any mode holds is under .invalid, which resolves nowhere",
    DEMONSTRATION_CONFIG.providers.every((p) => new URL(p.baseUrl).hostname.endsWith(".invalid")),
    DEMONSTRATION_CONFIG.providers.map((p) => p.baseUrl).join(" "));
  t.check("its configuration prices every model it allows, so nothing it could ask for is unpriced",
    DEMONSTRATION_CONFIG.providers.every((p) => p.models.every((m) => DEMONSTRATION_CONFIG.pricing.some((x) => x.providerId === p.providerId && x.model === m))));

  const imported = await import("../cli.ts");
  t.check("imported rather than invoked, it runs nothing and exposes its argument parsing",
    typeof imported.main === "function" && imported.parseArgs(["--simulate"]).mode === "simulate"
    && imported.parseArgs([]).mode === "help");
  t.check("and no mode is the default: an unrecognised flag is help, not a run",
    imported.parseArgs(["--go"]).mode === "help" && imported.parseArgs(["--run"]).mode === "run");
}

t.section("what every command reported about itself");
for (const outcome of runs) {
  t.check(`\`${outcome.args}\` reported no cost outside this process`,
    outcome.status === 2 || says(outcome, /external cost\s+\$0\.00/), `exit ${outcome.status}`);
}

t.finish();
