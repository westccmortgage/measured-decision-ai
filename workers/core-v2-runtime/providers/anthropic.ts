/* ANTHROPIC MESSAGES, NON-STREAMING.
 *
 * Everything that is true only of this provider is in this file: the path,
 * the version header, the name of the header the key goes in, the fact that
 * the strict shape is asked for as a tool the answer is forced into, the
 * shape of an attached image, the words it stops with, and the names it
 * gives its counts. Nothing else in the repository knows any of it.
 *
 * The answer is not asked for as prose. It is asked for as one tool call
 * whose input is the envelope, the tool is declared STRICT so the provider
 * validates the arguments against the schema rather than being asked nicely,
 * and the answer is forced into that tool.
 *
 * Streaming is off on purpose. A streamed answer is read while it is being
 * written, and an answer read while it is being written cannot be kept
 * verbatim beside the envelope made of it.
 *
 * ── PROTOCOL NOTE ──────────────────────────────────────────────────────────
 * Documentation:  https://docs.anthropic.com/en/docs/agents-and-tools/tool-use/implement-tool-use
 * Checked:        2026-09-08
 * Verified with:  the Claude API reference bundled with this workstation
 *                 (the `claude-api` skill, cached 2026-06-24). That reference
 *                 states: "Strict tool use (no beta): set `strict: true` as a
 *                 top-level field on the tool definition (alongside
 *                 name/description/input_schema), NOT on tool_choice. Schema
 *                 must have additionalProperties: false + required."
 *                 It also records that forced tool choice
 *                 (`tool_choice: {type:"tool"|"any"}`) is REJECTED WITH 400 on
 *                 some current models, and that thinking is always on for
 *                 those models. That combination is why this adapter refuses
 *                 before submission rather than quietly dropping strictness or
 *                 quietly dropping the forced choice — see
 *                 configurationProblems() below.
 *                 The URL itself could not be fetched from this environment:
 *                 outbound access to docs.anthropic.com is blocked by the
 *                 network policy here (EGRESS_BLOCKED). What a canary must
 *                 confirm is listed in the runtime README.
 * Usage fields:   input_tokens, output_tokens, cache_creation_input_tokens,
 *                 cache_read_input_tokens. Cache reads and cache writes are
 *                 counted SEPARATELY from input_tokens, and thinking is
 *                 billed inside output_tokens — there is no separate
 *                 reasoning counter. budget/usage.ts encodes exactly that
 *                 and nothing more.
 * ──────────────────────────────────────────────────────────────────────────
 */
import type { HttpRequest, HttpResponse } from "../transport/transport.ts";
import type { ResolvedMaterial } from "../material/material.ts";
import { bytesOf, isTextual } from "../material/material.ts";
import type { ModelCapabilities, ProviderConfiguration } from "../runtime-config.ts";
import type { ParsedAnswer, ProviderProtocol, ProviderRequestPlan } from "./provider.ts";
import { schemaIsClosed,
  RESULT_ENVELOPE_SCHEMA, RESULT_ENVELOPE_SCHEMA_DESCRIPTION, RESULT_ENVELOPE_SCHEMA_NAME,
  headerRequestId, jsonBody, materialHeading, parseJsonBody, rawUsageOf,
} from "./provider.ts";

export const ANTHROPIC_PROVIDER_ID = "anthropic";
const MESSAGES_PATH = "/v1/messages";
const VERSION_HEADER = "anthropic-version";
const VERSION = "2023-06-01";
const KEY_HEADER = "x-api-key";

/* The words this provider stops with, and what each one means here. */
const CEILING = "max_tokens";
const REFUSED = "refusal";

type Block = Record<string, unknown>;

export class AnthropicProtocol implements ProviderProtocol {
  readonly providerId = ANTHROPIC_PROVIDER_ID;
  readonly requestPath = MESSAGES_PATH;

  /* What this adapter is going to put in the request, checked against what
     the operator says the model can do. Every one of these would otherwise
     be a 400 after the request had left, or — worse — a silent downgrade. */
  configurationProblems(configuration: ProviderConfiguration, model: string, material: ResolvedMaterial[]): string[] {
    const can: ModelCapabilities | undefined = configuration.capabilities[model];
    if (!can) return [`${this.providerId} does not say what ${model} can be asked to do`];
    const problems: string[] = [];
    if (!can.forcedToolChoice) {
      problems.push(`${model} does not accept a forced tool choice, and this adapter answers only through one forced tool — asking it anyway would be rejected, and dropping the forced choice would make the answer optional`);
    }
    if (!can.strictSchema) {
      problems.push(`${model} does not accept a strict tool schema, and this adapter declares one — the strictness would have to be silently removed, which would make "the shape was enforced" untrue`);
    }
    if (can.thinking === "always_on" && !can.forcedToolChoice) {
      problems.push(`${model} thinks on every request and cannot be forced to a tool; the two cannot be combined, so this assignment cannot be sent to it`);
    }
    if (!can.images && material.some((m) => !isTextual(m))) {
      problems.push(`this assignment carries material that is not text and ${model} is configured as unable to be sent images`);
    }
    return problems;
  }

  buildRequest(plan: ProviderRequestPlan): HttpRequest {
    /* One system instruction and one question, with the material this
       assignment authorises attached to it. No prior turn, no assistant turn
       to continue, nothing carried from any other call: the whole
       conversation this provider is ever shown is built here, from this
       packet, and thrown away afterwards. */
    const content: Block[] = [{ type: "text", text: plan.prompt.user }];
    for (const item of plan.material) {
      content.push({ type: "text", text: materialHeading(item) });
      if (isTextual(item)) {
        content.push({ type: "text", text: Buffer.from(bytesOf(item)).toString("utf8") });
      } else {
        content.push({
          type: "image",
          source: { type: "base64", media_type: item.mimeType, data: Buffer.from(bytesOf(item)).toString("base64") },
        });
      }
    }

    const body = {
      model: plan.model,
      max_tokens: plan.maximumOutputTokens,
      stream: false,
      system: plan.prompt.system,
      messages: [{ role: "user", content }],
      tools: [
        {
          name: RESULT_ENVELOPE_SCHEMA_NAME,
          description: `${RESULT_ENVELOPE_SCHEMA_DESCRIPTION} ${plan.expectedOutputContract}`,
          input_schema: RESULT_ENVELOPE_SCHEMA,
          /* Top-level on the tool, not on tool_choice: the provider validates
             the arguments against the schema — but only where the schema is
             closed enough for it to. See schemaIsClosed. */
          ...(schemaIsClosed(RESULT_ENVELOPE_SCHEMA) ? { strict: true } : {}),
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
    const content = Array.isArray(body.content) ? (body.content as Block[]) : [];
    const stopReason = typeof body.stop_reason === "string" ? body.stop_reason : null;

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
      rawUsage: rawUsageOf(body.usage),
      stopReason,
      refusal: stopReason === REFUSED ? (spoken.length ? spoken : "the provider stopped with a refusal and said nothing further") : null,
      incomplete: stopReason === CEILING,
    };
  }
}

function trimmed(baseUrl: string): string {
  return baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
}
