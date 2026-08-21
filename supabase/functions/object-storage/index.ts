import { safeError } from "../_shared/safe-error.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  getSignedUrl,
  ListPartsCommand,
  signedObjectReadUrl,
  UploadPartCommand,
  awsObjectStore,
} from "../_shared/aws-object-store.ts";

const PART_SIZE = 32 * 1024 * 1024;
const MAX_PARTS_PER_REQUEST = 100;
const URL_TTL_SECONDS = 60 * 60;
const allowedOrigins = new Set([
  "https://measureddecision.com",
  "https://www.measureddecision.com",
  "http://localhost:8080",
  "http://127.0.0.1:8080",
]);

type UploadRow = {
  id: string;
  organization_id: string;
  property_id: string;
  space_id: string | null;
  entity_type: "project_document" | "evidence";
  storage_bucket: string;
  object_key: string;
  multipart_upload_id: string;
  original_filename: string;
  mime_type: string;
  byte_size: number;
  entity_metadata: Record<string, unknown>;
  status: "pending" | "completed" | "aborted" | "failed";
  created_by: string;
  field_assignment_id: string | null;
  capture_session_id: string | null;
  project_intake_access_id: string | null;
};

type FieldAssignment = {
  id: string;
  organization_id: string;
  property_id: string;
  baseline_id: string;
  capture_task_id: string;
  requirement_id: string;
  space_id: string | null;
  status: string;
  token_hash: string;
  expires_at: string;
  created_by: string;
  instructions_snapshot: Record<string, unknown>;
};

type CaptureSession = {
  id: string;
  organization_id: string;
  property_id: string;
  default_space_id: string;
  status: string;
  token_hash: string;
  expires_at: string;
  created_by: string;
};
type ProjectIntakeAccess={id:string;organization_id:string;property_id:string;default_space_id:string;status:string;code_hash:string;created_by:string};

function corsHeaders(request: Request) {
  const origin = request.headers.get("origin") || "";
  return {
    "Access-Control-Allow-Origin": allowedOrigins.has(origin)
      ? origin
      : "https://measureddecision.com",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    Vary: "Origin",
  };
}

function json(request: Request, body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders(request),
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
}

function cleanFilename(value: unknown) {
  const raw = String(value || "file").normalize("NFKD");
  const parts = raw.split(".");
  const extension = parts.length > 1
    ? `.${String(parts.pop()).toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 12)}`
    : "";
  const base = parts.join(".").replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return `${(base || "file").slice(0, 96)}${extension}`;
}

function text(value: unknown, fallback = "") {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function numberValue(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function isUuid(value: unknown) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || ""));
}
function normalizeProjectCode(value:unknown){return String(value||"").toUpperCase().replace(/[^A-Z2-9]/g,"")}

const SOURCE_TYPES = new Set([
  "phone", "360_camera", "drone", "document", "external_system", "manual_upload", "derived",
]);

/* What produced the file. Guessing here would be worse than leaving it unset, so
   an unrecognised claim from a client is dropped rather than coerced. */
function resolveSourceType(
  declared: unknown,
  entityType: string,
  context: { captureSession: boolean; projectAccess: boolean; fieldAssignment: boolean },
) {
  const claimed = String(declared || "").trim();
  if (SOURCE_TYPES.has(claimed)) return claimed;
  if (entityType === "project_document") return "document";
  if (context.captureSession) return "360_camera";
  if (context.fieldAssignment) return "phone";
  if (context.projectAccess) return "manual_upload";
  return "manual_upload";
}

/* Where a request came from, for the audit trail. Behind Supabase's edge these
   are proxy headers: recorded as reported, never presented as verified. */
function requestOrigin(request: Request) {
  const forwarded = request.headers.get("x-forwarded-for") || "";
  return {
    ip: forwarded.split(",")[0].trim() || null,
    userAgent: (request.headers.get("user-agent") || "").slice(0, 500) || null,
  };
}

