/* AN INVENTED SET OF RECORDINGS, AND THE TRUTH ABOUT THEM.
 *
 * A recording declares nothing about itself; a discoverer finds its scenes
 * as time ranges; each scene has a topic and a number of speaker turns. The
 * second synthetic pack exists so the kernel is exercised on a source with
 * time-range locators and top-level discovered segments — a shape nothing
 * about sheets and boxes would reach.
 */
import type { SourceDescriptor, SourceManifest } from "../../kernel/contracts.ts";
import { canonical, entityId, sha256 } from "../../kernel/ids.ts";

export type Scene = { label: string; ordinal: number; startMs: number; endMs: number; topic: string; turns: number; contentHash: string };
export type Recording = { sourceId: string; ordinal: number; label: string; durationMs: number; contentHash: string; scenes: Scene[] };

export type TranscriptSetOptions = { seed?: string; recordings?: number; scenesPerRecording?: number; organizationId?: string; workflowId?: string };

export type TranscriptSet = {
  manifest: SourceManifest;
  recordings: Recording[];
  byRecordingHash: Map<string, Recording>;
  bySceneHash: Map<string, Scene>;
  totals: Record<string, { turns: number; scenes: number }>;
};

const TOPICS = ["orientation", "review", "handover", "closing"];

function rng(seed: string): () => number {
  let state = sha256(seed);
  return () => { state = sha256(state); return parseInt(state.slice(0, 8), 16) / 0xffffffff; };
}

export function syntheticTranscriptSet(options: TranscriptSetOptions = {}): TranscriptSet {
  const seed = options.seed ?? "synthetic-transcripts/1";
  const count = options.recordings ?? 1;
  const perRecording = options.scenesPerRecording ?? 3;
  const next = rng(seed);
  const organizationId = options.organizationId ?? entityId("fixture-organisation", seed);
  const workflowId = options.workflowId ?? entityId("fixture-workflow", seed);
  const recordings: Recording[] = [];
  const descriptors: SourceDescriptor[] = [];
  const totals: TranscriptSet["totals"] = {};

  for (let r = 0; r < count; r++) {
    const sourceId = entityId("fixture-recording", seed, r);
    const scenes: Scene[] = [];
    let cursor = 0;
    for (let s = 0; s < perRecording; s++) {
      const length = 20_000 + Math.floor(next() * 60_000);
      const scene: Scene = { label: `scene ${s + 1}`, ordinal: s, startMs: cursor, endMs: cursor + length, topic: TOPICS[Math.floor(next() * TOPICS.length)], turns: 2 + Math.floor(next() * 12), contentHash: "" };
      scene.contentHash = `fx-${sha256(canonical({ seed, r, s, scene: [scene.startMs, scene.endMs, scene.topic, scene.turns] })).slice(0, 24)}`;
      scenes.push(scene);
      cursor += length;
    }
    const recording: Recording = { sourceId, ordinal: r, label: `recording ${r + 1}`, durationMs: cursor, contentHash: "", scenes };
    recording.contentHash = `fx-${sha256(canonical({ seed, r, scenes: scenes.map((s) => s.contentHash) })).slice(0, 24)}`;
    recordings.push(recording);
    totals[`recording/${r}`] = { turns: scenes.reduce((n, s) => n + s.turns, 0), scenes: scenes.length };
    descriptors.push({
      sourceId, ordinal: r, sourceKind: "recording", label: recording.label, uri: `fixture://synthetic-transcripts/${sha256(seed).slice(0, 8)}/${r}`,
      contentHash: recording.contentHash, hashAlgorithm: "sha-256", objectVersionId: null, byteSize: Math.floor(cursor / 10), media: { fixture: true, duration_ms: cursor }, declaredSegments: [],
    });
  }
  const manifest: SourceManifest = {
    workflowId, organizationId, domainPack: "synthetic-transcripts", domainPackVersion: "1.0", workflowType: "synthetic_transcript_review",
    requestedScope: { fixture: seed }, sources: descriptors,
  };
  return { manifest, recordings, totals, byRecordingHash: new Map(recordings.map((r) => [r.contentHash, r])), bySceneHash: new Map(recordings.flatMap((r) => r.scenes.map((s) => [s.contentHash, s] as const))) };
}
