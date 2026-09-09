/* THE DURABLE LEDGER: WHAT MAY BE SPENT, WHAT IS HELD, WHAT IS GONE.
 *
 * Migration 059 keeps the money in two tables and four doors, because the
 * invariant it holds — held plus spent never exceeds authorised — is
 * arithmetic across two rows under one lock, and no amount of care in a
 * worker can keep it from outside. This file is the TypeScript side of those
 * doors and nothing else: it computes the numbers from operator
 * configuration, hands them to the database, and turns the database's
 * refusals into typed errors a dispatcher can act on.
 *
 * Three rules it exists to keep:
 *
 *   1. A reservation is taken IN THE SAME UNIT OF WORK as the submission it
 *      pays for, for the MOST the attempt could cost — the ceilings the
 *      request will actually carry, each priced at the highest rate any
 *      billable component of its category could be charged at. Never an
 *      expectation, and never the ordinary rate where a cache write or a
 *      reasoning token could cost more: an engine that reserves what it
 *      expects and learns the truth afterwards has already spent the
 *      difference.
 *   2. A price is operator-supplied. An unpriced model has no ceiling, and
 *      something with no ceiling cannot be reserved for, and therefore cannot
 *      be sent. There is no default rate anywhere in this package.
 *   3. Every refusal is a refusal in the open. A door that says no comes back
 *      as BudgetRefused carrying the database's own sentence, never as a
 *      false the caller can forget to read.
 *
 * Nothing here names a provider. A provider id is a value that arrives from
 * configuration, is written into the price basis of a reservation, and is
 * read back out again to settle it. This file never knows what one is.
 */
import { isPostgresError } from "../../core-v2/postgres/wire.ts";
import type { Queryable, Row } from "../../core-v2/postgres/wire.ts";
import { costCeiling } from "../runtime-config.ts";
import type { BillableUsage, BillingRates } from "./usage.ts";
import { billableRecord, priceUsage } from "./usage.ts";
import { normalizeUsage } from "../providers/usage-dialects.ts";
import type { CostCeiling, ModelPrice, RuntimeConfig } from "../runtime-config.ts";

/* ────────────────────────────────────────────────── what a caller gets back */

export type BudgetOperation = "authorization" | "reservation" | "settlement" | "release" | "spending stop" | "reading";

/* The database said no, and this is what it said. Every door in 059 refuses
   with a sentence rather than a code; the sentence is the thing a dispatcher
   has to act on and a person has to read, so it is carried whole. */
export class BudgetRefused extends Error {
  readonly operation: BudgetOperation;
  /* The attempt or workflow the refusal is about. */
  readonly subject: string;
  /* The refusal in the database's own words, with the engine's prefix taken
     off. Never a code, never a boolean. */
  readonly reason: string;
  readonly sqlState: string | null;
  constructor(operation: BudgetOperation, subject: string, reason: string, sqlState: string | null = null) {
    super(`core-v2 runtime: ${operation} refused for ${subject}: ${reason}`);
    this.name = "BudgetRefused";
    this.operation = operation;
    this.subject = subject;
    this.reason = reason;
    this.sqlState = sqlState;
  }
}

export function isBudgetRefused(error: unknown): error is BudgetRefused {
  return error instanceof BudgetRefused;
}

/* What one workflow is allowed to spend, and the ceilings it may not cross
   whatever the money says. All of it operator-supplied: the engine writes
   this row once and never widens it. */
export type WorkflowAuthorization = {
  workflowId: string;
  organizationId: string;
  /* Three letters, upper case. Defaults to the currency of nothing: the
     caller states it, because a price and a budget in different currencies
     is not a comparison. */
  currency?: string;
  /* The most this whole workflow may cost. Zero is a real answer and the one
     every test runs at: nothing that costs anything may be sent. */
  authorizedMaximum: number;
  /* The most any single attempt may cost, however much the workflow has left. */
  maximumPerAttempt: number;
  maximumInputTokens?: number | null;
  maximumOutputTokens?: number | null;
  /* How many attempts this workflow may reserve for at all. */
  maximumAttempts?: number | null;
  /* How many may be holding a reservation at one moment. */
  maximumConcurrentAttempts?: number | null;
  /* After this moment nothing further is sent. */
  wallClockDeadline?: Date | string | null;
};

