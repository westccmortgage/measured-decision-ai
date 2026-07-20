# Measured Decision Spatial Intelligence Studio

## Product boundary

Studio is the governed bridge between physical-property evidence and an Apple Vision Pro experience. It is not a generic file manager and it does not let AI silently turn suggestions into facts.

The production path is:

1. Capture: phone photos, video, 360 media, plans, records, USDZ, or Reality assets.
2. Organize: assign every source to an organization, property, building, level, and space.
3. Preserve: keep the original in a private immutable storage path and record provenance.
4. Analyze: create a server-side job using selected evidence and a versioned processing profile.
5. Review: present suggestions beside the exact source; a named human accepts, edits, or rejects each suggestion.
6. Package: freeze a release manifest that references only approved evidence and review records.
7. Experience: a native visionOS client reads the manifest and private signed media URLs.

## Security boundary

- Supabase Auth supplies the user identity.
- Row Level Security limits all records to organization membership.
- Storage bucket `property-evidence` is private.
- Provider API keys exist only in a server-side Edge Function or worker.
- The browser never receives a provider secret or service-role key.
- Signed media URLs are short-lived and issued after an authorization check.
- AI output is stored in `ai_suggestions`, separate from `verified_observations`.
- A Vision package can only be marked `approved` by an authorized human reviewer.

## AI processing contract

Input includes evidence IDs, a processing-profile version, allowed tasks, and the requesting user. The worker resolves private files, validates MIME type and size, invokes the approved model, validates structured output, and writes suggestions with source references and model provenance.

Allowed early outputs:

- source-grounded visible observations;
- candidate room/object labels;
- contradictions and missing-evidence questions;
- candidate spatial anchors for human placement;
- summaries that preserve uncertainty.

Disallowed outputs:

- code-compliance certification;
- structural, environmental, or medical diagnosis;
- appraisal or final valuation;
- percentage-of-completion claims without an approved deterministic method;
- autonomous lending, insurance, construction, or safety decisions.

## Apple Vision Pro contract

The web Studio exports a platform-neutral manifest. A separate native visionOS application will:

- authenticate the user;
- request an authorized manifest version;
- resolve signed media and spatial-asset URLs;
- render the property/space graph;
- place approved annotations and evidence panels;
- allow review notes and return them to Studio;
- work from a downloaded release snapshot when offline use is authorized.

The web prototype does not generate an installable visionOS application, a USDZ model, or a real digital twin. Those require a capture pipeline and a native RealityKit/SwiftUI client.

## Delivery phases

### Phase 1 — operational web slice

Auth, private storage, property/space/evidence records, human review, audit log, and draft Vision manifest.

### Phase 2 — AI evidence worker

Versioned analysis profiles, structured output validation, job retries, cost controls, suggestion review, and provenance.

### Phase 3 — spatial capture

360 ingestion, photogrammetry or room-plan pipeline where supported, spatial anchors, and derived-asset versioning.

### Phase 4 — visionOS pilot

Native client, authenticated package sync, room navigation, evidence overlays, review capture, and one-property field test.

## Definition of a real pilot

One property is a successful pilot when ten named spaces can be opened in Studio, each source can be traced to its original, AI suggestions can be reviewed individually, a release can be approved by a named person, and the same approved release can be navigated in Vision Pro without exposing private media publicly.
