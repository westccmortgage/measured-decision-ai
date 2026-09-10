/* THE START, AS ONE WRITE.
 *
 * WHAT WENT WRONG BEFORE.
 *
 * The first version of this door did two things in a row:
 *
 *     enqueueWorkflow(...)          -- workflow, sources, outbox, audit
 *     store.schedule(workflowId)    -- the continuation the watchdog reads
 *
 * Both are durable. Neither is durable WITH the other. A process that died
 * between them — a redeploy, a timeout, a dropped socket, a pod eviction —
 * left a real workflow, with real sources and a real pending start command,
 * that no watchdog would ever look at, because the only table the watchdog
 * reads had no row for it. It was not visibly broken: `status` answered, the
 * id was real, the caller had been told 202. It simply never ran, and nothing
 * anywhere would ever say why.
 *
 * That is the one failure this whole change exists to prevent, so the start
 * that creates it must not be able to half-happen.
 *
 * HOW IT IS FIXED, WITHOUT A NEW MECHANISM.
 *
 * The wire client already has `transaction(fn)`, and the repository already
 * writes the four start rows inside one. The only thing missing was a way to
 * put a fifth write inside the SAME one. So the repository is handed a client
 * that is already in a transaction — `query` runs on the transaction, and
 * `transaction(fn)` runs the block on the transaction it is already in rather
 * than opening a second. Savepoints inside still work, because a savepoint is
 * issued on the query object either way.
 *
 * The result: workflow, sources, outbox, audit and the first continuation
 * commit together or not at all. The id this function returns is the id of a
 * workflow the automatic runner can already see.
 *
 * WHAT IT REFUSES, AND WHEN.
 *
 * Before the transaction opens, never inside it. A shape V1 cannot run is a
 * 400 with the numbers in it, not a workflow row that will fail its own
 * material check on every pass until a fuse settles it.
 */
import type { DomainPack } from "../core-v2/kernel/domain.ts";
import type { WorkflowRecord } from "../core-v2/kernel/repository.ts";
import type { Queryable } from "../core-v2/postgres/wire.ts";
import { PostgresOrchestrationRepository } from "../core-v2/postgres/repository.ts";
import { enqueueWorkflow } from "../core-v2-runtime/dispatcher.ts";
import { checkShape, isShapeRefusal, syntheticSourceSet } from "./source-set.ts";
import type { ShapeRefusal, SourceSet, SyntheticShape } from "./source-set.ts";

/* A client that is already inside a transaction. `transaction` is the identity
   here on purpose: the repository asks for one and gets the one it is in. */
export type TransactionalClient = Queryable & { transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> };

export function alreadyInTransaction(tx: Queryable): TransactionalClient {
  return {
    query: (sql, params) => tx.query(sql, params),
    transaction: <T,>(fn: (inner: Queryable) => Promise<T>): Promise<T> => fn(tx),
  };
}

export type StartRequest = {
  organizationId: string;
  shape: Required<SyntheticShape>;
};

export type StartRefusal = ShapeRefusal;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/* Everything a caller may say, checked once, in one place, before a workflow
   exists. The Edge Function calls this; so does the offline suite. */
export function parseStartRequest(body: Record<string, unknown>): StartRequest | StartRefusal {
  const organizationId = body.organizationId;
  if (typeof organizationId !== "string" || !UUID.test(organizationId)) {
    return { refused: "start needs the organizationId whose workflow this is", field: "organizationId" };
  }
  const asked: SyntheticShape = {
    seed: typeof body.sourceSetSeed === "string" ? body.sourceSetSeed : "",
    sources: numberOrAbsent(body.sources),
    sheetsPerSource: numberOrAbsent(body.sheetsPerSource),
    entriesPerTable: numberOrAbsent(body.entriesPerTable),
  };
  if (asked.seed === "") {
    return { refused: "start needs sourceSetSeed: the source set this workflow reads, named so that any later runner can rebuild exactly it", field: "sourceSetSeed" };
  }
  const shape = checkShape(asked);
  if (isShapeRefusal(shape)) return shape;
  return { organizationId, shape };
}

/* A value the caller wrote down, or nothing at all. A blank, a null and an
   absent field all mean "use the default"; anything else is checked, and
   "four" is refused rather than quietly becoming three. */
function numberOrAbsent(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return typeof value === "number" ? value : Number(value);
}

export type StartOutcome = {
  workflowId: string;
  state: WorkflowRecord["state"];
  sourceSet: SourceSet;
};

export type StartOptions = {
  client: TransactionalClient;
  request: StartRequest;
  pack: DomainPack;
  /* Run inside the transaction, after the workflow rows and before the
     continuation. It exists so a test can kill a start exactly where the old
     code could die, and prove that nothing survives it. Production passes
     nothing. */
  betweenWrites?: (tx: Queryable, workflowId: string) => Promise<void>;
};

/* Workflow, sources, outbox, audit and the first continuation — one commit. */
export async function startWorkflowAtomically(options: StartOptions): Promise<StartOutcome> {
  const { client, request, pack } = options;
  const sourceSet = syntheticSourceSet(request.shape, request.organizationId);

  const workflow = await client.transaction(async (tx) => {
    const repo = new PostgresOrchestrationRepository(
      alreadyInTransaction(tx) as never, { organizationId: request.organizationId },
    );
    const created = await enqueueWorkflow(repo, sourceSet.manifest, pack);
    if (options.betweenWrites) await options.betweenWrites(tx, created.workflowId);
    /* The same door migration 060 gives every other caller, called on this
       transaction rather than beside it. */
    await tx.query(
      `select 1 from public.core_v2_schedule_continuation($1::uuid, now())`,
      [created.workflowId],
    );
    return created;
  });

  return { workflowId: workflow.workflowId, state: workflow.state, sourceSet };
}