export type ReservationState = "reserved" | "settled" | "released";

export type Reservation = {
  attemptId: string;
  organizationId: string;
  workflowId: string;
  state: ReservationState;
  /* The most it could cost, priced from the ceilings it was sent with. */
  reservedCost: number;
  reservedInputTokens: number;
  reservedOutputTokens: number;
  /* What it did cost, priced from what the answering system reported. */
  settledCost: number | null;
  /* The provider's own usage object, exactly as it arrived. */
  usage: Record<string, unknown> | null;
  /* The same usage in billable components, and the version of the rules that
     produced them. Both are kept: one is evidence, the other is arithmetic. */
  normalizedUsage: Record<string, unknown> | null;
  normalizationVersion: string | null;
  /* Set when a settlement could not be worked out and the hold therefore
     stands. A person, or a later reconciliation, resolves it. */
  attentionReason: string | null;
  /* The operator's price at the moment the hold was taken, kept so that a
     price changed mid-run cannot change what an attempt cost. */
  priceBasis: PriceBasis | null;
  releaseReason: string | null;
  reservedAt: string;
  settledAt: string | null;
  releasedAt: string | null;
};

/* Everything needed to settle the attempt at the price it was reserved under,
   written into the reservation row at reserve time. */
export type PriceBasis = {
  provider_id: string;
  model: string;
  currency: string;
  effective_from: string;
  input_per_million_tokens: number;
  output_per_million_tokens: number;
  cached_input_per_million_tokens: number | null;
  cache_write_per_million_tokens: number | null;
  reasoning_per_million_tokens: number | null;
  maximum_input_tokens: number;
  maximum_output_tokens: number;
  /* HOW THE HOLD WAS ARRIVED AT, not only what it was. The rates above settle
     the attempt; these three reproduce the reservation — the highest rate any
     billable component of each category could have been charged at, the rule
     that chose them, and the number they produced. Without them a reader can
     check what an attempt cost and cannot check that the hold was a real
     ceiling; with them both directions are arithmetic anyone can repeat. */
  ceiling_rule: string;
  ceiling_input_per_million_tokens: number;
  ceiling_output_per_million_tokens: number;
  maximum_cost: number;
};

export type BudgetState = {
  workflowId: string;
  organizationId: string;
  currency: string;
  /* What the operator authorised. */
  authorized: number;
  maximumPerAttempt: number;
  /* What attempts that may still be running are holding. */
  held: number;
  /* What finished attempts cost. */
  spent: number;
  /* authorised − held − spent. Negative is possible and is not hidden: an
     answer that cost more than was held is recorded at what it cost, and the
     shortfall is a fact about the run rather than something to round away. */
  remaining: number;
  maximumInputTokens: number | null;
  maximumOutputTokens: number | null;
  maximumAttempts: number | null;
  maximumConcurrentAttempts: number | null;
  heldInputTokens: number;
  heldOutputTokens: number;
  wallClockDeadline: string | null;
  stoppedReason: string | null;
  stoppedAt: string | null;
};

/* ────────────────────────────────────────────────────────── small readings */

const num = (value: string | null, fallback = 0): number => (value === null ? fallback : Number(value));
const maybeNum = (value: string | null): number | null => (value === null ? null : Number(value));

/* numeric(14,6) on the far side, so six decimal places is the whole of the
   precision there is. Both costCeiling and settledCost already round to six;
   this fixes the text so a small number never travels as an exponent. */
function money(value: number, what: string): string {
  if (!Number.isFinite(value) || value < 0) throw new Error(`core-v2 runtime: ${what} must be a number that is not negative`);
  return value.toFixed(6);
}

function whole(value: number | null | undefined, what: string): string | null {
  if (value === null || value === undefined) return null;
  if (!Number.isFinite(value) || value < 0 || Math.trunc(value) !== value) {
    throw new Error(`core-v2 runtime: ${what} must be a whole number that is not negative`);
  }
  return String(value);
}

