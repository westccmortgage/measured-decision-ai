/* FROM A MANIFEST TO BOUNDED ASSIGNMENTS, IN TWO PHASES.
 *
 * Phase A is the kernel's: one ingest per source, one discovery per source
 * whose pack names a discoverer. Phase B is the pack's: from the persisted,
 * accepted segments, every bounded analysis, comparison and derivation. The
 * kernel closes the graph with one composition per subject once everything
 * else is terminal.
 *
 * Every task id is derived from the identity of the work, so planning twice
 * — after a restart, after a second discovery — creates nothing the second
 * time. A spec's `key` is only a handle for dependencies within one call.
 */
import type {
  DependencyKind, SegmentRecord, SourceDescriptor, SourceManifest, TaskPhase, TaskRecord, TaskSourceRef,
  WorkflowBudget, WorkflowRecord,
} from "./contracts.ts";
import { ENGINE_VERSION, KERNEL_TASK_TYPES } from "./contracts.ts";
import type { DomainPack, TaskSpec } from "./domain.ts";
import { canonical, entityId, fingerprint, sha256 } from "./ids.ts";
import type { OrchestrationPolicy } from "./policy.ts";
import type { NewTask } from "./repository.ts";
import type { RoleRegistry } from "./roles.ts";

export const CONTRACT_VERSION = `${ENGINE_VERSION}/contract.2`;

/* The identity of a piece of work: everything that would make it a different
   reading, and nothing that would merely make it a different attempt. */
export function taskIdentity(workflowId: string, phase: TaskPhase, taskType: string, subjectKey: string, sourceHashes: string[], independenceGroup: string | null): string {
  return fingerprint({ workflowId, phase, taskType, subjectKey, sourceHashes, independenceGroup, contract: CONTRACT_VERSION });
}

export function taskIdFor(workflowId: string, identity: string): string {
  return entityId("task", workflowId, identity);
}

/* A segment's id is its identity: where it is, what it is, what it holds. A
   discoverer that finds the same segment twice finds one segment. */
export function segmentIdFor(workflowId: string, sourceId: string, parentSegmentId: string | null, segmentKind: string, contentHash: string): string {
  return entityId("segment", workflowId, sourceId, parentSegmentId ?? "", segmentKind, contentHash);
}

export function sourceIdentityOf(source: SourceDescriptor): string {
  if (source.contentHash) return `digest=${source.hashAlgorithm ?? "sha256"}:${source.contentHash}`;
  if (source.objectVersionId) return `version=${source.objectVersionId}`;
  throw new Error(`core-v2: source ${source.sourceId} has neither a content hash nor a version — it is not read`);
}

export type Lookup = {
  sources: Map<string, SourceDescriptor>;
  segments: Map<string, SegmentRecord>;
};

export function lookupOf(manifest: SourceManifest, segments: SegmentRecord[]): Lookup {
  return {
    sources: new Map(manifest.sources.map((s) => [s.sourceId, s])),
    segments: new Map(segments.map((s) => [s.segmentId, s])),
  };
}

export function hashOfRef(ref: TaskSourceRef, lookup: Lookup): string {
  if (ref.segmentId) {
    const segment = lookup.segments.get(ref.segmentId);
    if (!segment) throw new Error(`core-v2: segment ${ref.segmentId} is not in the record`);
    return segment.contentHash;
  }
  if (ref.sourceId) {
    const source = lookup.sources.get(ref.sourceId);
    if (!source) throw new Error(`core-v2: source ${ref.sourceId} is not in the manifest`);
    return sourceIdentityOf(source);
  }
  throw new Error("core-v2: a task source names neither a source nor a segment");
}

/* Specs become tasks: ids from identity, dependencies by key resolved to ids,
   role versions from the registry. Refusals name the spec that broke a rule. */
