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
3. Review the versioned project baseline, source references, conflicts, and gaps.
4. Approve the baseline to create rooms and activate phase-based capture tasks.
5. Open a task in Evidence Intake; uploaded evidence is linked to that exact requirement.

Apply `supabase/migrations/005_plan_intelligence.sql` and deploy the
`plan-analyze` Edge Function before enabling the page in production. The worker
uses `OPENAI_PLAN_MODEL`, then `OPENAI_MODEL`, and requires the same server-only
`OPENAI_API_KEY` already used by evidence analysis. See
[`docs/AI_OPERATING_CONTRACT.md`](docs/AI_OPERATING_CONTRACT.md) for its scope
and non-inference rules. The versioned specialist responsibilities, routing,
training loop, and current activation status are defined in
[`docs/AGENT_OPERATING_MODEL.md`](docs/AGENT_OPERATING_MODEL.md).

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
