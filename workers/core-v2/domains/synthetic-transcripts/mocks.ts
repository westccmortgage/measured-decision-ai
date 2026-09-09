/* THE SCRIPTED AGENTS OF THE SYNTHETIC TRANSCRIPTS PACK. */
import type { PacketClaim, WorkPacket } from "../../kernel/contracts.ts";
import { emptyEnvelope } from "../../kernel/deterministic.ts";
import { ExecutorRegistry } from "../../kernel/executors.ts";
import type { Responder, Script, TruthOracle, TruthReading } from "../mock-executor.ts";
import { ScriptedExecutor, kernelRoleResponders } from "../mock-executor.ts";
import type { TranscriptSet } from "./fixture.ts";
import { SyntheticTranscriptsPack } from "./pack.ts";

const pack = new SyntheticTranscriptsPack();

export function discoverScenes(packet: WorkPacket, truth: TranscriptSet) {
  const env = emptyEnvelope(packet);
  const ref = packet.sources.find((s) => s.kind === "source");
  const recording = ref ? truth.byRecordingHash.get(ref.contentHash.replace(/^digest=[^:]+:/, "")) : null;
  if (!ref || !recording) { env.outcome = "failed_known"; env.limitations.push("no recording in the packet"); return env; }
  for (const s of recording.scenes) {
    env.segments.push({ segmentKey: `scene-${s.ordinal}`, sourceId: ref.sourceId, parentSegmentId: null, segmentKind: "scene", label: s.label, ordinal: s.ordinal, locator: { start_ms: s.startMs, end_ms: s.endMs }, contentHash: s.contentHash });
  }
  return env;
}

export function readScene(packet: WorkPacket, truth: TranscriptSet) {
  const env = emptyEnvelope(packet);
  const ref = packet.sources[0];
  const scene = ref?.segmentId ? truth.bySceneHash.get(ref.contentHash) : null;
  if (!ref || !scene) { env.outcome = "failed_known"; env.limitations.push("no scene in the packet"); return env; }
  env.anchors.push({ anchorKey: "range", sourceKind: "segment_locator", sourceId: ref.sourceId, segmentId: ref.segmentId, locator: { start_ms: scene.startMs, end_ms: scene.endMs }, quotedText: `${scene.topic}: ${scene.turns} turns` });
  env.claims.push({
    claimKey: "turns", subjectType: "scene", subjectKey: packet.subjectKey, predicate: "speaker_turns",
    value: { known: true, quantity: scene.turns, text: `${scene.turns} turns`, attributes: { topic: scene.topic } }, unit: "turns",
    observationBasis: "observed", scope: { segment: scene.label }, anchorKeys: ["range"], machineConfidence: 0.8,
  });
  return env;
}

export function oracleFor(truth: TranscriptSet): TruthOracle {
  return {
    readingFor(packet: WorkPacket, claim: PacketClaim): TruthReading {
      const at = claim.anchors[0];
      const ref = at ? packet.sources.find((s) => s.segmentId === at.segmentId) : null;
      const scene = ref ? truth.bySceneHash.get(ref.contentHash) : null;
      if (!scene) return "unreadable";
      if (claim.predicate !== "speaker_turns") return null;
      return { value: { known: true, quantity: scene.turns, text: `${scene.turns} turns`, attributes: { topic: scene.topic } }, unit: "turns" };
    },
  };
}

export function packResponders(truth: TranscriptSet): Record<string, Responder> {
  return {
    scene_discoverer: (p) => discoverScenes(p, truth),
    scene_reader: (p) => readScene(p, truth),
    ...kernelRoleResponders(oracleFor(truth), (u) => pack.normaliseUnit(u)),
  };
}

export const MOCK_FAMILIES = ["reader-family-one", "reader-family-two", "reader-family-three", "critic-family-one", "critic-family-two", "arbiter-family-one"];

export function mockExecutors(truth: TranscriptSet, options: { families?: string[]; aliases?: Record<string, string>; scripts?: Record<string, Script> } = {}) {
  const registry = new ExecutorRegistry();
  const executors: Record<string, ScriptedExecutor> = {};
  const responders = packResponders(truth);
  for (const family of options.families ?? MOCK_FAMILIES) {
    const alias = options.aliases?.[family];
    if (alias && executors[alias]) { registry.register(executors[alias], [family]); executors[family] = executors[alias]; continue; }
    const executor = new ScriptedExecutor(family, responders, options.scripts?.[family] ?? null);
    registry.register(executor, [family]);
    executors[family] = executor;
  }
  return { registry, executors };
}