function moment(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const at = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(at.getTime())) throw new Error("core-v2 runtime: a deadline must be a moment");
  return at.toISOString();
}

function parseJson(value: string | null): Record<string, unknown> | null {
  if (value === null) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch { return null; }
}

function toReservation(row: Row): Reservation {
  return {
    attemptId: row.attempt_id ?? "",
    organizationId: row.organization_id ?? "",
    workflowId: row.workflow_id ?? "",
    state: (row.state ?? "reserved") as ReservationState,
    reservedCost: num(row.reserved_cost),
    reservedInputTokens: num(row.reserved_input_tokens),
    reservedOutputTokens: num(row.reserved_output_tokens),
    settledCost: maybeNum(row.settled_cost),
    normalizedUsage: row.normalized_usage ? JSON.parse(row.normalized_usage) as Record<string, unknown> : null,
    normalizationVersion: row.normalization_version,
    attentionReason: row.attention_reason,
    usage: parseJson(row.usage),
    priceBasis: parseJson(row.price_basis) as PriceBasis | null,
    releaseReason: row.release_reason,
    reservedAt: row.reserved_at ?? "",
    settledAt: row.settled_at,
    releasedAt: row.released_at,
  };
}

function toBudget(row: Row): BudgetState {
  const authorized = num(row.authorized_maximum);
  const held = num(row.reserved);
  const spent = num(row.settled);
  return {
    workflowId: row.workflow_id ?? "",
    organizationId: row.organization_id ?? "",
    currency: row.currency ?? "",
    authorized,
    maximumPerAttempt: num(row.maximum_per_attempt),
    held,
    spent,
    remaining: Math.round((authorized - held - spent) * 1e6) / 1e6,
    maximumInputTokens: maybeNum(row.maximum_input_tokens),
    maximumOutputTokens: maybeNum(row.maximum_output_tokens),
    maximumAttempts: maybeNum(row.maximum_attempts),
    maximumConcurrentAttempts: maybeNum(row.maximum_concurrent_attempts),
    heldInputTokens: num(row.reserved_input_tokens),
    heldOutputTokens: num(row.reserved_output_tokens),
    wallClockDeadline: row.wall_clock_deadline,
    stoppedReason: row.stopped_reason,
    stoppedAt: row.stopped_at,
  };
}

/* A refusal from a door, or a refusal from the row invariant those doors
   exist to keep, becomes a typed error. Anything else — a missing function,
   a broken connection — is not a budget decision and is left alone, because
   dressing it as one would tell a dispatcher to give up on a run when what
   it should do is fail loudly. */
const REFUSING_SQLSTATES = new Set(["23514", "23505", "23502", "23503", "P0001"]);

function asRefusal(operation: BudgetOperation, subject: string, error: unknown): never {
  if (isPostgresError(error)) {
    const spoken = error.message.startsWith("core_v2:");
    if (spoken || REFUSING_SQLSTATES.has(error.code)) {
      let reason = error.message.replace(/^core_v2:\s*/, "");
      reason = reason.replace(/^(reservation|settlement|release) refused:\s*/, "");
      if (error.constraint === "workflow_cost_budgets_within_authorization") {
        reason = `${reason} — held plus spent may never exceed what was authorised`;
      }
      throw new BudgetRefused(operation, subject, reason, error.code);
    }
  }
  throw error;
}

/* ──────────────────────────────────────────────────────────── the ceiling */

/* The most an attempt could cost, priced from the ceilings the request will
   carry: the provider configuration's own input and output token ceilings,
   each at the highest rate any billable component of that category could be
   charged at. Null when the operator prices nothing for this model, or prices
   it in a way that establishes no upper bound — which is the whole of the
   answer either way: no ceiling, no reservation; no reservation, nothing
   sent. */
export function ceilingFor(config: RuntimeConfig, providerId: string, model: string, at?: Date): CostCeiling | null {
  const provider = config.providers.find((p) => p.providerId === providerId);
  if (!provider) return null;
  return costCeiling(config, providerId, model, provider.maximumInputTokens, provider.maximumOutputTokens, at);
}

