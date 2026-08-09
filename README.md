# Measured Decision AI

Official static website for [MeasuredDecision.com](https://measureddecision.com).

## Current product foundations

- [WalletWCCM](https://walletwccm.com) — closing-cost and cash-to-close clarity
- [GRCRM](https://grcrm.com) — lead and workflow continuity

## Commercial + Residential proof stage

The homepage opens with two lightweight master scenes instead of an abstract
technology loop:

- Commercial construction: site capture, drone context, a connected building
  model, and spatial human review.
- Residential construction: room capture, a connected home record, and a future
  owner reviewing the history in Vision Pro.

Both scenes are preloaded and crossfade without a blank frame. Visitors can
switch between them manually, pause playback, or let the page advance
automatically. Smaller mobile encodes and static posters reduce first-load cost
and preserve a useful fallback when autoplay is unavailable.

## Film Center

The compact Film Center restores four avatar-led films in one selectable player:

1. The Measured Decision Vision
2. Every Dollar Should Have an Evidence Path
3. Every Property Should Have a Living Record
4. From Documents to Spatial Intelligence

Each film includes an optional English CC track that is off by default.

## Method

Mortgage data → deterministic calculations → AI-assisted explanation → human review.

## Plan Intelligence pilot

The authenticated Studio now starts construction evidence collection from the
governing PDF plan set instead of from an unstructured site walk:

1. Upload private plans at `/studio/plans/` with discipline, revision, and issue date.
2. Run the server-side `plan-analyze` worker against an explicit document set.
3. Review the versioned project baseline, source references, conflicts, and gaps. If PDF markings cannot establish the official status, an authorized manager records the governing-set approval reference; AI gaps remain preserved.
4. Approve the baseline to create rooms and activate phase-based capture tasks.
5. Send one ready task from the roadmap to a field worker by email or private link.
6. The worker follows four mobile steps at `/field/` and uploads directly to private S3 without a Studio account.
7. Field Quality checks usability; a remote reviewer completes the task or asks for one clear retake from `/studio/operations/`.
8. Build and human-approve a governed Vision release. Drafts and stale evidence never replace the live package.

Production also requires migrations `006_external_object_storage.sql` through
`009_governing_plan_attestation.sql` plus `object-storage`, `field-workflow`,
`field-quality-check`, and `vision-release`. The plan worker
uses `OPENAI_PLAN_MODEL`, then `OPENAI_MODEL`, and requires the same server-only
`OPENAI_API_KEY` already used by evidence analysis. See
[`docs/AI_OPERATING_CONTRACT.md`](docs/AI_OPERATING_CONTRACT.md) for its scope
and non-inference rules. The versioned specialist responsibilities, routing,
training loop, and current activation status are defined in
[`docs/AGENT_OPERATING_MODEL.md`](docs/AGENT_OPERATING_MODEL.md).

Field emails use `RESEND_API_KEY` and `FIELD_EMAIL_FROM`. When those secrets are
not configured, Studio still creates the protected assignment and presents a
copyable link; it never pretends that an email was sent.

## Vision chapters

The site includes four illustrated chapters explaining the company's direction:

1. Our Vision
2. Financial Intelligence
3. Property & Spatial Intelligence
4. Technology & Human Review

Spatial imagery is explicitly presented as concept exploration, not released product functionality.

## Local preview

Run a static server from the repository root, for example:

```bash
python3 -m http.server 8080
```

Then open `http://localhost:8080`.

## Netlify media assembly

When deploying from GitHub, Netlify runs `scripts/assemble-media.sh` to reconstruct
the original MP4 files from repository-safe binary parts before publishing. This
keeps the full-quality media in source control without relying on Git LFS.
