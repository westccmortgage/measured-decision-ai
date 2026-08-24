/* One known world, used by every browser test.
 *
 * Modelled on the real project rather than invented: a plan-approved building
 * where most rooms have never been visited, one room holds a stitched capture,
 * one holds a camera pair the machine has not reached yet, and one holds only a
 * document. Those are the four states every screen has to survive, and three of
 * them are where the bugs have been. */
export const ORG = "org-1";
export const PROPERTY = "prop-1";

const room = (id, name, building, level) => ({
  id, name, building, level,
  organization_id: ORG, property_id: PROPERTY,
  review_state: "needs_review", created_at: "2026-08-01T00:00:00Z",
});

const file = (id, space_id, filename, mime, extra = {}) => ({
  id, space_id, organization_id: ORG, property_id: PROPERTY,
  storage_path: `organizations/${ORG}/properties/${PROPERTY}/evidence/${filename}`,
  storage_provider: "aws-s3", storage_bucket: "bucket",
  original_filename: filename, media_type: extra.media_type || "Property evidence",
  mime_type: mime, byte_size: 1024,
  captured_at: extra.captured_at || "2026-08-20T10:00:00Z",
  created_at: extra.created_at || "2026-08-20T10:00:00Z",
  source_metadata: extra.source_metadata || {},
  derivative_of: extra.derivative_of || null,
  deleted_at: null,
  ...extra,
});

export const rows = {
  organization_members: [{ organization_id: ORG, user_id: "user-1", role: "owner" }],
  properties: [{
    id: PROPERTY, organization_id: ORG, name: "3001 Hutton",
    address: { city: "Los Angeles", state: "CA", profile: { property_type: "single_family" } },
    access_classification: "private", created_at: "2026-08-01T00:00:00Z", deleted_at: null,
  }],
  spaces: [
    room("space-viewable", "Bath #1 A203", "Main House", "Level 1"),
    room("space-waiting", "Master Bedroom 205A", "Main House", "Level 2"),
    room("space-docs", "Kitchen A102", "Main House", "Level 1"),
    room("space-empty", "Stairs 108", "Main House", "Level 1"),
  ],
  evidence_items: [
    // A room you can stand in: the machine has run.
    file("ev-master", "space-viewable", "vid_20250222_043147_022-vr-master.mp4", "video/mp4", {
      media_type: "360 capture", derivative_of: "ev-lens-a",
      source_metadata: { projection: "equirectangular", vr: { playback_ready: true } },
      created_at: "2026-08-13T10:00:00Z",
    }),
    // A room holding a complete camera pair the machine has not reached.
    file("ev-b-00", "space-waiting", "VID_20250222_042413_00_013.insv", "application/octet-stream", {
      media_type: "360 camera original", created_at: "2026-08-21T18:16:00Z",
    }),
    file("ev-b-10", "space-waiting", "VID_20250222_042413_10_013.insv", "application/octet-stream", {
      media_type: "360 camera original", created_at: "2026-08-21T18:16:30Z",
    }),
    // A room with a document only: nothing the AI can read.
    file("ev-doc", "space-docs", "invoice-framing.pdf", "application/pdf", {
      media_type: "Document", created_at: "2026-08-19T09:00:00Z",
    }),
  ],
  capture_360_jobs: [{
    id: "job-1", organization_id: ORG, property_id: PROPERTY,
    capture_group_id: "grp-1", state: "waiting_for_sdk", progress: 5,
    stage: "Original pair verified", error_code: null,
    updated_at: "2026-08-21T18:17:00Z", created_at: "2026-08-21T18:17:00Z",
    capture_360_groups: { capture_key: "vid_20250222_042413_013", state: "ready" },
  }],
  worker_machine_runs: [],
  analysis_jobs: [], ai_suggestions: [], suggestion_reviews: [],
};

export const seed = { rows };

/* A project the moment it is created: no plan read, no rooms, no files.
 *
 * This is the first screen every new customer sees and it was never tested,
 * which is exactly how a deadlock survived there — no file may be uploaded
 * without a room, rooms come from the plan set, and the screen demanding a room
 * never named where plans go. The walk that covers the seeded project above
 * passed the whole time.
 */
export const emptyRows = {
  organization_members: rows.organization_members,
  properties: [{
    id: PROPERTY, organization_id: ORG, name: "3001 Hutton",
    address: {}, access_classification: "private",
    created_at: "2026-08-23T07:00:00Z", deleted_at: null,
  }],
  spaces: [],
  evidence_items: [],
  capture_360_jobs: [],
  worker_machine_runs: [],
  analysis_jobs: [], ai_suggestions: [], suggestion_reviews: [],
};

export const emptySeed = { rows: emptyRows };

