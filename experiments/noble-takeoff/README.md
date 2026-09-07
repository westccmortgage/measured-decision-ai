# Noble takeoff comparison — OpenAI · Claude · Gemini

The question: which reader produces the more complete and more correct
structural takeoff from the 4423 Noble set — materials, sizes, quantities,
and where each line came from. The app's saved reading (v3, contract
2026-09-06.1) is the starting point of the comparison; it is never shown
to the other models.

Nothing in this folder runs on its own. Paid calls happen only after the
models and the budget are approved, and only through `run/run-comparison.mjs`
with `--approve-budget`. This folder is not part of the product and is not
merged into `main` while the experiment is open (Netlify publishes the
repository root).

## Files

| File | What it is |
|---|---|
| `tasks.md` | The five control tasks A–E, with what a correct answer must contain |
| `ground-truth.json` | Facts checked against the PDF, each with a status: `verified`, `to_reverify`, `disputed` |
| `prompt.md` | The one request every provider receives, verbatim |
| `result-schema.json` | The one result format every provider must return |
| `scoring.md` + `results/scoring-template.csv` | How the four results are scored, per task |
| `models-and-budget.md` | Model IDs, why, access, file retention, cost estimate, cap |
| `kit/build-kit.mjs` | Builds the identical kit from the source PDF: full sheets + named enlargements with recorded coordinates; checks the edges |
| `run/run-comparison.mjs` | Sends the same kit and prompt to each provider once; records usage and cost; stops on an unknown outcome; never retries a paid call |

## What the session must be given

Checked on 2026-09-07 in a Claude Code on the web container. Three things decide
whether the run can start at all. The first two are set outside this repository
and neither can be fixed from inside a session that already began:

| | Where it is set | State on 2026-09-07 |
|---|---|---|
| `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY` | environment variables on the environment at claude.ai/code, not on a laptop and not in a file here | all three read "not set"; a container keeps the environment it was built with, so keys added later reach only a **new** session |
| Network egress to the three API hosts | the same environment's network settings | `api.anthropic.com` and `generativelanguage.googleapis.com` answer; **`api.openai.com` is refused by the egress policy** (`403 Host not in allowlist`), so the OpenAI reading cannot be taken until that host is allowed |
| Permission to run the two commands | `.claude/settings.json`, committed here | in place: the kit build and the runner, in the exact forms below and with any arguments |

The kit build also needs `poppler-utils`, `qpdf` and Pillow, which the image does
not carry. The image's package lists are stale, so `apt-get update` runs before
the install. All three installs are in the permission rules, and they are step 0
of the order below:

    apt-get update && apt-get install -y poppler-utils qpdf
    pip install pillow

## Order of work

1. Put the source PDF at `experiments/noble-takeoff/source/noble.pdf` (not committed; the folder is git-ignored). Nothing under `source/`, `kit/out/` or `results/` (except the scoring template) is tracked, and `netlify.toml` answers 404 for `/experiments/*` so a future merge of this branch publishes no drawing, no enlargement and no reading.
2. `node kit/build-kit.mjs --pages=24,25,26 --extra=14,22,27,28,29 --dpi=200 --grid=2x3 --overlap=150` — the command the kit was built with; writes `kit/out/` with `manifest.json`. `kit/out/coverage.txt` must read `edges: complete` for every structural page (it does: 7197×4795 px, 6 tiles each).
3. Re-verify `ground-truth.json` against `kit/out/*-full.png` and the enlargements; mark counts on the marked-up copies (`kit/out/marked/`), one member one mark. Anything not settled stays `disputed`.
4. Approve models and budget in `models-and-budget.md`.
5. `node run/run-comparison.mjs --approve-budget=10 --providers=openai,anthropic,google` — one reading per provider. A provider whose host the egress policy refuses is not reachable at all; leave it out of `--providers` and record it as not run, rather than retrying it.
6. Score in `results/scoring-template.csv`, per task, per axis. Place the app's saved reading at `results/app-v3.json` by hand (export of baseline v3); `results/` is git-ignored except the template, so no project reading, no provider answer and no ledger is ever committed.

## Stop rules

- A run whose answer was lost (timeout after the request was accepted) is recorded as `outcome_unknown` and is **not** retried by the script.
- A provider refusal before any reading (HTTP 4xx, "could not fetch") is recorded as `failed`; a person decides whether to retry.
- The script refuses to start when the estimated cost exceeds `--approve-budget`.
