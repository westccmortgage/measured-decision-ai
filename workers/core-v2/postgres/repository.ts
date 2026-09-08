/* THE POSTGRES REPOSITORY: THE RECORD.
 *
 * One class, one connection, the tables of migration 058 and nothing else.
 * It promises exactly what the in-memory double promises — the same guards,
 * the same errors, the same idempotency, the same shapes — and where the
 * double restores a snapshot on failure, this one rolls a transaction back.
 * The database's own triggers stand behind every write; this adapter checks
 * first, in the double's order, so a refusal reads the same from either.
 *
 * Every compare-and-set transition is one UPDATE ... WHERE state = $from
 * RETURNING; zero rows means a stale view, and the row is read once more to
 * say whether it is missing or merely elsewhere. The kernel's transition
 * table is consulted before the UPDATE so an illegal move is refused as
 * IllegalTransition before the trigger ever sees it.
 *
 * Method → table / function
 *   createWorkflow              intelligence_workflows + workflow_sources + workflow_outbox
 *                               + audit_events: the rows core_v2_start_workflow writes,
 *                               inserted directly because the door draws its own id
 *   getWorkflow                 select intelligence_workflows
 *   transitionWorkflow          update intelligence_workflows where state = $from
 *                               (started_at / finished_at as core_v2_workflow_transition)
 *   updateWorkflowProgress      update intelligence_workflows (the three unit counters)
 *   requestCancel               update intelligence_workflows (cancel_requested_at, once)
 *   claimOutbox                 core_v2_claim_outbox, under the workflow row lock, created only
 *   acknowledgeOutbox           core_v2_acknowledge_outbox
 *   listSources                 select workflow_sources
 *   listSegments, getSegment    select source_segments
 *   persistSegments             insert source_segments (the identity index is the reuse key)
 *   transitionSegment           update source_segments where status = $from
 *   admitTasks                  insert workflow_tasks + task_sources + task_target_claims
 *                               + task_dependencies, workflow row locked for the budgets
 *   getTask, listTasks,         select workflow_tasks (+ task_sources, task_target_claims)
 *   getRunnableTasks
 *   getDependencies, getDependents   select task_dependencies
 *   addDependency               insert task_dependencies (+ queued → blocked)
 *   transitionTask              update workflow_tasks where state = $from
 *   leaseTask                   core_v2_lease_task, after reclaiming an expired unsent lease
 *   heartbeatLease              core_v2_heartbeat_lease
 *   releaseDependents           select + update workflow_tasks
 *   expireLeases                select + update workflow_tasks, agent_attempts
 *   listAttempts, getAttempt    select agent_attempts
 *   createAttempt               insert agent_attempts
 *   submitAttempt               core_v2_submit_attempt, rows locked, independence checked around it
 *   transitionAttempt           update agent_attempts where state = $from
 *                               (submitted_at / received_at / finished_at as core_v2_attempt_transition)
 *   independenceDomainsForSubject    select agent_attempts join workflow_tasks
 *   commitValidatedResult       all of the above, one transaction
 *   recordReconciliation        update agent_attempts.reconciliation_outcome, once,
 *                               and only while the attempt is outcome_unknown
 *   listClaims, getClaim        select evidence_claims (+ evidence_anchors, claim_inputs)
 *   transitionClaim             update evidence_claims where status = $from
 *   listAnchors, listAssessmentAnchors   select evidence_anchors
 *   listAssessments             select claim_assessments join agent_attempts
 *   getDisagreement, listDisagreements   select disagreements (+ disagreement_claims, disagreement_follow_ups)
 *   transitionDisagreement      update disagreements where state = $from
 *   holdSubject                 insert disagreements + disagreement_claims + decisions + update, one transaction
 *   applyDecision               insert decisions + decision_evidence + decision_actions (+ update status)
 *   listDecisions, getDecision  select decisions (+ decision_evidence, decision_actions)
 *   audit                       insert audit_events
 *   listAudit                   select audit_events where action like 'core_v2.%'
 *
 * Clocks. The contract passes epoch milliseconds; the columns are
 * timestamptz. Values that are stored (cancel_requested_at) use the caller's
 * time. Lease expiry is compared against the database's clock everywhere —
 * core_v2_lease_task, core_v2_heartbeat_lease and core_v2_submit_attempt use
 * now() internally, and expireLeases and the reclaim before a lease use the
 * same clock so that one record cannot hold two opinions about whether a
 * lease has run out.
 */
import type {
  AnchorRecord, AssessmentRecord, AttemptRecord, AttemptState, AuditRecord, ClaimRecord, ClaimStatus,
  DecisionRecord, DependencyKind, DependencyRecord, DisagreementRecord, ReconciliationOutcome, SegmentRecord, SegmentStatus,
  SourceDescriptor, TaskRecord, TaskState, WorkflowRecord, WorkflowState,
} from "../kernel/contracts.ts";
import { ACTIVE_WORKFLOW_STATES } from "../kernel/contracts.ts";
import { canonical, isUuid } from "../kernel/ids.ts";
import { locatorInside, locatorProblem } from "../kernel/locators.ts";
import type {
  Admission, AdmissionLimits, ClaimFilter, CommitOutcome, DecisionApplication, DisagreementTransition, HoldOutcome,
  NewAnchor, NewAssessment, NewClaim, NewDisagreement, NewSegment, NewTask, OrchestrationRepository, ResultCommit,
  SubjectHold, SubmitOutcome,
} from "../kernel/repository.ts";
import { taskPayload } from "../kernel/repository.ts";
import {
  IllegalTransition, SUBMITTED_ATTEMPT_STATES, StaleState, TERMINAL_ATTEMPT_STATES, TERMINAL_TASK_STATES,
  attemptMoveAllowed, claimMoveAllowed, decisionMoveAllowed, disagreementMoveAllowed, segmentMoveAllowed,
  taskMoveAllowed, workflowMoveAllowed,
} from "../kernel/transitions.ts";
import type { Param, Queryable, Row, WireClient } from "./wire.ts";
import { isPostgresError } from "./wire.ts";

const ZERO = "00000000-0000-0000-0000-000000000000";
/* Where a source's declared segments travel: the record has no column for
   them, so they ride inside `media` under this key and are split back out. */
const DECLARED_SEGMENTS = "core_v2.declared_segments";

export type PostgresRepositoryOptions = { organizationId?: string };

/* ───────────────────────────────────────────────────────── small helpers */

type Q = Queryable;

const ms = (column: string) => `(floor(extract(epoch from ${column}) * 1000))::bigint`;
const num = (v: string | null): number | null => (v === null ? null : Number(v));
const int = (v: string | null): number => (v === null ? 0 : Number(v));
const bool = (v: string | null): boolean => v === "t" || v === "true";
function json<T>(v: string | null, fallback: T): T { return v === null ? fallback : (JSON.parse(v) as T); }
const jsonParam = (v: unknown): string | null => (v === undefined || v === null ? null : JSON.stringify(v));
const uuids = (ids: string[]): string => `{${ids.filter(isUuid).map((id) => `"${id}"`).join(",")}}`;
const texts = (xs: string[]): string => `{${xs.map((x) => `"${x.replace(/\\/g, "\\\\").replace(/"/g, "\\\"")}"`).join(",")}}`;
const noSuch = (kind: string, id: string) => new Error(`core-v2: no ${kind} ${id}`);
const first = (rows: Row[]): Row | null => rows[0] ?? null;

function isCheckViolation(error: unknown, ...needles: string[]): boolean {
  return isPostgresError(error) && error.code === "23514" && needles.some((n) => error.message.includes(n));
}

/* ───────────────────────────────────────────────────────── column lists */

const WORKFLOW_COLUMNS = `w.id, w.organization_id, w.domain_pack, w.domain_pack_version, w.workflow_type, w.engine_version, w.state,
  w.source_set_fingerprint, w.request_fingerprint, w.requested_scope, w.budget, ${ms("w.cancel_requested_at")} as cancel_requested_at,
  w.total_units, w.completed_units, w.attention_units, w.error_code, w.error_message`;

const SOURCE_COLUMNS = `s.id, s.ordinal, s.source_kind, s.label, s.uri, s.content_hash, s.hash_algorithm, s.object_version_id, s.byte_size, s.media`;

const SEGMENT_COLUMNS = `s.id, s.workflow_id, s.source_id, s.parent_segment_id, s.segment_kind, s.label, s.ordinal, s.locator, s.content_hash,
  s.status, s.discovered_by, s.discovered_by_attempt_id`;

const TASK_COLUMNS = `t.id, t.workflow_id, t.parent_task_id, t.created_by_task_id, t.phase, t.task_type, t.role_key, t.role_version, t.subject_key,
  t.priority, t.input_fingerprint, t.contract_version, t.independence_group, t.depth, t.critic_round, t.arbiter_round, t.disagreement_id,
  t.max_claims, t.state, t.lease_owner, t.lease_token, ${ms("t.lease_expires_at")} as lease_expires_at, t.terminal_reason`;

const ATTEMPT_COLUMNS = `a.id, a.workflow_id, a.task_id, a.attempt_no, a.role_key, a.role_version, a.executor_kind, a.executor_family,
  a.independence_domain, a.model_configuration, a.state, a.lease_token, a.packet_fingerprint, a.packet_bytes, a.provider_request_id,
  a.model_reported, a.usage, a.raw_result, a.raw_result_hash, a.validation_state, a.validation_problems, a.error_code, a.error_message,
  a.reconciliation_outcome, a.provider_stop_reason, a.provider_duration_ms, a.provider_response`;

const CLAIM_COLUMNS = `c.id, c.workflow_id, c.task_id, c.attempt_id, c.independence_group, c.independence_domain, c.subject_type, c.subject_key,
  c.predicate, c.value, c.unit, c.observation_basis, c.scope, c.status, c.machine_confidence, c.supersedes_claim_id, c.incomplete_source_attempt`;

const ANCHOR_COLUMNS = `a.id, a.workflow_id, a.claim_id, a.assessment_id, a.source_kind, a.source_id, a.segment_id, a.locator, a.quoted_text, a.anchor_hash`;

const ASSESSMENT_COLUMNS = `s.id, s.workflow_id, s.claim_id, s.attempt_id, s.task_id, s.assessment, s.reason_code, s.explanation,
  s.proposed_value, s.proposed_unit, at.independence_domain`;

const DISAGREEMENT_COLUMNS = `d.id, d.workflow_id, d.disagreement_key, d.kind, d.severity, d.subject_signature, d.state, d.resolution_decision_id,
  d.critic_rounds, d.arbiter_rounds, d.needs_human_reason`;

const DECISION_COLUMNS = `d.id, d.workflow_id, d.task_id, d.disagreement_id, d.decision_type, d.subject_key, d.title, d.status, d.authority,
  d.rationale, d.risk_level, d.decided_by_attempt_id, d.summary`;

/* ───────────────────────────────────────────────────────── row mappers */

function toWorkflow(r: Row): WorkflowRecord {
  return {
    workflowId: r.id!, organizationId: r.organization_id!, domainPack: r.domain_pack!, domainPackVersion: r.domain_pack_version!,
    workflowType: r.workflow_type!, engineVersion: r.engine_version!, state: r.state as WorkflowState,
    sourceSetFingerprint: r.source_set_fingerprint!, requestFingerprint: r.request_fingerprint!,
    requestedScope: json<Record<string, unknown>>(r.requested_scope, {}), budget: json<WorkflowRecord["budget"]>(r.budget, {} as WorkflowRecord["budget"]),
    cancelRequestedAt: num(r.cancel_requested_at), totalUnits: int(r.total_units), completedUnits: int(r.completed_units),
    attentionUnits: int(r.attention_units), errorCode: r.error_code, errorMessage: r.error_message,
  };
}

function toSource(r: Row): SourceDescriptor {
  const media = json<Record<string, unknown>>(r.media, {});
  const declared = media[DECLARED_SEGMENTS];
  const rest: Record<string, unknown> = { ...media };
  delete rest[DECLARED_SEGMENTS];
  return {
    sourceId: r.id!, ordinal: int(r.ordinal), sourceKind: r.source_kind!, label: r.label, uri: r.uri!, contentHash: r.content_hash,
    hashAlgorithm: r.hash_algorithm, objectVersionId: r.object_version_id, byteSize: num(r.byte_size), media: rest,
    declaredSegments: Array.isArray(declared) ? (declared as SourceDescriptor["declaredSegments"]) : [],
  };
}

function toSegment(r: Row): SegmentRecord {
  return {
    segmentId: r.id!, workflowId: r.workflow_id!, sourceId: r.source_id!, parentSegmentId: r.parent_segment_id, segmentKind: r.segment_kind!,
    label: r.label, ordinal: int(r.ordinal), locator: json<SegmentRecord["locator"]>(r.locator, {}), contentHash: r.content_hash!,
    status: r.status as SegmentStatus, discoveredBy: r.discovered_by as SegmentRecord["discoveredBy"], discoveredByAttemptId: r.discovered_by_attempt_id,
  };
}

function toTask(r: Row, sources: TaskRecord["sources"], targetClaimIds: string[]): TaskRecord {
  return {
    taskId: r.id!, workflowId: r.workflow_id!, parentTaskId: r.parent_task_id, createdByTaskId: r.created_by_task_id,
    phase: r.phase as TaskRecord["phase"], taskType: r.task_type!, roleKey: r.role_key!, roleVersion: r.role_version!, subjectKey: r.subject_key!,
    priority: int(r.priority), sources, inputFingerprint: r.input_fingerprint!, contractVersion: r.contract_version!,
    independenceGroup: r.independence_group, depth: int(r.depth), criticRound: int(r.critic_round), arbiterRound: int(r.arbiter_round),
    disagreementId: r.disagreement_id, targetClaimIds, maxClaims: int(r.max_claims), state: r.state as TaskState,
    leaseOwner: r.lease_owner, leaseToken: r.lease_token, leaseExpiresAt: num(r.lease_expires_at), terminalReason: r.terminal_reason,
  };
}