function basisOf(ceiling: CostCeiling): PriceBasis {
  const price: ModelPrice = ceiling.basis;
  return {
    provider_id: ceiling.providerId,
    model: ceiling.model,
    currency: ceiling.currency,
    effective_from: price.effectiveFrom,
    input_per_million_tokens: price.inputPerMillionTokens,
    output_per_million_tokens: price.outputPerMillionTokens,
    cached_input_per_million_tokens: price.cachedInputPerMillionTokens ?? null,
    cache_write_per_million_tokens: price.cacheWritePerMillionTokens ?? null,
    reasoning_per_million_tokens: price.reasoningPerMillionTokens ?? null,
    maximum_input_tokens: ceiling.maximumInputTokens,
    maximum_output_tokens: ceiling.maximumOutputTokens,
    ceiling_rule: ceiling.rule,
    ceiling_input_per_million_tokens: ceiling.ceilingInputPerMillionTokens,
    ceiling_output_per_million_tokens: ceiling.ceilingOutputPerMillionTokens,
    maximum_cost: ceiling.maximumCost,
  };
}

/* ───────────────────────────────────────────────────────────── the ledger */

export class BudgetLedger {
  private readonly db: Queryable;
  private readonly config: RuntimeConfig;

  /* Any Queryable: the connection, or the transaction of one. A dispatcher
     that wants its reservation to stand or fall with the rest of a unit of
     work builds a ledger over the transaction. */
  constructor(db: Queryable, config: RuntimeConfig) {
    this.db = db;
    this.config = config;
  }

  /* THE SAME LEDGER, WRITING ON SOMEBODY ELSE'S UNIT OF WORK. Used when a
     hold has to stand or fall with a move the record is making — a
     reservation and the submission it pays for are one thing, and a
     reservation written through a second connection would survive the
     rollback of the first. Same configuration, same rules, different
     handle. */
  on(db: Queryable): BudgetLedger {
    return new BudgetLedger(db, this.config);
  }

  /* WHAT A RUN IS ALLOWED TO SPEND. Operator configuration, written once.
     Asking again with the same numbers is the same authorisation; asking with
     different ones is refused, because the engine does not widen a budget. */
  async authorizeWorkflow(authorization: WorkflowAuthorization): Promise<BudgetState> {
    const existing = await this.budget(authorization.workflowId);
    if (existing) {
      const same = existing.authorized === authorization.authorizedMaximum
        && existing.maximumPerAttempt === authorization.maximumPerAttempt
        && existing.maximumInputTokens === (authorization.maximumInputTokens ?? null)
        && existing.maximumOutputTokens === (authorization.maximumOutputTokens ?? null)
        && existing.maximumAttempts === (authorization.maximumAttempts ?? null)
        && existing.maximumConcurrentAttempts === (authorization.maximumConcurrentAttempts ?? null);
      if (same) return existing;
      throw new BudgetRefused("authorization", authorization.workflowId,
        `workflow ${authorization.workflowId} is already authorised for ${existing.authorized} ${existing.currency}; a budget is not rewritten by the engine`);
    }
    try {
      /* Through the door, like every other write to these tables. The
         organisation is not passed: the door reads it off the workflow, so a
         budget cannot be filed under an organisation that does not own the
         run it pays for. */
      const result = await this.db.query(
        `select (public.core_v2_authorize_workflow_spending(
           $1, $2::numeric, $3::numeric, $4, $5::bigint, $6::bigint, $7::int, $8::int, $9::timestamptz)).*`,
        [
          authorization.workflowId,
          money(authorization.authorizedMaximum, "an authorised maximum"),
          money(authorization.maximumPerAttempt, "a per-attempt maximum"),
          (authorization.currency ?? "USD").toUpperCase(),
          whole(authorization.maximumInputTokens, "an input-token ceiling"),
          whole(authorization.maximumOutputTokens, "an output-token ceiling"),
          whole(authorization.maximumAttempts, "an attempt ceiling"),
          whole(authorization.maximumConcurrentAttempts, "a concurrency ceiling"),
          moment(authorization.wallClockDeadline),
        ],
      );
      return toBudget(result.rows[0]);
    } catch (error) {
      return asRefusal("authorization", authorization.workflowId, error);
    }
  }

