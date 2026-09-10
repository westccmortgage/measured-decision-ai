/* THE DURABLE ANSWER TO "WHEN DOES THIS WORKFLOW RUN AGAIN".
 *
 * Every decision about waking lives in the database, in migration 060's
 * `workflow_continuations`, and this file is only the thin way to reach it.
 * Nothing here decides anything: the claim is a single statement under
 * SKIP LOCKED so two runners never spend an invocation on one workflow, the
 * release is fenced by a token so a runner whose hold expired mid-pass cannot
 * write over whoever holds it now, and the fuses that stop a poisoned
 * workflow waking forever are in the SQL where every caller shares them.
 *
 * It is written against `Queryable` — the same dependency-free wire client
 * the rest of Core V2 uses — so a test drives it against a throwaway cluster
 * and the Edge Function drives it against Supavisor, with no difference in
 * behaviour to argue about.
 */
import type { Queryable } from "../core-v2/postgres/wire.ts";

/* What a runner holds while it works. The token is the whole of its right to
   write back. */
export type ContinuationHold = {
  workflowId: string;
  holdToken: string;
  /* How many continuations this workflow has had, this one included. */
  continuations: number;
  idleStreak: number;
  heldUntil: string | null;
};

export type ContinuationRecord = {
  workflowId: string;
  organizationId: string;
  state: "due" | "held" | "settled";
  dueAt: string;
  heldBy: string | null;
  heldUntil: string | null;
  continuations: number;
  idleStreak: number;
  backoffMs: number;
  lastError: string | null;
  settledReason: string | null;
  settledAt: string | null;
};

export type ContinuationLimits = {
  maximumIdleStreak: number;
  maximumContinuations: number;
  firstBackoffMs: number;
  maximumBackoffMs: number;
};

/* What the release said happened to the row. `null` means the hold was not
   ours any more — not an error to repair, a fact to log and leave alone. */
export type ReleaseOutcome = ContinuationRecord | null;

export interface ContinuationStore {
  schedule(workflowId: string, dueAt?: Date | null): Promise<ContinuationRecord | null>;
  claim(runner: string, holdMs: number): Promise<ContinuationHold | null>;
  release(input: {
    workflowId: string; holdToken: string; moved: boolean;
    nextDueAt?: Date | null; error?: string | null;
  }): Promise<ReleaseOutcome>;
  settle(workflowId: string, reason: string): Promise<ContinuationRecord | null>;
  due(limit: number): Promise<string[]>;
  read(workflowId: string): Promise<ContinuationRecord | null>;
  limits(): Promise<ContinuationLimits>;
}

const COLUMNS = `
  c.workflow_id::text as workflow_id, c.organization_id::text as organization_id, c.state,
  c.due_at, c.held_by, c.held_until, c.continuations, c.idle_streak, c.backoff_ms,
  c.last_error, c.settled_reason, c.settled_at`;

const asNumber = (value: unknown): number => {
  const n = typeof value === "number" ? value : Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
};
const asText = (value: unknown): string | null => (value === null || value === undefined ? null : String(value));
const asTime = (value: unknown): string => (value instanceof Date ? value.toISOString() : String(value ?? ""));

function toRecord(row: Record<string, unknown>): ContinuationRecord {
  return {
    workflowId: String(row.workflow_id),
    organizationId: String(row.organization_id),
    state: String(row.state) as ContinuationRecord["state"],
    dueAt: asTime(row.due_at),
    heldBy: asText(row.held_by),
    heldUntil: row.held_until === null || row.held_until === undefined ? null : asTime(row.held_until),
    continuations: asNumber(row.continuations),
    idleStreak: asNumber(row.idle_streak),
    backoffMs: asNumber(row.backoff_ms),
    lastError: asText(row.last_error),
    settledReason: asText(row.settled_reason),
    settledAt: row.settled_at === null || row.settled_at === undefined ? null : asTime(row.settled_at),
  };
}

export class PostgresContinuationStore implements ContinuationStore {
  private client: Queryable;
  constructor(client: Queryable) { this.client = client; }

  async schedule(workflowId: string, dueAt: Date | null = null): Promise<ContinuationRecord | null> {
    const r = await this.client.query(
      `select ${COLUMNS} from public.core_v2_schedule_continuation($1::uuid, coalesce($2::timestamptz, now())) c`,
      [workflowId, dueAt === null ? null : dueAt.toISOString()],
    );
    return r.rows.length && r.rows[0].workflow_id ? toRecord(r.rows[0]) : null;
  }

  /* One statement, and it either hands back a hold or nothing. There is no
     "try again in a moment": another runner holding the row is the system
     working, not a collision to retry through. */
  async claim(runner: string, holdMs: number): Promise<ContinuationHold | null> {
    const r = await this.client.query(
      `select c.workflow_id::text as workflow_id, c.hold_token::text as hold_token,
              c.continuations, c.idle_streak, c.held_until
         from public.core_v2_claim_continuation($1, $2::int) c`,
      [runner, Math.trunc(holdMs)],
    );
    const row = r.rows[0];
    if (!row || !row.workflow_id) return null;
    return {
      workflowId: String(row.workflow_id),
      holdToken: String(row.hold_token),
      continuations: asNumber(row.continuations),
      idleStreak: asNumber(row.idle_streak),
      heldUntil: row.held_until === null || row.held_until === undefined ? null : asTime(row.held_until),
    };
  }

  async release(input: {
    workflowId: string; holdToken: string; moved: boolean;
    nextDueAt?: Date | null; error?: string | null;
  }): Promise<ReleaseOutcome> {
    const r = await this.client.query(
      `select ${COLUMNS} from public.core_v2_release_continuation($1::uuid, $2::uuid, $3::boolean, $4::timestamptz, $5) c`,
      [
        input.workflowId, input.holdToken, input.moved === true,
        input.nextDueAt ? input.nextDueAt.toISOString() : null,
        input.error ?? null,
      ],
    );
    return r.rows.length && r.rows[0].workflow_id ? toRecord(r.rows[0]) : null;
  }

  async settle(workflowId: string, reason: string): Promise<ContinuationRecord | null> {
    const r = await this.client.query(
      `select ${COLUMNS} from public.core_v2_settle_continuation($1::uuid, $2) c`,
      [workflowId, reason],
    );
    return r.rows.length && r.rows[0].workflow_id ? toRecord(r.rows[0]) : null;
  }

  async due(limit: number): Promise<string[]> {
    const r = await this.client.query(
      `select w::text as workflow_id from public.core_v2_due_continuations($1::int) w`,
      [Math.trunc(limit)],
    );
    return r.rows.map((row) => String(row.workflow_id));
  }

  async read(workflowId: string): Promise<ContinuationRecord | null> {
    const r = await this.client.query(
      `select ${COLUMNS} from public.workflow_continuations c where c.workflow_id = $1::uuid`,
      [workflowId],
    );
    return r.rows.length ? toRecord(r.rows[0]) : null;
  }

  async limits(): Promise<ContinuationLimits> {
    const r = await this.client.query(`select * from public.core_v2_continuation_limits()`);
    const row = r.rows[0] ?? {};
    return {
      maximumIdleStreak: asNumber(row.maximum_idle_streak),
      maximumContinuations: asNumber(row.maximum_continuations),
      firstBackoffMs: asNumber(row.first_backoff_ms),
      maximumBackoffMs: asNumber(row.maximum_backoff_ms),
    };
  }
}