function toAttempt(r: Row): AttemptRecord {
  return {
    attemptId: r.id!, workflowId: r.workflow_id!, taskId: r.task_id!, attemptNo: int(r.attempt_no), roleKey: r.role_key!, roleVersion: r.role_version!,
    executorKind: r.executor_kind as AttemptRecord["executorKind"], executorFamily: r.executor_family!, independenceDomain: r.independence_domain!,
    modelConfiguration: r.model_configuration ?? "", state: r.state as AttemptState, leaseToken: r.lease_token, packetFingerprint: r.packet_fingerprint!,
    packetBytes: int(r.packet_bytes), providerRequestId: r.provider_request_id, modelReported: r.model_reported,
    usage: json<Record<string, unknown>>(r.usage, {}), rawResult: json<unknown>(r.raw_result, null), rawResultHash: r.raw_result_hash,
    validationState: r.validation_state as AttemptRecord["validationState"], validationProblems: json<string[]>(r.validation_problems, []),
    providerStopReason: r.provider_stop_reason, providerDurationMs: num(r.provider_duration_ms),
    providerResponse: json<unknown>(r.provider_response, null),
    errorCode: r.error_code, errorMessage: r.error_message,
    reconciliationOutcome: (r.reconciliation_outcome ?? null) as AttemptRecord["reconciliationOutcome"],
  };
}

function toClaim(r: Row, anchorIds: string[], inputClaimIds: string[]): ClaimRecord {
  return {
    claimId: r.id!, workflowId: r.workflow_id!, taskId: r.task_id, attemptId: r.attempt_id, independenceGroup: r.independence_group,
    independenceDomain: r.independence_domain, subjectType: r.subject_type!, subjectKey: r.subject_key!, predicate: r.predicate!,
    value: json<ClaimRecord["value"]>(r.value, { known: false, quantity: null, text: null }), unit: r.unit,
    observationBasis: r.observation_basis as ClaimRecord["observationBasis"], scope: json<Record<string, string>>(r.scope, {}),
    status: r.status as ClaimStatus, machineConfidence: num(r.machine_confidence), anchorIds, inputClaimIds,
    incompleteSourceAttempt: bool(r.incomplete_source_attempt), supersedesClaimId: r.supersedes_claim_id,
  };
}

function toAnchor(r: Row): AnchorRecord {
  return {
    anchorId: r.id!, workflowId: r.workflow_id!, claimId: r.claim_id, assessmentId: r.assessment_id,
    sourceKind: r.source_kind as AnchorRecord["sourceKind"], sourceId: r.source_id, segmentId: r.segment_id,
    locator: json<AnchorRecord["locator"]>(r.locator, {}), quotedText: r.quoted_text, anchorHash: r.anchor_hash!,
  };
}

function toAssessment(r: Row, anchorIds: string[]): AssessmentRecord {
  return {
    assessmentId: r.id!, workflowId: r.workflow_id!, claimId: r.claim_id!, attemptId: r.attempt_id!, taskId: r.task_id as string,
    assessment: r.assessment as AssessmentRecord["assessment"], reasonCode: r.reason_code!, explanation: r.explanation ?? "", anchorIds,
    /* What this reviewer read off the source instead: the only value an
       arbiter may correct to. */
    proposedValue: r.proposed_value === null || r.proposed_value === undefined ? null : json<AssessmentRecord["proposedValue"]>(r.proposed_value, null),
    proposedUnit: r.proposed_unit ?? null, independenceDomain: r.independence_domain ?? "",
  };
}

function toDisagreement(r: Row, claimIds: string[], followUps: DisagreementRecord["followUps"]): DisagreementRecord {
  return {
    disagreementId: r.id!, workflowId: r.workflow_id!, disagreementKey: r.disagreement_key!, kind: r.kind as DisagreementRecord["kind"],
    severity: r.severity as DisagreementRecord["severity"], subjectSignature: json<Record<string, string>>(r.subject_signature, {}), claimIds,
    state: r.state as DisagreementRecord["state"], resolutionDecisionId: r.resolution_decision_id, criticRounds: int(r.critic_rounds),
    arbiterRounds: int(r.arbiter_rounds), followUps, needsHumanReason: r.needs_human_reason,
  };
}

function toDecision(r: Row, evidence: DecisionRecord["evidence"], actions: DecisionRecord["actions"]): DecisionRecord {
  const summary = json<Record<string, unknown>>(r.summary, {});
  return {
    decisionId: r.id!, workflowId: r.workflow_id!, taskId: r.task_id, disagreementId: r.disagreement_id,
    decisionType: r.decision_type as DecisionRecord["decisionType"], subjectKey: r.subject_key ?? "", title: r.title!,
    status: r.status as DecisionRecord["status"], authority: r.authority as DecisionRecord["authority"], rationale: r.rationale ?? "",
    riskLevel: r.risk_level as DecisionRecord["riskLevel"], decidedByAttemptId: r.decided_by_attempt_id, evidence, actions,
    summary: Object.keys(summary).length ? (summary as DecisionRecord["summary"]) : null,
  };
}

/* ───────────────────────────────────────────────────────── the adapter */

export class PostgresOrchestrationRepository implements OrchestrationRepository {
  private client: WireClient;
  private organizationId: string | null;

  constructor(client: WireClient, options: PostgresRepositoryOptions = {}) {
    this.client = client;
    this.organizationId = options.organizationId ?? null;
  }

  /* ─────────────────────────────────────────────────────────── workflow */

  private async workflowIn(q: Q, workflowId: string, lock = false): Promise<WorkflowRecord | null> {
    if (!isUuid(workflowId)) return null;
    const r = await q.query(`select ${WORKFLOW_COLUMNS} from public.intelligence_workflows w where w.id = $1${lock ? " for update" : ""}`, [workflowId]);
    return r.rows.length ? toWorkflow(r.rows[0]) : null;
  }

  async createWorkflow(record: WorkflowRecord, sources: SourceDescriptor[]): Promise<WorkflowRecord> {
    return this.client.transaction(async (tx) => {
      const existing = await this.workflowIn(tx, record.workflowId);
      if (existing) {
        const identity = (w: WorkflowRecord) => canonical({ o: w.organizationId, p: w.domainPack, v: w.domainPackVersion, t: w.workflowType, e: w.engineVersion, s: w.sourceSetFingerprint, r: w.requestFingerprint, q: w.requestedScope });
        if (identity(existing) !== identity(record)) throw new Error(`core-v2: workflow ${record.workflowId} already exists with a different intent`);
        return existing;
      }
      if (sources.length === 0) throw new Error("core-v2: a workflow names the sources it reads");
      for (const s of sources) if (!s.contentHash && !s.objectVersionId) throw new Error(`core-v2: source ${s.sourceId} has neither a content hash nor a version — it is not read`);
      try {
        await tx.query(`insert into public.intelligence_workflows(id, organization_id, domain_pack, domain_pack_version, workflow_type, engine_version, state,
            source_set_fingerprint, request_fingerprint, requested_scope, budget, cancel_requested_at, total_units, completed_units, attention_units,
            error_code, error_message)
          values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb, to_timestamp($12::double precision / 1000), $13::int, $14::int, $15::int, $16, $17)`,
          [record.workflowId, record.organizationId, record.domainPack, record.domainPackVersion, record.workflowType, record.engineVersion, record.state,
            record.sourceSetFingerprint, record.requestFingerprint, JSON.stringify(record.requestedScope ?? {}), JSON.stringify(record.budget ?? {}),
            record.cancelRequestedAt, record.totalUnits, record.completedUnits, record.attentionUnits, record.errorCode, record.errorMessage]);
      } catch (error) {
        if (isPostgresError(error) && error.code === "23505" && error.constraint === "intelligence_workflows_one_live_request") {
          throw new Error(`core-v2: another live workflow of organisation ${record.organizationId} already answers request ${record.requestFingerprint}`);
        }
        throw error;
      }
      for (const s of sources) {
        const media: Record<string, unknown> = { ...(s.media ?? {}) };
        if (s.declaredSegments && s.declaredSegments.length) media[DECLARED_SEGMENTS] = s.declaredSegments;
        await tx.query(`insert into public.workflow_sources(id, organization_id, workflow_id, ordinal, source_kind, label, uri, content_hash, hash_algorithm,
            object_version_id, byte_size, media, created_at)
          values ($1, $2, $3, $4::int, $5, $6, $7, $8, $9, $10, $11::bigint, $12::jsonb, clock_timestamp())`,
          [s.sourceId, record.organizationId, record.workflowId, s.ordinal, s.sourceKind, s.label, s.uri, s.contentHash, s.hashAlgorithm,
            s.objectVersionId, s.byteSize, JSON.stringify(media)]);
      }
      const payload = {
        workflow_id: record.workflowId, organization_id: record.organizationId, domain_pack: record.domainPack, domain_pack_version: record.domainPackVersion,
        workflow_type: record.workflowType, engine_version: record.engineVersion, source_count: sources.length,
        source_set_fingerprint: record.sourceSetFingerprint, request_fingerprint: record.requestFingerprint,
      };
      await tx.query(`insert into public.workflow_outbox(organization_id, workflow_id, command, payload) values ($1, $2, 'start', $3::jsonb)`,
        [record.organizationId, record.workflowId, JSON.stringify(payload)]);
      await this.auditIn(tx, record.organizationId, {
        action: "core_v2.workflow.started", entityType: "intelligence_workflow", entityId: record.workflowId,
        detail: { domain_pack: record.domainPack, domain_pack_version: record.domainPackVersion, workflow_type: record.workflowType, source_count: sources.length,
          source_set_fingerprint: record.sourceSetFingerprint, request_fingerprint: record.requestFingerprint, duplicate_authorized: false },
      });
      return (await this.workflowIn(tx, record.workflowId))!;
    });
  }

  getWorkflow(workflowId: string): Promise<WorkflowRecord | null> { return this.workflowIn(this.client, workflowId); }

  private async transitionWorkflowIn(q: Q, workflowId: string, from: WorkflowState, to: WorkflowState, patch: { errorCode?: string | null; errorMessage?: string | null } = {}): Promise<WorkflowRecord> {
    if (!workflowMoveAllowed(from, to)) {
      const wf = await this.workflowIn(q, workflowId);
      if (!wf) throw noSuch("workflow", workflowId);
      if (wf.state !== from) throw new StaleState("workflow", workflowId, from, wf.state);
      throw new IllegalTransition("workflow", from, to);
    }
    if (!isUuid(workflowId)) throw noSuch("workflow", workflowId);
    const r = await q.query(`update public.intelligence_workflows w
        set state = $3::text, error_code = coalesce($4, error_code), error_message = coalesce($5, error_message),
            started_at = case when $3::text = 'planning' and started_at is null then now() else started_at end,
            finished_at = case when $3::text in ('completed','partial','failed','cancelled') then now() else finished_at end
      where w.id = $1 and w.state = $2 returning ${WORKFLOW_COLUMNS}`,
      [workflowId, from, to, patch.errorCode ?? null, patch.errorMessage ?? null]);
    if (r.rows.length) return toWorkflow(r.rows[0]);
    const wf = await this.workflowIn(q, workflowId);
    if (!wf) throw noSuch("workflow", workflowId);
    throw new StaleState("workflow", workflowId, from, wf.state);
  }

  transitionWorkflow(workflowId: string, from: WorkflowState, to: WorkflowState, patch: { errorCode?: string | null; errorMessage?: string | null } = {}): Promise<WorkflowRecord> {
    return this.transitionWorkflowIn(this.client, workflowId, from, to, patch);
  }

  async updateWorkflowProgress(workflowId: string, progress: { totalUnits: number; completedUnits: number; attentionUnits: number }): Promise<void> {
    if (!isUuid(workflowId)) throw noSuch("workflow", workflowId);
    const r = await this.client.query(`update public.intelligence_workflows set total_units = $2::int, completed_units = $3::int, attention_units = $4::int where id = $1`,
      [workflowId, progress.totalUnits, progress.completedUnits, progress.attentionUnits]);
    if (r.rowCount === 0) throw noSuch("workflow", workflowId);
  }

  async requestCancel(workflowId: string, at: number): Promise<WorkflowRecord> {
    if (!isUuid(workflowId)) throw noSuch("workflow", workflowId);
    const r = await this.client.query(`update public.intelligence_workflows w
        set cancel_requested_at = coalesce(cancel_requested_at, to_timestamp($2::double precision / 1000))
      where w.id = $1 returning ${WORKFLOW_COLUMNS}`, [workflowId, at]);
    if (!r.rows.length) throw noSuch("workflow", workflowId);
    return toWorkflow(r.rows[0]);
  }

  async claimOutbox(workflowId: string, dispatcher: string): Promise<boolean> {
    if (!isUuid(workflowId)) return false;
    return this.client.transaction(async (tx) => {
      const wf = await this.workflowIn(tx, workflowId, true);
      if (!wf || wf.state !== "created") return false;
      const r = await tx.query(`select (public.core_v2_claim_outbox($1, $2)).state as state`, [workflowId, dispatcher]);
      return r.rows.length > 0 && r.rows[0].state !== null;
    });
  }

