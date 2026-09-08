/* THE MONEY, PUT ON THE PATH THE WORK ACTUALLY TAKES.
 *
 * A ledger nobody calls is a spreadsheet. The reservation has to be taken at
 * the one moment that matters — after the engine has decided what it is about
 * to send and before it sends it — and the settlement has to happen where the
 * answer is written down, or a crash between the two loses the only record of
 * what was spent.
 *
 * The kernel cannot do either. It does not know that answering costs money,
 * and it must not learn: the engine reasons about evidence, and a universal
 * engine that priced its readers would be a client of whoever it priced. But
 * the kernel does hand every attempt through one door on its way out — the
 * record — and the runtime decides which record a dispatcher is given. So the
 * money lives in a decorator over the record:
 *
 *   · submitAttempt is the last thing that happens before anything is sent.
 *     A hold for the most this attempt could cost is taken there, atomically,
 *     in the database; if the hold is refused, the submission is refused and
 *     nothing leaves the process;
 *   · an attempt that is cancelled or rejected before submission gives its
 *     hold back, because nothing was sent and nothing can have been charged;
 *   · commitValidatedResult is where the answer is written down, so it is
 *     where the hold becomes a settlement — priced from what the answering
 *     system actually reported, never from what was expected;
 *   · an attempt whose outcome nobody knows settles nothing and releases
 *     nothing. The money may already be gone, and a hold that comes off on a
 *     guess is how a run quietly oversubscribes itself.
 *
 * Code costs nothing, so a deterministic attempt reserves nothing. Everything
 * else the record does, it goes on doing untouched: this decorator overrides
 * three methods and inherits the rest, so a method nobody thought about here
 * cannot silently behave differently because of it.
 */
import type { OrchestrationRepository, ResultCommit, SubmitOutcome } from "../../core-v2/kernel/repository.ts";
import type { AttemptRecord, AttemptState, ProviderFacts } from "../../core-v2/kernel/contracts.ts";
import type { CommitOutcome } from "../../core-v2/kernel/repository.ts";
import type { RuntimeConfig } from "../runtime-config.ts";
import type { BudgetLedger } from "./ledger.ts";
import { ceilingFor, isBudgetRefused } from "./ledger.ts";

export type MeterEvent = {
  event: "budget.reserved" | "budget.settled" | "budget.released" | "budget.refused"
  | "budget.settlement_refused" | "budget.release_refused" | "budget.holds" | "budget.needs_attention";
  attempt?: string;
  workflow?: string;
  provider?: string;
  model?: string;
  amount?: number;
  reason?: string;
};

export type MeterOptions = {
  ledger: BudgetLedger;
  config: RuntimeConfig;
  /* Which provider serves a family, from the same routing the executors were
     built with. A family this does not know is a family nothing can be
     reserved for, and an attempt nothing can be reserved for is not sent. */
  providerOfFamily: (family: string) => string | null;
  /* Which model each provider is being asked for, when not its configured
     default. The hold must be priced at the model that will actually be
     asked, or it is a hold for a different question. */
  models?: Record<string, string>;
  now?: () => number;
  events?: (event: MeterEvent) => void;
};

/* An attempt that never left this process. Its hold is given back rather than
   settled at zero, because "it cost nothing" and "it was never sent" are
   different facts and the record should say which. */
const UNSENT: AttemptState[] = ["cancelled_before_submission", "rejected_before_submission"];

