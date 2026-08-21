# Evidence provenance

The platform exists to answer one chain of questions about a file. This page
says, for each link in that chain, where the answer is stored and how good it is.

| Question | Answer lives in | State |
|---|---|---|
| Who uploaded this? | `evidence_items.created_by`, or the guest link id | Implemented |
| When? | `evidence_items.created_at` | Implemented |
| Which project? | `organization_id`, `property_id`, `space_id` | Implemented |
| What was the original file? | `original_filename`, `mime_type`, `byte_size`, `storage_path`, `object_version_id` | Implemented |
| What produced it? | `source_type` | Implemented |
| Has it changed? | `sha256` + `content_hash_algorithm` + `content_hash_scope` | Partial |
| Which AI process looked at it? | `analysis_jobs` → `ai_suggestions.job_id` | Implemented |
| What did the AI determine? | `ai_suggestions.body`, `.layer`, `.confidence` | Implemented |
| What supported or contradicted it? | `supporting_evidence_ids`, `conflicting_evidence_ids`, `missing_evidence` | Partial |
| What did the human decide? | `suggestion_reviews.state`, `.reviewed_by` | Implemented |
| When was it decided? | `suggestion_reviews.reviewed_at` | Implemented |

## Integrity: read the two columns together

`sha256` on its own is not a claim. It means nothing without
`content_hash_algorithm`, which says how it was produced, and
`content_hash_scope`, which says what it covers. Three values are possible:

- **`sha-256` / `whole-file`** — a real digest of the whole file, computed by
  something that read all of it. This is the strong claim.
- **`s3-etag-md5` / `parts-composite`** — what S3 returned when the upload
  completed. For a multipart upload that is a digest of the part digests, not of
  the file. It proves the stored object has not changed since upload. It is not
  a file hash and must never be presented as one.
- **null** — no digest recorded. Integrity cannot be asserted for this file.

**Why not always the strong claim?** A browser cannot hash a 40 GB camera
original without reading it a second time, on a phone, in the field. So the
upload path records what the store can prove, and the stitching machine — which
downloads the whole original to disk anyway — computes the real digest and
writes it back (`record_digest` in `workers/insta360/worker.py`). Every 360
original that has been through stitching, and every master it produced, carries
a whole-file SHA-256.

**Photos and documents** are hashed in the browser before they are sent, for
anything up to 64 MiB — which is nearly all of them. Web Crypto has no
incremental digest, so that limit is what a mid-range phone will allocate without
the tab being killed mid-upload, and hashing never blocks an upload: if it fails
the record simply says no whole-file digest was taken.

A digest computed by an uploader is a claim about what they sent, not proof of
what arrived, which is why `content_hash_recorded_by` distinguishes
`client-upload` from `server-verified`. The `verify_evidence_digest` operation
reads the stored object back and recomputes, turning the claim into a fact — and
if the two disagree it says so, writes `evidence.integrity_mismatch` into the
audit trail, and leaves the record saying what it said rather than quietly
overwriting the disagreement. It is on request rather than on every upload
because reading the file back would add its download time to every completion,
for a check almost nobody needs at that moment.

**The remaining gap** is files between 64 MiB and whatever the stitching machine
happens to touch: a large video that is not a 360 capture keeps its S3 ETag. The
honest label is already on it.

## The original is never overwritten

**Implemented.** There is no code path that replaces the bytes behind an evidence
record. `guard_evidence_deletion` refuses any update that changes
`storage_path` or `storage_bucket`, so a "replacement" is structurally
impossible — a different file is a different record.

**Implemented.** Derivatives point at their parent through
`evidence_items.derivative_of`, and carry in `source_metadata` what was done and
by what. A stitched 360 master records both parents by evidence id, filename and
digest (`derived_from`), because it has two parents and the column holds one.

**Implemented.** Trimming is recorded rather than assumed: the master carries the
policy name, the seconds removed from each end, and the reason
(`camera-handling-v1`). A viewer can state what was cut and why.

## Deletion does not break the chain

Deleting evidence sets `deleted_at`. The row stays, the stored object stays, and
anything derived from it still has a parent to point at. Destroying the bytes is
a second, separate, owner-only act (`purge_evidence`) that refuses to run unless
the file was already deleted, requires explicit confirmation, and warns when
other files were derived from it. Even then the row survives the bytes: a record
saying "this file existed and on this date this person destroyed it" is worth
more than a gap. See DATA_RETENTION.md.

## Observation, interpretation, decision

The product rule is structural, not a convention.

- **Observation** — what was detected. `ai_suggestions.layer = 'observation'`.
- **Interpretation** — what the AI believes the evidence may support.
  `ai_suggestions.layer = 'interpretation'`. This is what the analysis worker
  writes.
- **Decision** — what an authorized person approved, rejected, or sent back for
  more evidence. A row in `suggestion_reviews`.

An AI process cannot author a decision. `suggestion_reviews.reviewed_by` is a
`not null` reference to `auth.users`, and no model and no service key has such an
identity to offer. The separation is enforced by the schema, not by discipline.

Where the AI cannot establish something, it says so rather than filling the gap:
`missing_evidence` carries the questions the capture did not answer, and
`conflicting_evidence_ids` stays empty because nothing in the pipeline detects
contradiction between two captures yet. An empty column is honest; a guessed one
would not be.

## Reconstructing an AI conclusion

`analysis_jobs` records the provider, the model that was *asked for* (`model`),
the model that *answered* (`model_version`), the workflow profile and its
version, a fingerprint of the exact instructions and response schema used
(`prompt_fingerprint`), how many files went in, and the token usage. Change the
prompt or the schema and the fingerprint changes, so an old finding can never be
silently attributed to today's prompt.

Deleted evidence never reaches a model: the analysis worker filters it out
before building the request. A conclusion drawn from a file the record no longer
shows could not be explained to anyone later.

## The audit trail

`public.audit_events` is append-only, enforced by a trigger rather than by
policy — the service key bypasses row-level security but cannot bypass a
trigger. No row can be updated or deleted by anyone, including us.

Written by the database, so no caller can forget:

| Event | Trigger |
|---|---|
| `decision.made`, `decision.changed` | `suggestion_reviews` |
| `analysis.queued/processing/completed/failed` | `analysis_jobs` |
| `release.draft/review/approved/revoked` | `vision_releases` |
| `member.added/role_changed/removed` | `organization_members` |

Written by the Edge Functions, through `record_audit_event`:

| Event | Where |
|---|---|
| `evidence.uploaded_to_s3` | `object-storage` |
| `evidence.deleted`, `evidence.restored`, `evidence.purged` | `object-storage` |
| `evidence.removed_before_submission` | `object-storage`, guest capture links |
| `project_intake.created`, `project_intake.submitted` | `project-intake` |

Each entry carries the organization, the property where known, the actor and
what *kind* of actor it was (`user`, `guest_link`, `service`, `worker`,
`system`), the action, the resource, before/after state where it applies, and
the reported IP and user agent. Those last two arrive as proxy headers and are
recorded as reported, never as verified.

Opening a file to look at it is recorded (`evidence.opened`), and so is
generating a report (`report.generated`). A thumbnail appearing in a list is not:
one is a person choosing to see something, which is what "who saw what" means,
and the other is the page loading, which would bury the first under thousands of
entries that answer nothing.

Both come from a browser, so they arrive through `record_client_event` — a narrow
door with a fixed list of four actions, membership checked, and the actor forced
to the caller. A client cannot invent an action, attribute one to someone else,
or write into a project it has no part in.

**Planned.** No one can read the trail from the product yet — only an owner or
admin via the database. The trail is being made complete before it is made
visible.