  async acknowledgeOutbox(workflowId: string): Promise<void> {
    if (!isUuid(workflowId)) throw new Error(`core-v2: no start command for ${workflowId}`);
    const r = await this.client.query(`select (public.core_v2_acknowledge_outbox($1)).state as state`, [workflowId]);
    if (r.rows.length && r.rows[0].state !== null) return;
    const exists = await this.client.query(`select 1 as one from public.workflow_outbox where workflow_id = $1`, [workflowId]);
    if (!exists.rows.length) throw new Error(`core-v2: no start command for ${workflowId}`);
  }

  /* ─────────────────────────────────────────────── sources and segments */

  async listSources(workflowId: string): Promise<SourceDescriptor[]> {
    if (!isUuid(workflowId)) return [];
    const r = await this.client.query(`select ${SOURCE_COLUMNS} from public.workflow_sources s where s.workflow_id = $1 order by s.ordinal`, [workflowId]);
    return r.rows.map(toSource);
  }

  private async sourceIdsIn(q: Q, workflowId: string): Promise<Set<string>> {
    if (!isUuid(workflowId)) return new Set();
    const r = await q.query(`select s.id from public.workflow_sources s where s.workflow_id = $1`, [workflowId]);
    return new Set(r.rows.map((row) => row.id!));
  }

  private async segmentIn(q: Q, segmentId: string): Promise<SegmentRecord | null> {
    if (!isUuid(segmentId)) return null;
    const r = await q.query(`select ${SEGMENT_COLUMNS} from public.source_segments s where s.id = $1`, [segmentId]);
    return r.rows.length ? toSegment(r.rows[0]) : null;
  }

  private async segmentByIdentityIn(q: Q, s: NewSegment): Promise<SegmentRecord | null> {
    if (!isUuid(s.workflowId) || !isUuid(s.sourceId) || (s.parentSegmentId && !isUuid(s.parentSegmentId))) return null;
    const r = await q.query(`select ${SEGMENT_COLUMNS} from public.source_segments s
      where s.workflow_id = $1 and s.source_id = $2 and coalesce(s.parent_segment_id, $3::uuid) = $3::uuid and s.segment_kind = $4 and s.content_hash = $5`,
      [s.workflowId, s.sourceId, s.parentSegmentId ?? ZERO, s.segmentKind, s.contentHash]);
    return r.rows.length ? toSegment(r.rows[0]) : null;
  }

  async listSegments(workflowId: string, filter: { sourceId?: string; statuses?: SegmentStatus[] } = {}): Promise<SegmentRecord[]> {
    if (!isUuid(workflowId)) return [];
    const clauses = ["s.workflow_id = $1"];
    const params: Param[] = [workflowId];
    if (filter.sourceId) { params.push(filter.sourceId); clauses.push(isUuid(filter.sourceId) ? `s.source_id = $${params.length}` : "false"); }
    if (filter.statuses) { params.push(texts(filter.statuses)); clauses.push(`s.status = any($${params.length}::text[])`); }
    const r = await this.client.query(`select ${SEGMENT_COLUMNS} from public.source_segments s where ${clauses.join(" and ")} order by s.ordinal, s.id`, params);
    return r.rows.map(toSegment);
  }

  getSegment(segmentId: string): Promise<SegmentRecord | null> { return this.segmentIn(this.client, segmentId); }

  private async persistSegmentsIn(q: Q, organizationId: string, workflowId: string, segments: NewSegment[]): Promise<{ created: SegmentRecord[]; reused: SegmentRecord[] }> {
    const created: SegmentRecord[] = [];
    const reused: SegmentRecord[] = [];
    const sources = await this.sourceIdsIn(q, workflowId);
    for (const s of segments) {
      if (s.workflowId !== workflowId) throw new Error("core-v2: a segment of another workflow");
      if (!sources.has(s.sourceId)) throw new Error(`core-v2: segment names source ${s.sourceId}, which this workflow does not read`);
      const problem = locatorProblem(s.locator);
      if (problem) throw new Error(`core-v2: segment ${s.label ?? s.segmentKind}: ${problem}`);
      if (s.parentSegmentId) {
        const parent = await this.segmentIn(q, s.parentSegmentId);
        if (!parent) throw new Error(`core-v2: segment names parent ${s.parentSegmentId}, which does not exist`);
        if (parent.sourceId !== s.sourceId || parent.workflowId !== workflowId) throw new Error("core-v2: a segment's parent belongs to another source");
        if (!locatorInside(s.locator, parent.locator)) throw new Error(`core-v2: segment ${s.label ?? s.segmentKind} lies outside its parent`);
      }
      const existing = (await this.segmentByIdentityIn(q, s)) ?? (await this.segmentIn(q, s.segmentId));
      if (existing) {
        const payload = (x: NewSegment | SegmentRecord) => canonical({ l: x.locator, o: x.ordinal, k: x.segmentKind, p: x.parentSegmentId, h: x.contentHash, src: x.sourceId });
        if (payload(existing) !== payload(s)) throw new Error(`core-v2: segment ${s.segmentId} already names different work`);
        reused.push(existing); continue;
      }
      await q.query(`insert into public.source_segments(id, organization_id, workflow_id, source_id, parent_segment_id, segment_kind, label, ordinal, locator,
          content_hash, status, discovered_by, discovered_by_attempt_id, created_at)
        values ($1, $2, $3, $4, $5, $6, $7, $8::int, $9::jsonb, $10, $11, $12, $13, clock_timestamp())`,
        [s.segmentId, organizationId, workflowId, s.sourceId, s.parentSegmentId, s.segmentKind, s.label, s.ordinal, JSON.stringify(s.locator ?? {}),
          s.contentHash, s.status, s.discoveredBy, s.discoveredByAttemptId]);
      created.push({ ...s });
    }
    return { created, reused };
  }

  persistSegments(workflowId: string, segments: NewSegment[]): Promise<{ created: SegmentRecord[]; reused: SegmentRecord[] }> {
    return this.client.transaction(async (tx) => {
      const wf = await this.workflowIn(tx, workflowId, true);
      return this.persistSegmentsIn(tx, wf?.organizationId ?? ZERO, workflowId, segments);
    });
  }

  private async transitionSegmentIn(q: Q, segmentId: string, from: SegmentStatus, to: SegmentStatus): Promise<SegmentRecord> {
    if (!segmentMoveAllowed(from, to)) {
      const s = await this.segmentIn(q, segmentId);
      if (!s) throw noSuch("segment", segmentId);
      if (s.status !== from) throw new StaleState("segment", segmentId, from, s.status);
      throw new IllegalTransition("segment", from, to);
    }
    if (!isUuid(segmentId)) throw noSuch("segment", segmentId);
    const r = await q.query(`update public.source_segments s set status = $3 where s.id = $1 and s.status = $2 returning ${SEGMENT_COLUMNS}`, [segmentId, from, to]);
    if (r.rows.length) return toSegment(r.rows[0]);
    const s = await this.segmentIn(q, segmentId);
    if (!s) throw noSuch("segment", segmentId);
    throw new StaleState("segment", segmentId, from, s.status);
  }

  transitionSegment(segmentId: string, from: SegmentStatus, to: SegmentStatus): Promise<SegmentRecord> {
    return this.transitionSegmentIn(this.client, segmentId, from, to);
  }

  /* ──────────────────────────────────────────────────────────── tasks */

  private async tasksWhere(q: Q, where: string, params: Param[], order = "t.created_at, t.id", lock = false): Promise<TaskRecord[]> {
    const r = await q.query(`select ${TASK_COLUMNS} from public.workflow_tasks t where ${where} order by ${order}${lock ? " for update" : ""}`, params);
    if (!r.rows.length) return [];
    const ids = uuids(r.rows.map((row) => row.id!));
    const sources = await q.query(`select task_id, source_id, segment_id from public.task_sources where task_id = any($1::uuid[]) order by task_id, ordinal`, [ids]);
    const targets = await q.query(`select task_id, claim_id from public.task_target_claims where task_id = any($1::uuid[]) order by task_id, created_at, claim_id`, [ids]);
    const sourcesOf = new Map<string, TaskRecord["sources"]>();
    for (const s of sources.rows) { const list = sourcesOf.get(s.task_id!) ?? []; list.push({ sourceId: s.source_id, segmentId: s.segment_id }); sourcesOf.set(s.task_id!, list); }
    const targetsOf = new Map<string, string[]>();
    for (const t of targets.rows) { const list = targetsOf.get(t.task_id!) ?? []; list.push(t.claim_id!); targetsOf.set(t.task_id!, list); }
    return r.rows.map((row) => toTask(row, sourcesOf.get(row.id!) ?? [], targetsOf.get(row.id!) ?? []));
  }

  private async taskIn(q: Q, taskId: string, lock = false): Promise<TaskRecord | null> {
    if (!isUuid(taskId)) return null;
    return first(await this.tasksWhere(q, "t.id = $1", [taskId], "t.id", lock) as unknown as Row[]) as unknown as TaskRecord | null;
  }

  private async taskExistsIn(q: Q, taskId: string): Promise<boolean> {
    if (!isUuid(taskId)) return false;
    const r = await q.query(`select 1 as one from public.workflow_tasks where id = $1`, [taskId]);
    return r.rows.length > 0;
  }

  private async taskByIdentityIn(q: Q, t: NewTask): Promise<TaskRecord | null> {
    if (!isUuid(t.workflowId)) return null;
    return first(await this.tasksWhere(q,
      "t.workflow_id = $1 and t.phase = $2 and t.task_type = $3 and t.subject_key = $4 and t.input_fingerprint = $5 and t.contract_version = $6 and coalesce(t.independence_group, '') = $7",
      [t.workflowId, t.phase, t.taskType, t.subjectKey, t.inputFingerprint, t.contractVersion, t.independenceGroup ?? ""], "t.id") as unknown as Row[]) as unknown as TaskRecord | null;
  }

  private async edgeExistsIn(q: Q, taskId: string, dependsOnTaskId: string): Promise<boolean> {
    if (!isUuid(taskId) || !isUuid(dependsOnTaskId)) return false;
    const r = await q.query(`select 1 as one from public.task_dependencies where task_id = $1 and depends_on_task_id = $2`, [taskId, dependsOnTaskId]);
    return r.rows.length > 0;
  }

  private async edgeCountIn(q: Q, workflowId: string): Promise<number> {
    const r = await q.query(`select count(*) as n from public.task_dependencies d join public.workflow_tasks t on t.id = d.task_id where t.workflow_id = $1`, [workflowId]);
    return int(r.rows[0].n);
  }

  /* One edge, under a savepoint so the database's own edge budget — when it
     is stricter than the limits the caller passed — becomes a refusal rather
     than a failed transaction. */
  private async insertEdgeIn(q: Q, organizationId: string, taskId: string, dependsOnTaskId: string, kind: DependencyKind): Promise<{ ok: true } | { ok: false; reason: string }> {
    await q.query("savepoint core_v2_edge");
    try {
      await q.query(`insert into public.task_dependencies(organization_id, task_id, depends_on_task_id, dependency_kind, created_at) values ($1, $2, $3, $4, clock_timestamp())`,
        [organizationId, taskId, dependsOnTaskId, kind]);
      await q.query("release savepoint core_v2_edge");
      return { ok: true };
    } catch (error) {
      await q.query("rollback to savepoint core_v2_edge");
      if (isCheckViolation(error, "its budget allows no more")) return { ok: false, reason: (error as Error).message.replace(/^core_v2: /, "") };
      throw error;
    }
  }