export function specsToTasks(
  specs: TaskSpec[], workflowId: string, lookup: Lookup, registry: RoleRegistry, policy: OrchestrationPolicy,
  parent: TaskRecord | null = null, depth = 0,
): { tasks: NewTask[]; refusals: string[] } {
  const refusals: string[] = [];
  const idByKey = new Map<string, string>();
  const drafts: { spec: TaskSpec; id: string; identity: string }[] = [];
  const allSourceIds = new Set(lookup.sources.keys());

  for (const spec of specs) {
    const role = registry.forTaskType(spec.taskType);
    if (role.roleKey !== spec.roleKey) { refusals.push(`${spec.key}: ${spec.taskType} is ${role.roleKey}'s work, not ${spec.roleKey}'s`); continue; }
    if (role.phase !== spec.phase) { refusals.push(`${spec.key}: ${spec.taskType} belongs to the ${role.phase} phase`); continue; }
    if (spec.sources.length > role.maximumSources) { refusals.push(`${spec.key}: ${spec.sources.length} sources exceeds ${role.roleKey}'s ${role.maximumSources}`); continue; }
    if (spec.sources.length > policy.maximumPacketSources) { refusals.push(`${spec.key}: ${spec.sources.length} sources exceeds the policy's ${policy.maximumPacketSources}`); continue; }
    /* One assignment carrying the whole set is the shape of request the
       kernel exists to replace. */
    const sourcesNamed = new Set(spec.sources.map((s) => s.sourceId ?? lookup.segments.get(s.segmentId!)?.sourceId));
    if (allSourceIds.size > 1 && sourcesNamed.size >= allSourceIds.size && spec.phase !== "compose") {
      refusals.push(`${spec.key}: one assignment over every source of the workflow`); continue;
    }
    if (spec.independenceGroup && !role.requiresIndependentReading) { refusals.push(`${spec.key}: ${role.roleKey} is not read blind, yet the spec names a group`); continue; }
    if (idByKey.has(spec.key)) { refusals.push(`${spec.key}: two specs share one key`); continue; }
    let hashes: string[];
    try { hashes = spec.sources.map((s) => hashOfRef(s, lookup)); } catch (error) { refusals.push(`${spec.key}: ${(error as Error).message}`); continue; }
    const identity = taskIdentity(workflowId, spec.phase, spec.taskType, spec.subjectKey, hashes, spec.independenceGroup);
    const id = taskIdFor(workflowId, identity);
    idByKey.set(spec.key, id);
    drafts.push({ spec, id, identity });
  }

  const tasks: NewTask[] = [];
  for (const { spec, id, identity } of drafts) {
    const role = registry.role(spec.roleKey);
    const dependsOn: { taskId: string; kind: DependencyKind }[] = [];
    let broken = false;
    for (const d of spec.dependsOn) {
      const target = idByKey.get(d.key);
      if (!target) { refusals.push(`${spec.key}: depends on ${d.key}, which this expansion does not define`); broken = true; break; }
      if (target === id) { refusals.push(`${spec.key}: depends on itself`); broken = true; break; }
      dependsOn.push({ taskId: target, kind: d.kind });
    }
    if (broken) continue;
    for (const d of spec.dependsOnTaskIds) dependsOn.push({ taskId: d.taskId, kind: d.kind });
    tasks.push({
      taskId: id, workflowId, parentTaskId: parent?.taskId ?? null, createdByTaskId: parent?.taskId ?? null,
      phase: spec.phase, taskType: spec.taskType, roleKey: role.roleKey, roleVersion: role.version, subjectKey: spec.subjectKey,
      priority: spec.priority, sources: spec.sources, inputFingerprint: identity, contractVersion: CONTRACT_VERSION,
      independenceGroup: spec.independenceGroup, depth, criticRound: parent?.criticRound ?? 0, arbiterRound: parent?.arbiterRound ?? 0,
      disagreementId: null, targetClaimIds: [], maxClaims: spec.maxClaims ?? role.maximumClaims, dependsOn,
    });
  }
  return { tasks, refusals };
}

/* The workflow row a manifest implies. Its two fingerprints are what make a
   run the same run: ask for the same sources under the same scope with the
   same pack, and you are asking for the work that already exists rather than
   a second copy of it. This lives here, and not inside the scheduler, so
   whoever puts a workflow on the queue and the scheduler that picks it up
   compute it the same way — two definitions of one identity would agree
   until the day one of them changed. */
export function workflowRecordFor(manifest: SourceManifest, pack: DomainPack, budget: WorkflowBudget): WorkflowRecord {
  const sourceSetFingerprint = sha256(canonical(manifest.sources.map((s) => [s.ordinal, s.sourceKind, s.uri, s.contentHash ?? `version=${s.objectVersionId}`, s.byteSize])));
  return {
    workflowId: manifest.workflowId, organizationId: manifest.organizationId, domainPack: pack.id, domainPackVersion: pack.version,
    workflowType: manifest.workflowType, engineVersion: ENGINE_VERSION, state: "created",
    sourceSetFingerprint,
    requestFingerprint: sha256(canonical([pack.id, pack.version, manifest.workflowType, sourceSetFingerprint, manifest.requestedScope, ENGINE_VERSION])),
    requestedScope: manifest.requestedScope, budget, cancelRequestedAt: null,
    totalUnits: 0, completedUnits: 0, attentionUnits: 0, errorCode: null, errorMessage: null,
  };
}

