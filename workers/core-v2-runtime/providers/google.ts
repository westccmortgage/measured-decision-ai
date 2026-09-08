/* GOOGLE GEMINI generateContent, NON-STREAMING.
 *
 * Everything that is true only of this provider is in this file: the model
 * in the path rather than the body, the system instruction as its own turn,
 * the strict shape asked for as a response schema plus a mime type, the
 * upper-case words it stops with, the four names it gives its counts, and
 * the fact that its schema dialect has no opinion called
 * "additionalProperties" and rejects a schema that states one.
 *
 * The key travels in the standard authorization header rather than in a
 * query string or in this provider's own header name. Two reasons, and the
 * second is the one that matters: a key in a url is a key in every log that
 * ever writes a url, and the transport's redaction covers the authorization
 * header by name — a credential this layer sent under a name the redactor
 * does not know would be a credential printed in the event stream.
 */
import type { HttpRequest, HttpResponse } from "../transport/transport.ts";
import type { ParsedAnswer, ProviderProtocol, ProviderRequestPlan } from "./provider.ts";
import {
  RESULT_ENVELOPE_SCHEMA, RESULT_ENVELOPE_SCHEMA_DESCRIPTION,
  countedUsage, headerRequestId, jsonBody, parseJsonBody,
} from "./provider.ts";

export const GOOGLE_PROVIDER_ID = "google";
const MODELS_PATH = "/v1beta/models";
const GENERATE = ":generateContent";
const KEY_HEADER = "authorization";

/* The words it stops with. One is a ceiling; the rest are a refusal. */
const CEILING = "MAX_TOKENS";
const FINISHED = new Set(["STOP"]);

export class GoogleProtocol implements ProviderProtocol {
  readonly providerId = GOOGLE_PROVIDER_ID;

  buildRequest(plan: ProviderRequestPlan): HttpRequest {
    const body = {
      systemInstruction: { role: "system", parts: [{ text: plan.prompt.system }] },
      /* One turn. There is no history field here and none is built: what
         this provider is shown is this packet, and nothing else. */
      contents: [{ role: "user", parts: [{ text: plan.prompt.user }] }],
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
        [KEY_HEADER]: `Bearer ${plan.apiKey}`,
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
    const parts = Array.isArray(content.parts) ? (content.parts as Record<string, unknown>[]) : [];
    const usage = (body.usageMetadata ?? {}) as Record<string, unknown>;
    const feedback = (body.promptFeedback ?? {}) as Record<string, unknown>;

    const finishReason = typeof candidate.finishReason === "string" ? candidate.finishReason : null;
    const blockReason = typeof feedback.blockReason === "string" ? feedback.blockReason : null;
    const spoken = parts
      .filter((part) => typeof part.text === "string")
      .map((part) => part.text as string)
      .join("");

    /* Anything that is neither "it finished" nor "it ran out of room" is
       this provider declining, and what it declined with is its own word. */
    const declined = blockReason
      ?? (finishReason && finishReason !== CEILING && !FINISHED.has(finishReason) ? finishReason : null);

    return {
      text: spoken.length ? spoken : null,
      requestId: (typeof body.responseId === "string" ? body.responseId : null) ?? headerRequestId(response),
      modelReported: typeof body.modelVersion === "string" ? body.modelVersion : null,
      usage: countedUsage({
        input: usage.promptTokenCount,
        output: usage.candidatesTokenCount,
        cached: usage.cachedContentTokenCount,
        reasoning: usage.thoughtsTokenCount,
      }),
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
function forResponseSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(forResponseSchema);
  if (typeof schema !== "object" || schema === null) return schema;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema as Record<string, unknown>)) {
    if (key === "additionalProperties") continue;
    out[key] = forResponseSchema(value);
  }
  return out;
}
