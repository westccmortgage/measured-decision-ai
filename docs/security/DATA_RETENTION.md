# Deletion, retention and recovery

## Five different things called "delete"

| Name | What happens | Reversible | Who |
|---|---|---|---|
| **Remove from the record** | `deleted_at` is set. The file leaves every list, screen and export. The row and the stored object are untouched. | Yes | owner, admin |
| **Restore** | `deleted_at` cleared. | — | owner, admin |
| **Purge** | The S3 object is destroyed. The row survives, marked `purged_at`. | **No** | owner only |
| **Storage lifecycle** | Not configured. See below. | — | — |
| **Audit history** | Never deleted, by anyone, ever. | — | nobody |

The first is what the Delete button does. It used to do the third.

## Why the button changed

Before this, pressing Delete in the Studio removed the S3 object and the database
row together, and the screen said "deleted permanently" — accurately. One
misplaced tap ended a file that other findings were derived from, and nothing
anywhere recorded that the file had ever existed. For an evidence platform that
is the wrong default in every direction: it destroys the thing the product is
for, it breaks the parent link of anything derived from it, and it leaves no
trace of the act.

Now: the file leaves the record, the bytes stay, an owner can bring it back, and
the deletion is written into an append-only trail with who, when and why.

Purging is deliberately awkward. It requires the file to be deleted first, it
requires explicit confirmation in the request, it is refused to admins, and it
refuses a second time — naming the count — if other files were derived from the
one being destroyed.

## What survives a purge

The row. `purged_at`, `purged_by`, the original filename, the size, the hash if
one was recorded, and every audit entry the file ever appeared in. A gap in a
record cannot be explained; a marked destruction can.

## Retention policies

**Planned.** `evidence_items.retention_policy` and `retain_until` exist and are
null on every row, which means exactly what it says: no policy has been applied
to any file. Nothing enforces them yet and nothing pretends to. When retention
lands, it is a scheduled job reading those two columns, not a schema change.

**Planned.** Files removed by a capture guest before submission are kept
indefinitely today. These are the one category where storage cost argues for a
lifecycle rule; they are marked `deleted_at` with a stated reason so a future
job can find them.

## Backups and recovery

Both platforms provide this; the project adds nothing of its own and should not.

**Postgres (Supabase).** Project `hbqlhplgqwuesrovbiye`, us-east-2, PostgreSQL 17.

The point-in-time-recovery machinery is running. Checked in the live database on
21 August 2026: `wal_level = logical`, `archive_mode = on`, and
`archive_command = /usr/bin/admin-mgr wal-push` with `archive_timeout = 120` —
a write-ahead log segment is shipped to backup storage at least every two
minutes. That is the mechanism a restore-to-a-moment depends on, and it is on.

What SQL cannot tell us is the **retention window** — 7, 14 or 28 days depending
on the plan and add-on. That is a dashboard setting: Supabase → the project →
Database → Backups. **Write the number here when it is read**, because "we can
restore" and "we can restore as far back as the mistake" are different promises.

**Objects (S3).** The bucket is private and objects are written with version ids
recorded in `object_version_id`, which is what a versioned bucket returns.
**Whether versioning is actually enabled on
`measured-decision-production-808454010303` must be confirmed in the AWS console
and written here.** If it is on, a purge that supplies a version id removes one
version and earlier ones remain; if it is off, a purge is final. The code is
correct either way; the recovery story is not the same, so the answer matters.

**What happens if someone deletes a project.** Nothing, because no client can.
There is no delete policy on `properties` at all, so a project cannot be removed
from a browser by anyone in any role — which matters, because until this was
fixed a *contributor* could delete a whole project with one PostgREST call,
cascading to every space, evidence row and job inside it. The Studio never
offered that button; the policy offered it anyway.

Removing a project now sets `deleted_at`. Everything inside it stays exactly
where it is, the entry records how much was inside at that moment, and
`restore_project` brings it back whole.

**And a space that still holds evidence** cannot be deleted either. That rule
used to live in the Studio's JavaScript, which is the caller's to change; it is
now a trigger, and it names the count in the refusal. Deleting such a space would
have set every `space_id` to null — the files would survive but stop belonging
anywhere, which for a record built on "which room is this?" is its own kind of
loss.

Note that the audit trail resists this: `audit_events` refuses to be deleted,
including by cascade, so removing an organization outright will fail with a
clear message rather than quietly erasing its history.

## One historical exposure

Until 21 August 2026 the GPU worker's boot script sourced its environment file
under shell tracing, which printed the Supabase service role key into a log that
is uploaded to S3 and written to the EC2 serial console. Anyone with read access
to either could have taken it.

Fixed: the key is never traced, and the log is filtered again on its way out of
the machine. **If any machine before that date uploaded a log, the key must be
rotated in the Supabase dashboard and the objects under `worker-logs/` deleted.**

Separately, a file named `TEMP_STATECOURSE_EXPORT_LINK.md` was committed to this
repository pointing at an unauthenticated export URL on a Netlify deploy preview.
The file has been removed, but git history retains it and the URL should be
treated as public: the underlying export should be taken down rather than
relied upon to stay unlisted.
