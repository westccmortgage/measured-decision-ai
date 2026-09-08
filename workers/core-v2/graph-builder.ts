/* A PROJECT BECOMES A GRAPH OF SMALL ASSIGNMENTS. NEVER ONE ASSIGNMENT.
 *
 * The planner reads a source manifest and produces tasks, dependencies and
 * independence groups. It extracts nothing and concludes nothing. Every task it
 * makes is bounded to one page, one region, one symbol family or one subject,
 * and a 200-page set simply produces several hundred of them. The one thing it
 * refuses to produce is a task whose sources are the whole project.
 *
 *   source manifest
 *       ↓ ingest_page                 one per page          (code)
 *       ↓ map_page_regions            one per page          (cartographer)
 *       ↓ extract_*                   one per region        (specialists)
 *         locate_symbol_family        one per plan × family (locator)
 *       ↓ independent reading         blind second group where required
 *       ↓ detect_disagreements        one per read subject  (code)
 *       ↓ verify / adjudicate         created later, only where readers differ
 *       ↓ count_instances             one per symbol family (code)
 *       ↓ derive_materials            one per assembly      (code)
 *       ↓ resolve_relationships       one per project       (builder)
 *       ↓ compose_decision            one per subject       (composer)
 *
 * Task ids are deterministic in the manifest, so planning the same manifest
 * twice — after a crash, on a restart — produces the same ids and the
 * repository can tell "already planned" from "new".
 */
import type {
  DependencyKind, ManifestRegion, SourceManifest, TaskRecord, TaskType,
} from "./contracts.ts";
import { fingerprint, shortId } from "./hash.ts";
import type { OrchestrationPolicy } from "./orchestration-policy.ts";
import { roleForTaskType } from "./role-registry.ts";

export type TaskSpec = {
  taskId: string;
  taskType: TaskType;
  roleKey: string;
  roleVersion: string;
  subjectKey: string;
  sourceIds: string[];
  dependsOn: { taskId: string; kind: DependencyKind }[];
  independenceGroup: string | null;
  priority: number;
  contractVersion: string;
  inputFingerprint: string;
  /* For counting and composing: which read subject this task waits on. */
  subjectOf: string | null;
};

export type TaskGraph = {
  workflowId: string;
  tasks: TaskSpec[];
  /* Subjects that were given more than one blind reader, with their groups. */
  independentSubjects: { subjectKey: string; taskType: TaskType; groups: string[] }[];
  refusals: string[];
};

export const CONTRACT_VERSION = "core-v2.contracts.1";
export const INDEPENDENCE_GROUPS = ["reader-a", "reader-b", "reader-c"];

/* The identity of a piece of work: what kind, of what, from which immutable
   sources, by which blind group, under which contract. Two requests for the
   same work — from the planner, or from two agents asking for the same
   follow-up — produce the same identity and are one task. Dependencies are
   deliberately not part of it: they are wiring, not work. */
export function workIdentity(workflowId: string, taskType: TaskType, subjectKey: string, sourceHashes: string[], independenceGroup: string | null): string {
  const role = roleForTaskType(taskType);
  return fingerprint({
    workflowId, taskType, subjectKey, sources: sourceHashes, contract: CONTRACT_VERSION,
    role: `${role.roleKey}@${role.version}`, independenceGroup,
  });
}

const REGION_TASK: Partial<Record<string, TaskType>> = {
  schedule: "extract_schedule",
  general_notes: "extract_notes",
  keynotes: "extract_notes",
  spec_text: "extract_notes",
  legend: "extract_legend",
  detail: "extract_dimensions",
  section: "extract_dimensions",
  elevation: "extract_dimensions",
};

