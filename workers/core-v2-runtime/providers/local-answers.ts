/* THE THREE SHAPES, ANSWERED FROM THIS PROCESS.
 *
 * A provider adapter can only be exercised by something that answers the way
 * that provider answers. This is that something: one transport that takes a
 * request an adapter built, works out from the address which provider's wire
 * it is on, asks the caller what the answer should be, and wraps it in that
 * provider's own response shape — a tool call for one, an output item for
 * another, a candidate part for the third, each with the counts written
 * where that provider writes them.
 *
 * It lives beside the adapters because it is provider-specific by nature,
 * and because this directory is the only place in the repository where a
 * provider's name and format are allowed to be written down. It is not a
 * mock of an adapter: the adapter under it is the real one, and everything
 * it does — building the request, reading the answer, reporting the facts,
 * classifying a failure — is the real thing. Only the wire is local.
 *
 * The one thing it knows about the words is that the prompt compiler writes
 * `taskId: <id>` on a line of its own. That is the seam that lets a caller
 * answer the question actually asked rather than a fixed string.
 *
 * Nothing here is a provider's real behaviour, and nothing here is evidence
 * about one. It answers what the caller says to answer.
 */
import type { HttpRequest, HttpResponse, HttpTransport } from "../transport/transport.ts";
import { ANTHROPIC_PROVIDER_ID } from "./anthropic.ts";
import { GOOGLE_PROVIDER_ID } from "./google.ts";
import { OPENAI_PROVIDER_ID } from "./openai.ts";
import { RESULT_ENVELOPE_SCHEMA_NAME } from "./provider.ts";

/* What an answer reports it used. Fixed, so what a ledger settles is a
   number a caller can name rather than one it has to read back and trust. */
export type LocalUsage = {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  reasoningTokens: number;
};

export const LOCAL_USAGE: LocalUsage = { inputTokens: 1000, outputTokens: 200, cachedInputTokens: 0, reasoningTokens: 0 };

/* The question, as it went out. `taskId` is null when the words carry none,
   which is itself something a caller may want to refuse. */
export type LocalQuestion = {
  providerId: string;
  taskId: string | null;
  model: string;
  system: string;
  user: string;
};

/* What a stand-in gives back: the object to answer with, or an Error to
   throw instead of answering — a socket that died, a request that never
   arrived. Returning an Error is how a caller writes "and this one never
   came back". */
export type LocalAnswer = (question: LocalQuestion) => unknown;

type Body = Record<string, unknown>;

type Shape = {
  providerId: string;
  /* What tells this provider's request from another's. Addresses are the
     operator's; paths are the provider's. */
  path: string;
  systemOf(body: Body): string;
  userOf(body: Body): string;
  modelOf(body: Body, url: string): string;
  answer(envelope: unknown, mark: string, model: string, usage: LocalUsage): HttpResponse;
};

const list = (value: unknown): Record<string, unknown>[] => (Array.isArray(value) ? value as Record<string, unknown>[] : []);
const text = (value: unknown): string => (typeof value === "string" ? value : "");

function json(body: unknown, headers: Record<string, string> = {}): HttpResponse {
  return { status: 200, headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) };
}

