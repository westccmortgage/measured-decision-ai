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
};

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

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error || "Object storage error");
}

function isUuid(value: unknown) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || ""));
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders(request) });
  if (request.method !== "POST") return json(request, { error: "Method not allowed" }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY") || Deno.env.get("SUPABASE_PUBLISHABLE_KEY");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const authorization = request.headers.get("Authorization") || "";
  if (!supabaseUrl || !anonKey || !serviceKey) return json(request, { error: "Server configuration is incomplete" }, 500);
  if (!authorization.startsWith("Bearer ")) return json(request, { error: "Authentication required" }, 401);

  const userClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authorization } },
    auth: { persistSession: false },
  });
  const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });
  const { data: userData, error: userError } = await userClient.auth.getUser();
  if (userError || !userData.user) return json(request, { error: "Invalid session" }, 401);

  try {
    const body = await request.json();
    const operation = text(body?.operation);
    const userId = userData.user.id;
    const { bucket, client: s3 } = awsObjectStore();

    async function membership(organizationId: string) {
      const { data } = await userClient.from("organization_members")
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
        .eq("created_by", userId)
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
      const entityType = text(body?.entity_type);
      const organizationId = text(body?.organization_id);
      const propertyId = text(body?.property_id);
      const spaceId = body?.space_id ? text(body.space_id) : null;
      const filename = text(body?.file?.name);
      const mimeType = text(body?.file?.type, "application/octet-stream");
      const byteSize = numberValue(body?.file?.size);
      if (!["project_document", "evidence"].includes(entityType)) throw Object.assign(new Error("Unsupported upload type"), { status: 400 });
      if (!isUuid(organizationId) || !isUuid(propertyId) || !filename || byteSize <= 0) throw Object.assign(new Error("Upload metadata is incomplete"), { status: 400 });
      if (byteSize > 5 * 1024 * 1024 * 1024 * 1024) throw Object.assign(new Error("File exceeds the S3 multipart limit"), { status: 413 });

      const role = await membership(organizationId);
      const allowedRoles = entityType === "project_document"
        ? ["owner", "admin", "contributor"]
        : ["owner", "admin", "contributor"];
      if (!role || !allowedRoles.includes(role)) throw Object.assign(new Error("Not authorized to upload this file"), { status: 403 });

      const { data: property } = await userClient.from("properties")
        .select("id")
        .eq("id", propertyId)
        .eq("organization_id", organizationId)
        .maybeSingle();
      if (!property) throw Object.assign(new Error("Project not found"), { status: 404 });
      if (entityType === "evidence") {
        if (!isUuid(spaceId)) throw Object.assign(new Error("A valid room is required"), { status: 400 });
        const { data: space } = await userClient.from("spaces")
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
        entity_metadata: body?.metadata && typeof body.metadata === "object" ? body.metadata : {},
        created_by: userId,
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
        }
        : {
          ...baseRecord,
          space_id: row.space_id,
          media_type: text(metadata.media_type, "Property evidence"),
          captured_at: text(metadata.captured_at, new Date().toISOString()),
          source_metadata: metadata.source_metadata || {},
          capture_task_id: metadata.capture_task_id || null,
          baseline_id: metadata.baseline_id || null,
        };
      const { data: inserted, error: insertError } = await admin.from(table).insert(record).select("*").single();
      if (insertError) {
        await s3.send(new DeleteObjectCommand({ Bucket: row.storage_bucket, Key: row.object_key })).catch(() => undefined);
        await admin.from("object_uploads").update({ status: "failed", updated_at: new Date().toISOString() }).eq("id", row.id);
        throw insertError;
      }
      const completedAt = new Date().toISOString();
      await admin.from("object_uploads").update({ status: "completed", completed_at: completedAt, updated_at: completedAt }).eq("id", row.id);
      const { error: auditError } = await admin.from("audit_events").insert({
        organization_id: row.organization_id,
        actor_id: userId,
        action: `${row.entity_type}.uploaded_to_s3`,
        entity_type: table,
        entity_id: row.id,
        detail: { bucket: row.storage_bucket, object_key: row.object_key, byte_size: row.byte_size },
      });
      if (auditError) console.error("Object upload audit event could not be recorded", auditError);
      return json(request, { record: inserted, signed_url: await signedObjectReadUrl(row.object_key, URL_TTL_SECONDS) });
    }

    if (operation === "get_url") {
      const entityType = text(body?.entity_type);
      const recordId = text(body?.record_id);
      const table = entityType === "project_document" ? "project_documents" : entityType === "evidence" ? "evidence_items" : "";
      if (!table || !isUuid(recordId)) throw Object.assign(new Error("A valid record is required"), { status: 400 });
      const { data: record } = await userClient.from(table)
        .select("id, organization_id, storage_provider, storage_bucket, storage_path")
        .eq("id", recordId)
        .maybeSingle();
      if (!record) throw Object.assign(new Error("Stored object not found"), { status: 404 });
      if (record.storage_provider !== "aws-s3" || record.storage_bucket !== bucket) throw Object.assign(new Error("Record is not stored in the configured S3 bucket"), { status: 409 });
      return json(request, { signed_url: await signedObjectReadUrl(record.storage_path, URL_TTL_SECONDS), expires_in: URL_TTL_SECONDS });
    }

    if (operation === "delete_evidence") {
      const recordId = text(body?.record_id);
      if (!isUuid(recordId)) throw Object.assign(new Error("A valid evidence record is required"), { status: 400 });
      const { data: record } = await userClient.from("evidence_items")
        .select("id, organization_id, property_id, storage_provider, storage_bucket, storage_path")
        .eq("id", recordId)
        .maybeSingle();
      if (!record) throw Object.assign(new Error("Evidence not found"), { status: 404 });
      const role = await membership(record.organization_id);
      if (!role || !["owner", "admin"].includes(role)) throw Object.assign(new Error("Only an owner or administrator can delete evidence"), { status: 403 });
      if (record.storage_provider === "aws-s3") {
        await s3.send(new DeleteObjectCommand({ Bucket: record.storage_bucket || bucket, Key: record.storage_path }));
      }
      const { error: deleteError } = await admin.from("evidence_items").delete().eq("id", record.id);
      if (deleteError) throw deleteError;
      return json(request, { deleted: true });
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
    console.error(error);
    const status = Number((error as { status?: number })?.status) || 500;
    return json(request, { error: errorMessage(error) }, status >= 400 && status <= 599 ? status : 500);
  }
});
