import { safeError } from "../_shared/safe-error.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const allowedOrigins = new Set([
  "https://measureddecision.ai",
  "https://www.measureddecision.ai",
  "https://measureddecision.com",
  "https://www.measureddecision.com",
  "http://localhost:8080",
  "http://127.0.0.1:8080",
]);

function cors(request: Request) {
  const origin = request.headers.get("origin") || "";
  return {
    "Access-Control-Allow-Origin": allowedOrigins.has(origin) ? origin : "https://measureddecision.ai",
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

function cleanText(value: unknown, fallback = "") {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
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
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function dateLabel(value: unknown) {
  if (!value) return "As soon as the work is visible";
  const date = new Date(String(value));
  return Number.isNaN(date.valueOf()) ? String(value) : date.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });
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
    const action = cleanText(body?.action);

    async function authenticatedActor() {
      if (!authorization.startsWith("Bearer ")) fail("Authentication required", 401);
      const userClient = createClient(supabaseUrl, anonKey, {
        global: { headers: { Authorization: authorization } },
        auth: { persistSession: false },
      });
      const { data, error } = await userClient.auth.getUser();
      if (error || !data.user) fail("Invalid session", 401);
      return { user: data.user, client: userClient };
    }

    async function assignmentFromToken() {
      const assignmentId = cleanText(body?.assignment_id);
      const token = cleanText(body?.token);
      if (!isUuid(assignmentId) || token.length < 32) fail("This field link is invalid", 401);
      const hash = await tokenHash(token);
      const { data: assignment, error } = await admin.from("field_assignments")
        .select("*")
        .eq("id", assignmentId)
        .eq("token_hash", hash)
        .maybeSingle();
      if (error || !assignment) fail("This field link is invalid", 401);
      if (assignment.status === "revoked") fail("This assignment was replaced or revoked", 410);
      if (new Date(assignment.expires_at).valueOf() <= Date.now()) {
        await admin.from("field_assignments").update({ status: "expired", updated_at: new Date().toISOString() }).eq("id", assignment.id);
        fail("This field link has expired. Ask the project manager for a new link", 410);
      }
      return assignment;
    }

    async function membership(client: ReturnType<typeof createClient>, organizationId: string, userId: string) {
      const { data } = await client.from("organization_members")
        .select("role")
        .eq("organization_id", organizationId)
        .eq("user_id", userId)
        .maybeSingle();
      return data?.role || null;
    }

    if (action === "create_assignment") {
      const { user, client } = await authenticatedActor();
      const taskId = cleanText(body?.capture_task_id);
      const workerName = cleanText(body?.worker_name);
      const workerEmail = cleanText(body?.worker_email).toLowerCase();
      if (!isUuid(taskId) || !workerName || !/^\S+@\S+\.\S+$/.test(workerEmail)) fail("Worker name and a valid email are required");

      const { data: task } = await admin.from("capture_tasks").select("*").eq("id", taskId).maybeSingle();
      if (!task) fail("Capture task not found", 404);
      const role = await membership(client, task.organization_id, user.id);
      if (!role || !["owner", "admin", "reviewer"].includes(role)) fail("Only a project manager or reviewer can send field work", 403);
      if (["blocked", "waived"].includes(task.status)) fail("Approve the project baseline before sending this task", 409);
      if (task.status === "verified") fail("This task is already complete", 409);
      if (task.status === "submitted") fail("Review the current submission before sending another assignment", 409);

      // Project-wide roadmap items do not always resolve to a plan room. Evidence
      // still needs a stable workspace so it remains visible in Studio and in the
      // governed release flow. Provision one shared site-level workspace instead
      // of asking a field worker to understand or choose an internal room UUID.
      let taskSpaceId = task.space_id as string | null;
      if (!taskSpaceId) {
        const fieldSpaceName = "Project-wide field record";
        const { data: existingSpace } = await admin.from("spaces")
          .select("id")
          .eq("organization_id", task.organization_id)
          .eq("property_id", task.property_id)
          .eq("name", fieldSpaceName)
          .maybeSingle();
        taskSpaceId = existingSpace?.id || null;
        if (!taskSpaceId) {
          const { data: createdSpace, error: spaceError } = await admin.from("spaces").insert({
            organization_id: task.organization_id,
            property_id: task.property_id,
            name: fieldSpaceName,
            building: "Project",
            level: "Site",
            review_state: "needs_review",
            created_by: user.id,
          }).select("id").single();
          if (spaceError || !createdSpace) throw spaceError || new Error("Project-wide field workspace could not be created");
          taskSpaceId = createdSpace.id;
        }
        await admin.from("capture_tasks").update({ space_id: taskSpaceId, updated_at: new Date().toISOString() }).eq("id", task.id);
      }

      const [{ data: requirement }, { data: property }, { data: space }] = await Promise.all([
        admin.from("capture_requirements").select("*").eq("id", task.requirement_id).single(),
        admin.from("properties").select("id, name, address").eq("id", task.property_id).single(),
        admin.from("spaces").select("id, name, building, level").eq("id", taskSpaceId).maybeSingle(),
      ]);
      if (!requirement || !property) fail("Task instructions are unavailable", 409);
      const { data: requirementPhase } = await admin.from("construction_phases")
        .select("id, code, name, sequence")
        .eq("id", requirement.phase_id)
        .maybeSingle();
      const effectivePhase = requirementPhase;
      const dueAt = body?.due_at ? new Date(body.due_at).toISOString() : null;
      const token = newToken();
      const snapshot = {
        project: property.name,
        property_address: property.address || null,
        phase: effectivePhase || null,
        title: requirement.title,
        priority: requirement.priority,
        capture_type: requirement.capture_type,
        location: space || null,
        rationale: requirement.rationale,
        instructions: requirement.instructions || [],
        must_show: requirement.must_show || [],
        acceptance_criteria: requirement.acceptance_criteria || [],
        before_concealment: requirement.before_concealment,
        plan_refs: requirement.plan_refs || [],
      };

      await admin.from("field_assignments")
        .update({ status: "revoked", updated_at: new Date().toISOString() })
        .eq("capture_task_id", task.id)
        .in("status", ["sent", "opened", "in_progress", "uploading", "retake"]);
      const now = new Date().toISOString();
      const { data: assignment, error: insertError } = await admin.from("field_assignments").insert({
        organization_id: task.organization_id,
        property_id: task.property_id,
        baseline_id: task.baseline_id,
        capture_task_id: task.id,
        requirement_id: task.requirement_id,
        space_id: taskSpaceId,
        worker_name: workerName,
        worker_email: workerEmail,
        token_hash: await tokenHash(token),
        instructions_snapshot: snapshot,
        due_at: dueAt,
        created_by: user.id,
        sent_at: now,
      }).select("*").single();
      if (insertError || !assignment) throw insertError || new Error("Assignment could not be saved");
      await Promise.all([
        admin.from("capture_tasks").update({ status: "in_progress", due_before: dueAt, updated_at: now }).eq("id", task.id),
        admin.from("field_assignment_events").insert({
          organization_id: task.organization_id,
          assignment_id: assignment.id,
          event_type: "assignment.created",
          actor_id: user.id,
          detail: { worker_name: workerName, worker_email: workerEmail, due_at: dueAt },
        }),
      ]);

      const portal = Deno.env.get("FIELD_PORTAL_URL") || "https://measureddecision.ai/field/";
      const link = `${portal}?assignment=${encodeURIComponent(assignment.id)}&token=${encodeURIComponent(token)}`;
      const resendKey = Deno.env.get("RESEND_API_KEY");
      const emailFrom = Deno.env.get("FIELD_EMAIL_FROM");
      const emailReplyTo = Deno.env.get("FIELD_EMAIL_REPLY_TO");
      let emailState = "not_configured";
      let emailMessageId: string | null = null;
      let emailError: string | null = null;
      if (resendKey && emailFrom) {
        try {
          const locationLabel = space ? `${space.building} · ${space.level} · ${space.name}` : "Confirm on site";
          const emailResponse = await fetch("https://api.resend.com/emails", {
            method: "POST",
            headers: { Authorization: `Bearer ${resendKey}`, "Content-Type": "application/json" },
            body: JSON.stringify({
              from: emailFrom,
              to: [workerEmail],
              ...(emailReplyTo ? { reply_to: emailReplyTo } : {}),
              subject: `${property.name}: ${requirement.title}`,
              text: `Measured Decision field task\n\n${requirement.title}\nProject: ${property.name}\nLocation: ${locationLabel}\nDue: ${dateLabel(dueAt)}\n\n${requirement.rationale}\n\nOpen field task: ${link}\n\nNo Studio account is required. This private link opens only this assignment and expires automatically.`,
              html: `<div style="font-family:Arial,sans-serif;max-width:620px;color:#10202f"><p style="color:#168da1;font-weight:700">MEASURED DECISION · FIELD TASK</p><h1 style="font-size:25px">${html(requirement.title)}</h1><p><strong>Project:</strong> ${html(property.name)}<br><strong>Location:</strong> ${html(locationLabel)}<br><strong>Due:</strong> ${html(dateLabel(dueAt))}</p><p>${html(requirement.rationale)}</p><p><a href="${html(link)}" style="display:inline-block;background:#24bfd5;color:#06101c;padding:14px 20px;border-radius:6px;text-decoration:none;font-weight:700">Open field task</a></p><p style="font-size:12px;color:#607386">No Studio account is required. This private link opens only this assignment and expires automatically.</p></div>`,
            }),
          });
          const emailPayload = await emailResponse.json().catch(() => ({}));
          if (emailResponse.ok) {
            emailState = "sent";
            emailMessageId = emailPayload?.id || null;
          } else {
            emailState = "failed";
            emailError = emailPayload?.message || `Email provider rejected the request (${emailResponse.status})`;
          }
        } catch (emailRequestError) {
          emailState = "failed";
          emailError = `Email provider could not be reached: ${emailRequestError instanceof Error ? emailRequestError.message : "network error"}`;
        }
      } else {
        emailError = !resendKey
          ? "RESEND_API_KEY is not configured in Supabase Edge Function secrets"
          : "FIELD_EMAIL_FROM is not configured in Supabase Edge Function secrets";
      }
      const emailAttemptedAt = new Date().toISOString();
      await Promise.all([
        admin.from("field_assignments").update({
          email_delivery_state: emailState,
          email_message_id: emailMessageId,
          email_delivery_error: emailError,
          email_last_attempt_at: emailAttemptedAt,
          updated_at: emailAttemptedAt,
        }).eq("id", assignment.id),
        admin.from("field_assignment_events").insert({
          organization_id: task.organization_id,
          assignment_id: assignment.id,
          event_type: `assignment.email_${emailState}`,
          actor_id: user.id,
          detail: { worker_email: workerEmail, provider: "resend", message_id: emailMessageId, error: emailError },
        }),
      ]);
      return json(request, { assignment_id: assignment.id, link, email_sent: emailState === "sent", email_state: emailState, email_error: emailError });
    }

    if (action === "get_assignment") {
      const assignment = await assignmentFromToken();
      const now = new Date().toISOString();
      if (assignment.status === "sent") {
        await Promise.all([
          admin.from("field_assignments").update({ status: "opened", opened_at: now, updated_at: now }).eq("id", assignment.id),
          admin.from("field_assignment_events").insert({ organization_id: assignment.organization_id, assignment_id: assignment.id, event_type: "assignment.opened" }),
        ]);
        assignment.status = "opened";
      }
      const { data: evidence } = await admin.from("evidence_items")
        .select("id, original_filename, mime_type, byte_size, captured_at, created_at")
        .eq("field_assignment_id", assignment.id)
        .is("deleted_at", null)
        .order("created_at");
      const { data: documents } = await admin.from("project_documents")
        .select("id, original_filename, mime_type, byte_size, issued_at, created_at")
        .eq("field_assignment_id", assignment.id)
        .order("created_at");
      const { data: checks } = await admin.from("field_quality_checks")
        .select("id, state, result, created_at, completed_at")
        .eq("assignment_id", assignment.id)
        .order("created_at", { ascending: false })
        .limit(1);
      return json(request, {
        assignment: {
          id: assignment.id,
          status: assignment.status,
          worker_name: assignment.worker_name,
          due_at: assignment.due_at,
          expires_at: assignment.expires_at,
          instructions: assignment.instructions_snapshot,
          upload_scope: {
            organization_id: assignment.organization_id,
            property_id: assignment.property_id,
            space_id: assignment.space_id,
            capture_task_id: assignment.capture_task_id,
            baseline_id: assignment.baseline_id,
          },
        },
        evidence: [
          ...(evidence || []).map((item) => ({ ...item, record_type: "evidence" })),
          ...(documents || []).map((item) => ({ ...item, record_type: "project_document" })),
        ].sort((left, right) => String(left.created_at).localeCompare(String(right.created_at))),
        quality_check: checks?.[0] || null,
      });
    }

    if (action === "start" || action === "uploading") {
      const assignment = await assignmentFromToken();
      const now = new Date().toISOString();
      const status = action === "start" ? "in_progress" : "uploading";
      const patch: Record<string, unknown> = { status, updated_at: now };
      if (action === "start" && !assignment.started_at) patch.started_at = now;
      await Promise.all([
        admin.from("field_assignments").update(patch).eq("id", assignment.id),
        admin.from("field_assignment_events").insert({ organization_id: assignment.organization_id, assignment_id: assignment.id, event_type: `assignment.${status}` }),
      ]);
      return json(request, { status });
    }

    if (action === "submit") {
      const assignment = await assignmentFromToken();
      const { data: evidence } = await admin.from("evidence_items")
        .select("id")
        .eq("field_assignment_id", assignment.id)
        .is("deleted_at", null)
        .eq("capture_task_id", assignment.capture_task_id);
      const { data: documents } = await admin.from("project_documents")
        .select("id")
        .eq("field_assignment_id", assignment.id)
        .eq("capture_task_id", assignment.capture_task_id);
      const evidenceIds = [...(evidence || []), ...(documents || [])].map((item) => item.id);
      if (!evidenceIds.length) fail("Upload at least one requested file before submitting", 409);
      const now = new Date().toISOString();
      const { data: check, error: checkError } = await admin.from("field_quality_checks").insert({
        organization_id: assignment.organization_id,
        property_id: assignment.property_id,
        assignment_id: assignment.id,
        capture_task_id: assignment.capture_task_id,
        evidence_ids: evidenceIds,
      }).select("id").single();
      if (checkError || !check) throw checkError || new Error("Quality check could not be queued");
      await Promise.all([
        admin.from("field_assignments").update({ status: "ai_check", submitted_at: now, updated_at: now }).eq("id", assignment.id),
        admin.from("capture_tasks").update({ status: "submitted", submitted_at: now, updated_at: now }).eq("id", assignment.capture_task_id),
        admin.from("field_assignment_events").insert({ organization_id: assignment.organization_id, assignment_id: assignment.id, event_type: "assignment.submitted", detail: { evidence_ids: evidenceIds, quality_check_id: check.id } }),
      ]);
      const qualityRequest = fetch(`${supabaseUrl}/functions/v1/field-quality-check`, {
        method: "POST",
        headers: { Authorization: `Bearer ${serviceKey}`, apikey: serviceKey, "Content-Type": "application/json" },
        body: JSON.stringify({ quality_check_id: check.id }),
      }).catch((error) => console.error("field-quality-check dispatch", error));
      const runtime = (globalThis as unknown as { EdgeRuntime?: { waitUntil(promise: Promise<unknown>): void } }).EdgeRuntime;
      if (runtime?.waitUntil) runtime.waitUntil(qualityRequest);
      else await qualityRequest;
      return json(request, { status: "ai_check", quality_check_id: check.id });
    }

    if (action === "review_decision") {
      const { user, client } = await authenticatedActor();
      const assignmentId = cleanText(body?.assignment_id);
      const decision = cleanText(body?.decision);
      const note = cleanText(body?.note);
      if (!isUuid(assignmentId) || !["complete", "retake"].includes(decision)) fail("A valid review decision is required");
      const { data: assignment } = await admin.from("field_assignments").select("*").eq("id", assignmentId).maybeSingle();
      if (!assignment) fail("Assignment not found", 404);
      const role = await membership(client, assignment.organization_id, user.id);
      if (!role || !["owner", "admin", "reviewer"].includes(role)) fail("Reviewer access is required", 403);
      const now = new Date().toISOString();
      const assignmentPatch = decision === "complete"
        ? { status: "completed", completed_at: now, updated_at: now }
        : { status: "retake", completed_at: null, updated_at: now };
      const taskPatch = decision === "complete"
        ? { status: "verified", verified_at: now, verified_by: user.id, reviewer_note: note || null, updated_at: now }
        : { status: "needs_more", verified_at: null, verified_by: null, reviewer_note: note || "Retake requested", updated_at: now };
      await Promise.all([
        admin.from("field_assignments").update(assignmentPatch).eq("id", assignment.id),
        admin.from("capture_tasks").update(taskPatch).eq("id", assignment.capture_task_id),
        admin.from("field_assignment_events").insert({ organization_id: assignment.organization_id, assignment_id: assignment.id, event_type: `review.${decision}`, actor_id: user.id, detail: { note } }),
        admin.from("audit_events").insert({ organization_id: assignment.organization_id, actor_id: user.id, action: `field_assignment.${decision}`, entity_type: "field_assignment", entity_id: assignment.id, detail: { capture_task_id: assignment.capture_task_id, note } }),
      ]);
      return json(request, { status: assignmentPatch.status });
    }

    return json(request, { error: "Unsupported action" }, 400);
  } catch (error) {
    const safe = safeError(error, "The field service could not complete that request.");
    return json(request, safe.body, safe.status);
  }
});