export function meteredRepository(inner: OrchestrationRepository, options: MeterOptions): OrchestrationRepository {
  const { ledger, config } = options;
  const now = options.now ?? (() => Date.now());
  const emit = (event: MeterEvent) => { if (options.events) options.events(event); };

  const modelFor = (providerId: string): string | null => {
    const provider = config.providers.find((p) => p.providerId === providerId);
    if (!provider) return null;
    return options.models?.[providerId] ?? provider.defaultModel;
  };

  /* A refusal that will refuse again forever is a run that has to stop being
     asked. Whether this is one is read off the budget row, not off the
     sentence: the money is gone, or the time is. Anything else — a
     concurrency ceiling, an attempt already holding — passes and is refused
     again next tick, which is what a ceiling is for. */
  const stopIfSpent = async (workflowId: string, reason: string): Promise<void> => {
    try {
      const budget = await ledger.budget(workflowId);
      if (!budget || budget.stoppedReason !== null) return;
      const spent = budget.remaining <= 0;
      const late = budget.wallClockDeadline !== null && Date.parse(budget.wallClockDeadline) <= now();
      if (spent || late) await ledger.stop(workflowId, reason);
    } catch (error) {
      emit({ event: "budget.refused", workflow: workflowId, reason: messageOf(error) });
    }
  };

  /* Whether anything can have been charged for this attempt: an identifier
     from the provider, a count it reported, or an answer it sent. Silence is
     read as "nothing arrived", which is only ever asserted for an attempt the
     engine has already classified as a known failure. */
  const reachedSomebody = (facts: ProviderFacts | undefined): boolean => {
    if (!facts) return false;
    if (typeof facts.requestId === "string" && facts.requestId.length > 0) return true;
    if (facts.response !== undefined && facts.response !== null) return true;
    return Object.keys(facts.usage ?? {}).length > 0;
  };

  const release = async (attemptId: string, reason: string): Promise<void> => {
    const held = await ledger.reservationOf(attemptId).catch(() => null);
    if (!held || held.state !== "reserved") return;
    try {
      await ledger.release(attemptId, reason);
      emit({ event: "budget.released", attempt: attemptId, workflow: held.workflowId, amount: held.reservedCost, reason });
    } catch (error) {
      emit({ event: "budget.release_refused", attempt: attemptId, workflow: held.workflowId, reason: messageOf(error) });
    }
  };

  const settle = async (attemptId: string, usage: Record<string, unknown>): Promise<void> => {
    const held = await ledger.reservationOf(attemptId).catch(() => null);
    if (!held || held.state !== "reserved") return;
    try {
      const settled = await ledger.settle(attemptId, usage);
      emit({ event: "budget.settled", attempt: attemptId, workflow: held.workflowId, amount: settled.settledCost ?? 0 });
    } catch (error) {
      /* The hold stands, and the row says why. That is the conservative
         direction — an unsettled reservation holds money a run cannot spend
         twice — and it is findable: openReservations() and the attention
         reason are the operator's list of them. Settling at zero here would
         be the engine deciding that a call it cannot account for was free. */
      const reason = messageOf(error);
      emit({ event: "budget.settlement_refused", attempt: attemptId, workflow: held.workflowId, reason });
      try {
        await ledger.flagForAttention(attemptId, reason);
        emit({ event: "budget.needs_attention", attempt: attemptId, workflow: held.workflowId, reason });
      } catch (second) {
        emit({ event: "budget.settlement_refused", attempt: attemptId, workflow: held.workflowId, reason: messageOf(second) });
      }
    }
  };

  /* Prototype delegation rather than forty forwarders written by hand: what
     is not named below is the record's own method, unchanged and unwrapped,
     and cannot drift from it. */
  const metered: OrchestrationRepository = Object.create(inner) as OrchestrationRepository;

  metered.submitAttempt = async (attemptId: string, leaseToken: string, at: number): Promise<SubmitOutcome> => {
    const attempt: AttemptRecord | null = await inner.getAttempt(attemptId);
    /* Code is free. It reserves nothing, holds nothing, and settles nothing. */
    if (attempt && attempt.executorKind === "model") {
      const providerId = options.providerOfFamily(attempt.executorFamily);
      const model = providerId ? modelFor(providerId) : null;
      if (!providerId || !model) {
        return { ok: false, reason: `no configured provider serves ${attempt.executorFamily}, so nothing can be reserved for this attempt and nothing is sent` };
      }
      try {
        const held = await ledger.reserve(attemptId, ceilingFor(config, providerId, model));
        emit({ event: "budget.reserved", attempt: attemptId, workflow: attempt.workflowId, provider: providerId, model, amount: held.reservedCost });
      } catch (error) {
        if (!isBudgetRefused(error)) throw error;
        emit({ event: "budget.refused", attempt: attemptId, workflow: attempt.workflowId, provider: providerId, model, reason: error.reason });
        await stopIfSpent(attempt.workflowId, error.reason);
        return { ok: false, reason: `budget refused: ${error.reason}` };
      }
    }
    return inner.submitAttempt(attemptId, leaseToken, at);
  };

  metered.transitionAttempt = async (attemptId: string, from: AttemptState, to: AttemptState, patch?: { errorCode?: string | null; errorMessage?: string | null; usage?: Record<string, unknown> }): Promise<AttemptRecord> => {
    const moved = await inner.transitionAttempt(attemptId, from, to, patch);
    if (UNSENT.includes(to)) await release(attemptId, patch?.errorCode ?? `the attempt ended ${to}`);
    return moved;
  };

  metered.commitValidatedResult = async (commit: ResultCommit): Promise<CommitOutcome> => {
    /* The record first, always. Money follows the fact; a settlement written
       before the result it settles would survive a commit that did not. */
    const outcome = await inner.commitValidatedResult(commit);
    const facts = commit.attempt.providerFacts;
    if (commit.attempt.to === "outcome_unknown") {
      /* Nothing. Not a settlement, because what it cost is not known; not a
         release, because the money may already be gone. The hold stands until
         somebody reconciles the attempt, which is exactly what 059 enforces. */
      emit({ event: "budget.holds", attempt: commit.attemptId, workflow: commit.workflowId, reason: "the outcome is unknown, so the hold stands" });
      return outcome;
    }
    if (commit.attempt.to === "failed_known" && !reachedSomebody(facts)) {
      await release(commit.attemptId, commit.attempt.errorCode ?? "the attempt failed without reaching anybody");
      return outcome;
    }
    await settle(commit.attemptId, (facts?.usage ?? {}) as Record<string, unknown>);
    return outcome;
  };

  return metered;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
