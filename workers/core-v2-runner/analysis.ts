/* THE OWNER'S UPLOADED FILES, AS SOMETHING THE ENGINE CAN READ.
 *
 * Between "a PDF is in storage" and "a reader is handed page four" there are
 * exactly two questions, and this file answers both from the record alone:
 *
 *   1. WHAT DOES THIS WORKFLOW READ. A manifest: one source per file, and one
 *      declared segment per page, per page of text, and per sampled frame —
 *      each under the hash of its own bytes, each with the place in the
 *      original it came from.
 *
 *   2. WHERE ARE THOSE BYTES. A resolver: given a hash the packet already
 *      authorises, the row that says which object holds them, and then the
 *      bytes. It answers by hash and by nothing else, so a resolver cannot
 *      widen an assignment and a reading cannot quietly be of something else.
 *
 * NOTHING HERE RE-READS A FILE TO CHANGE A FINISHED ANSWER. The manifest is
 * built from the parts that were recorded when the file was prepared. If those
 * parts change, the source's hash changes, and a different hash is a different
 * source set — which the engine already refuses to continue a workflow with.
 */
import type { SegmentDescriptor, SourceDescriptor, SourceManifest } from "../core-v2/kernel/contracts.ts";
import { canonical, entityId, isUuid, sha256 } from "../core-v2/kernel/ids.ts";
import type { Queryable } from "../core-v2/postgres/wire.ts";
import type { MaterialResolver, MediaKind, ResolvedMaterial } from "../core-v2-runtime/material/material.ts";
import type { SourceReference } from "../core-v2/kernel/contracts.ts";
import { PACK_ID, PACK_VERSION, SEGMENT_KINDS } from "../core-v2/domains/source-documents/pack.ts";

/* The scheme an analysis source is named under. It carries the analysis and
   the file's place in it, so a runner that finds this uri knows exactly which
   rows to rebuild from — and a uri it does not recognise is refused rather
   than guessed at. */
export const ANALYSIS_SCHEME = "mdai://analysis/";

export function analysisSourceUri(analysisId: string, ordinal: number): string {
  return `${ANALYSIS_SCHEME}${analysisId}/file/${ordinal}`;
}

export function analysisOfSourceUri(uri: string): { analysisId: string; ordinal: number } | null {
  if (!uri.startsWith(ANALYSIS_SCHEME)) return null;
  const match = /^mdai:\/\/analysis\/([0-9a-f-]{36})\/file\/(\d+)$/i.exec(uri);
  if (!match) return null;
  return { analysisId: match[1], ordinal: Number(match[2]) };
}

export type AnalysisPart = {
  partId: string;
  fileId: string;
  partKind: "pdf_page_image" | "pdf_page_text" | "video_frame";
  ordinal: number;
  storagePath: string | null;
  inlineText: string | null;
  mediaType: string;
  byteSize: number;
  contentHash: string;
  locator: Record<string, unknown>;
};

export type AnalysisFile = {
  fileId: string;
  ordinal: number;
  kind: "pdf" | "video" | "video360";
  fileName: string;
  mediaType: string;
  byteSize: number;
  storagePath: string;
  probe: Record<string, unknown>;
  parts: AnalysisPart[];
};

export type AnalysisRecord = {
  analysisId: string;
  organizationId: string;
  title: string;
  question: string;
  questionKind: string;
  state: string;
  authorizedUsd: number | null;
  paidCallsAllowed: boolean;
  /* The owner's own answer to "what should be compared with what". Empty
     means the material's own cross-references decide. */
  chosenPairing: Record<string, unknown>;
  files: AnalysisFile[];
};

const asJson = (value: unknown): Record<string, unknown> => {
  if (value === null || value === undefined) return {};
  if (typeof value === "string") { try { return JSON.parse(value) as Record<string, unknown>; } catch { return {}; } }
  return value as Record<string, unknown>;
};

/* Everything one analysis is, in three statements. Ordered, so the manifest
   built from it is the same manifest every time. */
