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
 * It knows nothing about the words. It unpacks each provider's request into
 * the parts that were actually sent — the text, and the material with its
 * media type and its bytes — and hands those to whoever is answering. There
 * is no task id in what it passes on, and no way to look an answer up: an
 * answer has to be made out of the request or not at all.
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

/* One part of a request, as it was actually sent. */
export type LocalPart =
  | { kind: "text"; text: string }
  | { kind: "image"; mimeType: string; bytes: Uint8Array };

/* The question, as it went out: the standing rules, and the parts of the
   turn in the order the adapter put them there. No identifier of the
   assignment is passed separately — whatever is in the parts is all there
   is, which is the same position a provider is in. */
export type LocalQuestion = {
  providerId: string;
  model: string;
  system: string;
  parts: LocalPart[];
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
  /* Every part of the turn, unpacked from this provider's own multimodal
     shape into one vocabulary. */
  partsOf(body: Body): LocalPart[];
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
    partsOf: (body) => list(list(body.messages)[0]?.content).map((block) => {
      if (block.type === "image") {
        const source = (block.source ?? {}) as Record<string, unknown>;
        return { kind: "image" as const, mimeType: text(source.media_type), bytes: new Uint8Array(Buffer.from(text(source.data), "base64")) };
      }
      return { kind: "text" as const, text: text(block.text) };
    }),
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
    partsOf: (body) => list(list(body.input)[0]?.content).map((part) => {
      if (part.type === "input_image") {
        const url = text(part.image_url);
        const m = url.match(/^data:([^;]+);base64,(.*)$/);
        return { kind: "image" as const, mimeType: m ? m[1] : "", bytes: new Uint8Array(Buffer.from(m ? m[2] : "", "base64")) };
      }
      return { kind: "text" as const, text: text(part.text) };
    }),
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
    partsOf: (body) => list(list(body.contents)[0]?.parts).map((part) => {
      if (part.inlineData) {
        const inline = part.inlineData as Record<string, unknown>;
        return { kind: "image" as const, mimeType: text(inline.mimeType), bytes: new Uint8Array(Buffer.from(text(inline.data), "base64")) };
      }
      return { kind: "text" as const, text: text(part.text) };
    }),
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
    const question: LocalQuestion = {
      providerId: shape.providerId,
      model: shape.modelOf(body, request.url),
      system: shape.systemOf(body),
      parts: shape.partsOf(body),
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
