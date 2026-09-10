/* THE RECORD, FROM THE BROWSER'S SIDE.
 *
 * Every screen in this path is rebuilt from these tables and from nothing the
 * browser remembers. That is the whole design rule: reloading the page, or
 * opening it on another device, shows the same analysis at the same point,
 * because the point is in the record and not in a variable.
 *
 * Row-level security does the access control. These calls go out as the
 * signed-in person, so a workspace they are not in returns nothing rather
 * than an error to interpret.
 */
import { KINDS, MAXIMUM_FILES, MAXIMUM_PART_BYTES, extensionOf, nameAndSizeRefusal, probeRefusal } from "./formats.js";
import { momentPlan, pagePlan } from "./plan.js";
import { putResumable, putSmall, CHUNK_BYTES } from "./resumable.js";
import { captureFrame, openVideo, pdfPageText, probePdf, probeVideo, renderPdfPage } from "./prepare.js";

const encoder = new TextEncoder();

export async function sha256Hex(data) {
  const bytes = typeof data === "string" ? encoder.encode(data)
    : data instanceof Blob ? new Uint8Array(await data.arrayBuffer())
    : new Uint8Array(data);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/* The whole file's identity, chunk by chunk, so a two-gigabyte file does not
   have to be held in memory to be identified. Documented in migration 063 for
   exactly what it is and is not. */
export async function fileFingerprint(file, onProgress) {
  const digests = [];
  for (let at = 0; at < file.size; at += CHUNK_BYTES) {
    const slice = await file.slice(at, Math.min(at + CHUNK_BYTES, file.size)).arrayBuffer();
    digests.push(new Uint8Array(await crypto.subtle.digest("SHA-256", slice)));
    onProgress?.({ hashed: Math.min(at + CHUNK_BYTES, file.size), total: file.size });
  }
  const joined = new Uint8Array(digests.length * 32);
  digests.forEach((d, i) => joined.set(d, i * 32));
  const root = await crypto.subtle.digest("SHA-256", joined);
  const hex = [...new Uint8Array(root)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex}-${file.size}`;
}

const safeName = (name) => String(name || "file").replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 80);

export class Refusal extends Error {
  constructor(message) { super(message); this.name = "Refusal"; }
}

/* ─────────────────────────────────────────────────────────── the analyses */

export class AnalysisRecord {
  constructor({ client, organizationId, userId, supabaseUrl, bucket, accessToken }) {
    this.client = client;
    this.organizationId = organizationId;
    this.userId = userId;
    this.supabaseUrl = supabaseUrl;
    this.bucket = bucket;
    this.accessToken = accessToken;
  }

  async list(limit = 25) {
    const { data, error } = await this.client
      .from("analysis_runs")
      .select("id, title, question_kind, question, state, workflow_id, run_requested_at, authorized_usd, created_at, last_error")
      .eq("organization_id", this.organizationId)
      .order("created_at", { ascending: false })
      .limit(limit);
    if (error) throw new Refusal(error.message);
    return data || [];
  }

  async create({ title, questionKind, question }) {
    const { data, error } = await this.client
      .from("analysis_runs")
      .insert({
        organization_id: this.organizationId,
        created_by: this.userId,
        title: String(title || "").trim() || "Untitled analysis",
        question_kind: questionKind,
        question: String(question || "").trim(),
      })
      .select("id, title, question_kind, question, state, created_at")
      .single();
    if (error) throw new Refusal(error.message);
    await this.note(data.id, "analysis.created", { title: data.title, questionKind });
    return data;
  }

  async read(analysisId) {
    const [run, files, parts, events] = await Promise.all([
      this.client.from("analysis_runs")
        .select("id, organization_id, title, question_kind, question, state, workflow_id, estimate, authorized_usd, run_requested_at, last_error, created_at")
        .eq("id", analysisId).maybeSingle(),
      this.client.from("analysis_files")
        .select("id, ordinal, kind, file_name, media_type, byte_size, storage_path, content_fingerprint, upload_state, probe, preparation_state, prepared_units, total_units, last_error")
        .eq("analysis_id", analysisId).order("ordinal"),
      this.client.from("analysis_parts")
        .select("id, file_id, part_kind, ordinal, storage_path, media_type, byte_size, content_sha256, locator")
        .eq("analysis_id", analysisId).order("file_id").order("part_kind").order("ordinal"),
      this.client.from("analysis_events")
        .select("at, kind, detail").eq("analysis_id", analysisId).order("at", { ascending: false }).limit(60),
    ]);
    for (const r of [run, files, parts, events]) if (r.error) throw new Refusal(r.error.message);
    if (!run.data) return null;
    const byFile = new Map();
    for (const part of parts.data || []) {
      const list = byFile.get(part.file_id) || [];
      list.push(part);
      byFile.set(part.file_id, list);
    }
    return {
      run: run.data,
      files: (files.data || []).map((f) => ({ ...f, parts: byFile.get(f.id) || [] })),
      events: events.data || [],
    };
  }

  async note(analysisId, kind, detail = {}) {
    try {
      await this.client.from("analysis_events")
        .insert({ analysis_id: analysisId, organization_id: this.organizationId, kind, detail });
    } catch { /* the history is a courtesy; losing a line must never stop the work */ }
  }

  async setState(analysisId, state, patch = {}) {
    const { error } = await this.client.from("analysis_runs")
      .update({ state, ...patch }).eq("id", analysisId);
    if (error) throw new Refusal(error.message);
  }

  /* ───────────────────────────────────────────────────────────── the files */

  /* Puts one file where the record can find it, and records it as it goes, so
     an interruption at any point leaves something that can be resumed rather
     than something that has to be redone. */
  async addFile({ analysisId, kind, file, existingFiles = [], onProgress, signal }) {
    const spec = KINDS[kind];
    if (!spec) throw new Refusal(`“${kind}” is not one of the three kinds this platform reads.`);
    if (existingFiles.length >= MAXIMUM_FILES) {
      throw new Refusal(`One analysis holds up to ${MAXIMUM_FILES} files. Remove one, or start a second analysis.`);
    }
    const early = nameAndSizeRefusal(kind, file);
    if (early) throw new Refusal(early);

    const ordinal = existingFiles.reduce((top, f) => Math.max(top, Number(f.ordinal) || 0), 0) + 1;
    const objectName = `${this.organizationId}/analysis/${analysisId}/${ordinal}-source${extensionOf(file.name) || (kind === "pdf" ? ".pdf" : ".mp4")}`;

    /* The row exists before the bytes do, so that a tab closed mid-upload
       leaves a file the next visit can see and finish. */
    const { data: row, error } = await this.client.from("analysis_files").insert({
      analysis_id: analysisId,
      organization_id: this.organizationId,
      ordinal, kind,
      file_name: file.name || `file-${ordinal}`,
      media_type: file.type || (kind === "pdf" ? "application/pdf" : "video/mp4"),
      byte_size: file.size,
      storage_path: objectName,
      upload_state: "uploading",
    }).select("id, ordinal, kind, file_name, byte_size, storage_path, upload_state").single();
    if (error) throw new Refusal(error.message);

    try {
      await putResumable({
        supabaseUrl: this.supabaseUrl, bucket: this.bucket, objectName, file,
        accessToken: this.accessToken, contentType: file.type,
        signal,
        onProgress: (p) => onProgress?.({ phase: "uploading", ...p }),
      });
      onProgress?.({ phase: "identifying", sent: file.size, total: file.size });
      const fingerprint = await fileFingerprint(file, (p) => onProgress?.({ phase: "identifying", sent: p.hashed, total: p.total }));
      const { error: settled } = await this.client.from("analysis_files")
        .update({ upload_state: "stored", content_fingerprint: fingerprint })
        .eq("id", row.id);
      if (settled) throw new Refusal(settled.message);
      await this.note(analysisId, "file.stored", { file: row.file_name, bytes: file.size, kind });
      return { ...row, upload_state: "stored", content_fingerprint: fingerprint };
    } catch (uploadError) {
      await this.client.from("analysis_files")
        .update({ upload_state: "failed", last_error: String(uploadError?.message || uploadError).slice(0, 500) })
        .eq("id", row.id);
      throw uploadError;
    }
  }

  async removeFile(analysisId, fileId) {
    const { error } = await this.client.from("analysis_files").delete().eq("id", fileId);
    if (error) throw new Refusal(error.message);
    await this.note(analysisId, "file.removed", { fileId });
  }

  /* ────────────────────────────────────────────────────── the preparation */

  /* Makes every piece this file owes the analysis, skipping the ones already
     in the record. Safe to call again at any time: it is the resume. */
  async prepareFile({ analysisId, fileRow, source, onProgress, signal }) {
    const kind = fileRow.kind;
    await this.client.from("analysis_files")
      .update({ preparation_state: "preparing", last_error: null }).eq("id", fileRow.id);

    const done = new Set((fileRow.parts || []).map((p) => `${p.part_kind}:${p.ordinal}`));
    const put = async (part) => {
      const key = `${part.part_kind}:${part.ordinal}`;
      if (done.has(key)) return false;
      if (part.blob) {
        await putSmall({
          supabaseUrl: this.supabaseUrl, bucket: this.bucket,
          objectName: part.storage_path, body: part.blob,
          accessToken: this.accessToken, contentType: part.media_type,
        });
      }
      const { error } = await this.client.from("analysis_parts").insert({
        analysis_id: analysisId, file_id: fileRow.id, organization_id: this.organizationId,
        part_kind: part.part_kind, ordinal: part.ordinal,
        storage_path: part.storage_path ?? null, inline_text: part.inline_text ?? null,
        media_type: part.media_type, byte_size: part.byte_size,
        content_sha256: part.content_sha256, locator: part.locator,
      });
      /* Two tabs preparing the same file is not a fault; the unique key says
         which one got there first and the other simply carries on. */
      if (error && !/duplicate key|unique constraint/i.test(error.message || "")) throw new Refusal(error.message);
      done.add(key);
      return true;
    };

    try {
      const prefix = `${this.organizationId}/analysis/${analysisId}/${fileRow.ordinal}`;
      const result = kind === "pdf"
        ? await this.#preparePdf({ fileRow, source, prefix, put, onProgress, signal })
        : await this.#prepareVideo({ fileRow, source, prefix, put, onProgress, signal });

      await this.client.from("analysis_files").update({
        preparation_state: "prepared",
        prepared_units: result.prepared,
        total_units: result.total,
        probe: result.probe,
      }).eq("id", fileRow.id);
      await this.note(analysisId, "file.prepared", {
        file: fileRow.file_name, units: result.prepared, total: result.total,
      });
      return result;
    } catch (error) {
      const said = String(error?.message || error).slice(0, 500);
      await this.client.from("analysis_files")
        .update({ preparation_state: "failed", last_error: said }).eq("id", fileRow.id);
      await this.note(analysisId, "file.preparation_failed", { file: fileRow.file_name, problem: said });
      throw error;
    }
  }

  async #preparePdf({ fileRow, source, prefix, put, onProgress, signal }) {
    const bytes = await source.arrayBuffer();
    const opened = await probePdf(bytes);
    const probe = { pages: opened.pages, encrypted: !!opened.encrypted };
    const refusal = probeRefusal("pdf", fileRow, { ...probe, reason: opened.reason });
    if (refusal) throw new Refusal(refusal);

    const pages = pagePlan(opened.pages);
    let prepared = 0;
    for (const { page } of pages) {
      if (signal?.aborted) break;
      onProgress?.({ phase: "preparing", unit: page, total: pages.length, what: `page ${page} of ${pages.length}` });

      const rendered = await renderPdfPage(opened.document, page, { limitBytes: MAXIMUM_PART_BYTES });
      const hash = await sha256Hex(rendered.blob);
      await put({
        part_kind: "pdf_page_image", ordinal: page,
        storage_path: `${prefix}/page-${page}.png`,
        media_type: "image/png", byte_size: rendered.blob.size, content_sha256: hash,
        blob: rendered.blob,
        locator: {
          page,
          /* The whole page, in the page's own points, and the pixels the
             reader was actually given. A fragment inside it is quoted by the
             reader as a box in these coordinates. */
          box: { x: 0, y: 0, width: rendered.pointWidth, height: rendered.pointHeight },
          pointWidth: rendered.pointWidth, pointHeight: rendered.pointHeight,
          pixelWidth: rendered.pixelWidth, pixelHeight: rendered.pixelHeight,
          reducedToGrey: rendered.reduced,
        },
      });

      const text = await pdfPageText(opened.document, page);
      if (text) {
        await put({
          part_kind: "pdf_page_text", ordinal: page,
          inline_text: text.slice(0, 20000),
          media_type: "text/plain; charset=utf-8",
          byte_size: encoder.encode(text.slice(0, 20000)).length,
          content_sha256: await sha256Hex(text.slice(0, 20000)),
          locator: { page, kind: "text" },
        });
      }
      prepared += 1;
    }
    return { prepared, total: pages.length, probe: { ...probe, textPages: prepared } };
  }

  async #prepareVideo({ fileRow, source, prefix, put, onProgress, signal }) {
    const probed = await probeVideo(source);
    const refusal = probeRefusal(fileRow.kind, fileRow, probed);
    if (refusal) throw new Refusal(refusal);

    const open = await openVideo(source);
    try {
      const moments = momentPlan(open.durationSeconds, { maximumMoments: KINDS[fileRow.kind].maximumParts });
      const read = [];
      let prepared = 0;
      for (const moment of moments) {
        if (signal?.aborted) break;
        onProgress?.({ phase: "preparing", unit: moment.ordinal, total: moments.length, what: `moment ${moment.ordinal} of ${moments.length}` });
        const frame = await captureFrame(open, moment.seconds, { limitBytes: MAXIMUM_PART_BYTES });
        if (!frame.ok) throw new Refusal(`${fileRow.file_name}: ${frame.reason}`);
        const hash = await sha256Hex(frame.blob);
        await put({
          part_kind: "video_frame", ordinal: moment.ordinal,
          storage_path: `${prefix}/frame-${String(moment.ordinal).padStart(3, "0")}.png`,
          media_type: "image/png", byte_size: frame.blob.size, content_sha256: hash,
          blob: frame.blob,
          locator: {
            /* The second the decoder landed on, not the second that was asked
               for. Both are kept, because the difference is the honest answer
               to "where exactly did this come from". */
            seconds: frame.actualSeconds,
            requestedSeconds: frame.requestedSeconds,
            pixelWidth: frame.pixelWidth, pixelHeight: frame.pixelHeight,
            sourceWidth: frame.sourceWidth, sourceHeight: frame.sourceHeight,
            equirectangular: fileRow.kind === "video360",
            reducedToGrey: frame.reduced,
          },
        });
        read.push({ ordinal: moment.ordinal, seconds: frame.actualSeconds });
        prepared += 1;
      }
      return {
        prepared, total: moments.length,
        probe: {
          durationSeconds: open.durationSeconds,
          width: open.width, height: open.height,
          equirectangular: fileRow.kind === "video360",
          /* Exactly which moments were looked at. The screen prints this; it
             is the difference between "we read the clip" and the truth. */
          momentsRead: read,
        },
      };
    } finally {
      open.close();
    }
  }
}