  private async admitTasksIn(q: Q, workflowId: string, tasks: NewTask[], limits: AdmissionLimits): Promise<Admission> {
    const created: TaskRecord[] = [];
    const reused: TaskRecord[] = [];
    const refused: { task: NewTask; reason: string }[] = [];
    const wf = await this.workflowIn(q, workflowId, true);
    if (!wf) throw noSuch("workflow", workflowId);
    const organizationId = wf.organizationId;
    let total = int((await q.query(`select count(*) as n from public.workflow_tasks where workflow_id = $1`, [workflowId])).rows[0].n);
    let edges = await this.edgeCountIn(q, workflowId);
    const childrenOf = new Map<string, number>();
    for (const row of (await q.query(`select parent_task_id, count(*) as n from public.workflow_tasks where workflow_id = $1 and parent_task_id is not null group by parent_task_id`, [workflowId])).rows) {
      childrenOf.set(row.parent_task_id!, int(row.n));
    }
    /* Edges whose far end is admitted later in this same batch wait until it is. */
    const deferred: { taskId: string; dependsOnTaskId: string; kind: DependencyKind }[] = [];

    for (const t of tasks) {
      if (t.workflowId !== workflowId) throw new Error("core-v2: a task of another workflow");
      const existing = (await this.taskByIdentityIn(q, t)) ?? (await this.taskIn(q, t.taskId));
      if (existing) {
        if (canonical(taskPayload(existing)) !== canonical(taskPayload(t))) {
          throw new Error(`core-v2: task ${t.taskId} already names different work (${existing.inputFingerprint} vs ${t.inputFingerprint})`);
        }
        /* The same work, now with prerequisites it did not have: they are
           added while it has not started, and never after. */
        if (["created", "blocked", "queued"].includes(existing.state)) {
          let state = existing.state;
          for (const d of t.dependsOn) {
            if (d.taskId === existing.taskId || (await this.edgeExistsIn(q, existing.taskId, d.taskId))) continue;
            const inRecord = await this.taskExistsIn(q, d.taskId);
            if (!inRecord && !tasks.some((x) => x.taskId === d.taskId)) continue;
            if (edges >= limits.maximumEdges) { refused.push({ task: t, reason: `the workflow is at its ceiling of ${limits.maximumEdges} dependency edges` }); break; }
            if (inRecord) {
              const edge = await this.insertEdgeIn(q, organizationId, existing.taskId, d.taskId, d.kind);
              if (!edge.ok) { refused.push({ task: t, reason: edge.reason }); break; }
            } else {
              deferred.push({ taskId: existing.taskId, dependsOnTaskId: d.taskId, kind: d.kind });
            }
            edges++;
            if (state === "queued" && await this.blockForNewPrerequisiteIn(q, existing.taskId)) state = "blocked";
          }
        }
        reused.push((await this.taskIn(q, existing.taskId))!); continue;
      }
      if (t.depth > limits.maximumDepth) { refused.push({ task: t, reason: `depth ${t.depth} exceeds the limit of ${limits.maximumDepth}` }); continue; }
      if (total >= limits.maximumTasks) { refused.push({ task: t, reason: `the workflow is at its ceiling of ${limits.maximumTasks} tasks` }); continue; }
      if (t.parentTaskId && (childrenOf.get(t.parentTaskId) ?? 0) >= limits.maximumChildrenPerParent) { refused.push({ task: t, reason: `task ${t.parentTaskId} has used its ${limits.maximumChildrenPerParent} follow-ups` }); continue; }
      if (edges + t.dependsOn.length > limits.maximumEdges) { refused.push({ task: t, reason: `the workflow is at its ceiling of ${limits.maximumEdges} dependency edges` }); continue; }
      for (const d of t.dependsOn) {
        if (d.taskId === t.taskId) throw new Error("core-v2: a task cannot depend on itself");
        if (!(await this.taskExistsIn(q, d.taskId)) && !tasks.some((x) => x.taskId === d.taskId)) throw new Error(`core-v2: task ${t.taskId} depends on ${d.taskId}, which does not exist`);
      }
      const { dependsOn, ...rest } = t;
      const record: TaskRecord = { ...rest, state: "created", leaseOwner: null, leaseToken: null, leaseExpiresAt: null, terminalReason: null };
      /* The insert under a savepoint: the row's own budget trigger reads the
         workflow's budget, which may be stricter than the limits passed in. */
      await q.query("savepoint core_v2_admit");
      try {
        await q.query(`insert into public.workflow_tasks(id, organization_id, workflow_id, parent_task_id, created_by_task_id, phase, task_type, role_key, role_version,
            subject_key, priority, input_fingerprint, contract_version, independence_group, depth, critic_round, arbiter_round, disagreement_id, state, max_claims, created_at)
          values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::int, $12, $13, $14, $15::int, $16::int, $17::int, $18, 'created', $19::int, clock_timestamp())`,
          [record.taskId, organizationId, workflowId, record.parentTaskId, record.createdByTaskId, record.phase, record.taskType, record.roleKey, record.roleVersion,
            record.subjectKey, record.priority, record.inputFingerprint, record.contractVersion, record.independenceGroup, record.depth, record.criticRound,
            record.arbiterRound, record.disagreementId, Math.trunc(record.maxClaims)]);
        await q.query("release savepoint core_v2_admit");
      } catch (error) {
        await q.query("rollback to savepoint core_v2_admit");
        if (isCheckViolation(error, "its budget allows no more", "the workflow allows follow-ups to depth", "the workflow allows no more")) {
          refused.push({ task: t, reason: (error as Error).message.replace(/^core_v2: /, "") }); continue;
        }
        throw error;
      }
      for (let i = 0; i < record.sources.length; i++) {
        const s = record.sources[i];
        await q.query(`insert into public.task_sources(organization_id, task_id, ordinal, source_id, segment_id) values ($1, $2, $3::int, $4, $5)`,
          [organizationId, record.taskId, i, s.sourceId, s.segmentId]);
      }
      for (const claimId of record.targetClaimIds) {
        await q.query(`insert into public.task_target_claims(organization_id, task_id, claim_id, created_at) values ($1, $2, $3, clock_timestamp())`,
          [organizationId, record.taskId, claimId]);
      }
      const seen = new Set<string>();
      for (const d of dependsOn) {
        if (seen.has(d.taskId)) continue;
        seen.add(d.taskId);
        if (await this.taskExistsIn(q, d.taskId)) {
          const edge = await this.insertEdgeIn(q, organizationId, record.taskId, d.taskId, d.kind);
          if (!edge.ok) throw new Error(`core-v2: ${edge.reason}`);
        } else {
          deferred.push({ taskId: record.taskId, dependsOnTaskId: d.taskId, kind: d.kind });
        }
        edges++;
      }
      total++;
      if (record.parentTaskId) childrenOf.set(record.parentTaskId, (childrenOf.get(record.parentTaskId) ?? 0) + 1);
      created.push(record);
    }
    for (const e of deferred) {
      if (!(await this.taskExistsIn(q, e.dependsOnTaskId))) throw new Error(`core-v2: task ${e.taskId} depends on ${e.dependsOnTaskId}, which was not admitted`);
      if (await this.edgeExistsIn(q, e.taskId, e.dependsOnTaskId)) continue;
      const edge = await this.insertEdgeIn(q, organizationId, e.taskId, e.dependsOnTaskId, e.kind);
      if (!edge.ok) throw new Error(`core-v2: ${edge.reason}`);
    }
    return { created, reused, refused };
  }

  admitTasks(workflowId: string, tasks: NewTask[], limits: AdmissionLimits): Promise<Admission> {
    return this.client.transaction((tx) => this.admitTasksIn(tx, workflowId, tasks, limits));
  }

  getTask(taskId: string): Promise<TaskRecord | null> { return this.taskIn(this.client, taskId); }

  listTasks(workflowId: string): Promise<TaskRecord[]> {
    if (!isUuid(workflowId)) return Promise.resolve([]);
    return this.tasksWhere(this.client, "t.workflow_id = $1", [workflowId]);
  }

  getRunnableTasks(workflowId: string): Promise<TaskRecord[]> {
    if (!isUuid(workflowId)) return Promise.resolve([]);
    return this.tasksWhere(this.client, "t.workflow_id = $1 and t.state = 'queued'", [workflowId], "t.priority, t.id");
  }

  private async dependenciesIn(q: Q, taskId: string): Promise<DependencyRecord[]> {
    if (!isUuid(taskId)) return [];
    const r = await q.query(`select task_id, depends_on_task_id, dependency_kind from public.task_dependencies where task_id = $1 order by created_at, depends_on_task_id`, [taskId]);
    return r.rows.map((row) => ({ taskId: row.task_id!, dependsOnTaskId: row.depends_on_task_id!, kind: row.dependency_kind as DependencyKind }));
  }

  getDependencies(taskId: string): Promise<DependencyRecord[]> { return this.dependenciesIn(this.client, taskId); }

  async getDependents(taskId: string): Promise<DependencyRecord[]> {
    if (!isUuid(taskId)) return [];
    const r = await this.client.query(`select task_id, depends_on_task_id, dependency_kind from public.task_dependencies where depends_on_task_id = $1 order by created_at, task_id`, [taskId]);
    return r.rows.map((row) => ({ taskId: row.task_id!, dependsOnTaskId: row.depends_on_task_id!, kind: row.dependency_kind as DependencyKind }));
  }

  private async addDependencyIn(q: Q, taskId: string, dependsOnTaskId: string, kind: DependencyKind, limits: AdmissionLimits): Promise<void> {
    if (taskId === dependsOnTaskId) throw new Error("core-v2: a task cannot depend on itself");
    if (await this.edgeExistsIn(q, taskId, dependsOnTaskId)) return;
    const task = await this.taskIn(q, taskId, true);
    if (!task) throw noSuch("task", taskId);
    if (!(await this.taskExistsIn(q, dependsOnTaskId))) throw noSuch("task", dependsOnTaskId);
    if (!["created", "blocked", "queued"].includes(task.state)) throw new Error(`core-v2: task ${taskId} is ${task.state} — a dependency cannot be added to work already under way`);
    const wf = await this.workflowIn(q, task.workflowId, true);
    const edges = await this.edgeCountIn(q, task.workflowId);
    if (edges >= limits.maximumEdges) throw new Error(`core-v2: the workflow is at its ceiling of ${limits.maximumEdges} dependency edges`);
    const edge = await this.insertEdgeIn(q, wf?.organizationId ?? task.workflowId, taskId, dependsOnTaskId, kind);
    if (!edge.ok) throw new Error(`core-v2: ${edge.reason}`);
    if (task.state === "queued") await this.blockForNewPrerequisiteIn(q, taskId);
  }

  addDependency(taskId: string, dependsOnTaskId: string, kind: DependencyKind, limits: AdmissionLimits): Promise<void> {
    return this.client.transaction((tx) => this.addDependencyIn(tx, taskId, dependsOnTaskId, kind, limits));
  }

  private async hasSubmittedAttemptIn(q: Q, taskId: string): Promise<boolean> {
    const r = await q.query(`select 1 as one from public.agent_attempts a where a.task_id = $1 and public.core_v2_attempt_submitted(a.state) limit 1`, [taskId]);
    return r.rows.length > 0;
  }

  /* A task that gains a prerequisite while it is queued must wait for it.
     Neither migration 058's transition table nor the kernel's mirror of it
     carries ('task','queued','blocked'), so the record cannot make the move
     the in-memory reference makes by writing the column directly: the guard
     trigger refuses it. The edge is written either way, and the day the
     table gains the row this makes the move without another change here. */
  /* A task already offered to workers has gained a prerequisite: it waits
     again rather than running with a dependency unmet. */
  private async blockForNewPrerequisiteIn(q: Q, taskId: string): Promise<boolean> {
    await this.transitionTaskIn(q, taskId, "queued", "blocked");
    return true;
  }

  private async transitionTaskIn(q: Q, taskId: string, from: TaskState, to: TaskState, reason: string | null = null): Promise<TaskRecord> {
    if (!taskMoveAllowed(from, to)) {
      const task = await this.taskIn(q, taskId);
      if (!task) throw noSuch("task", taskId);
      if (task.state !== from) throw new StaleState("task", taskId, from, task.state);
      throw new IllegalTransition("task", from, to);
    }
    if (!isUuid(taskId)) throw noSuch("task", taskId);
    if ((from === "leased" && to === "queued") || to === "cancelled") {
      const task = await this.taskIn(q, taskId);
      if (!task) throw noSuch("task", taskId);
      if (task.state !== from) throw new StaleState("task", taskId, from, task.state);
      if (await this.hasSubmittedAttemptIn(q, taskId)) throw new Error(`core-v2: task ${taskId} has an attempt that was already submitted — it is reconciled, not ${to === "cancelled" ? "cancelled" : "requeued"}`);
    }
    const keepLease = to === "leased" || to === "running";
    const terminal = TERMINAL_TASK_STATES.includes(to);
    const r = await q.query(`update public.workflow_tasks t
        set state = $3::text,
            terminal_reason = case when $4::boolean then coalesce($5, terminal_reason) else terminal_reason end,
            lease_owner = case when $6::boolean then lease_owner else null end,
            lease_token = case when $6::boolean then lease_token else null end,
            lease_expires_at = case when $6::boolean then lease_expires_at else null end
      where t.id = $1 and t.state = $2 returning t.id`, [taskId, from, to, terminal, reason, keepLease]);
    if (r.rows.length) return (await this.taskIn(q, taskId))!;
    const task = await this.taskIn(q, taskId);
    if (!task) throw noSuch("task", taskId);
    throw new StaleState("task", taskId, from, task.state);
  }

  transitionTask(taskId: string, from: TaskState, to: TaskState, reason: string | null = null): Promise<TaskRecord> {
    return this.client.transaction((tx) => this.transitionTaskIn(tx, taskId, from, to, reason));
  }

  private async latestAttemptIn(q: Q, taskId: string): Promise<AttemptRecord | null> {
    const r = await q.query(`select ${ATTEMPT_COLUMNS} from public.agent_attempts a where a.task_id = $1 order by a.attempt_no desc limit 1`, [taskId]);
    return r.rows.length ? toAttempt(r.rows[0]) : null;
  }

  /* An expired lease whose attempt never left is taken back: the prepared
     attempt is cancelled and the task returns to the queue. One that did
     leave is not — the executor may have run. */
  private async reclaimExpiredLeaseIn(q: Q, task: TaskRecord): Promise<boolean> {
    const latest = await this.latestAttemptIn(q, task.taskId);
    if (latest && SUBMITTED_ATTEMPT_STATES.includes(latest.state)) return false;
    if (latest && latest.state === "prepared") await this.transitionAttemptIn(q, latest.attemptId, "prepared", "cancelled_before_submission", { errorCode: "lease_expired_before_submission" });
    try { await this.transitionTaskIn(q, task.taskId, "leased", "queued"); } catch { return false; }
    return true;
  }

  private async leaseExpiredIn(q: Q, taskId: string): Promise<boolean> {
    const r = await q.query(`select (lease_expires_at is not null and lease_expires_at < now()) as expired from public.workflow_tasks where id = $1`, [taskId]);
    return r.rows.length > 0 && bool(r.rows[0].expired);
  }

  /* One grant per lease, with a fencing token: core_v2_lease_task, which
     draws the token and the expiry on the database's clock. */
  leaseTask(taskId: string, owner: string, ttlMs: number, _now: number): Promise<TaskRecord | null> {
    if (!isUuid(taskId)) return Promise.resolve(null);
    return this.client.transaction(async (tx) => {
      const task = await this.taskIn(tx, taskId, true);
      if (!task) return null;
      if (task.state === "leased" && task.leaseExpiresAt !== null && (await this.leaseExpiredIn(tx, taskId))) {
        if (!(await this.reclaimExpiredLeaseIn(tx, task))) return null;
      }
      const fresh = (await this.taskIn(tx, taskId))!;
      if (fresh.state !== "queued") return null;
      const r = await tx.query(`select (public.core_v2_lease_task($1, $2, $3::int)).id as id`, [taskId, owner, Math.trunc(ttlMs)]);
      if (!r.rows.length || r.rows[0].id === null) return null;
      return this.taskIn(tx, taskId);
    });
  }