export async function readAnalysis(client: Queryable, analysisId: string): Promise<AnalysisRecord | null> {
  const runs = await client.query(
    `select a.id::text as id, a.organization_id::text as organization_id, a.title, a.question,
            a.question_kind, a.state, a.authorized_usd, a.run_requested_at, a.pairing
       from public.analysis_runs a where a.id = $1::uuid`, [analysisId]);
  if (!runs.rows.length) return null;
  const run = runs.rows[0];

  const files = await client.query(
    `select f.id::text as id, f.ordinal, f.kind, f.file_name, f.media_type, f.byte_size,
            f.storage_path, f.probe
       from public.analysis_files f
      where f.analysis_id = $1::uuid and f.upload_state = 'stored'
      order by f.ordinal`, [analysisId]);

  const parts = await client.query(
    `select p.id::text as id, p.file_id::text as file_id, p.part_kind, p.ordinal, p.storage_path,
            p.inline_text, p.media_type, p.byte_size, p.content_sha256, p.locator
       from public.analysis_parts p
      where p.analysis_id = $1::uuid
      order by p.file_id, p.part_kind, p.ordinal`, [analysisId]);

  const byFile = new Map<string, AnalysisPart[]>();
  for (const row of parts.rows) {
    const list = byFile.get(String(row.file_id)) ?? [];
    list.push({
      partId: String(row.id), fileId: String(row.file_id),
      partKind: String(row.part_kind) as AnalysisPart["partKind"],
      ordinal: Number(row.ordinal),
      storagePath: row.storage_path === null || row.storage_path === undefined ? null : String(row.storage_path),
      inlineText: row.inline_text === null || row.inline_text === undefined ? null : String(row.inline_text),
      mediaType: String(row.media_type), byteSize: Number(row.byte_size ?? 0),
      contentHash: String(row.content_sha256), locator: asJson(row.locator),
    });
    byFile.set(String(row.file_id), list);
  }

  const authorized = run.authorized_usd === null || run.authorized_usd === undefined ? null : Number(run.authorized_usd);
  return {
    analysisId: String(run.id),
    organizationId: String(run.organization_id),
    title: String(run.title),
    question: String(run.question ?? ""),
    questionKind: String(run.question_kind),
    state: String(run.state),
    authorizedUsd: authorized,
    paidCallsAllowed: run.run_requested_at !== null && run.run_requested_at !== undefined && (authorized ?? 0) > 0,
    chosenPairing: asJson(run.pairing),
    files: files.rows.map((row) => ({
      fileId: String(row.id), ordinal: Number(row.ordinal),
      kind: String(row.kind) as AnalysisFile["kind"],
      fileName: String(row.file_name), mediaType: String(row.media_type),
      byteSize: Number(row.byte_size), storagePath: String(row.storage_path),
      probe: asJson(row.probe),
      parts: (byFile.get(String(row.id)) ?? []).sort((a, b) =>
        a.partKind.localeCompare(b.partKind) || a.ordinal - b.ordinal),
    })),
  };
}

export class AnalysisNotReadable extends Error {
  readonly reasons: string[];
  constructor(analysisId: string, reasons: string[]) {
    super(`core-v2-runner: analysis ${analysisId} cannot be read as a source set — ${reasons.join("; ")}`);
    this.name = "AnalysisNotReadable";
    this.reasons = reasons;
  }
}

/* A FILE'S HASH IS THE HASH OF WHAT WAS GOT OUT OF IT.
 *
 * Not of the upload: the engine never sends a whole PDF anywhere, and a hash
 * of bytes nobody reads proves nothing about what was read. This is the hash
 * of the ordered list of the parts — their kinds, their places and their own
 * hashes — so two analyses that prepared the same pages have the same source
 * hash, and a file prepared differently is a different source. */
export function fileContentHash(file: AnalysisFile): string {
  return sha256(canonical({
    kind: file.kind,
    parts: file.parts.map((p) => ({ k: p.partKind, o: p.ordinal, h: p.contentHash, l: p.locator })),
  }));
}

/* The manifest, from the record. Segment ids are derived from identity — the
   workflow, the source and the segment's own place — so the same analysis
   always produces the same ids and a rebuild after a restart lines up with
   what is already stored. */
/* THE WORKFLOW ID AN ANALYSIS BECOMES, DRAWN FROM THE ANALYSIS ITSELF.
 *
 * Deterministic on purpose. The workflow's id is what `createWorkflow` keys
 * on, so a second press of Run — a double click, a retried request, a browser
 * that reloaded mid-flight — finds the workflow that already exists instead of
 * starting a second one over the same files. The material cannot have changed
 * underneath it: migration 063 closes an analysis's files the moment a run is
 * requested. */
export function workflowIdForAnalysis(analysisId: string): string {
  return entityId("core_v2.analysis.workflow", analysisId);
}

