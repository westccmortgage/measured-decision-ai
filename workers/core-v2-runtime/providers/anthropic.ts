/* ANTHROPIC MESSAGES, NON-STREAMING.
 *
 * Everything that is true only of this provider is in this file: the path,
 * the version header, the name of the header the key goes in, the fact that
 * the strict shape is asked for as a tool the answer is forced into, the
 * words it stops with, and the names it gives its counts. Nothing else in
 * the repository knows any of it.
 *
 * The answer is not asked for as prose. It is asked for as one tool call
 * whose input is the envelope, and the answer is forced into that tool, so
 * "the model wrote a paragraph before the JSON" is not a failure mode that
 * has to be parsed around.
 *
 * Streaming is off on purpose. A streamed answer is read while it is being
 * written, and an answer read while it is being written cannot be kept
 * verbatim beside the envelope made of it.
 */
import type { HttpRequest, HttpResponse } from "../transport/transport.ts";
import type { ParsedAnswer, ProviderProtocol, ProviderRequestPlan } from "./provider.ts";
import {
  RESULT_ENVELOPE_SCHEMA, RESULT_ENVELOPE_SCHEMA_DESCRIPTION, RESULT_ENVELOPE_SCHEMA_NAME,
  countedUsage, headerRequestId, jsonBody, parseJsonBody,
} from "./provider.ts";

export const ANTHROPIC_PROVIDER_ID = "anthropic";
const MESSAGES_PATH = "/v1/messages";
const VERSION_HEADER = "anthropic-version";
const VERSION = "2023-06-01";
const KEY_HEADER = "x-api-key";

/* The words this provider stops with, and what each one means here. */
const CEILING = "max_tokens";
const REFUSED = "refusal";

export class AnthropicProtocol implements ProviderProtocol {
  readonly providerId = ANTHROPIC_PROVIDER_ID;

  buildRequest(plan: ProviderRequestPlan): HttpRequest {
    /* One system instruction and one question. No prior turn, no assistant
       turn to continue, nothing carried from any other call: the whole
       conversation this provider is ever shown is built here, from this
       packet, and thrown away afterwards. */
    const body = {
      model: plan.model,
      max_tokens: plan.maximumOutputTokens,
      stream: false,
      system: plan.prompt.system,
      messages: [
        { role: "user", content: [{ type: "text", text: plan.prompt.user }] },
      ],
      tools: [
        {
          name: RESULT_ENVELOPE_SCHEMA_NAME,
          description: `${RESULT_ENVELOPE_SCHEMA_DESCRIPTION} ${plan.expectedOutputContract}`,
          input_schema: RESULT_ENVELOPE_SCHEMA,
        },
      ],
      /* Not "you may use this tool": the answer is this tool. */
      tool_choice: { type: "tool", name: RESULT_ENVELOPE_SCHEMA_NAME },
    };
    return {
      method: "POST",
      url: `${trimmed(plan.configuration.baseUrl)}${MESSAGES_PATH}`,
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        [VERSION_HEADER]: VERSION,
        [KEY_HEADER]: plan.apiKey,
      },
      body: jsonBody(body),
      timeoutMs: plan.timeoutMs,
      signal: plan.signal,
    };
  }

  parse(response: HttpResponse): ParsedAnswer {
    const body = parseJsonBody(response);
    const content = Array.isArray(body.content) ? (body.content as Record<string, unknown>[]) : [];
    const stopReason = typeof body.stop_reason === "string" ? body.stop_reason : null;
    const usage = (body.usage ?? {}) as Record<string, unknown>;

    const toolUse = content.find((block) => block && block.type === "tool_use" && block.name === RESULT_ENVELOPE_SCHEMA_NAME);
    const spoken = content
      .filter((block) => block && block.type === "text" && typeof block.text === "string")
      .map((block) => block.text as string)
      .join("");

    /* A tool call is the answer. Text beside it is the partial answer of an
       attempt that ran out of room before it could make the call. */
    const text = toolUse ? JSON.stringify(toolUse.input ?? null) : (spoken.length ? spoken : null);

    return {
      text,
      /* The header is the identifier of the call; the body's id names the
         message. The header is what support can look a call up by, so it is
         preferred, and the message id is what there is when it is absent. */
      requestId: headerRequestId(response) ?? (typeof body.id === "string" ? body.id : null),
      modelReported: typeof body.model === "string" ? body.model : null,
      usage: countedUsage({
        input: usage.input_tokens,
        output: usage.output_tokens,
        cached: usage.cache_read_input_tokens,
        reasoning: usage.thinking_tokens,
      }),
      stopReason,
      refusal: stopReason === REFUSED ? (spoken.length ? spoken : "the provider stopped with a refusal and said nothing further") : null,
      incomplete: stopReason === CEILING,
    };
  }
}

function trimmed(baseUrl: string): string {
  return baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
}