const SHAPES: Shape[] = [
  {
    providerId: ANTHROPIC_PROVIDER_ID,
    path: "/v1/messages",
    systemOf: (body) => text(body.system),
    userOf: (body) => text((list(list(body.messages)[0]?.content)[0] ?? {}).text),
    modelOf: (body) => text(body.model),
    answer: (envelope, mark, model, usage) => json({
      id: `msg_${mark}`, type: "message", role: "assistant", model, stop_reason: "tool_use", stop_sequence: null,
      content: [{ type: "tool_use", id: `toolu_${mark}`, name: RESULT_ENVELOPE_SCHEMA_NAME, input: envelope }],
      usage: {
        input_tokens: usage.inputTokens, output_tokens: usage.outputTokens,
        cache_read_input_tokens: usage.cachedInputTokens, thinking_tokens: usage.reasoningTokens,
      },
    }, { "request-id": `req_${mark}` }),
  },
  {
    providerId: OPENAI_PROVIDER_ID,
    path: "/v1/responses",
    systemOf: (body) => text(body.instructions),
    userOf: (body) => text((list(list(body.input)[0]?.content)[0] ?? {}).text),
    modelOf: (body) => text(body.model),
    answer: (envelope, mark, model, usage) => json({
      id: `resp_${mark}`, object: "response", model, status: "completed", incomplete_details: null,
      output: [{
        id: `msg_${mark}`, type: "message", role: "assistant", status: "completed",
        content: [{ type: "output_text", text: JSON.stringify(envelope) }],
      }],
      usage: {
        input_tokens: usage.inputTokens, output_tokens: usage.outputTokens,
        total_tokens: usage.inputTokens + usage.outputTokens,
        input_tokens_details: { cached_tokens: usage.cachedInputTokens },
        output_tokens_details: { reasoning_tokens: usage.reasoningTokens },
      },
    }, { "x-request-id": `req_${mark}` }),
  },
  {
    providerId: GOOGLE_PROVIDER_ID,
    path: ":generateContent",
    systemOf: (body) => text(list((body.systemInstruction as Body | undefined)?.parts)[0]?.text),
    userOf: (body) => text(list(list(body.contents)[0]?.parts)[0]?.text),
    /* This one puts the model in the address rather than the body. */
    modelOf: (_body, url) => decodeURIComponent(url.split("/models/")[1]?.split(":")[0] ?? ""),
    answer: (envelope, mark, model, usage) => json({
      responseId: `rsp_${mark}`, modelVersion: model,
      candidates: [{ index: 0, finishReason: "STOP", content: { role: "model", parts: [{ text: JSON.stringify(envelope) }] } }],
      usageMetadata: {
        promptTokenCount: usage.inputTokens, candidatesTokenCount: usage.outputTokens,
        cachedContentTokenCount: usage.cachedInputTokens, thoughtsTokenCount: usage.reasoningTokens,
        totalTokenCount: usage.inputTokens + usage.outputTokens,
      },
    }),
  },
];

export function shapeFor(url: string): { providerId: string } | null {
  const shape = SHAPES.find((s) => url.includes(s.path));
  return shape ? { providerId: shape.providerId } : null;
}

/* What a local answer says answered it. Never the model that was asked for:
   a record that cannot tell "what I requested" from "what replied" cannot
   settle an argument about either. */
export function locallyReportedModel(model: string): string {
  return `${model}-local`;
}

export type LocalProviderTransportOptions = {
  answer: LocalAnswer;
  usage?: LocalUsage;
  /* Where a caller can watch what went out without keeping the requests. */
  onRequest?: (question: LocalQuestion) => void;
};

export class LocalProviderTransport implements HttpTransport {
  readonly name = "local-provider-shaped";
  /* Every request, exactly as an adapter built it. What a caller asserts
     against when the question is what actually went on the wire. */
  readonly sent: HttpRequest[] = [];
  readonly questions: LocalQuestion[] = [];
  private options: LocalProviderTransportOptions;
  private answered = 0;

  constructor(options: LocalProviderTransportOptions) {
    this.options = options;
  }

  answers(): number { return this.answered; }

  async send(request: HttpRequest): Promise<HttpResponse> {
    this.sent.push(request);
    const shape = SHAPES.find((s) => request.url.includes(s.path));
    if (!shape) throw new Error(`core-v2-runtime: nothing local answers ${request.method} ${request.url}`);
    let body: Body;
    try {
      body = JSON.parse(request.body) as Body;
    } catch (error) {
      throw new Error(`core-v2-runtime: a request that is not JSON reached the local stand-in: ${(error as Error).message}`);
    }
    const user = shape.userOf(body);
    const question: LocalQuestion = {
      providerId: shape.providerId,
      taskId: (user.match(/^taskId: (\S+)$/m) ?? [])[1] ?? null,
      model: shape.modelOf(body, request.url),
      system: shape.systemOf(body),
      user,
    };
    this.questions.push(question);
    if (this.options.onRequest) this.options.onRequest(question);
    const answer = this.options.answer(question);
    /* A caller that hands back an error is saying this one does not come
       back. Throwing it is what a transport does with such a thing. */
    if (answer instanceof Error) throw answer;
    this.answered++;
    return shape.answer(answer, `${shape.providerId}-${this.answered}`, locallyReportedModel(question.model), this.options.usage ?? LOCAL_USAGE);
  }
}