  async heartbeatLease(taskId: string, leaseToken: string, ttlMs: number, _now: number): Promise<boolean> {
    if (!isUuid(taskId) || !isUuid(leaseToken)) return false;
    const r = await this.client.query(`select public.core_v2_heartbeat_lease($1, $2, $3::int) as ok`, [taskId, leaseToken, Math.trunc(ttlMs)]);
    return r.rows.length > 0 && bool(r.rows[0].ok);
  }

  releaseDependents(workflowId: string): Promise<{ released: TaskRecord[]; stopped: TaskRecord[] }> {
    return this.client.transaction(async (tx) => {
      const released: TaskRecord[] = [];
      const stopped: TaskRecord[] = [];
      if (!isUuid(workflowId)) return { released, stopped };
      for (const task of await this.tasksWhere(tx, "t.workflow_id = $1", [workflowId])) {
        if (task.state !== "created" && task.state !== "blocked") continue;
        const deps = await this.dependenciesIn(tx, task.taskId);
        const upstream: TaskRecord[] = [];
        for (const d of deps) { const u = await this.taskIn(tx, d.dependsOnTaskId); if (u) upstream.push(u); }
        const dead = upstream.find((u) => ["failed_known", "outcome_unknown", "cancelled"].includes(u.state));
        if (dead) { stopped.push(await this.transitionTaskIn(tx, task.taskId, task.state, "cancelled", `upstream_${dead.state}:${dead.taskId}`)); continue; }
        if (upstream.some((u) => u.state === "superseded")) {
          if (task.state === "created") await this.transitionTaskIn(tx, task.taskId, "created", "blocked");
          continue;
        }
        if (upstream.every((u) => u.state === "completed")) released.push(await this.transitionTaskIn(tx, task.taskId, task.state, "queued"));
        else if (task.state === "created") await this.transitionTaskIn(tx, task.taskId, "created", "blocked");
      }
      return { released, stopped };
    });
  }

  /* Expiry is judged on the database's clock, the clock that granted the
     lease; `now` is the caller's and is not consulted. */
  expireLeases(workflowId: string, _now: number): Promise<TaskRecord[]> {
    return this.client.transaction(async (tx) => {
      const touched: TaskRecord[] = [];
      if (!isUuid(workflowId)) return touched;
      for (const task of await this.tasksWhere(tx, "t.workflow_id = $1 and t.lease_expires_at is not null and t.lease_expires_at < now()", [workflowId])) {
        if (task.state === "leased") {
          if (await this.reclaimExpiredLeaseIn(tx, task)) touched.push((await this.taskIn(tx, task.taskId))!);
          else { await this.transitionTaskIn(tx, task.taskId, "leased", "running"); touched.push(await this.transitionTaskIn(tx, task.taskId, "running", "outcome_unknown", "lease_expired_after_submission")); }
          continue;
        }
        if (task.state !== "running") continue;
        const latest = await this.latestAttemptIn(tx, task.taskId);
        if (latest && SUBMITTED_ATTEMPT_STATES.includes(latest.state) && !TERMINAL_ATTEMPT_STATES.includes(latest.state)) {
          await this.transitionAttemptIn(tx, latest.attemptId, latest.state, "outcome_unknown", { errorCode: "lease_expired_after_submission", errorMessage: "the worker holding this attempt did not come back" });
          touched.push(await this.transitionTaskIn(tx, task.taskId, "running", "outcome_unknown", "lease_expired_after_submission"));
        } else if (latest && latest.state === "prepared") {
          await this.transitionAttemptIn(tx, latest.attemptId, "prepared", "cancelled_before_submission", { errorCode: "lease_expired_before_submission" });
          touched.push(await this.transitionTaskIn(tx, task.taskId, "running", "failed_known", "lease_expired_before_submission"));
        } else if (latest && latest.state === "outcome_unknown") {
          touched.push(await this.transitionTaskIn(tx, task.taskId, "running", "outcome_unknown", "lease_expired_after_submission"));
        } else if (latest) {
          touched.push(await this.transitionTaskIn(tx, task.taskId, "running", "failed_known", `lease_expired_after_attempt_${latest.state}`));
        } else {
          touched.push(await this.transitionTaskIn(tx, task.taskId, "running", "failed_known", "lease_expired_without_attempt"));
        }
      }
      return touched;
    });
  }

  /* ─────────────────────────────────────────────────────────── attempts */

  private async attemptIn(q: Q, attemptId: string, lock = false): Promise<AttemptRecord | null> {
    if (!isUuid(attemptId)) return null;
    const r = await q.query(`select ${ATTEMPT_COLUMNS} from public.agent_attempts a where a.id = $1${lock ? " for update" : ""}`, [attemptId]);
    return r.rows.length ? toAttempt(r.rows[0]) : null;
  }

  private async attemptsOfTaskIn(q: Q, taskId: string): Promise<AttemptRecord[]> {
    if (!isUuid(taskId)) return [];
    const r = await q.query(`select ${ATTEMPT_COLUMNS} from public.agent_attempts a where a.task_id = $1 order by a.attempt_no`, [taskId]);
    return r.rows.map(toAttempt);
  }

  listAttempts(taskId: string): Promise<AttemptRecord[]> { return this.attemptsOfTaskIn(this.client, taskId); }
  getAttempt(attemptId: string): Promise<AttemptRecord | null> { return this.attemptIn(this.client, attemptId); }

  createAttempt(record: AttemptRecord): Promise<AttemptRecord> {
    return this.client.transaction(async (tx) => {
      if (await this.attemptIn(tx, record.attemptId)) throw new Error(`core-v2: attempt ${record.attemptId} already exists — it is not made twice`);
      const task = await this.taskIn(tx, record.taskId, true);
      if (!task) throw noSuch("task", record.taskId);
      if ((await this.attemptsOfTaskIn(tx, record.taskId)).some((a) => a.attemptNo === record.attemptNo)) throw new Error(`core-v2: attempt ${record.attemptNo} of ${record.taskId} already exists`);
      if (!record.executorFamily || !record.independenceDomain) throw new Error("core-v2: an attempt names its executor family and independence domain");
      const wf = await this.workflowIn(tx, task.workflowId);
      await tx.query(`insert into public.agent_attempts(id, organization_id, workflow_id, task_id, attempt_no, role_key, role_version, executor_kind, executor_family,
          independence_domain, model_configuration, state, lease_token, packet_fingerprint, packet_bytes, provider_request_id, model_reported, usage, raw_result,
          raw_result_hash, validation_state, validation_problems, error_code, error_message, reconciliation_outcome, created_at)
        values ($1, $2, $3, $4, $5::int, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15::int, $16, $17, $18::jsonb, $19::jsonb, $20, $21, $22::jsonb, $23, $24, $25, clock_timestamp())`,
        [record.attemptId, wf?.organizationId ?? ZERO, task.workflowId, record.taskId, record.attemptNo, record.roleKey, record.roleVersion, record.executorKind,
          record.executorFamily, record.independenceDomain, record.modelConfiguration ?? "", record.state, record.leaseToken, record.packetFingerprint, record.packetBytes,
          record.providerRequestId, record.modelReported, JSON.stringify(record.usage ?? {}), jsonParam(record.rawResult), record.rawResultHash, record.validationState,
          JSON.stringify(record.validationProblems ?? []), record.errorCode, record.errorMessage, record.reconciliationOutcome ?? null]);
      return { ...record, workflowId: task.workflowId };
    });
  }

  /* What an executor said about an attempt whose outcome was unknown.
     Written once; "unknown" writes nothing. The column is
     agent_attempts.reconciliation_outcome (see the report: migration 058
     does not carry it yet). */
  recordReconciliation(attemptId: string, outcome: ReconciliationOutcome): Promise<AttemptRecord> {
    return this.client.transaction(async (tx) => {
      const attempt = await this.attemptIn(tx, attemptId, true);
      if (!attempt) throw noSuch("attempt", attemptId);
      if (attempt.state !== "outcome_unknown") throw new Error(`core-v2: attempt ${attemptId} is ${attempt.state}; only an unknown outcome is reconciled`);
      if (outcome === "unknown") return attempt;
      if (attempt.reconciliationOutcome !== null && attempt.reconciliationOutcome !== outcome) throw new Error("core-v2: an attempt's reconciliation is written once");
      const r = await tx.query(`update public.agent_attempts a set reconciliation_outcome = $2 where a.id = $1 and a.state = 'outcome_unknown' returning ${ATTEMPT_COLUMNS}`, [attemptId, outcome]);
      if (!r.rows.length) throw new StaleState("attempt", attemptId, "outcome_unknown", (await this.attemptIn(tx, attemptId))?.state ?? "missing");
      return toAttempt(r.rows[0]);
    });
  }

  /* The one moment money may leave. The double's checks in the double's
     order on the locked rows, then the independence check, then
     core_v2_submit_attempt as the move itself under the same locks. */
  submitAttempt(attemptId: string, leaseToken: string, _now: number): Promise<SubmitOutcome> {
    return this.client.transaction(async (tx): Promise<SubmitOutcome> => {
      const attempt = await this.attemptIn(tx, attemptId, true);
      if (!attempt) return { ok: false, reason: "no such attempt" };
      /* Every blind reading of this attempt's subject is locked here, in id
         order and before this attempt's own task row, so that two workers
         submitting two groups of one subject serialise on the same rows
         instead of racing the independence check below. A task with no
         group locks nothing here and so cannot deadlock with one that does. */
      await tx.query(`select t.id from public.workflow_tasks t
        where t.independence_group is not null
          and (t.workflow_id, t.subject_key) = (select w.workflow_id, w.subject_key from public.workflow_tasks w where w.id = $1)
        order by t.id for update`, [attempt.taskId]);
      const task = await this.taskIn(tx, attempt.taskId, true);
      const wf = task ? await this.workflowIn(tx, task.workflowId) : null;
      if (!task || !wf) return { ok: false, reason: "no such task" };
      if (!ACTIVE_WORKFLOW_STATES.includes(wf.state)) return { ok: false, reason: `workflow is ${wf.state}` };
      if (wf.cancelRequestedAt !== null) return { ok: false, reason: "cancellation was requested" };
      if (task.state !== "running") return { ok: false, reason: `task is ${task.state}` };
      if (task.leaseToken !== leaseToken) return { ok: false, reason: "the lease is not the caller's" };
      const expiry = await tx.query(`select (lease_expires_at is null or lease_expires_at <= now()) as expired from public.workflow_tasks where id = $1`, [task.taskId]);
      if (task.leaseExpiresAt === null || bool(expiry.rows[0]?.expired ?? "t")) return { ok: false, reason: "the lease has expired" };
      if (attempt.state !== "prepared") return { ok: false, reason: `attempt is ${attempt.state}` };
      /* A blind reading is not sent to a domain that already read the subject
         under another group — whatever the router believed when it chose. */
      if (task.independenceGroup) {
        const clash = await tx.query(`select 1 as one from public.agent_attempts a join public.workflow_tasks t on t.id = a.task_id
          where t.workflow_id = $1 and t.subject_key = $2 and t.independence_group is not null and t.independence_group <> $3
            and public.core_v2_attempt_submitted(a.state) and a.independence_domain = $4 limit 1`,
          [task.workflowId, task.subjectKey, task.independenceGroup, attempt.independenceDomain]);
        if (clash.rows.length) return { ok: false, reason: `independence: domain ${attempt.independenceDomain} already read ${task.subjectKey} as another group` };
      }
      await tx.query("savepoint core_v2_submit");
      try {
        await tx.query(`select (public.core_v2_submit_attempt($1, $2)).id as id`, [attemptId, leaseToken]);
        await tx.query("release savepoint core_v2_submit");
      } catch (error) {
        await tx.query("rollback to savepoint core_v2_submit");
        if (isPostgresError(error) && error.message.startsWith("core_v2: submission refused: ")) {
          return { ok: false, reason: submissionReason(error.message.slice("core_v2: submission refused: ".length)) };
        }
        throw error;
      }
      return { ok: true, attempt: (await this.attemptIn(tx, attemptId))! };
    });
  }

