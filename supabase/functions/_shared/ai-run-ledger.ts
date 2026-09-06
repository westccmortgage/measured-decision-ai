/* AI COST GUARD — the one place a paid call is claimed, recorded and closed.
 *
 * Every process that spends money goes through here, so that "how many times
 * did we pay, and for what" has a single answer rather than five.
 *
 * The fingerprint is the whole mechanism. Two runs are the same purchase when
 * every input that can change the answer is the same: the project, the
 * process, the exact files and their versions, the requirements the reading
 * is measured against, the model, the prompt contract, and any setting that
 * steers the reading. Order must never matter — the same evidence selected in
 * a different order is the same evidence — so every list is sorted before it
 * is hashed.
 *
 * What is deliberately NOT in here: prices. Nothing in this file knows what a
 * token costs, and a number invented here would be presented to somebody as
 * money.
 */

export type AiProcessKey =
  | "plan-analyze"
  | "spatial-analyze"
  | "document-classify"
  | "document-evidence"
  | "field-quality-check";

export type FingerprintParts = {
  organizationId: string;
  propertyId?: string | null;
  processKey: AiProcessKey;
  model: string;
  contractVersion: string;
  /* Files, evidence, documents — anything the reading is OF. Each entry
     should carry its own version or updated_at where one exists, so a
     re-uploaded file under the same id is a different purchase. */
  inputs?: Array<string | null | undefined>;
  /* What the reading is measured AGAINST: requirement ids with versions. */
  requirements?: Array<string | null | undefined>;
  /* Anything else that steers the answer — profile, profile version, page
     selection, chunk index. Keys are sorted, so declaration order is free. */
  settings?: Record<string, unknown>;
};

/* Stable across machines and runs: sorted lists, sorted keys, no timestamps
   of its own, and a version tag so a future change to the recipe cannot be
   mistaken for unchanged inputs. */
const FINGERPRINT_RECIPE = "v1";

function normaliseList(values: Array<string | null | undefined> | undefined) {
  return [...new Set((values || []).map((v) => String(v ?? "").trim()).filter(Boolean))].sort();
}

function normaliseSettings(settings: Record<string, unknown> | undefined) {
  const entries = Object.entries(settings || {})
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .map(([key, value]) => [key, typeof value === "object" ? JSON.stringify(value) : String(value)] as const);
  entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return entries.map(([key, value]) => `${key}=${value}`);
}