  /* THE HOLD, TAKEN BEFORE ANYTHING IS SENT, FOR THE MOST IT COULD COST.
     The ceiling comes from costCeiling(): the ceilings the request will carry
     at the operator's full rates. A null ceiling is an unpriced model, and an
     unpriced model cannot be reserved for at all. */
  async reserve(attemptId: string, ceiling: CostCeiling | null): Promise<Reservation> {
    if (!ceiling) {
      throw new BudgetRefused("reservation", attemptId,
        "the operator's configuration prices nothing for what this attempt would ask, so it has no ceiling and no reservation can be taken for it");
    }
    try {
      const result = await this.db.query(
        `select * from public.core_v2_reserve_attempt_cost($1, $2::numeric, $3::bigint, $4::bigint, $5::jsonb)`,
        [
          attemptId,
          money(ceiling.maximumCost, "a maximum cost"),
          whole(ceiling.maximumInputTokens, "an input ceiling"),
          whole(ceiling.maximumOutputTokens, "an output ceiling"),
          JSON.stringify(basisOf(ceiling)),
        ],
      );
      return toReservation(result.rows[0]);
    } catch (error) {
      return asRefusal("reservation", attemptId, error);
    }
  }

  /* WHAT IT REALLY COST, from what the answering system reported and from the
     price the hold was taken under — not from whatever the configuration says
     today, because a price that changed mid-run does not change what an
     attempt cost. Counts the provider did not report are counted at zero
     rather than guessed, and the usage is kept beside the number so a dispute
     is settled from what arrived. */
  async settle(attemptId: string, usage: Record<string, unknown>): Promise<Reservation> {
    const held = await this.reservationOf(attemptId);
    if (!held) throw new BudgetRefused("settlement", attemptId, `attempt ${attemptId} reserved nothing`);
    /* Already settled is already settled. What it cost was worked out once,
       from what arrived then; asking again with different numbers does not
       re-price it and does not charge a second time. */
    if (held.state === "settled") return held;
    const basis = held.priceBasis;
    if (!basis || !basis.provider_id || !basis.model) {
      throw new BudgetRefused("settlement", attemptId,
        `the reservation for attempt ${attemptId} records no price it was taken under, so what it cost cannot be worked out`);
    }

    /* THE PRICE COMES FROM THE RESERVATION, NOT FROM THE CONFIGURATION.
       The rates were copied onto the row when the hold was taken, and they
       are what this attempt is settled at — whatever the operator has
       changed, added or removed since, and even if the model has been
       deleted from the configuration entirely. A price that changed after a
       hold was taken does not change what that attempt cost. */
    const rates: BillingRates = {
      currency: basis.currency,
      inputPerMillionTokens: basis.input_per_million_tokens,
      outputPerMillionTokens: basis.output_per_million_tokens,
      cachedInputPerMillionTokens: basis.cached_input_per_million_tokens,
      cacheWritePerMillionTokens: basis.cache_write_per_million_tokens,
      reasoningPerMillionTokens: basis.reasoning_per_million_tokens,
    };
    const billable: BillableUsage = normalizeUsage(basis.provider_id, usage);
    const priced = priceUsage(rates, billable);
    if (!priced.ok) {
      /* An unknown is not a zero. The hold stands and the attempt is marked
         for somebody to resolve; settling at nothing here would be the
         engine quietly deciding that a call it cannot account for was free. */
      throw new BudgetRefused("settlement", attemptId,
        `what attempt ${attemptId} cost cannot be worked out: ${priced.problems.join("; ")}`);
    }

    try {
      const result = await this.db.query(
        `select * from public.core_v2_settle_attempt_cost($1, $2::numeric, $3::jsonb, $4::jsonb, $5::text)`,
        [
          attemptId,
          money(priced.cost, "an actual cost"),
          JSON.stringify(usage ?? {}),
          JSON.stringify({ ...billableRecord(billable), notes: priced.notes }),
          billable.version,
        ],
      );
      return toReservation(result.rows[0]);
    } catch (error) {
      return asRefusal("settlement", attemptId, error);
    }
  }

