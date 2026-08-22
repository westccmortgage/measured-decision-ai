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
