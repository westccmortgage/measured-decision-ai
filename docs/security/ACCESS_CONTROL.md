# Access control

## The rule

Authorization is decided by the database or by an Edge Function. The browser
decides what to *show*; it never decides what someone is allowed to *have*. A
hidden button is a courtesy, not a control.

## Roles today

`public.studio_role` — one role per person per organization.

| Role | Read | Add evidence | Correct metadata | Decide | Delete |
|---|---|---|---|---|---|
| `owner` | ✓ | ✓ | ✓ | ✓ | ✓ (and purge) |
| `admin` | ✓ | ✓ | ✓ | ✓ | ✓ |
| `project_manager` | *reserved — see below* | | | | |
| `reviewer` | ✓ | — | ✓ | ✓ | — |
| `contributor` | ✓ | ✓ | ✓ | — | — |
| `viewer` | ✓ | — | — | — | — |
| `external_reviewer` | *reserved — see below* | | | | |

`project_manager` and `external_reviewer` exist in the enum
(`020_project_scoped_access.sql`) and are granted nothing yet. They are there so
that adding them later is a policy change rather than a migration of every table.

## Where it is enforced

**Implemented — row-level security.** Every table in `public` has RLS enabled.
Reads go through `public.is_org_member(organization_id)`; writes go through
`public.has_org_role(organization_id, roles[])`. Both read `auth.uid()` from the
verified JWT, so no client input takes part in the decision.

**Implemented — evidence deletion is owner/admin only, twice.** The Edge
Function checks the role before acting, and a database trigger
(`guard_evidence_deletion`) refuses any change to `deleted_at` or `purged_at`
from a session that is not owner or admin. A direct PostgREST call with a valid
contributor token cannot delete evidence.

**Implemented — storage identity cannot be repointed.** The same trigger refuses
any update that changes `storage_path` or `storage_bucket`. A record always
names the bytes it was created for; different bytes mean a new record with a
parent.

**Implemented — no client can delete a project or orphan a room.** There is no
delete policy on `properties`, so removing a project means `soft_delete_project`,
which is owner/admin and keeps everything. A space that still holds evidence
cannot be deleted by anyone; the refusal names the count.

**Implemented — service-role functions re-check.** `object-storage`,
`capture-session`, `field-workflow` and `project-intake` run with the service
key and therefore *outside* RLS. Each resolves the caller's membership before
touching anything, and guest links are additionally confined to their own
assignment, session or project id.

**Implemented — guest links are scoped, hashed and expiring.** Field assignments
and capture sessions carry a random token stored only as a SHA-256 hash, with a
status and an `expires_at` that are both checked on every call. Passwordless
project access uses a twelve-character code from a 32-symbol alphabet (about
1.2 × 10¹⁸ combinations), also stored only as a hash.

**Implemented — guessing is throttled.** Project creation is limited to 10 per
device per day. Failed code attempts are limited to 20 per device per day;
successful opens are never throttled, so the limit falls only on someone
guessing.

## Tenant and project isolation

**Implemented.** Every row in every domain table carries `organization_id`, and
every policy filters on it. S3 keys are laid out
`organizations/{org}/properties/{property}/…`, so a leaked key names its owner.
Signed URLs are minted per request from a record the caller has already been
authorized for, expire in one hour, and are never stored.

**Implemented.** A deleted file stops resolving: `get_url` returns 410 for
anything soft-deleted or purged, so a signed URL cannot be re-minted for a file
that has left the record.

**Partial — access is organization-wide, not project-wide.** A member of an
organization can read every property in it. That is correct for one builder with
one team and wrong for a customer with two clients who must not see each other.

**Planned — project-scoped access.** `public.property_members` and
`public.can_access_property(uuid)` exist now and are deliberately unused:
with the table empty the function answers exactly what `is_org_member` answers,
so behaviour is unchanged. New policies should be written against
`can_access_property` from here on, and the existing ones migrated to it when
project-scoped roles are switched on.

**Planned.** SSO/SAML, SCIM provisioning, IP allowlisting, session revocation,
and enforced MFA. None of these exist. Supabase Auth supports MFA; it is not
currently required.

## What is written down

Membership changes are recorded by a database trigger, not by the code that
makes them — `member.added`, `member.role_changed`, `member.removed`, each with
the previous role. See EVIDENCE_PROVENANCE.md for the rest of the audit trail.
