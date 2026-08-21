# Third-party services

Every outside service in the platform and what it can reach. Internal
documentation; kept current because the first question any enterprise customer
asks is "who else touches our data?"

| Service | Role | Can access | Cannot access |
|---|---|---|---|
| **Netlify** | Static hosting, CDN, TLS | Public site files. Request logs: IP, user agent, path. | No evidence, no database, no credentials. The site ships no secret. |
| **Supabase** | Postgres, Auth, Edge Functions | Everything in the system of record: projects, spaces, evidence *metadata*, AI findings, decisions, audit trail, user emails and auth identities. Holds every server-side secret. | The evidence files themselves, which are in S3. |
| **AWS S3** (`us-east-2`) | Evidence storage | Every evidence file: photos, video, 360 captures, documents. | No database, no user identities. |
| **AWS EC2** (g4dn, on demand) | 360 stitching | One capture at a time while it works, plus the service role key it is launched with. | Nothing durable. The instance is destroyed after each run. |
| **OpenAI** | Evidence and plan analysis | The images and video frames sent for one analysis, plus the instructions. Requests are sent with `store: false`. | The database, the bucket, user identities, anything not in that request. |
| **Resend** | Field assignment email | Recipient email address, the assignment link, the message body. | Everything else. |

## Notes that matter

**OpenAI sees evidence content.** This is the one service that is shown customer
material rather than metadata about it. `store: false` is set on every request,
which asks OpenAI not to retain the payload. Any customer contract with a
data-residency or no-third-party-AI clause conflicts with this and must be
raised before signing, not after.

**Supabase holds the keys to everything else.** The AWS credentials, the OpenAI
key and the Resend key are all Edge Function secrets. Compromise of the Supabase
project is compromise of the platform.

**The GPU worker is the widest short-lived exposure.** It is launched with the
service role key in its user-data and can read and write the whole database for
the ~20 minutes it runs. It is started by hand, stops itself, and holds a
three-hour hard deadline. Narrowing it to a scoped key is worthwhile and is not
done.

**Not used.** No analytics, no error-tracking service, no session replay, no
customer chat widget, no tag manager, no advertising pixel. Nothing on the site
reports a visitor to a third party. This is worth keeping true; each of those
would be a new row in this table and a new answer owed to a customer.

## Data location

Supabase project region and the S3 bucket are both US. No data-residency
commitment has been made to anyone, and none should be made without checking
both consoles first.

## Review

Re-read this page whenever a dependency is added, and before answering any
customer security questionnaire. A service that appears in the code and not in
this table is a documentation bug.