function bytesToHex(bytes: Uint8Array) {
  return Array.from(bytes).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function hashToken(token: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return bytesToHex(new Uint8Array(digest));
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders(request) });
  if (request.method !== "POST") return json(request, { error: "Method not allowed" }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY") || Deno.env.get("SUPABASE_PUBLISHABLE_KEY");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const authorization = request.headers.get("Authorization") || "";
  if (!supabaseUrl || !anonKey || !serviceKey) return json(request, { error: "Server configuration is incomplete" }, 500);

  const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

  try {
    const body = await request.json();
    const operation = text(body?.operation);
    let userId = "";
    let fieldAssignment: FieldAssignment | null = null;
    let captureSession: CaptureSession | null = null;
    let projectAccess: ProjectIntakeAccess | null = null;
    if (body?.field_access?.assignment_id && body?.field_access?.token) {
      const assignmentId = text(body.field_access.assignment_id);
      const token = text(body.field_access.token);
      if (!isUuid(assignmentId) || token.length < 32) throw Object.assign(new Error("Invalid field assignment"), { status: 401 });
      const { data: assignment } = await admin.from("field_assignments")
        .select("*")
        .eq("id", assignmentId)
        .eq("token_hash", await hashToken(token))
        .maybeSingle();
      if (!assignment || ["revoked", "expired", "completed"].includes(assignment.status) || new Date(assignment.expires_at).valueOf() <= Date.now()) {
        throw Object.assign(new Error("This field assignment is no longer available"), { status: 410 });
      }
      fieldAssignment = assignment as FieldAssignment;
      userId = fieldAssignment.created_by;
    } else if (body?.capture_access?.session_id && body?.capture_access?.token) {
      const sessionId = text(body.capture_access.session_id);
      const token = text(body.capture_access.token);
      if (!isUuid(sessionId) || token.length < 32) throw Object.assign(new Error("Invalid capture session"), { status: 401 });
      const { data: session } = await admin.from("capture_sessions")
        .select("*")
        .eq("id", sessionId)
        .eq("token_hash", await hashToken(token))
        .maybeSingle();
      if (!session || ["revoked", "expired", "completed"].includes(session.status) || new Date(session.expires_at).valueOf() <= Date.now()) {
        throw Object.assign(new Error("This capture session is no longer available"), { status: 410 });
      }
      captureSession = session as CaptureSession;
      userId = captureSession.created_by;
    } else if(body?.project_access?.code){
      const code=normalizeProjectCode(body.project_access.code);if(code.length!==12)throw Object.assign(new Error("Invalid project code"),{status:401});
      const{data:access}=await admin.from("project_intake_access").select("*").eq("code_hash",await hashToken(code)).maybeSingle();
      if(!access||access.status==="closed")throw Object.assign(new Error("This project is not available"),{status:410});
      projectAccess=access as ProjectIntakeAccess;userId=projectAccess.created_by;
    } else {
      if (!authorization.startsWith("Bearer ")) throw Object.assign(new Error("Authentication required"), { status: 401 });
      const userClient = createClient(supabaseUrl, anonKey, {
        global: { headers: { Authorization: authorization } },
        auth: { persistSession: false },
      });
      const { data: userData, error: userError } = await userClient.auth.getUser();
      if (userError || !userData.user) throw Object.assign(new Error("Invalid session"), { status: 401 });
      userId = userData.user.id;
    }
    const { bucket, client: s3 } = awsObjectStore();
    if (captureSession && ["submitted", "processing", "ready_for_review", "completed"].includes(captureSession.status) && operation !== "get_url") {
      throw Object.assign(new Error("This capture session has already been submitted"), { status: 409 });
    }

    async function membership(organizationId: string) {
      if (fieldAssignment) return "field_worker";
      if (captureSession) return "capture_guest";
      if(projectAccess)return "project_guest";
      const { data } = await admin.from("organization_members")
        .select("role")
        .eq("organization_id", organizationId)
        .eq("user_id", userId)
        .maybeSingle();
      return data?.role || null;
    }

    async function uploadSession(sessionId: unknown) {
      if (!isUuid(sessionId)) throw Object.assign(new Error("A valid upload session is required"), { status: 400 });
      const { data, error } = await admin.from("object_uploads")
        .select("*")
        .eq("id", sessionId)
        .eq(fieldAssignment?"field_assignment_id":captureSession?"capture_session_id":projectAccess?"project_intake_access_id":"created_by",fieldAssignment?fieldAssignment.id:captureSession?captureSession.id:projectAccess?projectAccess.id:userId)
        .maybeSingle();
      if (error || !data) throw Object.assign(new Error("Upload session not found"), { status: 404 });
      const role = await membership(data.organization_id);
      if (!role) throw Object.assign(new Error("Not authorized for this upload"), { status: 403 });
      return { row: data as UploadRow, role };
    }

    async function completedUpload(row: UploadRow) {
      const table = row.entity_type === "project_document" ? "project_documents" : "evidence_items";
      const { data: record, error } = await admin.from(table).select("*").eq("id", row.id).maybeSingle();
      if (error || !record) throw Object.assign(new Error("Completed upload record could not be recovered"), { status: 409 });
      return {
        status: "completed",
        record,
        signed_url: await signedObjectReadUrl(row.object_key, URL_TTL_SECONDS),
      };
    }

    if (operation === "create_upload") {
      const fieldCaptureType = text(fieldAssignment?.instructions_snapshot?.capture_type).toLowerCase();
      const entityType = captureSession
        ? "evidence"
        : projectAccess ? "evidence"
        : fieldAssignment
        ? fieldCaptureType === "document" ? "project_document" : "evidence"
        : text(body?.entity_type);
      const organizationId=captureSession?.organization_id||projectAccess?.organization_id||fieldAssignment?.organization_id||text(body?.organization_id);
      const propertyId=captureSession?.property_id||projectAccess?.property_id||fieldAssignment?.property_id||text(body?.property_id);
      const spaceId=captureSession?.default_space_id||projectAccess?.default_space_id||fieldAssignment?.space_id||(body?.space_id?text(body.space_id):null);
      const filename = text(body?.file?.name);
      const mimeType = text(body?.file?.type, "application/octet-stream");
      const byteSize = numberValue(body?.file?.size);
      if (!["project_document", "evidence"].includes(entityType)) throw Object.assign(new Error("Unsupported upload type"), { status: 400 });
      if (!isUuid(organizationId) || !isUuid(propertyId) || !filename || byteSize <= 0) throw Object.assign(new Error("Upload metadata is incomplete"), { status: 400 });
      if (byteSize > 5 * 1024 * 1024 * 1024 * 1024) throw Object.assign(new Error("File exceeds the S3 multipart limit"), { status: 413 });
      if (captureSession) {
        if (mimeType !== "video/mp4" && !filename.toLowerCase().endsWith(".mp4")) {
          throw Object.assign(new Error("Capture sessions accept full 360 MP4 video only"), { status: 415 });
        }
        if (byteSize > 50 * 1024 * 1024 * 1024) {
          throw Object.assign(new Error("A capture-session video cannot exceed 50 GB"), { status: 413 });
        }
        const { count } = await admin.from("object_uploads")
          .select("id", { count: "exact", head: true })
          .eq("capture_session_id", captureSession.id)
          .in("status", ["pending", "completed"]);
        if (Number(count || 0) >= 100) throw Object.assign(new Error("This capture session already contains 100 videos"), { status: 409 });
      }
      if(projectAccess){const lowerFilename=filename.toLowerCase();const insta360Source=[".insv",".insp",".lrv"].some(extension=>lowerFilename.endsWith(extension));const accepted=mimeType.startsWith("image/")||mimeType.startsWith("video/")||mimeType==="application/pdf"||lowerFilename.endsWith(".pdf")||insta360Source;if(!accepted)throw Object.assign(new Error("Add photos, videos, Insta360 originals, or PDF documents"),{status:415});if(byteSize>50*1024*1024*1024)throw Object.assign(new Error("A single evidence file cannot exceed 50 GB"),{status:413});const{count}=await admin.from("object_uploads").select("id",{count:"exact",head:true}).eq("project_intake_access_id",projectAccess.id).in("status",["pending","completed"]);if(Number(count||0)>=500)throw Object.assign(new Error("This project already contains 500 evidence files"),{status:409})}

      const role = await membership(organizationId);
      const allowedRoles = entityType === "project_document"
        ? ["owner", "admin", "contributor"]
        : ["owner", "admin", "contributor"];
      if(!role||(!fieldAssignment&&!captureSession&&!projectAccess&&!allowedRoles.includes(role)))throw Object.assign(new Error("Not authorized to upload this file"),{status:403});

      const { data: property } = await admin.from("properties")
        .select("id")
        .eq("id", propertyId)
        .eq("organization_id", organizationId)
        .maybeSingle();
      if (!property) throw Object.assign(new Error("Project not found"), { status: 404 });
      if (entityType === "evidence") {
        if (!isUuid(spaceId)) throw Object.assign(new Error("A valid room is required"), { status: 400 });
        const { data: space } = await admin.from("spaces")
          .select("id")
          .eq("id", spaceId)
          .eq("property_id", propertyId)
          .eq("organization_id", organizationId)
          .maybeSingle();
        if (!space) throw Object.assign(new Error("Room not found"), { status: 404 });
      }

      const sessionId = crypto.randomUUID();
      const kind = entityType === "project_document" ? "plans" : "evidence";
      const objectKey = `organizations/${organizationId}/properties/${propertyId}/${kind}/${sessionId}-${cleanFilename(filename)}`;
      const created = await s3.send(new CreateMultipartUploadCommand({
        Bucket: bucket,
        Key: objectKey,
        ContentType: mimeType,
        Metadata: {
          organization_id: organizationId,
          property_id: propertyId,
          entity_type: entityType,
          uploaded_by: userId,
        },
      }));
      if (!created.UploadId) throw new Error("S3 did not create a multipart upload");

      const suppliedMetadata = body?.metadata && typeof body.metadata === "object" ? body.metadata : {};
      const entityMetadata = captureSession ? {
        ...suppliedMetadata,
        media_type: "360 capture",
        capture_session_id: captureSession.id,
        source_metadata: {
          ...((suppliedMetadata as Record<string, Record<string, unknown>>)?.source_metadata || {}),
          source: "secure-capture-session",
          capture_session_id: captureSession.id,
        },
      } : projectAccess ? {...suppliedMetadata,media_type:text((suppliedMetadata as Record<string,unknown>).media_type,"Project evidence"),project_intake_access_id:projectAccess.id,source_metadata:{...((suppliedMetadata as Record<string,Record<string,unknown>>)?.source_metadata||{}),source:"passwordless-studio",project_intake_access_id:projectAccess.id}} : fieldAssignment ? {
        ...suppliedMetadata,
        capture_task_id: fieldAssignment.capture_task_id,
        baseline_id: fieldAssignment.baseline_id,
        field_assignment_id: fieldAssignment.id,
        source_metadata: {
          ...((suppliedMetadata as Record<string, Record<string, unknown>>)?.source_metadata || {}),
          source: "secure-field-portal",
          field_assignment_id: fieldAssignment.id,
        },
      } : suppliedMetadata;
      const { error: insertError } = await admin.from("object_uploads").insert({
        id: sessionId,
        organization_id: organizationId,
        property_id: propertyId,
        space_id: spaceId,
        entity_type: entityType,
        storage_bucket: bucket,
        object_key: objectKey,
        multipart_upload_id: created.UploadId,
        original_filename: filename,
        mime_type: mimeType,
        byte_size: byteSize,
        entity_metadata: entityMetadata,
        created_by: userId,
        field_assignment_id: fieldAssignment?.id || null,
        capture_session_id: captureSession?.id || null,
        project_intake_access_id:projectAccess?.id||null,
      });
      if (insertError) {
        await s3.send(new AbortMultipartUploadCommand({ Bucket: bucket, Key: objectKey, UploadId: created.UploadId })).catch(() => undefined);
        throw insertError;
      }
      return json(request, { session_id: sessionId, part_size: PART_SIZE, completed_parts: [] });
    }

    if (operation === "resume_upload") {
      const { row } = await uploadSession(body?.session_id);
      if (row.status === "completed") return json(request, await completedUpload(row));
      if (row.status !== "pending") throw Object.assign(new Error(`Upload is already ${row.status}`), { status: 409 });
      const parts: Array<{ part_number: number; etag: string; size: number }> = [];
      let marker: string | undefined;
      do {
        const page = await s3.send(new ListPartsCommand({
          Bucket: row.storage_bucket,
          Key: row.object_key,
          UploadId: row.multipart_upload_id,
          PartNumberMarker: marker,
        }));
        for (const part of page.Parts || []) {
          if (part.PartNumber && part.ETag) parts.push({ part_number: part.PartNumber, etag: part.ETag, size: part.Size || PART_SIZE });
        }
        marker = page.IsTruncated ? page.NextPartNumberMarker : undefined;
      } while (marker);
      return json(request, { session_id: row.id, part_size: PART_SIZE, completed_parts: parts });
    }

    if (operation === "sign_parts") {
      const { row } = await uploadSession(body?.session_id);
      if (row.status !== "pending") throw Object.assign(new Error(`Upload is ${row.status}`), { status: 409 });
      const partNumbers = Array.isArray(body?.part_numbers)
        ? [...new Set(body.part_numbers.map(numberValue).filter((part: number) => Number.isInteger(part) && part >= 1 && part <= 10000))]
        : [];
      if (!partNumbers.length || partNumbers.length > MAX_PARTS_PER_REQUEST) throw Object.assign(new Error("Request 1 to 100 valid part numbers"), { status: 400 });
      const urls = await Promise.all(partNumbers.map(async (partNumber: number) => ({
        part_number: partNumber,
        url: await getSignedUrl(s3, new UploadPartCommand({
          Bucket: row.storage_bucket,
          Key: row.object_key,
          UploadId: row.multipart_upload_id,
          PartNumber: partNumber,
        }), { expiresIn: URL_TTL_SECONDS }),
      })));
      await admin.from("object_uploads").update({ updated_at: new Date().toISOString() }).eq("id", row.id);
      return json(request, { urls, expires_in: URL_TTL_SECONDS });
    }

    if (operation === "complete_upload") {
      const { row } = await uploadSession(body?.session_id);
      if (row.status === "completed") return json(request, await completedUpload(row));
      if (row.status !== "pending") throw Object.assign(new Error(`Upload is already ${row.status}`), { status: 409 });
      const parts = Array.isArray(body?.parts) ? body.parts.map((part: Record<string, unknown>) => ({
        PartNumber: numberValue(part.part_number),
        ETag: text(part.etag),
      })).filter((part: { PartNumber: number; ETag: string }) => Number.isInteger(part.PartNumber) && part.PartNumber >= 1 && part.ETag) : [];
      parts.sort((a: { PartNumber: number }, b: { PartNumber: number }) => a.PartNumber - b.PartNumber);
      const expectedParts = Math.ceil(Number(row.byte_size) / PART_SIZE);
      if (parts.length !== expectedParts) throw Object.assign(new Error(`Upload has ${parts.length} of ${expectedParts} required parts`), { status: 409 });

      const completed = await s3.send(new CompleteMultipartUploadCommand({
        Bucket: row.storage_bucket,
        Key: row.object_key,
        UploadId: row.multipart_upload_id,
        MultipartUpload: { Parts: parts },
      }));
      const metadata = row.entity_metadata || {};
      const baseRecord = {
        id: row.id,
        organization_id: row.organization_id,
        property_id: row.property_id,
        storage_path: row.object_key,
        storage_provider: "aws-s3",
        storage_bucket: row.storage_bucket,
        object_version_id: completed.VersionId || null,
        object_etag: completed.ETag || null,
        /* An ETag is what the store can prove about the bytes it holds. It is not
           a whole-file SHA-256 and is labelled so nobody reads it as one; the
           real digest is written later by whatever process reads the whole file.
           A multipart ETag is a digest of the part digests, so it is recorded as
           the composite it is. */
        sha256: (completed.ETag || "").replace(/\"/g, "") || null,
        content_hash_algorithm: completed.ETag ? "s3-etag-md5" : null,
        content_hash_scope: completed.ETag
          ? ((completed.ETag || "").includes("-") ? "parts-composite" : "whole-file")
          : null,
        content_hash_recorded_at: completed.ETag ? new Date().toISOString() : null,
        content_hash_recorded_by: completed.ETag ? "s3-complete-multipart" : null,
        original_filename: row.original_filename,
        mime_type: row.mime_type,
        byte_size: row.byte_size,
        created_by: row.created_by,
      };
      const table = row.entity_type === "project_document" ? "project_documents" : "evidence_items";
      const record = row.entity_type === "project_document"
        ? {
          ...baseRecord,
          document_type: text(metadata.document_type, "other"),
          revision_label: metadata.revision_label || null,
          issued_at: metadata.issued_at || null,
          status: "uploaded",
          source_metadata: metadata.source_metadata || {},
          capture_task_id: metadata.capture_task_id || null,
          baseline_id: metadata.baseline_id || null,
          field_assignment_id: metadata.field_assignment_id || row.field_assignment_id || null,
        }
        : {
          ...baseRecord,
          space_id: row.space_id,
          media_type: text(metadata.media_type, "Property evidence"),
          source_type: resolveSourceType(metadata.source_type, row.entity_type, {
            captureSession: Boolean(captureSession),
            projectAccess: Boolean(projectAccess),
            fieldAssignment: Boolean(fieldAssignment),
          }),
          capture_device: (metadata.capture_device as Record<string, unknown>) || {},
          capture_location: (metadata.capture_location as Record<string, unknown>) || {},
          captured_at: text(metadata.captured_at, new Date().toISOString()),
          source_metadata: metadata.source_metadata || {},
          capture_task_id: metadata.capture_task_id || null,
          baseline_id: metadata.baseline_id || null,
          field_assignment_id: metadata.field_assignment_id || row.field_assignment_id || null,
          capture_session_id: metadata.capture_session_id || row.capture_session_id || null,
          project_intake_access_id:metadata.project_intake_access_id||row.project_intake_access_id||null,
        };
      const { data: inserted, error: insertError } = await admin.from(table).insert(record).select("*").single();
      if (insertError) {
        await s3.send(new DeleteObjectCommand({ Bucket: row.storage_bucket, Key: row.object_key, VersionId: completed.VersionId })).catch(() => undefined);
        await admin.from("object_uploads").update({ status: "failed", updated_at: new Date().toISOString() }).eq("id", row.id);
        throw insertError;
      }
      if (row.entity_type === "evidence" && /\.insv$/i.test(row.original_filename)) {
        const { error: captureGroupError } = await admin.rpc("reconcile_insta360_capture", { p_evidence_id: inserted.id });
        if (captureGroupError) console.error("Insta360 capture grouping could not be completed", captureGroupError);
      }
      if (
        row.entity_type === "evidence" &&
        /\.(mp4|mov|m4v)$/i.test(row.original_filename) &&
        metadata?.source_metadata?.projection === "equirectangular"
      ) {
        const { error: vrMasterError } = await admin.rpc("reconcile_prestitched_360", { p_evidence_id: inserted.id });
        if (vrMasterError) console.error("Pre-stitched 360 master could not be registered", vrMasterError);
      }
      const completedAt = new Date().toISOString();
      if (captureSession && row.entity_type === "evidence") {
        const source = (metadata.source_metadata || {}) as Record<string, unknown>;
        const duration = numberValue(source.duration_seconds) || null;
        const width = numberValue(source.width) || null;
        const height = numberValue(source.height) || null;
        const ratio = width && height ? width / height : 0;
        const projection = source.projection === "equirectangular" && ratio >= 1.9 && ratio <= 2.1
          ? "equirectangular"
          : "unknown";
        const guard = duration ? Math.min(3, Math.max(0.5, duration * 0.1)) : null;
        const suggestedEnd = duration && guard && duration - guard > guard ? duration - guard : duration;
        const { error: itemError } = await admin.from("capture_session_items").insert({
          id: row.id,
          organization_id: row.organization_id,
          property_id: row.property_id,
          session_id: captureSession.id,
          state: duration ? "trim_review" : "uploaded",
          source_duration_seconds: duration,
          source_width: width,
          source_height: height,
          projection,
          suggested_trim_start_seconds: guard,
          suggested_trim_end_seconds: suggestedEnd,
        });
        if (itemError) {
          // The source is accepted only after both governed records exist.
          // Roll back the object and evidence row so a retry cannot create an
          // orphan if the capture-session write fails.
          await admin.from("evidence_items").delete().eq("id", inserted.id);
          await s3.send(new DeleteObjectCommand({ Bucket: row.storage_bucket, Key: row.object_key, VersionId: completed.VersionId })).catch(() => undefined);
          await admin.from("object_uploads").update({ status: "failed", updated_at: completedAt }).eq("id", row.id);
          throw itemError;
        }
        await admin.from("capture_sessions").update({
          status: "reviewing",
          updated_at: completedAt,
        }).eq("id", captureSession.id);
      }
      await admin.from("object_uploads").update({ status: "completed", completed_at: completedAt, updated_at: completedAt }).eq("id", row.id);
      const { error: auditError } = await admin.from("audit_events").insert({
        organization_id: row.organization_id,
        actor_id:fieldAssignment||captureSession||projectAccess?null:userId,
        action: `${row.entity_type}.uploaded_to_s3`,
        entity_type: table,
        entity_id: row.id,
        detail:{bucket:row.storage_bucket,object_key:row.object_key,byte_size:row.byte_size,field_assignment_id:row.field_assignment_id,capture_session_id:row.capture_session_id,project_intake_access_id:row.project_intake_access_id},
      });
      if (auditError) console.error("Object upload audit event could not be recorded", auditError);
      return json(request, { record: inserted, signed_url: await signedObjectReadUrl(row.object_key, URL_TTL_SECONDS) });
    }

    if (operation === "get_url") {
      const entityType = text(body?.entity_type);
      const recordId = text(body?.record_id);
      const table = entityType === "project_document" ? "project_documents" : entityType === "evidence" ? "evidence_items" : "";
      if (!table || !isUuid(recordId)) throw Object.assign(new Error("A valid record is required"), { status: 400 });
      const { data: record } = await admin.from(table)
        .select("id,organization_id,property_id,storage_provider,storage_bucket,storage_path,field_assignment_id,capture_session_id,project_intake_access_id" + (entityType === "evidence" ? ",deleted_at,purged_at" : ""))
        .eq("id", recordId)
        .maybeSingle();
      if (!record) throw Object.assign(new Error("Stored object not found"), { status: 404 });
      /* A file that has been deleted from the record does not open again through
         a link somebody still has. */
      if ((record as Record<string, unknown>).purged_at) throw Object.assign(new Error("This file was destroyed. The record of it remains, the file does not."), { status: 410 });
      if ((record as Record<string, unknown>).deleted_at) throw Object.assign(new Error("This file has been deleted from the record"), { status: 410 });
      if (fieldAssignment) {
        if ((record as Record<string, unknown>).field_assignment_id !== fieldAssignment.id) throw Object.assign(new Error("This file is outside the field assignment"), { status: 403 });
      } else if (captureSession) {
        if ((record as Record<string, unknown>).capture_session_id !== captureSession.id) throw Object.assign(new Error("This file is outside the capture session"), { status: 403 });
      } else if(projectAccess){
        if((record as Record<string,unknown>).project_intake_access_id!==projectAccess.id||(record as Record<string,unknown>).property_id!==projectAccess.property_id)throw Object.assign(new Error("This file is outside the project"),{status:403});
      } else if (!await membership(record.organization_id)) {
        throw Object.assign(new Error("Not authorized to open this file"), { status: 403 });
      }
      if (record.storage_provider !== "aws-s3" || record.storage_bucket !== bucket) throw Object.assign(new Error("Record is not stored in the configured S3 bucket"), { status: 409 });
      return json(request, { signed_url: await signedObjectReadUrl(record.storage_path, URL_TTL_SECONDS), expires_in: URL_TTL_SECONDS });
    }

    /* Deleting evidence removes it from the record, not from existence.
       This used to destroy the S3 object and the row together, which meant one
       misplaced tap ended a file that other findings were derived from, and left
       nothing behind saying it had ever been there. Now the file leaves every
       list, the bytes stay, and the act is written into the audit trail. Actually
       destroying the bytes is the separate `purge_evidence` operation below. */
    if (operation === "delete_evidence") {
      if (fieldAssignment || captureSession) throw Object.assign(new Error("Guest links cannot delete submitted evidence"), { status: 403 });
      const recordId = text(body?.record_id);
      if (!isUuid(recordId)) throw Object.assign(new Error("A valid evidence record is required"), { status: 400 });
      const { data: record } = await admin.from("evidence_items")
        .select("id, organization_id, property_id, space_id, original_filename, storage_provider, storage_bucket, storage_path, deleted_at")
        .eq("id", recordId)
        .maybeSingle();
      if (!record) throw Object.assign(new Error("Evidence not found"), { status: 404 });
      const role = await membership(record.organization_id);
      if (!role || !["owner", "admin"].includes(role)) throw Object.assign(new Error("Only an owner or administrator can delete evidence"), { status: 403 });
      if (record.deleted_at) return json(request, { deleted: true, already_deleted: true, recoverable: true });
      const deletedAt = new Date().toISOString();
      const { error: softDeleteError } = await admin.from("evidence_items").update({
        deleted_at: deletedAt,
        deleted_by: userId || null,
        deletion_reason: text(body?.reason) || null,
      }).eq("id", record.id);
      if (softDeleteError) throw softDeleteError;
      const origin = requestOrigin(request);
      await admin.rpc("record_audit_event", {
        p_organization_id: record.organization_id,
        p_property_id: record.property_id,
        p_action: "evidence.deleted",
        p_entity_type: "evidence_items",
        p_entity_id: record.id,
        p_actor_id: userId || null,
        p_actor_kind: "user",
        p_detail: {
          original_filename: record.original_filename,
          space_id: record.space_id,
          storage_bucket: record.storage_bucket,
          object_key: record.storage_path,
          reason: text(body?.reason) || null,
          object_retained: true,
        },
        p_request_ip: origin.ip,
        p_user_agent: origin.userAgent,
      }).then(({ error }) => { if (error) console.error("Evidence deletion audit event failed", error); });
      return json(request, { deleted: true, recoverable: true, deleted_at: deletedAt });
    }

    /* Destroying the bytes. Deliberately separate, deliberately owner-only,
       deliberately refuses to act on anything that has not already been deleted
       and confirmed — so no single request can turn a mis-tap into a loss. */
    if (operation === "purge_evidence") {
      if (fieldAssignment || captureSession || projectAccess) throw Object.assign(new Error("Guest links cannot purge evidence"), { status: 403 });
      const recordId = text(body?.record_id);
      if (!isUuid(recordId)) throw Object.assign(new Error("A valid evidence record is required"), { status: 400 });
      if (body?.confirm_purge !== true) throw Object.assign(new Error("Purging destroys the stored file. Confirm the purge explicitly."), { status: 400 });
      const { data: record } = await admin.from("evidence_items")
        .select("id, organization_id, property_id, original_filename, storage_provider, storage_bucket, storage_path, object_version_id, deleted_at, purged_at")
        .eq("id", recordId)
        .maybeSingle();
      if (!record) throw Object.assign(new Error("Evidence not found"), { status: 404 });
      const role = await membership(record.organization_id);
      if (role !== "owner") throw Object.assign(new Error("Only an organization owner can destroy stored evidence"), { status: 403 });
      if (!record.deleted_at) throw Object.assign(new Error("Delete this evidence first. Purging is a second, separate decision."), { status: 409 });
      if (record.purged_at) return json(request, { purged: true, already_purged: true });
      const { count: derivativeCount } = await admin.from("evidence_items")
        .select("id", { count: "exact", head: true })
        .eq("derivative_of", record.id);
      if (derivativeCount && body?.confirm_orphans !== true) {
        throw Object.assign(new Error(`${derivativeCount} file${derivativeCount === 1 ? " was" : "s were"} derived from this one and would lose their parent. Confirm again to proceed.`), { status: 409 });
      }
      if (record.storage_provider === "aws-s3") {
        await s3.send(new DeleteObjectCommand({ Bucket: record.storage_bucket || bucket, Key: record.storage_path, VersionId: record.object_version_id || undefined }));
      }
      const purgedAt = new Date().toISOString();
      /* The row survives the bytes on purpose. A record saying "this file existed,
         and on this date this person destroyed it" is worth more than a gap. */
      const { error: purgeError } = await admin.from("evidence_items")
        .update({ purged_at: purgedAt, purged_by: userId || null })
        .eq("id", record.id);
      if (purgeError) throw purgeError;
      const origin = requestOrigin(request);
      await admin.rpc("record_audit_event", {
        p_organization_id: record.organization_id,
        p_property_id: record.property_id,
        p_action: "evidence.purged",
        p_entity_type: "evidence_items",
        p_entity_id: record.id,
        p_actor_id: userId || null,
        p_actor_kind: "user",
        p_detail: {
          original_filename: record.original_filename,
          storage_bucket: record.storage_bucket,
          object_key: record.storage_path,
          orphaned_derivatives: derivativeCount || 0,
        },
        p_request_ip: origin.ip,
        p_user_agent: origin.userAgent,
      }).then(({ error }) => { if (error) console.error("Evidence purge audit event failed", error); });
      return json(request, { purged: true });
    }

    /* Undo. The reason soft deletion is worth having at all. */
    if (operation === "restore_evidence") {
      if (fieldAssignment || captureSession || projectAccess) throw Object.assign(new Error("Guest links cannot restore evidence"), { status: 403 });
      const recordId = text(body?.record_id);
      if (!isUuid(recordId)) throw Object.assign(new Error("A valid evidence record is required"), { status: 400 });
      const { data: record } = await admin.from("evidence_items")
        .select("id, organization_id, property_id, original_filename, deleted_at, purged_at")
        .eq("id", recordId)
        .maybeSingle();
      if (!record) throw Object.assign(new Error("Evidence not found"), { status: 404 });
      const role = await membership(record.organization_id);
      if (!role || !["owner", "admin"].includes(role)) throw Object.assign(new Error("Only an owner or administrator can restore evidence"), { status: 403 });
      if (record.purged_at) throw Object.assign(new Error("This file was destroyed and cannot be brought back. The record of it remains."), { status: 410 });
      if (!record.deleted_at) return json(request, { restored: true, already_present: true });
      const { error: restoreError } = await admin.from("evidence_items")
        .update({ deleted_at: null, deleted_by: null, deletion_reason: null })
        .eq("id", record.id);
      if (restoreError) throw restoreError;
      const origin = requestOrigin(request);
      await admin.rpc("record_audit_event", {
        p_organization_id: record.organization_id,
        p_property_id: record.property_id,
        p_action: "evidence.restored",
        p_entity_type: "evidence_items",
        p_entity_id: record.id,
        p_actor_id: userId || null,
        p_actor_kind: "user",
        p_detail: { original_filename: record.original_filename, deleted_at: record.deleted_at },
        p_request_ip: origin.ip,
        p_user_agent: origin.userAgent,
      }).then(({ error }) => { if (error) console.error("Evidence restore audit event failed", error); });
      return json(request, { restored: true });
    }

    /* What an owner needs to see before deciding whether to destroy anything. */
    if (operation === "list_deleted_evidence") {
      if (fieldAssignment || captureSession || projectAccess) throw Object.assign(new Error("Guest links cannot read deleted evidence"), { status: 403 });
      const propertyId = text(body?.property_id);
      if (!isUuid(propertyId)) throw Object.assign(new Error("A valid project is required"), { status: 400 });
      const { data: property } = await admin.from("properties").select("id, organization_id").eq("id", propertyId).maybeSingle();
      if (!property) throw Object.assign(new Error("Project not found"), { status: 404 });
      const role = await membership(property.organization_id);
      if (!role || !["owner", "admin"].includes(role)) throw Object.assign(new Error("Only an owner or administrator can see deleted evidence"), { status: 403 });
      const { data: rows, error: listError } = await admin.from("evidence_items")
        .select("id, original_filename, media_type, byte_size, space_id, deleted_at, deleted_by, deletion_reason, purged_at")
        .eq("property_id", propertyId)
        .not("deleted_at", "is", null)
        .order("deleted_at", { ascending: false })
        .limit(200);
      if (listError) throw listError;
      return json(request, { deleted: rows || [] });
    }

    if (operation === "remove_capture_evidence") {
      if (!captureSession) throw Object.assign(new Error("A capture-session link is required"), { status: 403 });
      if (["submitted", "processing", "ready_for_review", "completed"].includes(captureSession.status)) {
        throw Object.assign(new Error("Submitted captures can no longer be removed from this link"), { status: 409 });
      }
      const recordId = text(body?.record_id);
      if (!isUuid(recordId)) throw Object.assign(new Error("A valid capture is required"), { status: 400 });
      const { data: record } = await admin.from("evidence_items")
        .select("id, storage_provider, storage_bucket, storage_path, object_version_id, deleted_at")
        .eq("id", recordId)
        .eq("capture_session_id", captureSession.id)
        .maybeSingle();
      if (!record) throw Object.assign(new Error("Capture not found in this session"), { status: 404 });
      /* An operator removing a mis-shot before submitting is correcting their own
         work, not deleting evidence of record — but it is still a capture that
         once existed, so it is hidden and written down rather than erased. */
      const removedAt = new Date().toISOString();
      const { error: removeError } = await admin.from("evidence_items").update({
        deleted_at: removedAt,
        deletion_reason: "Removed by the operator before the capture session was submitted",
      }).eq("id", record.id);
      if (removeError) throw removeError;
      await admin.from("object_uploads").update({ status: "aborted", updated_at: removedAt })
        .eq("id", record.id).eq("capture_session_id", captureSession.id);
      const captureOrigin = requestOrigin(request);
      await admin.rpc("record_audit_event", {
        p_organization_id: captureSession.organization_id,
        p_property_id: captureSession.property_id,
        p_action: "evidence.removed_before_submission",
        p_entity_type: "evidence_items",
        p_entity_id: record.id,
        p_actor_id: null,
        p_actor_kind: "guest_link",
        p_actor_label: `capture_session:${captureSession.id}`,
        p_detail: { object_key: record.storage_path, object_retained: true },
        p_request_ip: captureOrigin.ip,
        p_user_agent: captureOrigin.userAgent,
      }).then(({ error }) => { if (error) console.error("Capture removal audit event failed", error); });
      return json(request, { deleted: true });
    }

    if (operation === "delete_project_document") {
      if (fieldAssignment) throw Object.assign(new Error("Field links cannot delete project plans"), { status: 403 });
      const recordId = text(body?.record_id);
      if (!isUuid(recordId)) throw Object.assign(new Error("A valid project plan is required"), { status: 400 });
      const { data: record, error: recordError } = await admin.from("project_documents")
        .select("id, organization_id, property_id, storage_provider, storage_bucket, storage_path, object_version_id, original_filename")
        .eq("id", recordId)
        .maybeSingle();
      if (recordError) throw recordError;
      if (!record) throw Object.assign(new Error("Project plan not found"), { status: 404 });
      const role = await membership(record.organization_id);
      if (!role || !["owner", "admin"].includes(role)) {
        throw Object.assign(new Error("Only an owner or administrator can delete project plans"), { status: 403 });
      }

      const { data: property, error: propertyError } = await admin.from("properties")
        .select("active_baseline_id")
        .eq("id", record.property_id)
        .eq("organization_id", record.organization_id)
        .maybeSingle();
      if (propertyError) throw propertyError;
      if (!property) throw Object.assign(new Error("Project not found"), { status: 404 });

      const { data: baselineReferences, error: baselineError } = await admin.from("document_baselines")
        .select("id, version, state")
        .eq("organization_id", record.organization_id)
        .eq("property_id", record.property_id)
        .contains("source_document_ids", [record.id])
        .order("version", { ascending: false });
      if (baselineError) throw baselineError;
      const protectedBaseline = (baselineReferences || []).find((baseline) =>
        baseline.id === property.active_baseline_id
      );
      if (protectedBaseline) {
        throw Object.assign(new Error(`This plan is part of the active baseline v${protectedBaseline.version} and cannot be deleted. Activate a replacement baseline without it first.`), { status: 409 });
      }

      const { data: activeJob } = await admin.from("plan_analysis_jobs")
        .select("id")
        .eq("organization_id", record.organization_id)
        .eq("property_id", record.property_id)
        .contains("document_ids", [record.id])
        .in("state", ["queued", "processing"])
        .limit(1)
        .maybeSingle();
      if (activeJob) {
        throw Object.assign(new Error("This plan is currently being analyzed. Wait for the analysis to finish before deleting it."), { status: 409 });
      }

      if (record.storage_provider === "aws-s3") {
        if (record.storage_bucket !== bucket) throw Object.assign(new Error("This plan is outside the configured S3 bucket"), { status: 409 });
        await s3.send(new DeleteObjectCommand({
          Bucket: record.storage_bucket,
          Key: record.storage_path,
        }));
      } else if (record.storage_provider === "supabase") {
        const sourceBucket = text(record.storage_bucket, "project-plans");
        const { error: storageError } = await admin.storage.from(sourceBucket).remove([record.storage_path]);
        if (storageError) throw storageError;
      } else {
        throw Object.assign(new Error("This plan uses an unsupported storage provider"), { status: 409 });
      }

      const { error: deleteError } = await admin.from("project_documents").delete().eq("id", record.id);
      if (deleteError) throw deleteError;
      await admin.from("object_uploads").delete().eq("id", record.id);
      const { error: auditError } = await admin.from("audit_events").insert({
        organization_id: record.organization_id,
        actor_id: userId,
        action: "project_document.deleted",
        entity_type: "project_documents",
        entity_id: record.id,
        detail: {
          property_id: record.property_id,
          original_filename: record.original_filename,
          historical_baseline_versions: (baselineReferences || []).map((baseline) => baseline.version),
        },
      });
      if (auditError) console.error("Project plan deletion audit event could not be recorded", auditError);
      return json(request, { deleted: true, record_id: record.id });
    }

    if (operation === "abort_upload") {
      const { row } = await uploadSession(body?.session_id);
      if (row.status === "pending") {
        await s3.send(new AbortMultipartUploadCommand({ Bucket: row.storage_bucket, Key: row.object_key, UploadId: row.multipart_upload_id }));
        await admin.from("object_uploads").update({ status: "aborted", updated_at: new Date().toISOString() }).eq("id", row.id);
      }
      return json(request, { aborted: true });
    }

    return json(request, { error: "Unsupported operation" }, 400);
  } catch (error) {
    const safe = safeError(error, "The file service could not complete that request.");
    return json(request, safe.body, safe.status);
  }
});
