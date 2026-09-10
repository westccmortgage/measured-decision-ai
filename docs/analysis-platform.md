# The analysis platform: your own files, read and checked

**What it is.** A page in the Studio where you create an analysis, upload your
own PDF plans and video, say what you want checked, press Run once, and read
what independent AI readers found — with every finding opening on the page or
the second it came from.

**Where it is.** `/studio/analysis/` on whichever deployment you are using.

---

## The path, in five steps

1. **Create an analysis.** Name it, choose one of three questions — check the
   plans against themselves, compare the video against the plans, or check one
   specific thing — and optionally type the question in your own words. Those
   words are given to every reader verbatim.
2. **Add your files.** What is accepted and the limits are on the screen
   *before* the picker opens. Bytes go straight from your browser to storage,
   resumably; closing the tab costs the chunk in flight and nothing more.
3. **Material is prepared.** Every page of a PDF becomes its own image plus
   whatever text the file carried. A clip becomes a bounded set of frames at
   exact times. Each piece is stored the moment it is made.
4. **Run.** The screen shows the most it could cost before you authorise an
   amount. Nothing reaches a provider before this press.
5. **Read the result.** Three sections — Confirmed, Discrepancy found, Needs a
   check — one place in one section, each card opening on its evidence.

## What is accepted, and the limits

| kind | formats | limit | what becomes an assignment |
| --- | --- | --- | --- |
| PDF plan set | `.pdf`, scanned pages included | 200 MB, 120 pages | every page |
| Ordinary video | `.mp4`, `.mov`, `.webm` — H.264, VP8, VP9 or AV1 | 2 GB, 60 minutes | a frame every two seconds, up to 60 |
| 360° video | the same, and 2:1 equirectangular | 2 GB, 60 minutes | a frame every two seconds, up to 60 |

Up to 12 files and 120 places to read in one analysis. A refusal names what is
wrong with *your* file — its type, its size, its page count, its codec — and
the codec check opens the file rather than trusting the extension.

## Three things this platform will not say

**It will not say a thing is absent from a video.** A clip is sampled, not
watched. Beside every video result is the sentence that says how many moments
were read and how wide the unread gaps between them are. Absent from the
samples is not absent from the clip, and the screen says so in those words.

**It will not call a lone reading confirmed.** Confirmed means two readers in
different independence domains reached the same answer about the same place and
nothing contradicted it. One reading is never enough; two readings from the same
family are not two independent readings; and two readers agreeing that a place
is *unclear* is agreement about not knowing — it goes under Needs a check.

**It will not invent a direction in a 360 clip.** A frame opens the clip at the
second it came from. Which way the camera was pointing is not something this
analysis establishes, so the viewer opens where it opens and the card says the
direction is not set.

## Where the work happens, and what needs a tab open

| | where | needs this page open? |
| --- | --- | --- |
| upload | browser → storage, resumable | no — it resumes |
| preparing pages and frames | **in this browser** | **yes**, and it resumes at the first piece not in the record |
| the analysis itself | the server | no |
| watching it | rebuilt from the record | no |

Preparation is in the browser because rasterising a page needs a canvas and
decoding a clip needs a decoder, and this deployment has neither on the server:
an Edge Function has no canvas and no ffmpeg. Nothing is lost by closing the
tab — every piece is stored and recorded as it is made — but the remaining
pieces wait until you come back and pick the same file again.

## What runs after you close the browser

Each pass of the runner ends by knocking on the next, so a run continues on the
server without this page and without a scheduler. If a container is killed
between two passes the knock is lost; the record still holds a continuation
that is due, and opening the analysis knocks once when it sees one overdue by a
clear minute. Stopping halts new assignments and shows honestly what was
already sent — an answer nobody saw stays *unknown* rather than being called a
failure.

## What the money gate is

`run_requested_at` and `authorized_usd` on the analysis row. The runner reads
both from the record, never from a request and never from an ambient variable.
No press, no spending; and nothing spends past the amount authorised. One
analysis may be authorised at most $25.

## Keys

No provider key is ever sent to a browser. The page holds the signed-in
person's own token and nothing else; keys live in the function environment and
are read in exactly one line of the whole engine.

---

## Deploying it

Two halves, and they deploy differently.

**The page** is static. Netlify publishes the repository, so `/studio/analysis/`
is live on every deploy preview and on the site itself. Nothing to do.

**The database and the functions** deploy through
`.github/workflows/deploy-supabase-function.yml`, which runs on a push to
`main` touching `supabase/**`, or on `workflow_dispatch` against any ref. It
applies pending migrations with `supabase db push` and deploys every function
in `supabase/functions/`. It needs the repository secrets
`SUPABASE_ACCESS_TOKEN` and `SUPABASE_DB_PASSWORD`.

What this platform needs applied and deployed:

| | what it adds |
| --- | --- |
| migration 060 | durable continuations — how a workflow wakes itself |
| migration 061 | a settled continuation can still be cancelled |
| migration 062 | a stop is one write, and a watchdog tick that repairs before it knocks |
| migration 063 | `analysis_runs`, `analysis_files`, `analysis_parts`, `analysis_events`, the per-analysis spend authority, and the trigger that closes an analysis's material once it has been run |
| `core-v2-analysis` | the human door: preflight, estimate, run, status, results, cancel, evidence |
| `core-v2-runner-tick` | the machine door: one tick, and the knock on the next |
| `core-v2-runner` | start, cancel, status for a workflow directly |

**The watchdog stays unarmed.** `core_v2_runner_settings` ships empty with
`armed = false`, no cron job is created, and `core_v2_tick_due_continuations`
posts nowhere and says so. The chain is what continues a run; the watchdog is
the backstop, and arming it is a deliberate act — see `docs/core-v2-runner.md`.

### Checking a deployment without spending anything

```
curl -s -X POST "$SUPABASE_URL/functions/v1/core-v2-analysis" \
  -H "authorization: Bearer $YOUR_OWN_TOKEN" \
  -H "apikey: $PUBLISHABLE_KEY" \
  -H "content-type: application/json" \
  -d '{"op":"preflight"}'
```

`preflight` answers in names, never values: whether the record is reachable and
by which route, which declaration is in use, which provider key VARIABLES are
set, whether the tick door can be reached, and the spend ceiling. It reads no
key and sends nothing anywhere.