  /* THE HOLD STANDS, AND THE RECORD SAYS WHY. For an attempt whose cost
     cannot be worked out — no usage reported, a dialect nobody has written,
     a component the operator did not price. Not a settlement, because the
     number is not known; not a release, because the money may be gone. */
  async flagForAttention(attemptId: string, reason: string): Promise<Reservation> {
    try {
      const result = await this.db.query(
        `select * from public.core_v2_attempt_cost_needs_attention($1, $2)`, [attemptId, reason]);
      return toReservation(result.rows[0]);
    } catch (error) {
      return asRefusal("settlement", attemptId, error);
    }
  }

  /* GIVE THE HOLD BACK — and only the database decides whether that is
     allowed. An attempt that reached anything, or one whose outcome nobody
     knows, keeps holding, because the money may already be gone. */
  async release(attemptId: string, reason: string): Promise<Reservation> {
    try {
      const result = await this.db.query(
        `select * from public.core_v2_release_attempt_cost($1, $2)`, [attemptId, reason]);
      return toReservation(result.rows[0]);
    } catch (error) {
      return asRefusal("release", attemptId, error);
    }
  }

  /* STOP SPENDING, AND SAY WHY. The first reason stands. */
  async stop(workflowId: string, reason: string): Promise<BudgetState> {
    try {
      const result = await this.db.query(
        `select * from public.core_v2_stop_workflow_spending($1, $2)`, [workflowId, reason]);
      return toBudget(result.rows[0]);
    } catch (error) {
      return asRefusal("spending stop", workflowId, error);
    }
  }

  /* ─────────────────────────────────────────────── what the ledger says now */

  async budget(workflowId: string): Promise<BudgetState | null> {
    try {
      const result = await this.db.query(
        `select * from public.workflow_cost_budgets where workflow_id = $1`, [workflowId]);
      return result.rows.length ? toBudget(result.rows[0]) : null;
    } catch (error) {
      return asRefusal("reading", workflowId, error);
    }
  }

  async reservationOf(attemptId: string): Promise<Reservation | null> {
    try {
      const result = await this.db.query(
        `select * from public.attempt_cost_reservations where attempt_id = $1`, [attemptId]);
      return result.rows.length ? toReservation(result.rows[0]) : null;
    } catch (error) {
      return asRefusal("reading", attemptId, error);
    }
  }

  /* The four numbers a person asks for, in one reading, so they cannot
     disagree with each other. A workflow with no authorised budget is not
     zero — it is nothing, and nothing that costs anything may be sent for it. */
  async standing(workflowId: string): Promise<{ authorized: number; held: number; spent: number; remaining: number; stoppedReason: string | null } | null> {
    const budget = await this.budget(workflowId);
    if (!budget) return null;
    return { authorized: budget.authorized, held: budget.held, spent: budget.spent, remaining: budget.remaining, stoppedReason: budget.stoppedReason };
  }

  async authorized(workflowId: string): Promise<number | null> { return (await this.budget(workflowId))?.authorized ?? null; }
  async held(workflowId: string): Promise<number | null> { return (await this.budget(workflowId))?.held ?? null; }
  async spent(workflowId: string): Promise<number | null> { return (await this.budget(workflowId))?.spent ?? null; }
  async remaining(workflowId: string): Promise<number | null> { return (await this.budget(workflowId))?.remaining ?? null; }

  /* The attempts of this workflow that may still be running, which is what
     the concurrency ceiling counts. */
  async openReservations(workflowId: string): Promise<Reservation[]> {
    try {
      const result = await this.db.query(
        `select * from public.attempt_cost_reservations where workflow_id = $1 and state = 'reserved' order by reserved_at`, [workflowId]);
      return result.rows.map(toReservation);
    } catch (error) {
      return asRefusal("reading", workflowId, error);
    }
  }
}