  private async transitionAttemptIn(q: Q, attemptId: string, from: AttemptState, to: AttemptState, patch: { errorCode?: string | null; errorMessage?: string | null; usage?: Record<string, unknown> } = {}): Promise<AttemptRecord> {
    if (!attemptMoveAllowed(from, to)) {
      const attempt = await this.attemptIn(q, attemptId);
      if (!attempt) throw noSuch("attempt", attemptId);
      if (attempt.state !== from) throw new StaleState("attempt", attemptId, from, attempt.state);
      throw new IllegalTransition("attempt", from, to);
    }
    if (!isUuid(attemptId)) throw noSuch("attempt", attemptId);
    if (patch.errorCode !== undefined || patch.usage) {
      const attempt = await this.attemptIn(q, attemptId);
      if (!attempt) throw noSuch("attempt", attemptId);
      if (attempt.state !== from) throw new StaleState("attempt", attemptId, from, attempt.state);
      if (attempt.errorCode !== null && patch.errorCode !== undefined && patch.errorCode !== attempt.errorCode) throw new Error("core-v2: an attempt's error is written once");
      if (Object.keys(attempt.usage).length && patch.usage && canonical(patch.usage) !== canonical(attempt.usage)) throw new Error("core-v2: the recorded usage of an attempt cannot be replaced");
    }
    const r = await q.query(`update public.agent_attempts a
        set state = $3::text, error_code = coalesce($4, error_code), error_message = coalesce($5, error_message), usage = coalesce($6::jsonb, usage),
            submitted_at = case when $3::text = 'submitted' and submitted_at is null then now() else submitted_at end,
            received_at = case when $3::text in ('response_received','output_limited') and received_at is null then now() else received_at end,
            finished_at = case when $3::text in ('succeeded','failed_known','output_limited','outcome_unknown','rejected_before_submission','cancelled_before_submission')
                          then now() else finished_at end
      where a.id = $1 and a.state = $2 returning ${ATTEMPT_COLUMNS}`,
      [attemptId, from, to, patch.errorCode ?? null, patch.errorMessage ?? null, patch.usage ? JSON.stringify(patch.usage) : null]);
    if (r.rows.length) return toAttempt(r.rows[0]);
    const attempt = await this.attemptIn(q, attemptId);
    if (!attempt) throw noSuch("attempt", attemptId);
    throw new StaleState("attempt", attemptId, from, attempt.state);
  }

  transitionAttempt(attemptId: string, from: AttemptState, to: AttemptState, patch: { errorCode?: string | null; errorMessage?: string | null; usage?: Record<string, unknown> } = {}): Promise<AttemptRecord> {
    return this.client.transaction((tx) => this.transitionAttemptIn(tx, attemptId, from, to, patch));
  }

  async independenceDomainsForSubject(workflowId: string, subjectKey: string): Promise<string[]> {
    if (!isUuid(workflowId)) return [];
    const r = await this.client.query(`select a.independence_domain as domain, min(a.created_at) as first_seen
      from public.agent_attempts a join public.workflow_tasks t on t.id = a.task_id
      where t.workflow_id = $1 and t.subject_key = $2 and t.independence_group is not null and public.core_v2_attempt_submitted(a.state)
      group by a.independence_domain order by first_seen, domain`, [workflowId, subjectKey]);
    return r.rows.map((row) => row.domain!);
  }

  /* Everything one answer makes true, or nothing. A second commit of the
     same attempt returns what the first wrote. */
  commitValidatedResult(commit: ResultCommit): Promise<CommitOutcome> {
    return this.client.transaction(async (tx) => {
      const attempt = await this.attemptIn(tx, commit.attemptId, true);
      if (!attempt) throw noSuch("attempt", commit.attemptId);
      if (TERMINAL_ATTEMPT_STATES.includes(attempt.state)) {
        const disagreements: DisagreementRecord[] = [];
        for (const d of commit.disagreements) { const x = await this.disagreementIn(tx, d.disagreementId); if (x) disagreements.push(x); }
        const children: TaskRecord[] = [];
        for (const c of commit.children) { const x = await this.taskIn(tx, c.taskId); if (x) children.push(x); }
        const decisions: DecisionRecord[] = [];
        for (const d of commit.decisions) { const x = await this.decisionIn(tx, d.decision.decisionId); if (x) decisions.push(x); }
        return {
          alreadyCommitted: true,
          claims: await this.claimsWhere(tx, "c.attempt_id = $1", [commit.attemptId]),
          assessments: await this.assessmentsWhere(tx, "s.attempt_id = $1", [commit.attemptId]),
          disagreements,
          segments: { created: [], reused: (await tx.query(`select ${SEGMENT_COLUMNS} from public.source_segments s where s.discovered_by_attempt_id = $1 order by s.created_at, s.id`, [commit.attemptId])).rows.map(toSegment) },
          children: { created: [], reused: children, refused: [] },
          decisions,
          followUpsRefused: [],
        };
      }
      return this.applyCommitIn(tx, commit, attempt);
    });
  }

  private async applyCommitIn(q: Q, commit: ResultCommit, attempt: AttemptRecord): Promise<CommitOutcome> {
    const wf = await this.workflowIn(q, commit.workflowId, true);
    const organizationId = wf?.organizationId ?? ZERO;
    const task = await this.taskIn(q, commit.taskId, true);
    if (!task || task.taskId !== attempt.taskId) throw new Error("core-v2: the commit names a task that is not the attempt's");
    if (task.state !== "running") throw new StaleState("task", task.taskId, "running", task.state);
    if (!SUBMITTED_ATTEMPT_STATES.includes(attempt.state)) throw new Error(`core-v2: attempt ${attempt.attemptId} is ${attempt.state} — only a submitted attempt has a result`);
    if (attempt.rawResult !== null && attempt.rawResult !== undefined && attempt.rawResultHash !== commit.attempt.rawResultHash) throw new Error("core-v2: a stored result is not replaced");

    /* The attempt: raw result and what the executor saw of the thing that
       answered it, written once, then its states in order. coalesce keeps the
       write-once rule the schema also keeps: a fact already on the row stands,
       and a fact the executor could not give leaves the row as it was. */
    const facts = commit.attempt.providerFacts ?? {};
    await q.query(`update public.agent_attempts set raw_result = $2::jsonb, raw_result_hash = $3, validation_state = $4, validation_problems = $5::jsonb,
        provider_request_id = coalesce(provider_request_id, $6), model_reported = coalesce(model_reported, $7),
        usage = case when usage = '{}'::jsonb then $8::jsonb else usage end,
        provider_stop_reason = coalesce(provider_stop_reason, $9),
        provider_duration_ms = coalesce(provider_duration_ms, $10),
        provider_response = coalesce(provider_response, $11::jsonb)
      where id = $1`,
      [attempt.attemptId, jsonParam(commit.attempt.rawResult), commit.attempt.rawResultHash, commit.attempt.validationState,
       JSON.stringify(commit.attempt.validationProblems ?? []),
       facts.requestId ?? null, facts.modelReported ?? null, JSON.stringify(facts.usage ?? {}),
       facts.stopReason ?? null, facts.durationMs ?? null,
       facts.response === undefined ? null : jsonParam(facts.response)]);
    let current = (await this.attemptIn(q, attempt.attemptId))!;
    const path: AttemptState[] = commit.attempt.to === "succeeded" ? ["response_received", "parsed", "succeeded"]
      : commit.attempt.to === "failed_known" ? (current.state === "submitted" ? ["response_received", "failed_known"] : ["failed_known"])
      : [commit.attempt.to];
    for (const to of path) {
      if (current.state === to) continue;
      current = await this.transitionAttemptIn(q, current.attemptId, current.state, to, to === commit.attempt.to ? { errorCode: commit.attempt.errorCode, errorMessage: commit.attempt.errorMessage } : {});
    }

    const segments = await this.persistSegmentsIn(q, organizationId, commit.workflowId, commit.segments);
    const claims = await this.writeClaimsIn(q, organizationId, commit.claims, commit.workflowId);
    const assessments = await this.writeAssessmentsIn(q, organizationId, commit.assessments, commit.workflowId);
    const disagreements = await this.writeDisagreementsIn(q, organizationId, commit.disagreements, commit.workflowId);
    for (const t of commit.claimTransitions) await this.transitionClaimIn(q, t.claimId, t.from, t.to);
    for (const r of commit.disagreementRounds) {
      const d = await this.disagreementIn(q, r.disagreementId);
      if (!d) throw noSuch("disagreement", r.disagreementId);
      if ((r.criticRounds ?? d.criticRounds) < d.criticRounds || (r.arbiterRounds ?? d.arbiterRounds) < d.arbiterRounds) throw new Error("core-v2: rounds never decrease");
      await q.query(`update public.disagreements set critic_rounds = $2::int, arbiter_rounds = $3::int where id = $1`, [d.disagreementId, r.criticRounds ?? d.criticRounds, r.arbiterRounds ?? d.arbiterRounds]);
    }
    const decisions: DecisionRecord[] = [];
    for (const a of commit.decisions) decisions.push(await this.applyDecisionIn(q, a));
    for (const t of commit.disagreementTransitions) await this.transitionDisagreementIn(q, t);
    const children = await this.admitTasksIn(q, commit.workflowId, commit.children, commit.limits);
    for (const d of commit.dependencies) {
      const dependent = await this.taskIn(q, d.taskId);
      if (!dependent || !["created", "blocked", "queued"].includes(dependent.state)) continue;
      if (!(await this.taskExistsIn(q, d.dependsOnTaskId))) continue;
      await this.addDependencyIn(q, d.taskId, d.dependsOnTaskId, d.kind, commit.limits);
    }
    const followUpsRefused: { disagreementId: string; round: number; reason: string }[] = [];
    for (const f of commit.followUps) {
      const d = await this.disagreementIn(q, f.disagreementId);
      if (!d) throw noSuch("disagreement", f.disagreementId);
      if (d.followUps.some((x) => x.fingerprint === f.fingerprint)) { followUpsRefused.push({ disagreementId: f.disagreementId, round: f.round, reason: "the same follow-up was already admitted" }); continue; }
      if (d.followUps.some((x) => x.round === f.round)) { followUpsRefused.push({ disagreementId: f.disagreementId, round: f.round, reason: `round ${f.round} already has its one follow-up` }); continue; }
      await q.query(`insert into public.disagreement_follow_ups(organization_id, disagreement_id, round, fingerprint, task_id, created_at) values ($1, $2, $3::int, $4, $5, clock_timestamp())`,
        [organizationId, f.disagreementId, f.round, f.fingerprint, f.taskId]);
    }
    for (const t of commit.taskTransitions) await this.transitionTaskIn(q, t.taskId, t.from, t.to, t.reason);
    await this.transitionTaskIn(q, task.taskId, "running", commit.task.to, commit.task.reason);
    for (const a of commit.audits) await this.auditIn(q, organizationId, a);
    return { alreadyCommitted: false, claims, assessments, disagreements, segments, children, decisions, followUpsRefused };
  }

  private async anchorExistsIn(q: Q, anchorId: string): Promise<boolean> {
    if (!isUuid(anchorId)) return false;
    const r = await q.query(`select 1 as one from public.evidence_anchors where id = $1`, [anchorId]);
    return r.rows.length > 0;
  }

  private async writeAnchorsIn(q: Q, organizationId: string, anchors: NewAnchor[], workflowId: string, owner: { claimId: string | null; assessmentId: string | null }): Promise<string[]> {
    const ids: string[] = [];
    for (const a of anchors) {
      if (await this.anchorExistsIn(q, a.anchorId)) throw new Error(`core-v2: anchor ${a.anchorId} already exists`);
      const problem = locatorProblem(a.locator);
      if (problem) throw new Error(`core-v2: anchor ${a.anchorId}: ${problem}`);
      let sourceId = a.sourceId;
      if (a.segmentId) {
        const segment = await this.segmentIn(q, a.segmentId);
        if (!segment) throw new Error(`core-v2: anchor names segment ${a.segmentId}, which does not exist`);
        if (segment.workflowId !== workflowId) throw new Error("core-v2: anchor names a segment of another workflow");
        if (sourceId && sourceId !== segment.sourceId) throw new Error("core-v2: anchor combines a segment of one source with another source's id");
        sourceId = segment.sourceId;
        if (!locatorInside(a.locator, segment.locator)) throw new Error("core-v2: anchor locator lies outside the segment it names");
      } else if (sourceId && !(await this.sourceIdsIn(q, workflowId)).has(sourceId)) {
        throw new Error("core-v2: anchor names a source this workflow does not read");
      }
      await q.query(`insert into public.evidence_anchors(id, organization_id, workflow_id, claim_id, assessment_id, source_kind, source_id, segment_id, locator, quoted_text, anchor_hash, created_at)
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, clock_timestamp())`,
        [a.anchorId, organizationId, workflowId, owner.claimId, owner.assessmentId, a.sourceKind, sourceId, a.segmentId, JSON.stringify(a.locator ?? {}), a.quotedText, a.anchorHash]);
      ids.push(a.anchorId);
    }
    return ids;
  }

  private async claimExistsIn(q: Q, claimId: string): Promise<boolean> {
    if (!isUuid(claimId)) return false;
    const r = await q.query(`select 1 as one from public.evidence_claims where id = $1`, [claimId]);
    return r.rows.length > 0;
  }

  private async writeClaimsIn(q: Q, organizationId: string, claims: NewClaim[], workflowId: string): Promise<ClaimRecord[]> {
    const out: ClaimRecord[] = [];
    for (const c of claims) {
      if (await this.claimExistsIn(q, c.claimId)) throw new Error(`core-v2: claim ${c.claimId} already exists`);
      for (const id of c.inputClaimIds) if (!(await this.claimExistsIn(q, id))) throw new Error(`core-v2: claim names input ${id}, which does not exist`);
      const { anchors, ...rest } = c;
      await q.query(`insert into public.evidence_claims(id, organization_id, workflow_id, task_id, attempt_id, independence_group, independence_domain, subject_type, subject_key,
          predicate, value, unit, observation_basis, scope, status, machine_confidence, supersedes_claim_id, incomplete_source_attempt, created_at)
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12, $13, $14::jsonb, $15, $16::numeric, $17, $18::boolean, clock_timestamp())`,
        [c.claimId, organizationId, workflowId, c.taskId, c.attemptId, c.independenceGroup, c.independenceDomain, c.subjectType, c.subjectKey, c.predicate,
          JSON.stringify(c.value ?? {}), c.unit, c.observationBasis, JSON.stringify(c.scope ?? {}), c.status, c.machineConfidence, c.supersedesClaimId, c.incompleteSourceAttempt]);
      for (const id of c.inputClaimIds) {
        await q.query(`insert into public.claim_inputs(organization_id, claim_id, input_claim_id, created_at) values ($1, $2, $3, clock_timestamp())`, [organizationId, c.claimId, id]);
      }
      const anchorIds = await this.writeAnchorsIn(q, organizationId, anchors, workflowId, { claimId: c.claimId, assessmentId: null });
      out.push({ ...rest, workflowId, anchorIds });
    }
    return out;
  }