export async function buildFingerprint(parts: FingerprintParts): Promise<string> {
  const canonical = JSON.stringify({
    recipe: FINGERPRINT_RECIPE,
    org: parts.organizationId,
    project: parts.propertyId || "",
    process: parts.processKey,
    model: parts.model,
    contract: parts.contractVersion,
    inputs: normaliseList(parts.inputs),
    requirements: normaliseList(parts.requirements),
    settings: normaliseSettings(parts.settings),
  });
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export type ClaimVerdict = "CLAIMED" | "RUNNING" | "REUSED" | "UNKNOWN";

/* How a run ended, from the only angle that matters for money.
 *
 *   succeeded        the result is in our hands
 *   failed           the work demonstrably did not happen
 *   outcome_unknown  it left the building and we cannot say what happened
 *
 * There is no fourth option and no default. A worker that cannot tell the
 * difference must say outcome_unknown, because the cost of a needless
 * confirmation is a question, and the cost of a wrong "failed" is an invoice. */
export type RunOutcome = "succeeded" | "failed" | "outcome_unknown";

export type Claim = {
  verdict: ClaimVerdict;
  runId: string | null;
  previousRunId: string | null;
};

/* Ask the database — never the caller — whether this call may be made.
 *
 * A failure to reach the ledger must not silently become a free pass to spend
 * money, and must not block a reading either. It throws, and each worker
 * decides; every worker here treats it as "do not spend".
 */
export async function claimAiRun(
  admin: { rpc: (name: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }> },
  parts: FingerprintParts & {
    fingerprint?: string;
    jobTable?: string | null;
    jobId?: string | null;
    transport?: string | null;
    force?: boolean;
  },
): Promise<Claim & { fingerprint: string }> {
  const fingerprint = parts.fingerprint || (await buildFingerprint(parts));
  const { data, error } = await admin.rpc("claim_ai_run", {
    p_organization_id: parts.organizationId,
    p_property_id: parts.propertyId || null,
    p_process_key: parts.processKey,
    p_model: parts.model,
    p_contract_version: parts.contractVersion,
    p_input_fingerprint: fingerprint,
    p_job_table: parts.jobTable || null,
    p_job_id: parts.jobId || null,
    p_transport: parts.transport || null,
    p_force: Boolean(parts.force),
  });
  if (error) throw new Error(`AI run could not be claimed: ${(error as { message?: string }).message || error}`);
  const row = (Array.isArray(data) ? data[0] : data) as
    | { verdict: ClaimVerdict; run_id: string | null; previous_run_id: string | null }
    | undefined;
  if (!row) throw new Error("AI run could not be claimed: the ledger returned nothing");
  return {
    verdict: row.verdict,
    runId: row.run_id || null,
    previousRunId: row.previous_run_id || null,
    fingerprint,
  };
}

/* THE PART THAT DECIDES WHETHER WE MIGHT HAVE BEEN BILLED.
 *
 * A worker walks this in order and never guesses:
 *
 *   new RunProgress()   nothing sent yet — a failure here is `failed`
 *   .sent()             the request is on the wire — from this instant a
 *                       failure is `outcome_unknown`, because a reading may
 *                       have been performed and billed
 *   .refused()          the provider answered with a definite non-result
 *                       (a 4xx validation error, a terminal job status) — the
 *                       work did not happen, so `failed` again
 *   .answered()         a complete result is in hand — `succeeded`, and it
 *                       STAYS succeeded however badly the rest of the request
 *                       goes. A failure to save something we already bought is
 *                       a reason to retry the save, never the purchase.
 *
 * That last transition is the whole of requirement three: after .answered()
 * the outcome no longer moves, so a database error while recording the answer
 * cannot turn a paid reading back into something a retry would buy again. */
export class RunProgress {
  #outcome: RunOutcome = "failed";
  #answered = false;

  sent() {
    if (!this.#answered) this.#outcome = "outcome_unknown";
    return this;
  }

  /* The provider spoke and said no reading was made. */
  refused() {
    if (!this.#answered) this.#outcome = "failed";
    return this;
  }

  answered() {
    this.#answered = true;
    this.#outcome = "succeeded";
    return this;
  }

  get held() {
    return this.#answered;
  }

  outcome(): RunOutcome {
    return this.#outcome;
  }
}

/* An HTTP response is evidence about what happened, and the status says which
 * kind. A request the provider rejected before reading anything cost nothing;
 * a 5xx or a 429 may have been raised after the work was done, and a body we
 * could not read tells us nothing at all. */
export function outcomeForStatus(status: number): RunOutcome {
  if (status >= 200 && status < 300) return "succeeded";
  /* 408 and 429 are explicitly not in here: a timeout and a rate-limit rejection
     can both arrive after a reading was performed. */
  if (status === 400 || status === 401 || status === 403 || status === 404 || status === 422) {
    return "failed";
  }
  return "outcome_unknown";
}

/* Whatever the provider said about usage, as it said it.
 *
 * Providers name these fields differently and add new ones. Three are lifted
 * out because they are what a person reads; the rest is kept whole. A
 * provider that returns no usage at all leaves the run recorded and marked as
 * usage-unavailable — never a thrown error, because losing a paid reading
 * over a missing token count would be the worst trade in this file. */
export function usageFrom(payload: unknown): Record<string, unknown> {
  const usage = (payload as { usage?: Record<string, unknown> })?.usage;
  if (!usage || typeof usage !== "object") return {};
  return usage as Record<string, unknown>;
}

export async function finishAiRun(
  admin: { rpc: (name: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }> },
  runId: string | null,
  state: RunOutcome,
  usage: Record<string, unknown> = {},
  errorCode: string | null = null,
) {
  if (!runId) return;
  /* Closing the ledger must never be the thing that fails a workflow: the
     reading is bought and delivered either way. An unclosed row stays
     'running' and blocks a duplicate, which is the safe direction to fail. */
  try {
    await admin.rpc("finish_ai_run", {
      p_run_id: runId,
      p_state: state,
      p_usage: usage || {},
      p_error_code: errorCode,
    });
  } catch (error) {
    console.error("finish_ai_run", error);
  }
}
