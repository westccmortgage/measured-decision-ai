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

## Order of work

1. Put the source PDF at `experiments/noble-takeoff/source/noble.pdf` (not committed; the folder is git-ignored).
2. `node kit/build-kit.mjs` — writes `kit/out/` with `manifest.json`. Look at `kit/out/coverage.txt`: every page must read `edges: complete`.
3. Re-verify `ground-truth.json` against `kit/out/*-full.png` and the enlargements; mark counts on the marked-up copies (`kit/out/marked/`), one member one mark. Anything not settled stays `disputed`.
4. Approve models and budget in `models-and-budget.md`.
5. `node run/run-comparison.mjs --approve-budget=10 --providers=openai,anthropic,google` — one reading per provider.
6. Score in `results/scoring-template.csv`, per task, per axis. Fill `results/app-v3.json` from the saved baseline (already exported at the session's scratchpad as `noble-v3.json`; copy it in by hand).

## Stop rules

- A run whose answer was lost (timeout after the request was accepted) is recorded as `outcome_unknown` and is **not** retried by the script.
- A provider refusal before any reading (HTTP 4xx, "could not fetch") is recorded as `failed`; a person decides whether to retry.
- The script refuses to start when the estimated cost exceeds `--approve-budget`.