  private async writeAssessmentsIn(q: Q, organizationId: string, assessments: NewAssessment[], workflowId: string): Promise<AssessmentRecord[]> {
    const out: AssessmentRecord[] = [];
    for (const a of assessments) {
      if (isUuid(a.assessmentId) && (await q.query(`select 1 as one from public.claim_assessments where id = $1`, [a.assessmentId])).rows.length) throw new Error(`core-v2: assessment ${a.assessmentId} already exists`);
      if (!(await this.claimExistsIn(q, a.claimId))) throw new Error(`core-v2: assessment names claim ${a.claimId}, which does not exist`);
      if (isUuid(a.attemptId) && isUuid(a.claimId) && (await q.query(`select 1 as one from public.claim_assessments where attempt_id = $1 and claim_id = $2`, [a.attemptId, a.claimId])).rows.length) throw new Error("core-v2: one verdict per claim per attempt");
      const { anchors, ...rest } = a;
      await q.query(`insert into public.claim_assessments(id, organization_id, workflow_id, claim_id, attempt_id, task_id, assessment, reason_code, explanation, proposed_value, proposed_unit, created_at)
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, clock_timestamp())`,
        [a.assessmentId, organizationId, workflowId, a.claimId, a.attemptId, a.taskId, a.assessment, a.reasonCode, a.explanation,
         a.proposedValue === null || a.proposedValue === undefined ? null : JSON.stringify(a.proposedValue), a.proposedUnit ?? null]);
      const anchorIds = await this.writeAnchorsIn(q, organizationId, anchors, workflowId, { claimId: null, assessmentId: a.assessmentId });
      out.push({ ...rest, workflowId, anchorIds });
    }
    return out;
  }

  private async disagreementByKeyIn(q: Q, workflowId: string, key: string): Promise<DisagreementRecord | null> {
    if (!isUuid(workflowId)) return null;
    return first(await this.disagreementsWhere(q, "d.workflow_id = $1 and d.disagreement_key = $2", [workflowId, key]) as unknown as Row[]) as unknown as DisagreementRecord | null;
  }

  private async writeDisagreementsIn(q: Q, organizationId: string, disagreements: NewDisagreement[], workflowId: string): Promise<DisagreementRecord[]> {
    const out: DisagreementRecord[] = [];
    for (const d of disagreements) {
      const existing = await this.disagreementByKeyIn(q, workflowId, d.disagreementKey);
      if (existing) { out.push(existing); continue; }
      const claims: ClaimRecord[] = [];
      for (const claimId of d.claimIds) {
        const claim = await this.claimIn(q, claimId);
        if (!claim) throw new Error(`core-v2: disagreement names claim ${claimId}, which does not exist`);
        if (claim.workflowId !== workflowId) throw new Error("core-v2: disagreement compares a claim of another workflow");
        claims.push(claim);
      }
      await q.query(`insert into public.disagreements(id, organization_id, workflow_id, disagreement_key, kind, subject_signature, severity, state, critic_rounds, arbiter_rounds, created_at)
        values ($1, $2, $3, $4, $5, $6::jsonb, $7, 'open', 0, 0, clock_timestamp())`,
        [d.disagreementId, organizationId, workflowId, d.disagreementKey, d.kind, JSON.stringify(d.subjectSignature ?? {}), d.severity]);
      for (let i = 0; i < d.claimIds.length; i++) {
        await q.query(`insert into public.disagreement_claims(organization_id, disagreement_id, claim_id, position, role) values ($1, $2, $3, $4::int, 'candidate')`,
          [organizationId, d.disagreementId, d.claimIds[i], i]);
      }
      const record: DisagreementRecord = { ...d, workflowId, state: "open", resolutionDecisionId: null, criticRounds: 0, arbiterRounds: 0, followUps: [], needsHumanReason: null };
      for (const claim of claims) {
        if (claimMoveAllowed(claim.status, "disputed")) await q.query(`update public.evidence_claims set status = 'disputed' where id = $1 and status = $2`, [claim.claimId, claim.status]);
      }
      out.push(record);
    }
    return out;
  }

  /* ─────────────────────────────────────────────────────────── evidence */

  private async claimsWhere(q: Q, where: string, params: Param[], order = "c.created_at, c.id"): Promise<ClaimRecord[]> {
    const r = await q.query(`select ${CLAIM_COLUMNS} from public.evidence_claims c where ${where} order by ${order}`, params);
    if (!r.rows.length) return [];
    const ids = uuids(r.rows.map((row) => row.id!));
    const anchors = await q.query(`select id, claim_id from public.evidence_anchors where claim_id = any($1::uuid[]) order by created_at, id`, [ids]);
    const inputs = await q.query(`select claim_id, input_claim_id from public.claim_inputs where claim_id = any($1::uuid[]) order by created_at, input_claim_id`, [ids]);
    const anchorsOf = new Map<string, string[]>();
    for (const a of anchors.rows) { const list = anchorsOf.get(a.claim_id!) ?? []; list.push(a.id!); anchorsOf.set(a.claim_id!, list); }
    const inputsOf = new Map<string, string[]>();
    for (const i of inputs.rows) { const list = inputsOf.get(i.claim_id!) ?? []; list.push(i.input_claim_id!); inputsOf.set(i.claim_id!, list); }
    return r.rows.map((row) => toClaim(row, anchorsOf.get(row.id!) ?? [], inputsOf.get(row.id!) ?? []));
  }

  private async claimIn(q: Q, claimId: string): Promise<ClaimRecord | null> {
    if (!isUuid(claimId)) return null;
    return first(await this.claimsWhere(q, "c.id = $1", [claimId]) as unknown as Row[]) as unknown as ClaimRecord | null;
  }

  listClaims(filter: ClaimFilter): Promise<ClaimRecord[]> {
    const clauses: string[] = ["true"];
    const params: Param[] = [];
    const add = (clause: (n: number) => string, value: Param) => { params.push(value); clauses.push(clause(params.length)); };
    if (filter.workflowId) { if (!isUuid(filter.workflowId)) return Promise.resolve([]); add((n) => `c.workflow_id = $${n}`, filter.workflowId); }
    if (filter.taskIds) add((n) => `c.task_id = any($${n}::uuid[])`, uuids(filter.taskIds));
    if (filter.attemptIds) add((n) => `c.attempt_id = any($${n}::uuid[])`, uuids(filter.attemptIds));
    if (filter.subjectKey) add((n) => `c.subject_key = $${n}`, filter.subjectKey);
    if (filter.subjectKeyPrefix) add((n) => `starts_with(c.subject_key, $${n})`, filter.subjectKeyPrefix);
    if (filter.statuses) add((n) => `c.status = any($${n}::text[])`, texts(filter.statuses));
    if (filter.subjectTypes) add((n) => `c.subject_type = any($${n}::text[])`, texts(filter.subjectTypes));
    return this.claimsWhere(this.client, clauses.join(" and "), params);
  }

  getClaim(claimId: string): Promise<ClaimRecord | null> { return this.claimIn(this.client, claimId); }

  private async transitionClaimIn(q: Q, claimId: string, from: ClaimStatus, to: ClaimStatus): Promise<ClaimRecord> {
    if (!claimMoveAllowed(from, to)) {
      const claim = await this.claimIn(q, claimId);
      if (!claim) throw noSuch("claim", claimId);
      if (claim.status !== from) throw new StaleState("claim", claimId, from, claim.status);
      throw new IllegalTransition("claim", from, to);
    }
    if (!isUuid(claimId)) throw noSuch("claim", claimId);
    if (to === "accepted" || to === "verified" || to === "superseded") {
      const claim = await this.claimIn(q, claimId);
      if (!claim) throw noSuch("claim", claimId);
      if (claim.status !== from) throw new StaleState("claim", claimId, from, claim.status);
      if ((to === "accepted" || to === "verified") && claim.anchorIds.length === 0) throw new Error(`core-v2: claim ${claimId} has nothing to open — it is not ${to}`);
      if (to === "accepted" && claim.incompleteSourceAttempt) throw new Error(`core-v2: claim ${claimId} came from a cut-short attempt`);
      if (to === "superseded") {
        const standing = await q.query(`select d.id from public.decision_evidence e join public.decisions d on d.id = e.decision_id
          where e.claim_id = $1 and e.link = 'supports' and d.status in ('machine_decided','human_decided') order by d.created_at, d.id limit 1`, [claimId]);
        if (standing.rows.length) throw new Error(`core-v2: claim ${claimId} is under standing decision ${standing.rows[0].id} — supersede the decision in the same breath`);
      }
    }
    const r = await q.query(`update public.evidence_claims c set status = $3 where c.id = $1 and c.status = $2 returning c.id`, [claimId, from, to]);
    if (r.rows.length) return (await this.claimIn(q, claimId))!;
    const claim = await this.claimIn(q, claimId);
    if (!claim) throw noSuch("claim", claimId);
    throw new StaleState("claim", claimId, from, claim.status);
  }

  transitionClaim(claimId: string, from: ClaimStatus, to: ClaimStatus): Promise<ClaimRecord> {
    return this.client.transaction((tx) => this.transitionClaimIn(tx, claimId, from, to));
  }

  async listAnchors(claimIds: string[]): Promise<AnchorRecord[]> {
    const r = await this.client.query(`select ${ANCHOR_COLUMNS} from public.evidence_anchors a where a.claim_id = any($1::uuid[]) order by a.created_at, a.id`, [uuids(claimIds)]);
    return r.rows.map(toAnchor);
  }

  async listAssessmentAnchors(assessmentIds: string[]): Promise<AnchorRecord[]> {
    const r = await this.client.query(`select ${ANCHOR_COLUMNS} from public.evidence_anchors a where a.assessment_id = any($1::uuid[]) order by a.created_at, a.id`, [uuids(assessmentIds)]);
    return r.rows.map(toAnchor);
  }

  private async assessmentsWhere(q: Q, where: string, params: Param[]): Promise<AssessmentRecord[]> {
    const r = await q.query(`select ${ASSESSMENT_COLUMNS} from public.claim_assessments s left join public.agent_attempts at on at.id = s.attempt_id where ${where} order by s.created_at, s.id`, params);
    if (!r.rows.length) return [];
    const anchors = await q.query(`select id, assessment_id from public.evidence_anchors where assessment_id = any($1::uuid[]) order by created_at, id`, [uuids(r.rows.map((row) => row.id!))]);
    const anchorsOf = new Map<string, string[]>();
    for (const a of anchors.rows) { const list = anchorsOf.get(a.assessment_id!) ?? []; list.push(a.id!); anchorsOf.set(a.assessment_id!, list); }
    return r.rows.map((row) => toAssessment(row, anchorsOf.get(row.id!) ?? []));
  }

  listAssessments(claimIds: string[]): Promise<AssessmentRecord[]> {
    return this.assessmentsWhere(this.client, "s.claim_id = any($1::uuid[])", [uuids(claimIds)]);
  }

  /* ──────────────────────────────────────────────────────── disagreements */

  private async disagreementsWhere(q: Q, where: string, params: Param[]): Promise<DisagreementRecord[]> {
    const r = await q.query(`select ${DISAGREEMENT_COLUMNS} from public.disagreements d where ${where} order by d.created_at, d.id`, params);
    if (!r.rows.length) return [];
    const ids = uuids(r.rows.map((row) => row.id!));
    const claims = await q.query(`select disagreement_id, claim_id from public.disagreement_claims where disagreement_id = any($1::uuid[]) order by disagreement_id, position, claim_id`, [ids]);
    const followUps = await q.query(`select disagreement_id, round, fingerprint, task_id from public.disagreement_follow_ups where disagreement_id = any($1::uuid[]) order by disagreement_id, created_at, round`, [ids]);
    const claimsOf = new Map<string, string[]>();
    for (const c of claims.rows) { const list = claimsOf.get(c.disagreement_id!) ?? []; list.push(c.claim_id!); claimsOf.set(c.disagreement_id!, list); }
    const followUpsOf = new Map<string, DisagreementRecord["followUps"]>();
    for (const f of followUps.rows) { const list = followUpsOf.get(f.disagreement_id!) ?? []; list.push({ round: int(f.round), fingerprint: f.fingerprint!, taskId: f.task_id }); followUpsOf.set(f.disagreement_id!, list); }
    return r.rows.map((row) => toDisagreement(row, claimsOf.get(row.id!) ?? [], followUpsOf.get(row.id!) ?? []));
  }

  private async disagreementIn(q: Q, disagreementId: string): Promise<DisagreementRecord | null> {
    if (!isUuid(disagreementId)) return null;
    return first(await this.disagreementsWhere(q, "d.id = $1", [disagreementId]) as unknown as Row[]) as unknown as DisagreementRecord | null;
  }

  getDisagreement(disagreementId: string): Promise<DisagreementRecord | null> { return this.disagreementIn(this.client, disagreementId); }

  listDisagreements(workflowId: string): Promise<DisagreementRecord[]> {
    if (!isUuid(workflowId)) return Promise.resolve([]);
    return this.disagreementsWhere(this.client, "d.workflow_id = $1", [workflowId]);
  }

