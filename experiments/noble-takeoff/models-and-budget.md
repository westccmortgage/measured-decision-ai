# Models, access, retention, budget

Checked on 2026-09-07 against official documentation where the network allowed it. The proxy in this environment blocks `platform.openai.com`, `developers.openai.com`, `ai.google.dev` and `docs.cloud.google.com`; those facts come from search excerpts of the official pages and are marked **(search)**. Confirm each one against the provider's page before approving.

| | OpenAI | Anthropic | Google |
|---|---|---|---|
| Proposed model | `gpt-5.6-sol` (search: official model page) | `claude-opus-5` (official models overview) | `gemini-3.1-pro` (search: Google Cloud model page names this ID; several listings show `gemini-3.1-pro-preview` — confirm with the models list call before the run) |
| Why | The app's current reader; the reading it made is the starting point, so the same model reading the same kit isolates the effect of the kit and prompt | Anthropic's recommended default; 1M context; high-resolution image tier (2576 px long edge, 4784 visual tokens per image), which is what dense drawings need | Google's most capable reasoning model; PDF and image input; `media_resolution` per image lets the kit's enlargements go in at high resolution |
| Context / max output | 1,050,000 / 128,000 (search) | 1,000,000 / 128,000 | 1M (search) |
| Inputs | text, image; PDF via `input_file` in Responses (the app already sends PDFs this way in production) | text, image (JPEG/PNG/GIF/WebP), PDF (32 MB and 600 pages per request; each page as text + image) | text, image, PDF up to 50 MB or 1000 pages (search) |
| Price per 1M tokens | $4 in / $20 out, promotional through 2026-11-21 (search) | $5 in / $25 out | $2 in / $12 out under 200k prompt tokens; $4 / $18 above (third-party listings only — official page blocked; verify) |
| Image tokens | patch-based; the calculator on the docs site gives the exact count; high detail resizes, original keeps dimensions (search) | ⌈w/28⌉ × ⌈h/28⌉ visual tokens, capped at 4784 per image after downscaling to 2576 px long edge | 258 tokens per 768×768 tile; `media_resolution` high raises the per-image budget (search) |
| Access needed | API key with Responses API; the app's existing key can be used from the run script | API key (`ANTHROPIC_API_KEY`); no beta header needed for PDFs or images | API key for the Gemini Developer API (`GEMINI_API_KEY`) |
| Files: retention | Abuse-monitoring logs kept up to 30 days by default; Files API uploads persist until deleted or `expires_after`; ZDR by approval (search) | Files API: persist until deleted or `expires_in_seconds` (1 h – 90 d); images sent inline are ephemeral; PDF processing is ZDR-eligible except Covered Models (Opus 5 is not one) | Files API uploads auto-delete after 48 hours (search) |
| How the kit is sent | inline `input_image` (base64 data URLs) and the PDF as `input_file` base64 — nothing left in a file store | inline base64 `image` and `document` blocks — nothing left in a file store | inline `inlineData` — nothing left in a file store |

Sending everything inline keeps the retention posture the same for all three: no uploaded files remain with any provider after the call, only the provider's own request logging (OpenAI up to 30 days by default; Anthropic per its retention policy; Google per its API terms).

## Cost estimate (estimate, not a quote)

Kit per provider: 3 structural pages as PDF + 3 full-page images + 12 enlargements (2×2 per sheet) + up to 4 architectural pages, and the prompt (~4k tokens). Output ~15k tokens per provider.

| Provider | Input tokens (est.) | Input $ | Output tokens (est.) | Output $ | Per reading (est.) |
|---|---|---|---|---|---|
| OpenAI gpt-5.6-sol | ~90k (v3 measured ~5k tokens per 200-dpi image at high detail) | $0.36 | 15k | $0.30 | ~$0.70 |
| Anthropic claude-opus-5 | ~75k (15 images × ≤4784 + PDF pages) | $0.38 | 15k | $0.38 | ~$0.80 |
| Google gemini-3.1-pro | ~80k (258 tokens per 768-px tile, ~20 tiles per enlargement) | $0.16 | 15k | $0.18 | ~$0.35 |

Total estimate for three readings: about $2. **Proposed cap for the whole first experiment: $10**, enforced by the script (`--approve-budget=10`): it estimates before sending and refuses above the cap; after each call it records the provider's reported usage and the price table above.

Recorded per run: model, request bytes, usage (input/cached/output), computed cost, wall time, outcome (`succeeded` / `failed` / `outcome_unknown`). No automatic retry on any outcome.