/* The chain, state by state.
 *
 * A project does not have two states — it has a sequence, and almost every bug
 * a person has hit lived in a state between two that were tested. These are
 * built from the same pieces as the worlds above so that a schema change breaks
 * them together rather than leaving one quietly lying.
 *
 * Column names here are the real ones. An earlier draft of this file invented
 * `detail` and `updated_at` on a machine run, and the screen correctly said
 * nothing about a machine it had no readable word from — which looked exactly
 * like a bug in the screen. The seed is part of the evidence; it has to be as
 * true as the code.
 */
const clone = (value) => JSON.parse(JSON.stringify(value));

export const planDocument = (extra = {}) => ({
  id: "doc-1", organization_id: ORG, property_id: PROPERTY,
  storage_path: `organizations/${ORG}/properties/${PROPERTY}/documents/plans.pdf`,
  storage_provider: "aws-s3", storage_bucket: "bucket", object_version_id: null,
  original_filename: "Blueprints-3001-Hutton.pdf", mime_type: "application/pdf",
  byte_size: 900000, document_type: "plan_set", revision_label: "Rev A",
  issued_at: "2026-08-01", status: "uploaded", processing_error: null,
  created_at: "2026-08-23T07:10:00Z", ...extra,
});

/* Plans are in the project and nothing has read them yet. */
export const plansUploadedRows = () => {
  const r = clone(emptyRows);
  r.project_documents = [planDocument()];
  return r;
};

/* The plan set is being read right now, and the job has already reported 62%.
   A page opened at this moment must show 62, not restart the meter at zero. */
export const plansReadingRows = () => {
  const r = clone(emptyRows);
  r.project_documents = [planDocument({ status: "processing" })];
  r.plan_analysis_jobs = [{
    id: "pj-1", organization_id: ORG, property_id: PROPERTY, state: "processing",
    baseline_id: null, progress_stage: "reading_documents", progress_percent: 62,
    error_code: null, error_message: null,
    started_at: "2026-08-23T07:12:00Z", created_at: "2026-08-23T07:12:00Z",
  }];
  return r;
};

/* The plans were read: rooms exist, and not one of them holds anything. */
export const roomsNoEvidenceRows = () => {
  const r = clone(emptyRows);
  r.project_documents = [planDocument({ status: "analyzed" })];
  r.document_baselines = [{
    id: "bl-1", organization_id: ORG, property_id: PROPERTY, version: 1, state: "approved",
    source_document_ids: ["doc-1"], project_summary: "Single family remodel",
    analysis: {}, gaps: [], model: "test", created_at: "2026-08-23T07:20:00Z",
    approved_at: "2026-08-23T07:25:00Z",
  }];
  r.spaces = clone(rows.spaces);
  return r;
};

/* The 360 machine is awake and working, this minute. */
export const machineWorkingRows = () => {
  const r = clone(rows);
  const now = new Date().toISOString();
  r.worker_machine_runs = [{
    id: "run-1", instance_id: "i-0abc", region: "us-east-2", worker_version: "2026-08-21.3",
    state: "working", step: "Stitching capture 3 of 9", exit_code: null, message: null,
    log_url: null, jobs_claimed: 9, jobs_completed: 2, jobs_failed: 0,
    started_at: now, last_seen_at: now, finished_at: null,
  }];
  r.capture_360_jobs[0].state = "processing";
  r.capture_360_jobs[0].progress = 41;
  r.capture_360_jobs[0].stage = "Stitching frames";
  return r;
};

/* An AI review has produced an interpretation nobody has confirmed. */
export const aiReviewedRows = () => {
  const r = clone(rows);
  r.analysis_jobs = [{
    id: "aj-1", organization_id: ORG, property_id: PROPERTY, space_id: "space-viewable",
    state: "succeeded", profile: "room_interpretation", evidence_ids: ["ev-master"],
    error_code: null, created_at: "2026-08-22T10:00:00Z",
  }];
  r.ai_suggestions = [{
    id: "sg-1", organization_id: ORG, property_id: PROPERTY, space_id: "space-viewable",
    suggestion_type: "room_interpretation", evidence_ids: ["ev-master"],
    created_at: "2026-08-22T10:05:00Z",
    body: {
      summary: "Framing complete, drywall not started.",
      observations: ["Studs exposed on the north wall"],
      questions: ["Was the window replaced?"],
    },
  }];
  return r;
};

/* The plans were read and the roadmap is waiting for a person.
 *
 * This is the state that closed the loop a second time: analysing the plans
 * does not create the rooms — approving the roadmap does — so a project that
 * had already been read was still told to go and upload a plan set it had.
 */
export const baselineAwaitingApprovalRows = () => {
  const r = clone(emptyRows);
  r.project_documents = [planDocument({ status: "analyzed" })];
  r.document_baselines = [{
    id: "bl-1", organization_id: ORG, property_id: PROPERTY, version: 1, state: "review",
    source_document_ids: ["doc-1"], project_summary: "Single family remodel",
    analysis: {}, gaps: [], model: "test", created_at: "2026-08-23T07:20:00Z", approved_at: null,
  }];
  r.spaces = [];
  return r;
};