  private async transitionDisagreementIn(q: Q, t: DisagreementTransition): Promise<DisagreementRecord> {
    if (!disagreementMoveAllowed(t.from, t.to)) {
      const d = await this.disagreementIn(q, t.disagreementId);
      if (!d) throw noSuch("disagreement", t.disagreementId);
      if (d.state !== t.from) throw new StaleState("disagreement", t.disagreementId, t.from, d.state);
      throw new IllegalTransition("disagreement", t.from, t.to);
    }
    if (!isUuid(t.disagreementId)) throw noSuch("disagreement", t.disagreementId);
    if (t.to === "resolved") {
      const d = await this.disagreementIn(q, t.disagreementId);
      if (!d) throw noSuch("disagreement", t.disagreementId);
      if (d.state !== t.from) throw new StaleState("disagreement", t.disagreementId, t.from, d.state);
      const resolution = t.resolutionDecisionId ?? d.resolutionDecisionId;
      if (!resolution) throw new Error("core-v2: a resolved disagreement names the decision that resolved it");
      if (!(await this.decisionIn(q, resolution))) throw new Error("core-v2: a resolved disagreement names a decision that exists");
    }
    const r = await q.query(`update public.disagreements d
        set state = $3::text, resolution_decision_id = coalesce($4::uuid, resolution_decision_id), needs_human_reason = coalesce($5, needs_human_reason)
      where d.id = $1 and d.state = $2 returning d.id`, [t.disagreementId, t.from, t.to, isUuid(t.resolutionDecisionId ?? "") ? t.resolutionDecisionId : null, t.needsHumanReason ?? null]);
    if (r.rows.length) return (await this.disagreementIn(q, t.disagreementId))!;
    const d = await this.disagreementIn(q, t.disagreementId);
    if (!d) throw noSuch("disagreement", t.disagreementId);
    throw new StaleState("disagreement", t.disagreementId, t.from, d.state);
  }

  transitionDisagreement(t: DisagreementTransition): Promise<DisagreementRecord> {
    return this.client.transaction((tx) => this.transitionDisagreementIn(tx, t));
  }

  holdSubject(hold: SubjectHold): Promise<HoldOutcome> {
    return this.client.transaction(async (tx) => {
      const wf = await this.workflowIn(tx, hold.workflowId, true);
      const existing = await this.disagreementByKeyIn(tx, hold.workflowId, hold.disagreement.disagreementKey);
      if (existing) return { alreadyHeld: true, disagreement: existing, decision: await this.decisionIn(tx, hold.decision.decision.decisionId) };
      await this.writeDisagreementsIn(tx, wf?.organizationId ?? ZERO, [hold.disagreement], hold.workflowId);
      const decision = await this.applyDecisionIn(tx, hold.decision);
      const disagreement = await this.transitionDisagreementIn(tx, hold.transition);
      for (const a of hold.audits) await this.auditIn(tx, wf?.organizationId ?? ZERO, a);
      return { alreadyHeld: false, disagreement, decision };
    });
  }

  /* ──────────────────────────────────────────────────────────── decisions */

  private async decisionsWhere(q: Q, where: string, params: Param[]): Promise<DecisionRecord[]> {
    const r = await q.query(`select ${DECISION_COLUMNS} from public.decisions d where ${where} order by d.created_at, d.id`, params);
    if (!r.rows.length) return [];
    const ids = uuids(r.rows.map((row) => row.id!));
    const evidence = await q.query(`select decision_id, claim_id, anchor_id, link, rule from public.decision_evidence where decision_id = any($1::uuid[]) order by decision_id, created_at, id`, [ids]);
    const actions = await q.query(`select decision_id, action_type, owner_role from public.decision_actions where decision_id = any($1::uuid[]) order by decision_id, created_at, id`, [ids]);
    const evidenceOf = new Map<string, DecisionRecord["evidence"]>();
    for (const e of evidence.rows) { const list = evidenceOf.get(e.decision_id!) ?? []; list.push({ claimId: e.claim_id, anchorId: e.anchor_id, link: e.link as "supports" | "contradicts" | "context", rule: e.rule }); evidenceOf.set(e.decision_id!, list); }
    const actionsOf = new Map<string, DecisionRecord["actions"]>();
    for (const a of actions.rows) { const list = actionsOf.get(a.decision_id!) ?? []; list.push({ actionType: a.action_type as DecisionRecord["actions"][number]["actionType"], ownerRole: a.owner_role! }); actionsOf.set(a.decision_id!, list); }
    return r.rows.map((row) => toDecision(row, evidenceOf.get(row.id!) ?? [], actionsOf.get(row.id!) ?? []));
  }

  private async decisionIn(q: Q, decisionId: string): Promise<DecisionRecord | null> {
    if (!isUuid(decisionId)) return null;
    return first(await this.decisionsWhere(q, "d.id = $1", [decisionId]) as unknown as Row[]) as unknown as DecisionRecord | null;
  }

  private async applyDecisionIn(q: Q, application: DecisionApplication): Promise<DecisionRecord> {
    const { decision, decideTo } = application;
    const existing = await this.decisionIn(q, decision.decisionId);
    if (existing) {
      if (canonical({ ...existing, status: null }) !== canonical({ ...decision, status: null })) throw new Error(`core-v2: decision ${decision.decisionId} already exists with different content`);
      return existing;
    }
    if (decision.status !== "proposed") throw new Error("core-v2: a decision is written proposed and then decided");
    for (const e of decision.evidence) {
      if (e.claimId && !(await this.claimExistsIn(q, e.claimId))) throw new Error(`core-v2: decision cites claim ${e.claimId}, which does not exist`);
      if (e.anchorId) {
        const anchor = isUuid(e.anchorId) ? first((await q.query(`select claim_id from public.evidence_anchors where id = $1`, [e.anchorId])).rows) : null;
        if (!anchor) throw new Error(`core-v2: decision cites anchor ${e.anchorId}, which does not exist`);
        if (e.claimId && anchor.claim_id !== e.claimId) throw new Error("core-v2: that anchor belongs to another claim — a decision cites a claim through its own source");
      }
    }
    if (decision.disagreementId && !(await this.disagreementIn(q, decision.disagreementId))) throw new Error("core-v2: decision settles a disagreement that does not exist");
    const wf = await this.workflowIn(q, decision.workflowId);
    if (!wf) throw noSuch("workflow", decision.workflowId);
    await q.query(`insert into public.decisions(id, organization_id, workflow_id, task_id, disagreement_id, decision_type, subject_key, title, summary, status, authority,
        rationale, risk_level, decided_by_attempt_id, created_at)
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, 'proposed', $10, $11, $12, $13, clock_timestamp())`,
      [decision.decisionId, wf.organizationId, decision.workflowId, decision.taskId, decision.disagreementId, decision.decisionType, decision.subjectKey ?? "",
        decision.title, JSON.stringify(decision.summary ?? {}), decision.authority, decision.rationale ?? "", decision.riskLevel, decision.decidedByAttemptId]);
    for (const e of decision.evidence) {
      await q.query(`insert into public.decision_evidence(organization_id, decision_id, claim_id, anchor_id, link, rule, created_at) values ($1, $2, $3, $4, $5, $6, clock_timestamp())`,
        [wf.organizationId, decision.decisionId, e.claimId, e.anchorId, e.link, e.rule]);
    }
    for (const a of decision.actions) {
      await q.query(`insert into public.decision_actions(organization_id, decision_id, action_type, owner_role, created_at) values ($1, $2, $3, $4, clock_timestamp())`,
        [wf.organizationId, decision.decisionId, a.actionType, a.ownerRole]);
    }
    let record: DecisionRecord = { ...decision };
    if (decideTo) {
      if (!decisionMoveAllowed("proposed", decideTo)) throw new IllegalTransition("decision", "proposed", decideTo);
      if (decideTo === "machine_decided") {
        if (!record.decidedByAttemptId || !(await this.attemptIn(q, record.decidedByAttemptId))) throw new Error(`core-v2: decision ${record.decisionId} is machine decided by no attempt`);
        await this.assertDecisionRestsIn(q, record);
      }
      await q.query(`update public.decisions d
          set status = $2::text, effective_at = case when $2::text in ('machine_decided','human_decided') and effective_at is null then now() else effective_at end
        where d.id = $1 and d.status = 'proposed'`, [record.decisionId, decideTo]);
      record = { ...record, status: decideTo };
    }
    return record;
  }

  private async assertDecisionRestsIn(q: Q, d: DecisionRecord): Promise<void> {
    if (d.decisionType === "supersede") return;
    if (d.decisionType === "reject_all") {
      const dis = d.disagreementId ? await this.disagreementIn(q, d.disagreementId) : null;
      if (!dis) throw new Error(`core-v2: decision ${d.decisionId} rejects everything but settles no disagreement`);
      const contradicted = new Set(d.evidence.filter((e) => e.link === "contradicts" && e.claimId).map((e) => e.claimId));
      if (dis.claimIds.some((id) => !contradicted.has(id))) throw new Error(`core-v2: decision ${d.decisionId} rejects ${dis.claimIds.length} claims but names fewer of them`);
      let sourced = false;
      for (const e of d.evidence) if (e.link === "context" && e.anchorId && (await this.anchorExistsIn(q, e.anchorId))) { sourced = true; break; }
      if (!sourced) throw new Error("core-v2: rejecting every reading needs source evidence the record holds");
      return;
    }
    const supporting = d.evidence.filter((e) => e.link === "supports" && e.claimId).map((e) => e.claimId!);
    const accepted = supporting.length
      ? (await q.query(`select 1 as one from public.evidence_claims where id = any($1::uuid[]) and status = 'accepted' limit 1`, [uuids(supporting)])).rows.length > 0
      : false;
    if (!accepted) throw new Error(`core-v2: decision ${d.decisionId} rests on no accepted claim`);
  }

  applyDecision(application: DecisionApplication): Promise<DecisionRecord> {
    return this.client.transaction((tx) => this.applyDecisionIn(tx, application));
  }

  listDecisions(workflowId: string): Promise<DecisionRecord[]> {
    if (!isUuid(workflowId)) return Promise.resolve([]);
    return this.decisionsWhere(this.client, "d.workflow_id = $1", [workflowId]);
  }

  getDecision(decisionId: string): Promise<DecisionRecord | null> { return this.decisionIn(this.client, decisionId); }

  /* ─────────────────────────────────────────────────────────────── audit */

  private async auditIn(q: Q, organizationId: string, record: AuditRecord): Promise<void> {
    await q.query(`insert into public.audit_events(organization_id, actor_id, action, entity_type, entity_id, detail) values ($1, null, $2, $3, $4, $5::jsonb)`,
      [organizationId, record.action, record.entityType, record.entityId, JSON.stringify(record.detail ?? {})]);
  }

  /* An audit row belongs to an organisation. The configured one, when
     given; otherwise the organisation of the workflow the record names, by
     its detail or by the entity it is about. */
  private async organizationForAudit(q: Q, record: AuditRecord): Promise<string | null> {
    if (this.organizationId) return this.organizationId;
    const detail = record.detail ?? {};
    const named = [detail.workflowId, detail.workflow_id, detail.workflow].find((v) => typeof v === "string" && isUuid(v)) as string | undefined;
    if (named) { const wf = await this.workflowIn(q, named); if (wf) return wf.organizationId; }
    if (!isUuid(record.entityId)) return null;
    const table: Record<string, string> = {
      intelligence_workflow: "intelligence_workflows", workflow: "intelligence_workflows", workflow_task: "workflow_tasks", task: "workflow_tasks",
      agent_attempt: "agent_attempts", attempt: "agent_attempts", disagreement: "disagreements", decision: "decisions", evidence_claim: "evidence_claims",
      claim: "evidence_claims", source_segment: "source_segments", segment: "source_segments",
    };
    const t = table[record.entityType];
    if (!t) return null;
    const r = await q.query(`select organization_id from public.${t} where id = $1`, [record.entityId]);
    return r.rows.length ? r.rows[0].organization_id : null;
  }

  async audit(record: AuditRecord): Promise<void> {
    const organizationId = await this.organizationForAudit(this.client, record);
    if (!organizationId) throw new Error(`core-v2: audit ${record.action} of ${record.entityType} ${record.entityId} names no organisation the record knows`);
    await this.auditIn(this.client, organizationId, record);
  }

  async listAudit(): Promise<AuditRecord[]> {
    const r = this.organizationId
      ? await this.client.query(`select action, entity_type, entity_id, detail from public.audit_events where action like 'core_v2.%' and organization_id = $1 order by id`, [this.organizationId])
      : await this.client.query(`select action, entity_type, entity_id, detail from public.audit_events where action like 'core_v2.%' order by id`);
    return r.rows.map((row) => ({ action: row.action!, entityType: row.entity_type!, entityId: row.entity_id!, detail: json<Record<string, unknown>>(row.detail, {}) }));
  }
}

/* The refusal the database gave, in the double's words. */
function submissionReason(message: string): string {
  let m: RegExpMatchArray | null;
  if (message.startsWith("no attempt")) return "no such attempt";
  if ((m = message.match(/^workflow \S+ is (\S+)$/))) return `workflow is ${m[1]}`;
  if (message.startsWith("cancellation of workflow")) return "cancellation was requested";
  if ((m = message.match(/^task \S+ is (\S+), not running$/))) return `task is ${m[1]}`;
  if (message.startsWith("the lease token does not match")) return "the lease is not the caller's";
  if (message.startsWith("the lease on task")) return "the lease has expired";
  if ((m = message.match(/^attempt \S+ is (\S+), not prepared$/))) return `attempt is ${m[1]}`;
  return message;
}
