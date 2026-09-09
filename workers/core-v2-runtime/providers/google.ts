/* GOOGLE GEMINI generateContent, NON-STREAMING.
 *
 * Everything that is true only of this provider is in this file: the model
 * in the path rather than the body, the system instruction as its own turn,
 * the strict shape asked for as a response schema plus a mime type, the
 * upper-case words it stops with, the four names it gives its counts, and
 * the fact that its schema dialect has no opinion called
 * "additionalProperties" and rejects a schema that states one.
 *
 * The key travels in this provider's OWN documented header, x-goog-api-key,
 * and never in the url. It used to go in an Authorization: Bearer header
 * here, which was wrong twice over: an API key is not an OAuth token, and
 * sending one as if it were makes two different kinds of credential
 * indistinguishable in code that has to treat them differently. A key in a
 * query string would be worse again — a key in a url is a key in every log
 * that ever writes a url — so it is never put there. The transport's
 * redaction knows x-goog-api-key by name; a credential sent under a name the
 * redactor did not know would be a credential printed in the event stream.
 *
 * If OAuth bearer authentication is ever wanted for this provider it must be
 * a separately typed authentication mode with its own configuration, not a
 * key wearing a bearer's clothes.
 *
 * ── PROTOCOL NOTE ──────────────────────────────────────────────────────────
 * Documentation:  https://ai.google.dev/gemini-api/docs/api-key
 * Checked:        2026-09-08
 * Status:         NOT VERIFIED AGAINST THE LIVE DOCUMENT. Outbound access to
 *                 ai.google.dev is blocked by this environment's network
 *                 policy (EGRESS_BLOCKED), and no offline copy ships here.
 *                 The header name x-goog-api-key is the one named in the
 *                 correction this change implements, and it is the one this
 *                 adapter sends. What a canary must confirm: that the header
 *                 is accepted, that no key appears in any url this adapter
 *                 builds (it cannot — the url is built from baseUrl, path and
 *                 model only), and the usage semantics below.
 * Usage fields:   usageMetadata.promptTokenCount,
 *                 usageMetadata.candidatesTokenCount,
 *                 usageMetadata.cachedContentTokenCount,
 *                 usageMetadata.thoughtsTokenCount, totalTokenCount.
 *                 budget/usage.ts encodes: cached content is counted INSIDE
 *                 promptTokenCount (so it is subtracted before the uncached
 *                 rate is applied), and thoughts are counted SEPARATELY from
 *                 candidatesTokenCount (so they are added, not subtracted).
 *                 That pairing is the single most important thing for a
 *                 canary to check against a real invoice.
 * ──────────────────────────────────────────────────────────────────────────
 */
import type { HttpRequest, HttpResponse } from "../transport/transport.ts";
import type { ResolvedMaterial } from "../material/material.ts";
import { bytesOf, isTextual } from "../material/material.ts";
import type { ModelCapabilities, ProviderConfiguration } from "../runtime-config.ts";
import type { ParsedAnswer, ProviderProtocol, ProviderRequestPlan } from "./provider.ts";
import { envelopeText,
  RESULT_ENVELOPE_SCHEMA, RESULT_ENVELOPE_SCHEMA_DESCRIPTION,
  headerRequestId, jsonBody, materialHeading, parseJsonBody, rawUsageOf,
} from "./provider.ts";

export const GOOGLE_PROVIDER_ID = "google";
const MODELS_PATH = "/v1beta/models";
const GENERATE = ":generateContent";
const KEY_HEADER = "x-goog-api-key";

/* The words it stops with. One is a ceiling; the rest are a refusal. */
const CEILING = "MAX_TOKENS";
const FINISHED = new Set(["STOP"]);

export class GoogleProtocol implements ProviderProtocol {
  readonly providerId = GOOGLE_PROVIDER_ID;
  readonly requestPath = MODELS_PATH;

  configurationProblems(configuration: ProviderConfiguration, model: string, material: ResolvedMaterial[]): string[] {
    const can: ModelCapabilities | undefined = configuration.capabilities[model];
    if (!can) return [`${this.providerId} does not say what ${model} can be asked to do`];
    const problems: string[] = [];
    if (!can.strictSchema) {
      problems.push(`${model} does not accept a strict response schema, and this adapter answers only through one — the strictness would have to be silently dropped, which would make "the shape was enforced" untrue`);
    }
    if (!can.images && material.some((m) => !isTextual(m))) {
      problems.push(`this assignment carries material that is not text and ${model} is configured as unable to be sent images`);
    }
    return problems;
  }

