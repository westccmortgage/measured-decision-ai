# Cloudflare AI Gateway for OpenAI

Measured Decision can route its existing OpenAI Responses API traffic through a dedicated Cloudflare AI Gateway without changing the evidence or plan-analysis contracts.

## Why provider-native routing

`plan-analyze` creates an OpenAI background response and later retrieves that same response by ID. The Cloudflare provider-native OpenAI endpoint preserves the OpenAI Responses API path and wire format, so the existing background polling flow can stay intact.

When the Cloudflare variables below are present, the shared transport changes the base URL from direct OpenAI to:

`https://gateway.ai.cloudflare.com/v1/<account-id>/<gateway-id>/openai`

The request carries Cloudflare gateway authentication and deliberately does **not** carry an OpenAI `Authorization` header. That allows Cloudflare-managed credentials / Unified Billing to be used. If the Cloudflare variables are absent, the worker continues to use `OPENAI_API_KEY` directly.

## Production setup

Use a dedicated gateway for Measured Decision, for example `measured-decision`.

1. In Cloudflare, create or select the gateway and load AI Gateway Unified Billing credits.
2. Do not keep an OpenAI BYOK key under the gateway's `default` alias if the goal is Unified Billing. Cloudflare credential precedence uses a default stored provider key before Unified Billing.
3. Create a Cloudflare API token suitable for authenticated AI Gateway use. Keep it server-side only.
4. Set these Supabase Edge Function secrets:

```text
CLOUDFLARE_ACCOUNT_ID=<cloudflare account id>
CLOUDFLARE_AI_GATEWAY_ID=measured-decision
CLOUDFLARE_AI_GATEWAY_TOKEN=<server-only cloudflare token>
OPENAI_MODEL=gpt-5.6-sol
OPENAI_PLAN_MODEL=gpt-5.6-sol
```

`CLOUDFLARE_API_TOKEN` is accepted as a compatibility alias for `CLOUDFLARE_AI_GATEWAY_TOKEN`, but the dedicated variable is preferred so the credential's purpose is explicit.

`OPENAI_API_KEY` may remain configured during rollout. The code prefers Cloudflare only when the Cloudflare account ID and token are both present; otherwise direct OpenAI remains the fallback. A partial Cloudflare configuration fails closed rather than silently falling back.

## Privacy behavior

Every Cloudflare-routed request sends:

```text
cf-aig-collect-log-payload: false
```

This keeps Gateway request/response bodies out of AI Gateway logs while preserving operational metadata such as provider, model, status, token counts, duration, and cost where Cloudflare reports it.

`spatial-analyze` also requests Cloudflare Zero Data Retention per request and continues to send `store: false` to OpenAI.

`plan-analyze` intentionally does **not** request ZDR. It currently uses `background: true` and `store: true` because Studio polls the provider response by ID after the first Edge Function request returns. The Gateway payload log is still disabled. Do not enable gateway-wide ZDR for this dedicated gateway until the background plan workflow has been migrated to a completion/webhook design that no longer needs provider-side response retrieval.

## Rollout check

After the secrets are set and the two Edge Functions are deployed:

1. Run one small spatial evidence job. The API response and the `analysis.completed` audit event should report `transport: cloudflare_ai_gateway`.
2. Confirm the request appears in the Cloudflare gateway with payload logging disabled.
3. Confirm the charge is against AI Gateway Unified Billing rather than the direct OpenAI account.
4. Run one small plan set and verify `start -> provider_queued/reading_documents -> completed` still works through background polling.
5. Only then move normal production volume through the gateway.

## Current model

Both workers default to `gpt-5.6-sol` unless the environment overrides the model. On Cloudflare's model catalog this is the OpenAI model `openai/gpt-5.6-sol`; the provider-native OpenAI endpoint itself uses the native model name `gpt-5.6-sol` in the request body.