/* Phase A: what the kernel plans before any pack is asked anything. */
export function planDiscovery(manifest: SourceManifest, pack: DomainPack): TaskSpec[] {
  const specs: TaskSpec[] = [];
  for (const source of manifest.sources) {
    const ingestKey = `ingest:${source.sourceId}`;
    specs.push({
      key: ingestKey, phase: "ingest", taskType: KERNEL_TASK_TYPES.ingest, roleKey: "source_ingestor",
      subjectKey: `source:${source.ordinal}`, sources: [{ sourceId: source.sourceId, segmentId: null }],
      independenceGroup: null, priority: 10, dependsOn: [], dependsOnTaskIds: [],
    });
    const discoverer = pack.discovererFor(source);
    if (discoverer) {
      const role = pack.roles.find((r) => r.roleKey === discoverer);
      if (!role || role.kind !== "discoverer" || role.taskTypes.length === 0) throw new Error(`core-v2: ${pack.id} names ${discoverer} to discover ${source.sourceKind}, which is not one of its discoverer roles`);
      specs.push({
        key: `discover:${source.sourceId}`, phase: "discover", taskType: role.taskTypes[0], roleKey: discoverer,
        subjectKey: `source:${source.ordinal}`, sources: [{ sourceId: source.sourceId, segmentId: null }],
        independenceGroup: null, priority: 20, dependsOn: [{ key: ingestKey, kind: "requires_completion" }], dependsOnTaskIds: [],
      });
    }
  }
  return specs;
}

/* The close of the graph: one composition per subject, after everything else. */
export function planCompositions(subjects: string[], dependsOnTaskIds: string[]): TaskSpec[] {
  return [...new Set(subjects)].sort().map((subject) => ({
    key: `compose:${subject}`, phase: "compose", taskType: KERNEL_TASK_TYPES.compose, roleKey: "decision_composer",
    subjectKey: subject, sources: [], independenceGroup: null, priority: 900, dependsOn: [],
    dependsOnTaskIds: dependsOnTaskIds.map((taskId) => ({ taskId, kind: "requires_completion" as const })),
  }));
}

/* A short, readable account of a graph, for the dry run. */
export function describeTasks(tasks: NewTask[], lookup: Lookup): string {
  const lines: string[] = [];
  const byRole: Record<string, number> = {};
  for (const t of tasks) byRole[t.roleKey] = (byRole[t.roleKey] ?? 0) + 1;
  lines.push(`${tasks.length} bounded assignments`);
  lines.push("");
  lines.push("by role:");
  for (const [role, n] of Object.entries(byRole).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) lines.push(`  ${String(n).padStart(4)}  ${role}`);
  const blind = tasks.filter((t) => t.independenceGroup);
  if (blind.length) {
    lines.push("");
    lines.push("independent readings (blind groups):");
    const bySubject = new Map<string, string[]>();
    for (const t of blind) bySubject.set(`${t.taskType} ${t.subjectKey}`, [...(bySubject.get(`${t.taskType} ${t.subjectKey}`) ?? []), t.independenceGroup!]);
    for (const [k, groups] of bySubject) lines.push(`  ${k}  → ${groups.sort().join(" | ")}`);
  }
  lines.push("");
  lines.push("tasks:");
  for (const t of tasks) {
    const srcs = t.sources.map((s) => s.segmentId ? (lookup.segments.get(s.segmentId)?.label ?? s.segmentId.slice(0, 8)) : (lookup.sources.get(s.sourceId!)?.label ?? s.sourceId!.slice(0, 8)));
    const deps = t.dependsOn.map((d) => `${d.taskId.slice(0, 8)}(${d.kind.replace("requires_", "")})`);
    lines.push(`  ${t.taskId.slice(0, 8)}  ${t.phase.padEnd(10)} ${t.taskType.padEnd(34)} ${t.roleKey.padEnd(24)} ${t.subjectKey}${t.independenceGroup ? ` [${t.independenceGroup}]` : ""}${srcs.length ? ` ⟨${srcs.join(", ")}⟩` : ""}${deps.length ? ` ← ${deps.join(", ")}` : ""}`);
  }
  return lines.join("\n");
}
