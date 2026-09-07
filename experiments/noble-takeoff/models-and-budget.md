# Models, access, retention, budget

Checked 2026-09-07. This environment's proxy blocks `platform.openai.com`, `developers.openai.com`, `ai.google.dev` and `docs.cloud.google.com`; Anthropic's documentation was read directly. For the other two providers only search excerpts of the official pages were readable. Every cell carries its status: **confirmed** (read on the official page), **excerpt** (official page seen only as a search excerpt), **own use** (proven by this product's production calls), **not confirmed**. Nothing in this table is assumed.

## Model IDs and prices

| | OpenAI | Anthropic | Google |
|---|---|---|---|
| API model ID | `gpt-5.6-sol` — excerpt (official model page exists under that name); own use (the app's production reader) | `claude-opus-5` — confirmed | `gemini-3.1-pro-preview` — excerpt (an official Gemini API page names this ID and says it has no free tier); the Google Cloud model page is titled "Gemini 3.1 Pro". **Which string the Gemini Developer API accepts is not confirmed**; the runner lists models (a free call) and refuses to proceed if the configured ID is absent |
| Context / max output | 1,050,000 / 128,000 — excerpt | 1,000,000 / 128,000 — confirmed | not confirmed |
| Inputs | text + image — excerpt; PDF via `input_file` in the Responses API — own use | text, image, PDF (32 MB and 600 pages per request) — confirmed | text, image, PDF — excerpt; page limits not confirmed |
| Price per 1M tokens (input / output) | $4 / $20, promotional through 2026-11-21 — excerpt | $5 / $25 — confirmed | **not confirmed** (only third-party listings were readable; they are not used here) |
| Image token rule | not confirmed for this model; this product's own v3 run measured ≈ 4.7k input tokens per 200-dpi tile at `detail: high` — own use | ⌈w/28⌉ × ⌈h/28⌉ per image, downscaled to 2576 px long edge, ≤ 4784 tokens per image — confirmed | 258 tokens per 768×768 tile; `media_resolution` on Gemini 3 raises the per-image budget — excerpt; the exact count at `MEDIA_RESOLUTION_HIGH` is not confirmed |
| Access needed | an API key with access to the Responses API and to this model (the app's key qualifies) | `ANTHROPIC_API_KEY` | `GEMINI_API_KEY` with paid tier enabled (the model has no free tier) |
| Rate limits / availability | not confirmed for the key that will be used | not confirmed for the key that will be used | not confirmed |

## Reachability from the session that runs this

Measured on 2026-09-07 from a Claude Code on the web container, one request per
host with no key, reading only the status code. This is the environment's egress
policy, not a provider decision, and it is separate from whether a key is set.

| Host | Result | Meaning |
|---|---|---|
| `api.anthropic.com` | 401, "x-api-key header is required" | reachable; the request arrived at Anthropic |
| `generativelanguage.googleapis.com` | 403, "Method doesn't allow unregistered callers" | reachable; the request arrived at Google |
| `api.openai.com` | 403, "Host not in allowlist: api.openai.com" — answered by the egress proxy, which recorded `connect_rejected` for the host | **not reachable**; nothing left the container |

So the OpenAI reading cannot be taken from this environment even with a valid
key. Either `api.openai.com` is added to the environment's network egress
settings at claude.ai/code, or OpenAI is left out of `--providers` and the
comparison records it as not run for that reason. The runner does not work
around a refused host and should not be made to.

## Retention — what "inline" does and does not mean

Sending pages and images inline (base64 in the request body) is the **transport**: it means the runner creates no object in a provider's file store, so there is nothing to delete afterwards. It is **not** a guarantee that the provider holds no copy. Each provider still logs the request and response under its own policy:

| | OpenAI | Anthropic | Google |
|---|---|---|---|
| Request/response logging | abuse-monitoring logs kept up to 30 days by default; Zero Data Retention is by approval — excerpt. The runner sends `store: false` so the response is not kept as a retrievable object — excerpt (documented parameter) | files uploaded through the Files API persist until deleted or `expires_in_seconds`; PDF processing is ZDR-eligible (Opus 5 is not a Covered Model) — confirmed. The standard retention period for request logs was not read in this session — not confirmed | prompts and outputs retained 55 days for abuse monitoring on the paid tier; an in-memory cache with a 24-hour TTL; ZDR by request — excerpt |
| File store | none used | none used | none used |

Conclusion: after the run, no file object remains with any provider, but each provider may hold the request content for its logging window (30 days OpenAI; not confirmed Anthropic; 55 days Google). If that is not acceptable for the Noble set, the run needs a ZDR arrangement with each provider first.

## Budget — recomputed from the real kit, worst case

The kit is built (`kit/out/manifest.json`): S-2, S-3, S-4 at 200 dpi (7197×4795 px each), each as one full page plus six enlargements (2×3 grid, 150 px overlap; every page edge covered, `coverage.txt`), plus five reference pages as full pages (A-210 p14, S-1 p22, S-5 p27, S-6 p28, S-7 p29): **26 images and 8 PDF pages** per provider.

Worst case per provider = every image at its maximum token count + 8 PDF pages at 3,000 + 6,000 prompt, and the **hard output cap** every request carries (32,000 tokens). The runner recomputes this from the manifest before sending (`--dry-run` shows it).

| Provider | Input tokens (worst) | Input $ | Output cap | Output $ (worst) | Worst case |
|---|---|---|---|---|---|
| OpenAI gpt-5.6-sol | 26 × 5,000 + 24,000 + 6,000 = 160,000 | $0.64 | 32,000 | $0.64 | **$1.28** |
| Anthropic claude-opus-5 | 26 × 4,784 + 24,000 + 6,000 = 154,384 | $0.77 | 32,000 | $0.80 | **$1.57** |
| Google gemini-3.1-pro-preview | 26 × 5,200 + 30,000 = 165,200 | not confirmed | 32,000 | not confirmed | **not computable** until the price is confirmed on the official page |

Confirmed part of the worst case: **$2.85** (OpenAI + Anthropic; `run-comparison.mjs --dry-run` prints the same). Proposed cap for the whole first experiment: **$10**.

## How the cap is enforced

1. The runner refuses to start without `--approve-budget=<usd>`.
2. Before any call it computes the worst case per provider from the real manifest and the output cap, and refuses if the sum exceeds the approved amount. A provider without a confirmed price cannot be estimated and is refused until a person enters the price in the table.
3. Every request carries a hard output limit (`max_output_tokens` / `max_tokens` / `maxOutputTokens` = 32,000).
4. Providers run one after another. Before each send the runner checks `spent so far (from reported usage) + next worst case ≤ cap`; otherwise it stops.
5. A lost answer (`outcome_unknown`) stops the run. Nothing is retried automatically.
6. Usage reported by the provider is written to `results/ledger.json` with the price table used; the sum is the experiment's cost of record.
