/* OPENAI RESPONSES, NON-STREAMING.
 *
 * Everything that is true only of this provider is in this file: the path,
 * the bearer scheme, the fact that the system instruction is a field rather
 * than a turn, the shape of a strict schema declaration, the two places it
 * writes its counts, and the two ways it says it did not finish.
 *
 * Two fields here are there to be absent rather than present. This provider
 * can be asked to remember a call and to continue one, and neither is ever
 * used: `store` is false so nothing is kept on its side, and there is no
 * previous-call field at all, so every request is the first request. That is
 * what independence means at this layer — two readers of one source must not
 * be one reader who read it twice.
 */
import type { HttpRequest, HttpResponse } from "../transport/transport.ts";
import type { ParsedAnswer, ProviderProtocol, ProviderRequestPlan } from "./provider.ts";
import {
  RESULT_ENVELOPE_SCHEMA, RESULT_ENVELOPE_SCHEMA_DESCRIPTION, RESULT_ENVELOPE_SCHEMA_NAME,
  countedUsage, headerRequestId, jsonBody, parseJsonBody,
} from "./provider.ts";

export const OPENAI_PROVIDER_ID = "openai";
const RESPONSES_PATH = "/v1/responses";
const KEY_HEADER = "authorization";

/* The word it uses when the answer was cut off by the ceiling. */
const CEILING = "max_output_tokens";

export class OpenAiProtocol implements ProviderProtocol {
  readonly providerId = OPENAI_PROVIDER_ID;

  buildRequest(plan: ProviderRequestPlan): HttpRequest {
    const body = {
      model: plan.model,
      max_output_tokens: plan.maximumOutputTokens,
      stream: false,
      /* Nothing about this call is kept on the provider's side, so nothing
         about it can be continued by a later one. */
      store: false,
      instructions: plan.prompt.system,
      input: [
        { role: "user", content: [{ type: "input_text", text: plan.prompt.user }] },
      ],
      text: {
        format: {
          type: "json_schema",
          name: RESULT_ENVELOPE_SCHEMA_NAME,
          description: `${RESULT_ENVELOPE_SCHEMA_DESCRIPTION} ${plan.expectedOutputContract}`,
          strict: true,
          schema: RESULT_ENVELOPE_SCHEMA,
        },
      },
    };
    return {
      method: "POST",
      url: `${trimmed(plan.configuration.baseUrl)}${RESPONSES_PATH}`,
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
    const output = Array.isArray(body.output) ? (body.output as Record<string, unknown>[]) : [];
    const usage = (body.usage ?? {}) as Record<string, unknown>;
    const inputDetails = (usage.input_tokens_details ?? {}) as Record<string, unknown>;
    const outputDetails = (usage.output_tokens_details ?? {}) as Record<string, unknown>;
    const incompleteDetails = (body.incomplete_details ?? null) as Record<string, unknown> | null;
    const status = typeof body.status === "string" ? body.status : null;
    const reason = incompleteDetails && typeof incompleteDetails.reason === "string" ? incompleteDetails.reason : null;

    /* The parts of the answer, flattened: the output is a list of items, each
       of which is a list of parts, and only two kinds of part say anything. */
    const parts: Record<string, unknown>[] = [];
    for (const item of output) {
      const content = Array.isArray(item?.content) ? (item.content as Record<string, unknown>[]) : [];
      for (const part of content) if (part) parts.push(part);
    }
    const spoken = parts
      .filter((part) => part.type === "output_text" && typeof part.text === "string")
      .map((part) => part.text as string)
      .join("");
    const declined = parts
      .filter((part) => part.type === "refusal" && typeof part.refusal === "string")
      .map((part) => part.refusal as string)
      .join(" ");

    return {
      text: spoken.length ? spoken : null,
      requestId: headerRequestId(response) ?? (typeof body.id === "string" ? body.id : null),
      modelReported: typeof body.model === "string" ? body.model : null,
      usage: countedUsage({
        input: usage.input_tokens,
        output: usage.output_tokens,
        cached: inputDetails.cached_tokens,
        reasoning: outputDetails.reasoning_tokens,
      }),
      stopReason: reason ?? status,
      refusal: declined.length ? declined : null,
      incomplete: reason === CEILING,
    };
  }
}

function trimmed(baseUrl: string): string {
  return baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
}
