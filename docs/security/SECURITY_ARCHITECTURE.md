# Security architecture

## What the system is

Four pieces, three of them hosted by someone else.

| Piece | What it is | What it holds |
|---|---|---|
| **Web** | Static HTML/CSS/JS on Netlify, built from `main` | No customer data. Ships a Supabase *publishable* key, which is designed to be public and grants nothing on its own. |
| **Supabase** | Postgres + Auth + Edge Functions (Deno) | The system of record: projects, spaces, evidence rows, AI jobs, findings, decisions, the audit trail. |
| **AWS S3** | `measured-decision-production-808454010303`, us-east-2 | Every evidence file. Private bucket, no public read. |
| **EC2 g4dn** | Started by hand, stops itself | Nothing durable. Downloads a capture, stitches it, uploads the result, shuts down. |

## Trust boundaries

There are three, and the same rule holds at each: **the browser is never trusted
and never enforces anything.**

**1. Browser → Postgres (PostgREST).** Direct, with the user's own JWT. Every
table has row-level security on, so what a query can return is decided by the
database from `auth.uid()`, not by what the query asked for. A tampered client
gets the same rows as an honest one.

**2. Browser → Edge Function.** Used where a request needs powers the browser
must not have: signing S3 URLs, completing a multipart upload, deleting, calling
OpenAI. These run with the service key, which bypasses row-level security — so
each one re-checks membership itself before acting
(`membership()` in `supabase/functions/object-storage/index.ts`). Anything
holding the service key must assume RLS is not protecting it.

**3. Guest links → Edge Function.** Field workers, capture guests and
passwordless project users have no account. They present a token or a project
code; the function hashes it (SHA-256) and looks up the hash — the raw value is
never stored. Their reach is bounded to the one assignment, session or project
the token names, and re-checked on every operation.

## Where secrets live

- **AWS keys, service role key, OpenAI key, Resend key**: Supabase Edge Function
  secrets. Never in the repository, never in the browser bundle.
- **Supabase publishable key**: in `studio/config.js` on purpose. It identifies
  the project and authorises nothing by itself.
- **GPU worker**: reads its configuration from `/opt/mdai/worker.env`, written at
  boot from the EC2 user-data field. The service role key is pasted there at
  launch and is never traced into the machine's log
  (`workers/insta360/user-data.sh`).
- The repository is scanned for accidentally committed credentials; the current
  scan is clean. See DATA_RETENTION.md for the one historical exposure and what
  was done about it.

## Transport and storage

**Implemented.** TLS everywhere: Netlify, Supabase and S3 are HTTPS-only, and
`Strict-Transport-Security` is set on every response (`netlify.toml`).
Encryption at rest is provided by the platforms — Supabase encrypts Postgres
volumes, S3 encrypts objects server-side by default. Neither is something this
codebase implements; both are things it relies on and should be re-verified
when a customer asks.

**Implemented.** Response headers: `X-Content-Type-Options`, `Referrer-Policy`,
`X-Frame-Options`, `Permissions-Policy`, and a partial Content-Security-Policy
(`frame-ancestors`, `base-uri`, `form-action`, `object-src`).

**Planned.** A full CSP with `script-src` and `connect-src`. The four directives
shipped cannot break a working page. A script/connect policy can, and the upload
path, the 360 viewer and the vendored Supabase fallback all need to be exercised
against it before it goes live. Known origins to allow when that work happens:
`https://hbqlhplgqwuesrovbiye.supabase.co` (plus `wss:`), the S3 bucket host,
`https://cdn.jsdelivr.net`, `https://fonts.googleapis.com`,
`https://fonts.gstatic.com`, and `blob:`/`data:` for media.

## Errors and logs

**Implemented.** A message we wrote is shown to the caller. Anything else — a
Postgres error, an SDK failure — is replaced with a neutral sentence and an
eight-character reference, and the real error is logged against that reference
(`supabase/functions/_shared/safe-error.ts`). Constraint names, column names and
internal identifiers no longer reach a browser.

**Implemented.** No credential is written to a log by any component. The GPU
worker filters its own log a second time on the way out, as a backstop.

**Partial.** Logs are whatever Supabase and Netlify retain by default. There is
no central log store, no alerting, and no defined retention. See
INCIDENT_RESPONSE.md.

## Deliberate non-goals for now

- No compliance dashboard, and no security controls in the everyday UI.
- No customer-facing audit viewer yet; the trail is complete before it is shown.
- No self-service key management, SSO, or SCIM. These belong to the enterprise
  phase, not to a product that is still proving its evidence model.