export function buildTaskGraph(manifest: SourceManifest, policy: OrchestrationPolicy): TaskGraph {
  const tasks: TaskSpec[] = [];
  const refusals: string[] = [];
  const independentSubjects: TaskGraph["independentSubjects"] = [];
  const byId = new Map<string, TaskSpec>();
  const wf = manifest.workflowId;
  const sourceHash = new Map<string, string>();
  for (const d of manifest.documents) sourceHash.set(d.documentId, d.contentHash);
  for (const p of manifest.pages) sourceHash.set(p.pageId, p.contentHash);
  for (const r of manifest.regions) sourceHash.set(r.regionId, r.contentHash);

  if (manifest.documents.some((d) => !d.contentHash)) {
    refusals.push("a document without a content hash is not a Core V2 source");
  }

  const add = (spec: Omit<TaskSpec, "taskId" | "roleKey" | "roleVersion" | "contractVersion" | "inputFingerprint">): TaskSpec => {
    const role = roleForTaskType(spec.taskType);
    if (spec.sourceIds.length > role.maximumSources) {
      refusals.push(`${spec.taskType} ${spec.subjectKey}: ${spec.sourceIds.length} sources exceeds the role's ${role.maximumSources}`);
    }
    const taskId = shortId("task", wf, spec.taskType, spec.subjectKey, spec.independenceGroup);
    const inputFingerprint = workIdentity(wf, spec.taskType, spec.subjectKey,
      spec.sourceIds.map((id) => sourceHash.get(id) ?? id), spec.independenceGroup);
    const full: TaskSpec = {
      ...spec, taskId, roleKey: role.roleKey, roleVersion: role.version,
      contractVersion: CONTRACT_VERSION, inputFingerprint,
    };
    if (byId.has(taskId)) return byId.get(taskId)!;
    byId.set(taskId, full);
    tasks.push(full);
    return full;
  };

  const readersFor = (taskType: TaskType): (string | null)[] => {
    if (!manifest.independentReadingTaskTypes.includes(taskType)) return [null];
    const role = roleForTaskType(taskType);
    if (!role.requiresIndependentReading) return [null];
    const n = Math.max(2, Math.min(policy.maximumIndependentReadersPerSubject, INDEPENDENCE_GROUPS.length));
    return INDEPENDENCE_GROUPS.slice(0, n);
  };

  /* ── pages: ingest, then map ── */
  const mapByPage = new Map<string, TaskSpec>();
  for (const page of manifest.pages) {
    const ingest = add({
      taskType: "ingest_page", subjectKey: page.pageId, sourceIds: [page.pageId],
      dependsOn: [], independenceGroup: null, priority: 10, subjectOf: null,
    });
    const map = add({
      taskType: "map_page_regions", subjectKey: page.pageId, sourceIds: [page.pageId],
      dependsOn: [{ taskId: ingest.taskId, kind: "requires_completion" }],
      independenceGroup: null, priority: 20, subjectOf: null,
    });
    mapByPage.set(page.pageId, map);
  }

  /* ── regions: one specialist task per region, blind pairs where required ── */
  const legendTaskByRegion = new Map<string, TaskSpec>();
  const readSubjects = new Map<string, { taskType: TaskType; tasks: TaskSpec[]; region: ManifestRegion | null }>();
  const noteSubjects = new Map<string, TaskSpec[]>();

  const regionTask = (region: ManifestRegion, taskType: TaskType, group: string | null, extraDeps: TaskSpec[]): TaskSpec => {
    const map = mapByPage.get(region.pageId);
    const subjectKey = `${region.pageId}/${region.regionId}`;
    return add({
      taskType, subjectKey, sourceIds: [region.regionId],
      dependsOn: [
        ...(map ? [{ taskId: map.taskId, kind: "requires_completion" as DependencyKind }] : []),
        ...extraDeps.map((d) => ({ taskId: d.taskId, kind: "requires_claims" as DependencyKind })),
      ],
      independenceGroup: group, priority: 30, subjectOf: subjectKey,
    });
  };

  for (const region of manifest.regions.filter((r) => r.kind === "legend")) {
    const t = regionTask(region, "extract_legend", null, []);
    legendTaskByRegion.set(region.regionId, t);
  }

  for (const region of manifest.regions) {
    const taskType = REGION_TASK[region.kind];
    if (!taskType || taskType === "extract_legend") continue;
    const subjectKey = `${region.pageId}/${region.regionId}`;
    const made: TaskSpec[] = [];
    for (const group of readersFor(taskType)) made.push(regionTask(region, taskType, group, []));
    readSubjects.set(subjectKey, { taskType, tasks: made, region });
    if (taskType === "extract_notes") noteSubjects.set(subjectKey, made);
    if (made.length > 1) {
      independentSubjects.push({ subjectKey, taskType, groups: made.map((t) => t.independenceGroup!) });
    }
  }

  /* ── symbol families: one locator per plan region per family ── */
  const locatorsByFamily = new Map<string, TaskSpec[]>();
  for (const region of manifest.regions.filter((r) => r.kind === "plan_view")) {
    for (const familyKey of region.symbolFamilies ?? []) {
      const family = manifest.symbolFamilies.find((f) => f.familyKey === familyKey);
      const legend = family?.definedByRegionId ? legendTaskByRegion.get(family.definedByRegionId) : undefined;
      const subjectKey = `${region.pageId}/${region.regionId}/${familyKey}`;
      const made: TaskSpec[] = [];
      for (const group of readersFor("locate_symbol_family")) {
        const map = mapByPage.get(region.pageId);
        made.push(add({
          taskType: "locate_symbol_family", subjectKey,
          sourceIds: legend ? [region.regionId, family!.definedByRegionId!] : [region.regionId],
          dependsOn: [
            ...(map ? [{ taskId: map.taskId, kind: "requires_completion" as DependencyKind }] : []),
            ...(legend ? [{ taskId: legend.taskId, kind: "requires_claims" as DependencyKind }] : []),
          ],
          independenceGroup: group, priority: 40, subjectOf: subjectKey,
        }));
      }
      readSubjects.set(subjectKey, { taskType: "locate_symbol_family", tasks: made, region });
      locatorsByFamily.set(familyKey, [...(locatorsByFamily.get(familyKey) ?? []), ...made]);
      if (made.length > 1) {
        independentSubjects.push({ subjectKey, taskType: "locate_symbol_family", groups: made.map((t) => t.independenceGroup!) });
      }
    }
  }

  /* ── comparison: one per subject that was read more than once ── */
  const comparisonBySubject = new Map<string, TaskSpec>();
  for (const [subjectKey, subject] of readSubjects) {
    if (subject.tasks.length < 2) continue;
    const compare = add({
      taskType: "detect_disagreements", subjectKey, sourceIds: [],
      dependsOn: subject.tasks.map((t) => ({ taskId: t.taskId, kind: "requires_claims" as DependencyKind })),
      independenceGroup: null, priority: 50, subjectOf: subjectKey,
    });
    comparisonBySubject.set(subjectKey, compare);
  }

  /* ── counting: one per family, after every locator (and comparison) of it ── */
  const countByFamily = new Map<string, TaskSpec>();
  for (const family of manifest.symbolFamilies) {
    const locators = locatorsByFamily.get(family.familyKey) ?? [];
    if (locators.length === 0) continue;
    const deps: { taskId: string; kind: DependencyKind }[] = [];
    const subjects = new Set(locators.map((t) => t.subjectOf!));
    for (const s of subjects) {
      const compare = comparisonBySubject.get(s);
      if (compare) deps.push({ taskId: compare.taskId, kind: "requires_resolution" });
      else for (const t of locators.filter((l) => l.subjectOf === s)) deps.push({ taskId: t.taskId, kind: "requires_claims" });
    }
    const count = add({
      taskType: "count_instances", subjectKey: family.familyKey, sourceIds: [],
      dependsOn: deps, independenceGroup: null, priority: 60, subjectOf: family.familyKey,
    });
    countByFamily.set(family.familyKey, count);
  }

  /* ── materials: one per family, after its count, its schedule, its dimensions ── */
  const materialsByFamily = new Map<string, TaskSpec>();
  const dimensionTasks = [...readSubjects.values()].filter((s) => s.taskType === "extract_dimensions").flatMap((s) => s.tasks);
  for (const [familyKey, count] of countByFamily) {
    const deps: { taskId: string; kind: DependencyKind }[] = [{ taskId: count.taskId, kind: "requires_claims" }];
    for (const t of dimensionTasks) deps.push({ taskId: t.taskId, kind: "requires_claims" });
    const family = manifest.symbolFamilies.find((f) => f.familyKey === familyKey);
    const schedule = family?.scheduledByRegionId
      ? [...readSubjects.values()].find((s) => s.taskType === "extract_schedule" && s.region?.regionId === family.scheduledByRegionId)
      : undefined;
    if (schedule) {
      const compare = comparisonBySubject.get(schedule.tasks[0].subjectOf!);
      deps.push(compare ? { taskId: compare.taskId, kind: "requires_resolution" }
                        : { taskId: schedule.tasks[0].taskId, kind: "requires_claims" });
    }
    materialsByFamily.set(familyKey, add({
      taskType: "derive_materials", subjectKey: familyKey, sourceIds: [],
      dependsOn: deps, independenceGroup: null, priority: 70, subjectOf: familyKey,
    }));
  }

  /* ── relationships: once, after every extraction has settled ── */
  const allReads = [...readSubjects.values()].flatMap((s) => s.tasks);
  const settled = [...readSubjects.entries()].map(([subjectKey, s]) =>
    comparisonBySubject.get(subjectKey)
      ? { taskId: comparisonBySubject.get(subjectKey)!.taskId, kind: "requires_resolution" as DependencyKind }
      : { taskId: s.tasks[0].taskId, kind: "requires_claims" as DependencyKind });
  if (allReads.length > 0) {
    add({
      taskType: "resolve_relationships", subjectKey: "project", sourceIds: [],
      dependsOn: [...settled, ...[...legendTaskByRegion.values()].map((t) => ({ taskId: t.taskId, kind: "requires_claims" as DependencyKind }))],
      independenceGroup: null, priority: 80, subjectOf: null,
    });
  }

  /* ── decisions: one per family that was counted, and one per note group ── */
  for (const [familyKey, count] of countByFamily) {
    const deps: { taskId: string; kind: DependencyKind }[] = [{ taskId: count.taskId, kind: "requires_claims" }];
    const materials = materialsByFamily.get(familyKey);
    if (materials) deps.push({ taskId: materials.taskId, kind: "requires_claims" });
    add({
      taskType: "compose_decision", subjectKey: familyKey, sourceIds: [],
      dependsOn: deps, independenceGroup: null, priority: 90, subjectOf: familyKey,
    });
  }
  for (const [subjectKey, made] of noteSubjects) {
    const compare = comparisonBySubject.get(subjectKey);
    add({
      taskType: "compose_decision", subjectKey, sourceIds: [],
      dependsOn: [compare ? { taskId: compare.taskId, kind: "requires_resolution" }
                          : { taskId: made[0].taskId, kind: "requires_claims" }],
      independenceGroup: null, priority: 90, subjectOf: subjectKey,
    });
  }

  /* ── the prohibitions ── */
  const allSourceIds = new Set([...manifest.pages.map((p) => p.pageId), ...manifest.regions.map((r) => r.regionId)]);
  for (const task of tasks) {
    if (task.sourceIds.length > 0 && task.sourceIds.length >= allSourceIds.size && allSourceIds.size > 1) {
      refusals.push(`${task.taskId} would carry the complete project — no assignment may`);
    }
    if (manifest.documents.length > 1 && task.sourceIds.length > 0) {
      const docs = new Set(task.sourceIds.map((id) => sourceDocument(manifest, id)));
      if (docs.size === manifest.documents.length && manifest.documents.length > 1 && task.taskType !== "locate_symbol_family") {
        refusals.push(`${task.taskId} spans every document — no assignment may`);
      }
    }
  }
  if (tasks.length > policy.maximumTasksPerWorkflow) {
    refusals.push(`${tasks.length} tasks exceeds the policy ceiling of ${policy.maximumTasksPerWorkflow}`);
  }

  return { workflowId: wf, tasks, independentSubjects, refusals };
}