  buildRequest(plan: ProviderRequestPlan): HttpRequest {
    const parts: Record<string, unknown>[] = [{ text: plan.prompt.user }];
    for (const item of plan.material) {
      parts.push({ text: materialHeading(item) });
      if (isTextual(item)) {
        parts.push({ text: Buffer.from(bytesOf(item)).toString("utf8") });
      } else {
        parts.push({ inlineData: { mimeType: item.mimeType, data: Buffer.from(bytesOf(item)).toString("base64") } });
      }
    }
    const body = {
      systemInstruction: { role: "system", parts: [{ text: plan.prompt.system }] },
      /* One turn. There is no history field here and none is built: what
         this provider is shown is this packet, and nothing else. */
      contents: [{ role: "user", parts }],
      generationConfig: {
        responseMimeType: "application/json",
        responseSchema: {
          ...(forResponseSchema(RESULT_ENVELOPE_SCHEMA) as Record<string, unknown>),
          description: `${RESULT_ENVELOPE_SCHEMA_DESCRIPTION} ${plan.expectedOutputContract}`,
        },
        maxOutputTokens: plan.maximumOutputTokens,
        candidateCount: 1,
      },
    };
    return {
      method: "POST",
      /* The model is part of the address here, which is why the address is
         built per request rather than once per provider. */
      url: `${trimmed(plan.configuration.baseUrl)}${MODELS_PATH}/${encodeURIComponent(plan.model)}${GENERATE}`,
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        [KEY_HEADER]: plan.apiKey,
      },
      body: jsonBody(body),
      timeoutMs: plan.timeoutMs,
      signal: plan.signal,
    };
  }

  parse(response: HttpResponse): ParsedAnswer {
    const body = parseJsonBody(response);
    const candidates = Array.isArray(body.candidates) ? (body.candidates as Record<string, unknown>[]) : [];
    const candidate = (candidates[0] ?? {}) as Record<string, unknown>;
    const content = (candidate.content ?? {}) as Record<string, unknown>;
    const answered = Array.isArray(content.parts) ? (content.parts as Record<string, unknown>[]) : [];
    const feedback = (body.promptFeedback ?? {}) as Record<string, unknown>;

    const finishReason = typeof candidate.finishReason === "string" ? candidate.finishReason : null;
    const blockReason = typeof feedback.blockReason === "string" ? feedback.blockReason : null;
    const spoken = answered
      .filter((part) => typeof part.text === "string")
      .map((part) => part.text as string)
      .join("");

    /* Anything that is neither "it finished" nor "it ran out of room" is
       this provider declining, and what it declined with is its own word. */
    const declined = blockReason
      ?? (finishReason && finishReason !== CEILING && !FINISHED.has(finishReason) ? finishReason : null);

    return {
      text: spoken.length ? envelopeText(spoken) : null,
      requestId: (typeof body.responseId === "string" ? body.responseId : null) ?? headerRequestId(response),
      modelReported: typeof body.modelVersion === "string" ? body.modelVersion : null,
      rawUsage: rawUsageOf(body.usageMetadata),
      stopReason: blockReason ?? finishReason,
      refusal: declined ? `the provider stopped with ${declined}` : null,
      incomplete: finishReason === CEILING,
    };
  }
}

function trimmed(baseUrl: string): string {
  return baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
}

/* The same schema, minus the one keyword this provider's dialect refuses. A
   translation, not a relaxation: the fields required are still required, and
   the strictness that is lost is enforced again by the kernel's validator,
   which never trusted the shape anyway. */
/* THE SHARED SCHEMA, SPOKEN IN THIS PROVIDER'S DIALECT.
 *
 * `responseSchema` here is not JSON Schema: it is a protobuf message, and the
 * translation from one to the other is this adapter's job — which is the
 * whole reason an adapter exists. Two differences, both of which this
 * provider states plainly rather than ignoring.
 *
 *   · `additionalProperties` is not a field of that message. Dropped.
 *   · `type` is a single enum, not a list, so a JSON Schema union like
 *     `["number", "null"]` is rejected with, verbatim:
 *
 *       Invalid JSON payload received. Unknown name "type" at
 *       'generation_config.response_schema.properties[1].value.items
 *        .properties[4].value.properties[1].value':
 *       Proto field is not repeating, cannot start list.
 *
 *     — 400 in 83 ms, which is what both of this canary's Google calls got.
 *     The message says nullable with a flag beside the type, so that is what
 *     it is given: `{type:"number", nullable:true}`. Nothing about what the
 *     kernel asked for changes; only how it is spelled.
 *
 * A union of two real types with no null in it is not a nullable field and is
 * not translatable, so it is passed through unchanged and this provider
 * refuses it — better a 400 that names the field than a schema that quietly
 * means something else. */
function forResponseSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(forResponseSchema);
  if (typeof schema !== "object" || schema === null) return schema;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema as Record<string, unknown>)) {
    if (key === "additionalProperties") continue;
    if (key === "type" && Array.isArray(value)) {
      const named = value.filter((t): t is string => typeof t === "string");
      const real = named.filter((t) => t !== "null");
      if (real.length === 1 && named.length !== real.length) {
        out.type = real[0];
        out.nullable = true;
        continue;
      }
      if (real.length === 1) { out.type = real[0]; continue; }
    }
    out[key] = forResponseSchema(value);
  }
  return out;
}
