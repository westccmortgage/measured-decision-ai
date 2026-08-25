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

## Security and evidence integrity

How the platform keeps the chain from camera to decision, who can reach what,
and what deletion actually means: [`docs/security/`](docs/security/). Each page
marks what is implemented, what is partial, and what is planned, so nothing
there can be mistaken for a control that exists.

Measured Decision has not completed a SOC 2, ISO 27001, HIPAA or FedRAMP audit,
and nothing in this repository or on the site claims otherwise.

The properties that must not silently stop being true are executable:

```
bash supabase/tests/run.sh
```

That builds a throwaway PostgreSQL, applies every migration the way CI does, and
asserts tenant isolation, evidence immutability, deletion authority, an
append-only audit trail, and the rule that no AI process can author a human
decision.

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
`field-quality-check`, and `vision-release`. The plan worker uses
`OPENAI_PLAN_MODEL`, then `OPENAI_MODEL`. Evidence and plan analysis prefer the
server-only Cloudflare AI Gateway transport when its account ID and token are
configured, and otherwise fall back to the existing server-only `OPENAI_API_KEY`.
See [`docs/CLOUDFLARE_AI_GATEWAY.md`](docs/CLOUDFLARE_AI_GATEWAY.md) for Unified
Billing activation and privacy behavior, and
[`docs/AI_OPERATING_CONTRACT.md`](docs/AI_OPERATING_CONTRACT.md) for the model's
scope and non-inference rules. The versioned specialist responsibilities,
routing, training loop, and current activation status are defined in
[`docs/AGENT_OPERATING_MODEL.md`](docs/AGENT_OPERATING_MODEL.md).

Field emails use Resend. Configure these Supabase Edge Function secrets before
testing delivery:

- `RESEND_API_KEY`
- `FIELD_EMAIL_FROM`, for example
  `Measured Decision <field@updates.measureddecision.com>`
- `FIELD_EMAIL_REPLY_TO` (optional)

The sender domain must be verified in Resend. When email is not configured or
the provider rejects a request, Studio still saves the assignment, presents the
protected field link, and shows the exact delivery error; it never labels a
generated link as a delivered email. A `sent` state means that Resend accepted
the message for delivery, not that the recipient opened or received it.

## Studio route: project today → decision

Opening a project no longer lands on a bare upload box. The signed-in Studio is
one route with no dead ends, and it is built for a phone first:

1. **Project today** — what the record says right now, what changed since the
   last upload, what needs attention, and a single next action with a named
   owner. The chain below it (plans → evidence → AI review → human verification
   → decision → spatial record) is interactive: every step either opens the
   screen that advances it or says why it cannot run yet.
2. **Upload** — originals go to private storage unchanged.
3. **AI processing** — a real percentage, a row per space with its current
   stage, the exact error when one fails, and a retry that reruns only that
   space.
4. **Results** — every metric names what it counts, and every space opens.

Opening a space shows its evidence, the AI interpretation labeled as a
suggestion, the open questions the AI could not establish, requested captures,
and the human verification controls that turn a suggestion into a record. A
factual note written at confirmation is the decision record for that space.

Evidence opens in `studio/pano360.js`, a dependency-free viewer. Equirectangular
photos and MP4 exports render as a real sphere with drag, pinch, and device
orientation; flat photos, video, and documents open in the same place, so
"see the evidence" is always one action. Protected Insta360 originals cannot be
played by a browser, and the viewer says so and points at the export step
instead of failing silently.

`Copy link for Vision Pro` produces `/studio/?property=…&evidence=…`, which opens
the project straight on that capture. That link is the current bridge into a
headset; a native visionOS client is still ahead of it.

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