export function manifestOfAnalysis(
  analysis: AnalysisRecord,
  workflowId: string,
  pairing: { pairs: unknown[]; unpaired: unknown[]; note: string } = { pairs: [], unpaired: [], note: "" },
): SourceManifest {
  /* A manifest carries the id the workflow will be created under. A
     placeholder here becomes a workflow nothing can find. */
  if (!isUuid(workflowId)) {
    throw new AnalysisNotReadable(analysis.analysisId, [`"${workflowId}" is not a workflow id`]);
  }
  const reasons: string[] = [];
  if (analysis.files.length === 0) reasons.push("it holds no stored file");

  const sources: SourceDescriptor[] = [];
  for (const file of analysis.files) {
    const sourceId = entityId("analysis-source", analysis.analysisId, String(file.ordinal));
    const declared: SegmentDescriptor[] = [];

    for (const part of file.parts) {
      const kind = part.partKind === "pdf_page_image" ? SEGMENT_KINDS.page
        : part.partKind === "pdf_page_text" ? SEGMENT_KINDS.pageText
        : SEGMENT_KINDS.moment;
      declared.push({
        sourceId,
        parentSegmentId: null,
        segmentKind: kind,
        label: labelOf(file, part),
        ordinal: part.ordinal,
        locator: part.locator as SegmentDescriptor["locator"],
        contentHash: part.contentHash,
      });
    }
    if (declared.length === 0) reasons.push(`file ${file.ordinal} has nothing prepared to read`);

    sources.push({
      sourceId,
      ordinal: file.ordinal,
      sourceKind: file.kind === "pdf" ? "document" : "recording",
      label: file.fileName,
      uri: analysisSourceUri(analysis.analysisId, file.ordinal),
      contentHash: fileContentHash(file),
      hashAlgorithm: "sha256",
      objectVersionId: null,
      byteSize: file.byteSize,
      media: { mediaType: file.mediaType, ...file.probe },
      declaredSegments: declared,
    });
  }
  if (reasons.length > 0) throw new AnalysisNotReadable(analysis.analysisId, reasons);

  return {
    workflowId,
    organizationId: analysis.organizationId,
    domainPack: PACK_ID,
    domainPackVersion: PACK_VERSION,
    workflowType: analysis.questionKind,
    /* What the owner asked for, in the shape the record can keep: which
       question they chose, how many files it is over, and how many pieces
       were prepared. Not the question's words — those go to the pack, which
       puts them in the assignment. */
    requestedScope: {
      analysisId: analysis.analysisId,
      questionKind: analysis.questionKind,
      files: analysis.files.length,
      segments: sources.reduce((n, s) => n + s.declaredSegments.length, 0),
      /* WHAT THIS RUN COMPARES, frozen with the workflow. 058 does not let a
         requested scope change, so the pairs a reading was made under can be
         read back from the record for as long as the result stands — and a
         later pass builds exactly the assignments the first one did. */
      pairs: pairing.pairs,
      unpaired: pairing.unpaired,
      pairingNote: pairing.note,
    },
    sources,
  };
}

function labelOf(file: AnalysisFile, part: AnalysisPart): string {
  if (part.partKind === "pdf_page_image") return `${file.fileName} · page ${part.ordinal}`;
  if (part.partKind === "pdf_page_text") return `${file.fileName} · page ${part.ordinal} text`;
  const seconds = Number(part.locator.seconds ?? 0);
  return `${file.fileName} · ${clock(seconds)}`;
}

export function clock(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  const m = Math.floor(whole / 60);
  const s = whole % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

/* ─────────────────────────────────────────────── the bytes, by hash alone */

export type ReadObject = (storagePath: string) => Promise<Uint8Array>;

const MEDIA_KIND: Record<AnalysisPart["partKind"], MediaKind> = {
  pdf_page_image: "pdf_page_image",
  pdf_page_text: "text",
  video_frame: "image",
};

/* Answers only what it is asked, and only by hash. It holds the parts of ONE
   analysis, so a reference from another workflow finds nothing here — which is
   the same refusal the fixture resolver makes, for the same reason. */
export class AnalysisMaterialResolver implements MaterialResolver {
  readonly name = "analysis-storage";
  readonly asked: SourceReference[] = [];
  private byHash: Map<string, AnalysisPart>;
  private read: ReadObject;
  private cache = new Map<string, Uint8Array>();

  constructor(analysis: AnalysisRecord, read: ReadObject) {
    this.byHash = new Map();
    for (const file of analysis.files) for (const part of file.parts) this.byHash.set(part.contentHash, part);
    this.read = read;
  }

  async resolve(sources: readonly SourceReference[]): Promise<ResolvedMaterial[]> {
    const out: ResolvedMaterial[] = [];
    for (const reference of sources) {
      this.asked.push(reference);
      const part = this.byHash.get(reference.contentHash);
      /* Nothing under that hash is nothing to return. Saying so is the whole
         answer; the caller's rule is to refuse, and it does. */
      if (!part) continue;

      if (part.inlineText !== null && part.storagePath === null) {
        out.push({
          sourceId: reference.sourceId, segmentId: reference.segmentId,
          mediaKind: MEDIA_KIND[part.partKind], mimeType: part.mediaType,
          contentHash: part.contentHash, byteLength: new TextEncoder().encode(part.inlineText).length,
          locator: reference.locator, content: { text: part.inlineText },
        });
        continue;
      }
      if (part.storagePath === null) continue;

      let bytes = this.cache.get(part.contentHash);
      if (!bytes) {
        bytes = await this.read(part.storagePath);
        this.cache.set(part.contentHash, bytes);
      }
      out.push({
        sourceId: reference.sourceId, segmentId: reference.segmentId,
        mediaKind: MEDIA_KIND[part.partKind], mimeType: part.mediaType,
        contentHash: part.contentHash, byteLength: bytes.length,
        locator: reference.locator, content: { bytes },
      });
    }
    return out;
  }
}
