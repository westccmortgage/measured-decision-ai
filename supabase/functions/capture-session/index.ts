import { safeError } from "../_shared/safe-error.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const allowedOrigins = new Set([
  "https://measureddecision.com",
  "https://www.measureddecision.com",
  "http://localhost:8080",
  "http://127.0.0.1:8080",
]);

function cors(request: Request) {
  const origin = request.headers.get("origin") || "";
  return {
    "Access-Control-Allow-Origin": allowedOrigins.has(origin) ? origin : "https://measureddecision.com",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    Vary: "Origin",
  };
}

function json(request: Request, body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors(request), "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

function fail(message: string, status = 400): never {
  throw Object.assign(new Error(message), { status });
}

function text(value: unknown, fallback = "") {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function number(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isUuid(value: unknown) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || ""));
}

function bytesToHex(bytes: Uint8Array) {
  return Array.from(bytes).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function tokenHash(token: string) {
  return bytesToHex(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token))));
}

function newToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function html(value: unknown) {
  return String(value || "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: cors(request) });
  if (request.method !== "POST") return json(request, { error: "Method not allowed" }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY") || Deno.env.get("SUPABASE_PUBLISHABLE_KEY");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !anonKey || !serviceKey) return json(request, { error: "Server configuration is incomplete" }, 500);
  const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });
  const authorization = request.headers.get("Authorization") || "";

  try {
    const body = await request.json();
    const action = text(body?.action);

    async function actor() {
      if (!authorization.startsWith("Bearer ")) fail("Authentication required", 401);
      const userClient = createClient(supabaseUrl, anonKey, {
        global: { headers: { Authorization: authorization } },
        auth: { persistSession: false },
      });
      const { data, error } = await userClient.auth.getUser();
      if (error || !data.user) fail("Invalid session", 401);
      return { user: data.user, client: userClient };
    }

    async function sessionFromToken() {
      const sessionId = text(body?.session_id);
      const token = text(body?.token);
      if (!isUuid(sessionId) || token.length < 32) fail("This capture link is invalid", 401);
      const { data: session } = await admin.from("capture_sessions")
        .select("*")
        .eq("id", sessionId)
        .eq("token_hash", await tokenHash(token))
        .maybeSingle();
      if (!session) fail("This capture link is invalid", 401);
      if (session.status === "revoked") fail("This capture link was revoked", 410);
      if (new Date(session.expires_at).valueOf() <= Date.now()) {
        await admin.from("capture_sessions").update({ status: "expired", updated_at: new Date().toISOString() }).eq("id", session.id);
        fail("This capture link has expired. Ask the project manager for a new link", 410);
      }
      return session;
    }

    async function requireManager(client: ReturnType<typeof createClient>, organizationId: string, userId: string) {
      const { data } = await client.from("organization_members").select("role")
        .eq("organization_id", organizationId).eq("user_id", userId).maybeSingle();
      if (!data || !["owner", "admin", "reviewer"].includes(data.role)) fail("Only a project manager or reviewer can create capture sessions", 403);
    }

    if (action === "create") {
      const { user, client } = await actor();
      const propertyId = text(body?.property_id);
      const recipientName = text(body?.recipient_name);
      const recipientEmail = text(body?.recipient_email).toLowerCase();
      const label = text(body?.label, "Room capture session");
      if (!isUuid(propertyId) || !recipientName || !/^\S+@\S+\.\S+$/.test(recipientEmail)) fail("Project, recipient name, and a valid email are required");
      const { data: property } = await admin.from("properties").select("id, organization_id, name, address").eq("id", propertyId).maybeSingle();
      if (!property) fail("Project not found", 404);
      await requireManager(client, property.organization_id, user.id);

      const intakeName = "Customer capture intake";
      let { data: space } = await admin.from("spaces").select("id").eq("organization_id", property.organization_id).eq("property_id", property.id).eq("name", intakeName).maybeSingle();
      if (!space) {
        const { data, error } = await admin.from("spaces").insert({
          organization_id: property.organization_id,
          property_id: property.id,
          name: intakeName,
          building: "Project",
          level: "Capture intake",
          review_state: "needs_review",
          created_by: user.id,
        }).select("id").single();
        if (error || !data) throw error || new Error("Capture intake could not be created");
        space = data;
      }

      const token = newToken();
      const { data: session, error } = await admin.from("capture_sessions").insert({
        organization_id: property.organization_id,
        property_id: property.id,
        default_space_id: space.id,
        label,
        recipient_name: recipientName,
        recipient_email: recipientEmail,
        token_hash: await tokenHash(token),
        created_by: user.id,
      }).select("*").single();
      if (error || !session) throw error || new Error("Capture session could not be created");

      const portal = Deno.env.get("CAPTURE_PORTAL_URL") || "https://measureddecision.com/capture/";
      const link = `${portal}?session=${encodeURIComponent(session.id)}&token=${encodeURIComponent(token)}`;
      const resendKey = Deno.env.get("RESEND_API_KEY");
      const emailFrom = Deno.env.get("FIELD_EMAIL_FROM");
      const replyTo = Deno.env.get("FIELD_EMAIL_REPLY_TO");
      let emailState = "not_configured";
      let messageId: string | null = null;
      let emailError: string | null = null;
      if (resendKey && emailFrom) {
        try {
          const response = await fetch("https://api.resend.com/emails", {
            method: "POST",
            headers: { Authorization: `Bearer ${resendKey}`, "Content-Type": "application/json" },
            body: JSON.stringify({
              from: emailFrom,
              to: [recipientEmail],
              ...(replyTo ? { reply_to: replyTo } : {}),
              subject: `${property.name}: upload room captures`,
              text: `Measured Decision capture session\n\nProject: ${property.name}\n\nOpen your private upload page: ${link}\n\nChoose all room videos, confirm the room name and suggested trim, then submit. No account is required.`,
              html: `<div style="font-family:Arial,sans-serif;max-width:620px;color:#10202f"><p style="color:#168da1;font-weight:700">MEASURED DECISION · CAPTURE SESSION</p><h1 style="font-size:25px">Upload room captures</h1><p><strong>Project:</strong> ${html(property.name)}</p><p>Choose all room videos, confirm each room name and suggested trim, then submit.</p><p><a href="${html(link)}" style="display:inline-block;background:#24bfd5;color:#06101c;padding:14px 20px;border-radius:6px;text-decoration:none;font-weight:700">Open capture session</a></p><p style="font-size:12px;color:#607386">No account is required. This private link expires automatically.</p></div>`,
            }),
          });
          const payload = await response.json().catch(() => ({}));
          if (response.ok) { emailState = "sent"; messageId = payload?.id || null; }
          else { emailState = "failed"; emailError = payload?.message || `Email provider rejected the request (${response.status})`; }
        } catch (error) {
          emailState = "failed";
          emailError = error instanceof Error ? error.message : "Email provider could not be reached";
        }
      }
      await admin.from("capture_sessions").update({ email_delivery_state: emailState, email_message_id: messageId, email_delivery_error: emailError, updated_at: new Date().toISOString() }).eq("id", session.id);
      return json(request, { session_id: session.id, link, email_state: emailState, email_error: emailError });
    }

    if (action === "revoke") {
      const { user, client } = await actor();
      const sessionId = text(body?.session_id);
      if (!isUuid(sessionId)) fail("Capture session is required");
      const { data: session } = await admin.from("capture_sessions").select("id, organization_id, status").eq("id", sessionId).maybeSingle();
      if (!session) fail("Capture session not found", 404);
      await requireManager(client, session.organization_id, user.id);
      if (["submitted", "processing", "ready_for_review", "completed"].includes(session.status)) fail("A submitted capture session cannot be revoked from this screen", 409);
      const now = new Date().toISOString();
      const [sessionUpdate, auditInsert] = await Promise.all([
        admin.from("capture_sessions").update({ status: "revoked", updated_at: now }).eq("id", session.id),
        admin.from("audit_events").insert({ organization_id: session.organization_id, actor_id: user.id, action: "capture_session.revoked", entity_type: "capture_sessions", entity_id: session.id, detail: {} }),
      ]);
      if (sessionUpdate.error) throw sessionUpdate.error;
      if (auditInsert.error) console.error("Capture-session revoke audit could not be recorded", auditInsert.error);
      return json(request, { revoked: true });
    }

    if (action === "get") {
      const session = await sessionFromToken();
      if (session.status === "sent") {
        const now = new Date().toISOString();
        await admin.from("capture_sessions").update({ status: "opened", opened_at: now, updated_at: now }).eq("id", session.id);
        session.status = "opened";
      }
      const [propertyResult, evidenceResult, itemResult] = await Promise.all([
        admin.from("properties").select("id, name, address").eq("id", session.property_id).single(),
        admin.from("evidence_items").select("id, original_filename, mime_type, byte_size, created_at").eq("capture_session_id", session.id).is("deleted_at", null).order("created_at"),
        admin.from("capture_session_items").select("*").eq("session_id", session.id).order("item_order").order("created_at"),
      ]);
      if (propertyResult.error) throw propertyResult.error;
      if (evidenceResult.error) throw evidenceResult.error;
      if (itemResult.error) throw itemResult.error;
      const property = propertyResult.data;
      const evidence = evidenceResult.data;
      const items = itemResult.data;
      const itemById = new Map((items || []).map((item) => [item.id, item]));
      return json(request, {
        session: { id: session.id, label: session.label, status: session.status, recipient_name: session.recipient_name, expires_at: session.expires_at },
        property,
        upload_scope: { organization_id: session.organization_id, property_id: session.property_id, space_id: session.default_space_id },
        items: (evidence || []).map((record) => ({ ...record, ...(itemById.get(record.id) || {}) })),
      });
    }

    if (action === "uploading") {
      const session = await sessionFromToken();
      if (["submitted", "processing", "ready_for_review", "completed"].includes(session.status)) {
        fail("This capture session has already been submitted", 409);
      }
      await admin.from("capture_sessions").update({ status: "uploading", updated_at: new Date().toISOString() }).eq("id", session.id);
      return json(request, { status: "uploading" });
    }

    if (action === "save_item") {
      const session = await sessionFromToken();
      if (["submitted", "processing", "ready_for_review", "completed"].includes(session.status)) {
        fail("This capture session has already been submitted", 409);
      }
      const itemId = text(body?.item_id);
      const roomName = text(body?.room_name);
      const start = number(body?.trim_start_seconds);
      const end = number(body?.trim_end_seconds);
      if (!isUuid(itemId) || !roomName || start === null || end === null || start < 0 || end <= start) fail("Room name and a valid trim range are required");
      const { data: item } = await admin.from("capture_session_items").select("*").eq("id", itemId).eq("session_id", session.id).maybeSingle();
      if (!item) fail("Capture item not found", 404);
      if (item.source_duration_seconds && end > Number(item.source_duration_seconds) + 0.05) fail("Trim end exceeds the source duration");
      const { error } = await admin.rpc("confirm_capture_session_item", {
        p_session_id: session.id,
        p_item_id: item.id,
        p_room_name: roomName,
        p_trim_start_seconds: start,
        p_trim_end_seconds: end,
        p_source_metadata_patch: {
          room_name: roomName,
          projection: item.projection,
          width: item.source_width,
          height: item.source_height,
          duration_seconds: item.source_duration_seconds,
          trim: { start_seconds: start, end_seconds: end, confirmed_by_uploader: true },
          source: "secure-capture-session",
          capture_session_id: session.id,
        },
      });
      if (error) throw error;
      return json(request, { saved: true });
    }

    if (action === "submit") {
      const session = await sessionFromToken();
      if (["submitted", "processing", "ready_for_review", "completed"].includes(session.status)) {
        fail("This capture session has already been submitted", 409);
      }
      const { data: items, error: itemError } = await admin.from("capture_session_items").select("*").eq("session_id", session.id).order("created_at");
      if (itemError) throw itemError;
      if (!items?.length) fail("Upload at least one 360 room video before submitting", 409);
      const incomplete = items.filter((item) => !item.room_name || !item.trim_confirmed);
      if (incomplete.length) fail(`Confirm the room and trim for ${incomplete.length} video${incomplete.length === 1 ? "" : "s"}`, 409);
      const wrongProjection = items.filter((item) => item.projection !== "equirectangular");
      if (wrongProjection.length) {
        fail(`${wrongProjection.length} video${wrongProjection.length === 1 ? " is" : "s are"} not confirmed as 2:1 equirectangular 360. Remove and export ${wrongProjection.length === 1 ? "it" : "them"} as full 360 MP4`, 409);
      }
      const { data: jobCount, error } = await admin.rpc("enqueue_capture_session", { p_session_id: session.id });
      if (error) throw error;
      return json(request, { submitted: true, item_count: items.length, processing_jobs: Number(jobCount) || items.length });
    }

    return json(request, { error: "Unsupported action" }, 400);
  } catch (error) {
    const safe = safeError(error, "The capture service could not complete that request.");
    return json(request, safe.body, safe.status);
  }
});
