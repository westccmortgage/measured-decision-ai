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
 *
 * ── PROTOCOL NOTE ──────────────────────────────────────────────────────────
 * Documentation:  https://platform.openai.com/docs/api-reference/responses
 * Checked:        2026-09-08
 * Status:         NOT VERIFIED AGAINST THE LIVE DOCUMENT. Outbound access to
 *                 the documentation host is blocked by this environment's
 *                 network policy, and no offline copy of it ships with this
 *                 workstation. What is encoded here is this repository's
 *                 reading of the Responses API and it is written so that a
 *                 canary can check it field by field:
 *                   · request:  model, max_output_tokens, stream:false,
 *                               store:false, instructions (the system
 *                               instruction is a field, not a turn), input
 *                               as a list of messages whose content parts are
 *                               input_text / input_image, and
 *                               text.format = {type:"json_schema", name,
 *                               schema, strict:true}.
 *                   · response: output[] items of type "message", whose
 *                               content parts are "output_text" (the answer)
 *                               or "refusal" (the provider declining);
 *                               status "incomplete" with
 *                               incomplete_details.reason
 *                               "max_output_tokens" for the ceiling; id for
 *                               the response and the x-request-id header for
 *                               the call; model for what answered.
 *                   · usage:    input_tokens (INCLUDING
 *                               input_tokens_details.cached_tokens) and
 *                               output_tokens (INCLUDING
 *                               output_tokens_details.reasoning_tokens). Those
 *                               two "including"s are the whole reason
 *                               budget/usage.ts subtracts before it prices.
 *                 A field that turns out to be named differently is a parse
 *                 failure with the raw answer preserved, never a wrong number.
 * Deliberate:     `text.format` carries no `description`. The contract the
 *                 role expects is said in the instructions instead, because a
 *                 field that is not in the documented shape is a field that
 *                 might be rejected.
 * ──────────────────────────────────────────────────────────────────────────
 */
import type { HttpRequest, HttpResponse } from "../transport/transport.ts";
import type { ResolvedMaterial } from "../material/material.ts";
import { bytesOf, isTextual } from "../material/material.ts";
import type { ModelCapabilities, ProviderConfiguration } from "../runtime-config.ts";
import type { ParsedAnswer, ProviderProtocol, ProviderRequestPlan } from "./provider.ts";
import {
  RESULT_ENVELOPE_SCHEMA, RESULT_ENVELOPE_SCHEMA_DESCRIPTION, RESULT_ENVELOPE_SCHEMA_NAME,
  headerRequestId, jsonBody, materialHeading, parseJsonBody, rawUsageOf,
} from "./provider.ts";

export const OPENAI_PROVIDER_ID = "openai";
const RESPONSES_PATH = "/v1/responses";
const KEY_HEADER = "authorization";

/* The word it uses when the answer was cut off by the ceiling. */
const CEILING = "max_output_tokens";

export class OpenAiProtocol implements ProviderProtocol {
  readonly providerId = OPENAI_PROVIDER_ID;

  configurationProblems(configuration: ProviderConfiguration, model: string, material: ResolvedMaterial[]): string[] {
    const can: ModelCapabilities | undefined = configuration.capabilities[model];
    if (!can) return [`${this.providerId} does not say what ${model} can be asked to do`];
    const problems: string[] = [];
    if (!can.strictSchema) {
      problems.push(`${model} does not accept a strict output schema, and this adapter declares one — the strictness would have to be silently removed, which would make "the shape was enforced" untrue`);
    }
    if (!can.images && material.some((m) => !isTextual(m))) {
      problems.push(`this assignment carries material that is not text and ${model} is configured as unable to be sent images`);
    }
    return problems;
  }

  buildRequest(plan: ProviderRequestPlan): HttpRequest {
    /* One turn, with the material this assignment authorises attached to it. */
    const content: Record<string, unknown>[] = [{ type: "input_text", text: plan.prompt.user }];
    for (const item of plan.material) {
      content.push({ type: "input_text", text: materialHeading(item) });
      if (isTextual(item)) {
        content.push({ type: "input_text", text: Buffer.from(bytesOf(item)).toString("utf8") });
      } else {
        content.push({
          type: "input_image",
          image_url: `data:${item.mimeType};base64,${Buffer.from(bytesOf(item)).toString("base64")}`,
        });
      }
    }

    const body = {
      model: plan.model,
      max_output_tokens: plan.maximumOutputTokens,
      stream: false,
      /* Nothing about this call is kept on the provider's side, so nothing
         about it can be continued by a later one. */
      store: false,
      instructions: `${plan.prompt.system}\n\n${RESULT_ENVELOPE_SCHEMA_DESCRIPTION} ${plan.expectedOutputContract}`,
      input: [{ role: "user", content }],
      text: {
        format: {
          type: "json_schema",
          name: RESULT_ENVELOPE_SCHEMA_NAME,
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
      rawUsage: rawUsageOf(body.usage),
      stopReason: reason ?? status,
      refusal: declined.length ? declined : null,
      incomplete: reason === CEILING,
    };
  }
}

function trimmed(baseUrl: string): string {
  return baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
}