function sourceDocument(manifest: SourceManifest, sourceId: string): string {
  const page = manifest.pages.find((p) => p.pageId === sourceId);
  if (page) return page.documentId;
  const region = manifest.regions.find((r) => r.regionId === sourceId);
  if (region) return manifest.pages.find((p) => p.pageId === region.pageId)?.documentId ?? "?";
  return sourceId;
}

export function specToRecord(spec: TaskSpec, workflowId: string): TaskRecord {
  return {
    taskId: spec.taskId, workflowId, parentTaskId: null, taskType: spec.taskType,
    roleKey: spec.roleKey, roleVersion: spec.roleVersion, subjectKey: spec.subjectKey,
    state: "created", priority: spec.priority, sourceIds: spec.sourceIds,
    inputFingerprint: spec.inputFingerprint, contractVersion: spec.contractVersion,
    independenceGroup: spec.independenceGroup, depth: 0, leaseOwner: null, leaseExpiresAt: null,
    terminalReason: null, createdByTaskId: null, criticRound: 0, arbiterRound: 0, disagreementId: null,
    targetClaimIds: [],
  };
}

/* A compact, readable rendering of a graph — what --dry-run prints. */
export function describeGraph(graph: TaskGraph): string {
  const byRole = new Map<string, number>();
  for (const t of graph.tasks) byRole.set(t.roleKey, (byRole.get(t.roleKey) ?? 0) + 1);
  const lines: string[] = [];
  lines.push(`workflow ${graph.workflowId}: ${graph.tasks.length} bounded assignments`);
  lines.push("");
  lines.push("by role:");
  for (const [role, n] of [...byRole.entries()].sort((a, b) => b[1] - a[1])) lines.push(`  ${String(n).padStart(4)}  ${role}`);
  lines.push("");
  lines.push("independent readings (blind pairs):");
  for (const s of graph.independentSubjects) lines.push(`  ${s.taskType.padEnd(22)} ${s.subjectKey}  → ${s.groups.join(" | ")}`);
  lines.push("");
  lines.push("tasks:");
  for (const t of graph.tasks) {
    const deps = t.dependsOn.length ? ` ← ${t.dependsOn.map((d) => `${d.taskId.slice(0, 12)}(${d.kind.replace("requires_", "")})`).join(", ")}` : "";
    const group = t.independenceGroup ? ` [${t.independenceGroup}]` : "";
    lines.push(`  ${t.taskId.slice(0, 12)}  ${t.taskType.padEnd(22)} ${t.roleKey.padEnd(24)} ${t.subjectKey}${group}${deps}`);
  }
  if (graph.refusals.length) {
    lines.push("");
    lines.push("REFUSED:");
    for (const r of graph.refusals) lines.push(`  ${r}`);
  }
  return lines.join("\n");
}
