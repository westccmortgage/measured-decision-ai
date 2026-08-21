# Incident response

Written for the size the team actually is. When the team is larger, this page
grows; inventing a process nobody will follow helps nobody.

## What counts as an incident

- A credential is exposed — in a log, a screenshot, a commit, a message.
- Evidence is destroyed, altered, or reaches someone who should not have it.
- A component is unreachable long enough to block work.
- Anything that would need to be told to a customer.

If it is unclear whether something counts, treat it as one. The cost of the
short version of this process is minutes.

## First hour

1. **Write down the time and what was seen.** Before fixing anything. A fix
   frequently destroys the evidence of what happened.
2. **Contain.** Rotate the credential, stop the machine, revoke the link. Prefer
   the action that stops the bleeding over the action that is tidy.
3. **Do not delete.** No log, no bucket object, no database row, no branch. The
   audit trail refuses deletion by design; extend the same courtesy to
   everything else until the picture is clear.
4. **Establish scope** using the audit trail: `audit_events` filtered by
   organization and time gives every decision, analysis, upload, deletion and
   membership change in the window, with the actor kind.

## Rotating each credential

| Credential | Where | What breaks while it is rotated |
|---|---|---|
| Supabase service role key | Supabase dashboard → API | All Edge Functions and the GPU worker, until secrets are updated and the worker is relaunched |
| Supabase publishable key | Supabase dashboard | The site, until `studio/config.js` is updated and redeployed |
| AWS access key for S3 | IAM → the Edge Function's user | Uploads and signed URLs, until the Edge Function secret is updated |
| OpenAI key | OpenAI dashboard | Evidence and plan analysis |
| Resend key | Resend dashboard | Field assignment emails only |

The GPU worker holds the service role key in its EC2 user-data. Rotating that
key requires relaunching the machine with the new value; the running machine
will fail its next Supabase call and stop, which is the intended behaviour.

## If evidence may have been reached by the wrong person

1. Identify the files: `audit_events` where `action` starts `evidence.`, or the
   `object_uploads` rows for the window.
2. Signed URLs expire in one hour and cannot be re-minted for a file that has
   been deleted, so containment for a specific file is: delete it from the
   record, then decide about purging separately.
3. Revoke the guest link that was involved — set the assignment, capture session
   or project access to `revoked`/`closed`. Every operation re-checks status, so
   this takes effect on the next request.
4. Determine whether a customer must be told. Default to telling them.

## If evidence was destroyed

Purge is irreversible for the bytes but the row survives with `purged_at` and
`purged_by`, and the audit entry names the actor and the object key. If bucket
versioning is enabled, an earlier version may still exist — confirm the bucket's
versioning state (see DATA_RETENTION.md) before concluding anything is gone.

## Afterwards

Write down what happened, what was done, and the one change that would have
prevented it. Make that change or record why not. The failure history at the top
of `workers/insta360/AWS.md` is the model: it exists because eight machines
failed the same way, and writing it down is what stopped the ninth.

## Not built

- No on-call rotation, no paging, no SLA.
- No security monitoring or alerting. Nothing watches for anomalous access.
- No formal breach notification procedure or timeline commitment.
- No external penetration test has been performed.

These are named so that nobody reading this page believes they exist.
