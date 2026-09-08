/* THE SEAM BETWEEN THE KERNEL AND A DOMAIN.
 *
 * A domain pack knows what a segment of its sources is, which analysts read
 * it, which subjects and predicates they report, and how a derived quantity
 * is computed. The kernel knows how to distribute that work, keep readers
 * blind, compare, verify, adjudicate, decide, recover and stop. This file is
 * everything the two say to each other.
 *
 * A pack receives persisted segments and returns task specifications. It
 * cannot reach the repository, the scheduler, an executor or another pack.
 */
import type {
  AgentResultEnvelope, AgentRoleDefinition, ClaimRecord, DependencyKind, ProposedClaim, SegmentRecord,
  SourceDescriptor, SourceManifest, TaskPhase, TaskRecord, TaskSourceRef, WorkPacket,
} from "./contracts.ts";
import type { OrchestrationPolicy } from "./policy.ts";

/* A bounded assignment as a pack describes it. The kernel derives the task
   id from the identity of the work; `key` is only a handle for dependencies
   between specs of one expansion. */
export type TaskSpec = {
  key: string;
  phase: TaskPhase;
  taskType: string;
  roleKey: string;
  subjectKey: string;
  sources: TaskSourceRef[];
  independenceGroup: string | null;
  priority: number;
  dependsOn: { key: string; kind: DependencyKind }[];
  dependsOnTaskIds: { taskId: string; kind: DependencyKind }[];
  maxClaims?: number;
};

export type ExpansionInput = {
  manifest: SourceManifest;
  policy: OrchestrationPolicy;
  /* Every accepted segment of the workflow, whichever source it belongs to. */
  segments: SegmentRecord[];
  /* Every task the workflow already holds — so a pack can depend on work the
     kernel planned (an ingest, a discovery) by id. */
  tasks: TaskRecord[];
};

export interface DomainPack {
  readonly id: string;
  readonly version: string;

  /* The pack's own roles: analysts, discoverers, derivers. The kernel adds
     its universal roles; a pack may not redefine them. */
  readonly roles: AgentRoleDefinition[];

  /* Objective text by task type, for the packets of this pack's task types. */
  readonly objectives: Record<string, string>;

  /* Which role discovers the segments of this source beneath the segments it
     declares — or null when what the source declares is all there is. */
  discovererFor(source: SourceDescriptor): string | null;

  /* Phase B. From every accepted segment, every bounded assignment of the
     discover (beneath a declared segment), analyze, compare and derive
     phases. Must be deterministic and complete: called again with the same
     input it returns the same specs, and the kernel's admission turns
     repeats into reuse. It runs again after every ingest and discovery. */
  expand(input: ExpansionInput): TaskSpec[];

  /* The subjects a decision is composed for, from the accepted evidence. */
  decisionSubjects(claims: ClaimRecord[]): string[];

  /* Domain rules on one claim of an envelope. The kernel's rules run first
     and are not the pack's to relax. */
  validateClaim(packet: WorkPacket, claim: ProposedClaim, envelope: AgentResultEnvelope): string[];

  /* Normalisation for comparison: casing, spelling, aliases. Never semantic. */
  normaliseUnit(unit: string | null): string | null;
  normaliseKey(key: string): string;

  /* Follow-up geometry. */
  isRelated(target: SegmentRecord, task: TaskRecord, segments: SegmentRecord[]): boolean;
  isReference(segment: SegmentRecord): boolean;
  linkedSegments(segment: SegmentRecord, segments: SegmentRecord[]): SegmentRecord[];

  /* The derive phase: deterministic code the pack owns. It receives a packet
     of accepted claims and returns derived claims that name their inputs. */
  derive(packet: WorkPacket): Promise<AgentResultEnvelope>;
}

export const INDEPENDENCE_GROUPS = ["reader-a", "reader-b", "reader-c"];
