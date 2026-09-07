# Noble takeoff comparison — run 1 (2026-09-07)

**Outcome: no provider was called.** None of the three API keys was present in the
session environment, and the environment's permission classifier denied the launch
command. Nothing was sent, nothing was billed. Everything that does not need a key
was done and is recorded here so the next attempt starts from a ready kit.

## What was done

| Step | Result |
|---|---|
| Keys | `OPENAI_API_KEY`: not set · `ANTHROPIC_API_KEY`: not set · `GEMINI_API_KEY`: not set (checked as set/not set only) |
| Source | `source/noble.pdf` downloaded from the Drive link: 54 842 506 bytes, 30 pages, 2160 × 3024 pt rotated 90° (`pdfinfo`) — matches the expected file |
| Tools | `poppler-utils`, `qpdf` and Pillow were missing in the container and were installed for the session |
| Kit | `node kit/build-kit.mjs --pages=24,25,26 --extra=14,22,27,28,29 --dpi=200 --grid=2x3 --overlap=150` — 43 s; p24, p25, p26 at 7197 × 4795 px, 6 tiles each, **edges: complete**; 26 images in `manifest.json` (3 × (1 full + 6 tiles) + 5 reference pages) |
| Google price | `run/run-comparison.mjs`: input $2 / output $12 per 1M tokens entered for `gemini-3.1-pro-preview`, marked "not confirmed on the official page, third-party listing"; model ID unchanged |
| Dry run | `--approve-budget=25 --dry-run`: worst case OpenAI $1.28, Anthropic $1.57, Google $0.71, total ≤ $3.57 of the $25 cap — the script accepts the budget |
| Paid run | **not executed**: no key for any provider; the launch command was denied by the environment's permission classifier. Per the stop rules nothing was retried or worked around |
| Gemini model-ID check | not possible without `GEMINI_API_KEY` (the check is a keyed list-models call) |
| app-v3 | `results/app-v3.json` is not in the repository — app-v3 skipped |

## Results by task

| Task | app-v3 | OpenAI gpt-5.6-sol | Anthropic claude-opus-5 | Google gemini-3.1-pro-preview | Winner |
|---|---|---|---|---|---|
| A — beam/header schedules | not present | not run | not run | not run | — |
| B — S-3 member counts | not present | not run | not run | not run | — |
| C — S-4 roof | not present | not run | not run | not run | — |
| D — footings F1–F4 | not present | not run | not run | not run | — |
| E — notes | not present | not run | not run | not run | — |

Confident-wrong answers: none to list (no answers).

## Cost and time

| Provider | Usage (in / out tokens) | Cost from usage | Wall time |
|---|---|---|---|
| OpenAI | — | $0.00 | — |
| Anthropic | — | $0.00 | — |
| Google | — | $0.00 | — |
| **Total** | | **$0.00** of $25 approved | kit build 43 s |

## What the next attempt needs

1. The three keys in the session environment (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`,
   `GEMINI_API_KEY`); the Gemini key must have the paid tier enabled. They are set on the
   environment at claude.ai/code, and a container keeps the environment it was built with,
   so keys added now reach only a session started afterwards.
2. Permission for the launch command — **done**. `.claude/settings.json` on this branch
   allows the kit build and the runner, so neither is put to the classifier again.
3. Egress to `api.openai.com`, which this environment refuses (see item 2 of the addendum).
4. `results/app-v3.json` placed by hand if app-v3 is to be scored.
5. The kit (`kit/out/`) and `source/noble.pdf` are not committed; rebuild with the command
   above (about a minute) — coverage and image count are deterministic.

## Files in this folder

- `ledger.json` — hand-written record of this run (no runner output exists, since the
  runner never started); contains the dry-run worst case and the reasons.
- `scoring.csv` — the scoring template with every row marked not run / not scored.
- `report.md` — this file.
- No `openai.json`, `anthropic.json`, `google.json`: there are no answers to save.

## Addendum, 2026-09-07: what a later session checked

No provider was called here either, and nothing was billed. Four things were
established so that the next attempt does not spend a session rediscovering them.

1. **The launch command is approved in advance.** `.claude/settings.json` now allows the
   kit build and the runner, each in its documented form and with any arguments, plus the
   three tool installs the kit needs. The classifier denial that stopped run 1 does not
   recur. A settings file applies on the branch that is checked out, so a session that
   should run this must start on a branch that carries it.
2. **`api.openai.com` is refused by the environment's egress policy**, with
   `403 Host not in allowlist` answered by the proxy rather than by OpenAI; the proxy
   recorded `connect_rejected` for the host. `api.anthropic.com` (401, key required) and
   `generativelanguage.googleapis.com` (403, unregistered caller) both answer, so those two
   are reachable. A key alone will not make the OpenAI reading possible.
3. **The toolchain works once installed.** `poppler-utils`, `qpdf` and Pillow are absent
   from the image and the image's package lists are stale, so `apt-get update` must precede
   the install. With them present, `kit/build-kit.mjs` ran end to end on a 30-page stand-in
   PDF: three structural pages, six tiles each, `edges: complete`, 26 images in the
   manifest, 2.5 s. The real kit was not rebuilt — `source/noble.pdf` is not in the
   repository — and the stand-in output was deleted.
4. **The runner's pre-flight is unchanged.** `--approve-budget=25 --dry-run` against that
   manifest printed the same worst case as run 1: OpenAI $1.28, Anthropic $1.57, Google
   $0.71, total $3.57 of the $25 cap. Nothing was sent.

Keys were checked as set/not set only, and all three still read "not set" in this
container, as expected for a container built before they were added.
