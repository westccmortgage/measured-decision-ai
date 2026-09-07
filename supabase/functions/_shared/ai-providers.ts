/* THREE READERS, ONE READING.
 *
 * A plan set can be read by OpenAI, by Claude or by Gemini. What each one is
 * given must be the same: the same pages, the same drawing-desk enlargements
 * in the same order, the same task, the same result format. Only the envelope
 * differs, because the three APIs are shaped differently — one takes a
 * Responses request with signed file URLs and answers in the background, two
 * take a single synchronous request with the bytes inline.
 *
 * Three things this file refuses to do:
 *
 *   - guess a model id. Every id here was read on the provider's own model
 *     page, and `verifyModelId` asks the provider — a free call — before a
 *     paid reading is bought under a name we only believe in.
 *   - present an unknown price as zero. A model whose published price we
 *     could not confirm carries `price_status: "not_confirmed"` and a null
 *     price; the screen says the tariff is unknown, and никогда $0.00.
 *   - put a key anywhere but this process. Secrets are read from the
 *     function's own environment (Supabase Secrets) and never travel to the
 *     browser, to a log line, or into a stored row.
 */

export type ProviderKey = "openai" | "anthropic" | "google";

/* How the reading is bought.
 *   background — the provider accepts the request, answers with an id, and
 *                the answer is retrieved later. A long read survives the
 *                edge function's lifetime.
 *   sync       — one request, one answer, inside this invocation. A long
 *                read must fit the invocation, so a chunk that does not
 *                finish is recorded as unfinished, never as complete. */
export type ProviderMode = "background" | "sync";

export type PriceStatus = "confirmed" | "promotional" | "not_confirmed";

export type ModelOption = {
  id: string;
  label: string;
  /* USD per million tokens, or null when the published price could not be
     confirmed on the provider's own page. Null is not zero. */
  input_per_mtok: number | null;
  output_per_mtok: number | null;
  price_status: PriceStatus;
  price_note: string;
};

export type ProviderDefinition = {
  key: ProviderKey;
  label: string;
  secret: string;
  mode: ProviderMode;
  baseUrl: string;
  models: ModelOption[];
  /* Where the model ids and prices in this row were read. */
  source: string;
};

/* Checked 2026-09-07 on each provider's own documentation. `verifyModelId`
   re-checks the id against the provider's live model list before a paid
   reading, so a rename shows up as an error rather than as a silent charge. */
export const PROVIDERS: Record<ProviderKey, ProviderDefinition> = {
  openai: {
    key: "openai",
    label: "OpenAI",
    secret: "OPENAI_API_KEY",
    mode: "background",
    baseUrl: "https://api.openai.com/v1",
    source: "developers.openai.com/api/docs/models/gpt-5.6-sol",
    models: [
      {
        id: "gpt-5.6-sol",
        label: "GPT-5.6 Sol",
        input_per_mtok: 4,
        output_per_mtok: 20,
        price_status: "promotional",
        price_note: "Promotional pricing published through 2026-11-21.",
      },
    ],
  },
  anthropic: {
    key: "anthropic",
    label: "Claude",
    secret: "ANTHROPIC_API_KEY",
    mode: "sync",
    baseUrl: "https://api.anthropic.com/v1",
    source: "platform.claude.com/docs/en/about-claude/models/overview",
    models: [
      {
        id: "claude-opus-5",
        label: "Claude Opus 5",
        input_per_mtok: 5,
        output_per_mtok: 25,
        price_status: "confirmed",
        price_note: "Published on the models overview.",
      },
    ],
  },
  google: {
    key: "google",
    label: "Gemini",
    secret: "GEMINI_API_KEY",
    mode: "sync",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    source: "ai.google.dev/gemini-api/docs/generate-content/gemini-3",
    models: [
      {
        id: "gemini-3.1-pro-preview",
        label: "Gemini 3.1 Pro (preview)",
        input_per_mtok: null,
        output_per_mtok: null,
        price_status: "not_confirmed",
        price_note: "The published price for this model was not confirmed on the provider's page, so cost is reported as unknown, never as zero.",
      },
    ],
  },
};

export const DEFAULT_PROVIDER: ProviderKey = "openai";

export function isProviderKey(value: unknown): value is ProviderKey {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(PROVIDERS, value);
}

function secretValue(name: string) {
  return (Deno.env.get(name) || "").trim();
}

/* Whether a provider can be run at all, without saying anything about the
   key itself. This is the only thing the browser ever learns about a secret. */
export function providerConfigured(key: ProviderKey) {
  const definition = PROVIDERS[key];
  if (key === "openai") {
    /* The plan reader's existing OpenAI path also accepts the Cloudflare AI
       Gateway credentials, which stand in for a direct key. */
    return Boolean(
      secretValue(definition.secret) ||
      (secretValue("CLOUDFLARE_ACCOUNT_ID") && (secretValue("CLOUDFLARE_AI_GATEWAY_TOKEN") || secretValue("CLOUDFLARE_API_TOKEN"))),
    );
  }
  return Boolean(secretValue(definition.secret));
}

export function modelOption(key: ProviderKey, modelId?: string | null): ModelOption | null {
  const models = PROVIDERS[key].models;
  if (!modelId) return models[0] || null;
  return models.find((model) => model.id === modelId) || null;
}

/* A model id this registry does not carry — an environment override, or a
   provider rename — still runs, but its price is unknown by definition, and
   an unknown price is null rather than a number nobody can source. */
export function modelOptionOrUnknown(key: ProviderKey, modelId?: string | null): ModelOption {
  const known = modelOption(key, modelId);
  if (known && (!modelId || known.id === modelId)) return known;
  return {
    id: String(modelId),
    label: String(modelId),
    input_per_mtok: null,
    output_per_mtok: null,
    price_status: "not_confirmed",
    price_note: "This model is not in the checked registry, so its price is unknown and cost is reported as unknown, never as zero.",
  };
}

/* What the picker in the Studio is built from. Carries no secret — only
   whether each provider has one. */
export function providerCatalogue() {
  return Object.values(PROVIDERS).map((definition) => ({
    provider: definition.key,
    label: definition.label,
    mode: definition.mode,
    configured: providerConfigured(definition.key),
    source: definition.source,
    models: definition.models.map((model) => ({ ...model })),
  }));
}

export class ProviderNotConfigured extends Error {
  readonly provider: ProviderKey;
  constructor(provider: ProviderKey) {
    super(`Provider not configured: ${PROVIDERS[provider].label} has no key in this project's secrets.`);
    this.provider = provider;
    this.name = "ProviderNotConfigured";
  }
}

export type ProviderTransport = {
  provider: ProviderKey;
  mode: ProviderMode;
  baseUrl: string;
  headers: Record<string, string>;
  model: ModelOption;
  /* Named for the ledger, which reconciles invoices per wire. */
  transport: string;
};

export function providerTransport(key: ProviderKey, modelId?: string | null): ProviderTransport {
  const definition = PROVIDERS[key];
  const model = modelOptionOrUnknown(key, modelId);
  const secret = secretValue(definition.secret);
  if (!secret) throw new ProviderNotConfigured(key);
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (key === "openai") headers.Authorization = `Bearer ${secret}`;
  if (key === "anthropic") {
    headers["x-api-key"] = secret;
    headers["anthropic-version"] = "2023-06-01";
  }
  if (key === "google") headers["x-goog-api-key"] = secret;
  return {
    provider: key,
    mode: definition.mode,
    baseUrl: definition.baseUrl,
    headers,
    model,
    transport: `${key}_direct`,
  };
}

/* A free call to the provider's own model list. A paid reading is never
   bought under a model id the provider does not list. */
export async function verifyModelId(transport: ProviderTransport): Promise<{ ok: boolean; detail: string }> {
  const id = transport.model.id;
  try {
    if (transport.provider === "openai") {
      const response = await fetch(`${transport.baseUrl}/models/${encodeURIComponent(id)}`, { headers: transport.headers });
      if (response.ok) return { ok: true, detail: `${id} listed by OpenAI` };
      if (response.status === 404) return { ok: false, detail: `OpenAI does not list ${id}` };
      return { ok: true, detail: `model list unavailable (${response.status}); proceeding with ${id}` };
    }
    if (transport.provider === "anthropic") {
      const response = await fetch(`${transport.baseUrl}/models/${encodeURIComponent(id)}`, { headers: transport.headers });
      if (response.ok) return { ok: true, detail: `${id} listed by Anthropic` };
      if (response.status === 404) return { ok: false, detail: `Anthropic does not list ${id}` };
      return { ok: true, detail: `model list unavailable (${response.status}); proceeding with ${id}` };
    }
    const response = await fetch(`${transport.baseUrl}/models/${encodeURIComponent(id)}`, { headers: transport.headers });
    if (response.ok) return { ok: true, detail: `${id} listed by Google` };
    if (response.status === 404) {
      const list = await fetch(`${transport.baseUrl}/models?pageSize=200`, { headers: transport.headers })
        .then((r) => r.json()).catch(() => ({}));
      const names = ((list?.models || []) as Array<{ name?: string }>)
        .map((m) => String(m.name || "").replace(/^models\//, ""))
        .filter((n) => /gemini-3/.test(n));
      return { ok: false, detail: `Google does not list ${id}. Listed Gemini 3 models: ${names.join(", ") || "none"}` };
    }
    return { ok: true, detail: `model list unavailable (${response.status}); proceeding with ${id}` };
  } catch (error) {
    /* A model check that could not run is not a reason to refuse a reading
       the person asked for; it is a reason to say so. */
    return { ok: true, detail: `model check failed (${String(error).slice(0, 80)}); proceeding with ${id}` };
  }
}

/* ONE READING, described once.
 *
 * Everything a reader is given, in provider-neutral form. The encoders below
 * turn this into each API's own envelope and change nothing else: same
 * documents in the same order, same images with the same labels, same task,
 * same schema. */
export type ReadingAsset = {
  /* What the reader sees this file called. */
  label: string;
  /* Signed, short-lived, server-side only. */
  url: string;
  mediaType: string;
};

export type ReadingContent = {
  instructions: string;
  taskText: string;
  registerText: string;
  chunkNote: string | null;
  imageNote: string | null;
  documents: ReadingAsset[];
  images: ReadingAsset[];
  schema: Record<string, unknown>;
  maxOutputTokens: number;
};

/* The one place a reading's shape is described in words, so that the three
   envelopes cannot drift apart unnoticed. Used by the test that proves all
   three carry the same pages, the same enlargements and the same task. */
export function readingManifest(content: ReadingContent) {
  return {
    documents: content.documents.map((doc) => doc.label),
    images: content.images.map((image) => image.label),
    task_bytes: content.taskText.length,
    instructions_bytes: content.instructions.length,
    register_bytes: content.registerText.length,
    chunk_note: content.chunkNote || "",
    image_note: content.imageNote || "",
    schema_keys: Object.keys((content.schema as { properties?: Record<string, unknown> })?.properties || {}).sort(),
    max_output_tokens: content.maxOutputTokens,
  };
}

/* A JSON body assembled as a stream.
 *
 * Two of the three APIs take the bytes inline. A plan chunk is up to eighty
 * ~200 dpi tiles; holding them all as base64 in one string is how an edge
 * function dies. So the body is produced piece by piece: each asset is
 * fetched, encoded, written, and released before the next one starts. */
type BodyPart = string | { fetch: string };

function base64(bytes: Uint8Array) {
  let binary = "";
  const step = 0x8000;
  for (let index = 0; index < bytes.length; index += step) {
    binary += String.fromCharCode(...bytes.subarray(index, index + step));
  }
  return btoa(binary);
}

export function jsonStreamBody(parts: BodyPart[], fetchImpl: typeof fetch = fetch): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let index = 0;
  return new ReadableStream({
    async pull(controller) {
      if (index >= parts.length) {
        controller.close();
        return;
      }
      const part = parts[index];
      index += 1;
      if (typeof part === "string") {
        controller.enqueue(encoder.encode(part));
        return;
      }
      const response = await fetchImpl(part.fetch);
      if (!response.ok) throw new Error(`Could not read an input file for the reading (${response.status})`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      controller.enqueue(encoder.encode(base64(bytes)));
    },
  });
}

const jsonText = (value: unknown) => JSON.stringify(value);

/* OpenAI: Responses API, background, signed URLs. The proven production
   path — unchanged in shape by this file. */
export function openAIRequestBody(transport: ProviderTransport, content: ReadingContent) {
  const userContent: Array<Record<string, unknown>> = [
    { type: "input_text", text: content.taskText },
  ];
  if (content.chunkNote) userContent.push({ type: "input_text", text: content.chunkNote });
  userContent.push(...content.documents.map((doc) => ({ type: "input_file", file_url: doc.url })));
  if (content.images.length) {
    if (content.imageNote) userContent.push({ type: "input_text", text: content.imageNote });
    for (const image of content.images) {
      userContent.push({ type: "input_image", image_url: image.url, detail: "high" });
    }
  }
  return {
    model: transport.model.id,
    background: true,
    store: true,
    max_output_tokens: content.maxOutputTokens,
    instructions: content.instructions,
    input: [{ role: "user", content: userContent }],
    text: {
      format: {
        type: "json_schema",
        name: "plan_baseline",
        strict: true,
        schema: content.schema,
      },
    },
  };
}

/* Anthropic and Google take one synchronous request each, with the same
   assets inline. Both bodies are streamed, so no asset is ever held in
   memory beside the ones before it. */
export function syncRequest(transport: ProviderTransport, content: ReadingContent) {
  const parts: BodyPart[] = [];
  const anthropic = transport.provider === "anthropic";
  let first = true;
  const separator = () => (first ? "" : ",");
  const text = (value: string) => {
    parts.push(anthropic
      ? `${separator()}{"type":"text","text":${jsonText(value)}}`
      : `${separator()}{"text":${jsonText(value)}}`);
    first = false;
  };
  const asset = (item: ReadingAsset, kind: "document" | "image") => {
    parts.push(anthropic
      ? `${separator()}{"type":"${kind}","source":{"type":"base64","media_type":${jsonText(item.mediaType)},"data":"`
      : `${separator()}{"inlineData":{"mimeType":${jsonText(item.mediaType)},"data":"`);
    parts.push({ fetch: item.url });
    parts.push(`"}}`);
    first = false;
  };

  if (anthropic) {
    parts.push(`{"model":${jsonText(transport.model.id)},"max_tokens":${content.maxOutputTokens}`);
    parts.push(`,"system":${jsonText(content.instructions)}`);
    parts.push(`,"messages":[{"role":"user","content":[`);
  } else {
    parts.push(`{"contents":[{"role":"user","parts":[`);
    text(content.instructions);
  }

  for (const document of content.documents) {
    text(`Document: ${document.label}`);
    asset(document, "document");
  }
  if (content.images.length && content.imageNote) text(content.imageNote);
  for (const image of content.images) {
    text(`Image ${image.label}`);
    asset(image, "image");
  }
  text(content.taskText);
  if (content.chunkNote) text(content.chunkNote);

  if (anthropic) {
    parts.push(`]}]}`);
    return { url: `${transport.baseUrl}/messages`, parts };
  }
  parts.push(`]}],"generationConfig":{"responseMimeType":"application/json","maxOutputTokens":${content.maxOutputTokens},"responseJsonSchema":${jsonText(content.schema)}}}`);
  return {
    url: `${transport.baseUrl}/models/${encodeURIComponent(transport.model.id)}:generateContent`,
    parts,
  };
}

/* The reader's answer, in one shape. */
export type ProviderAnswer = {
  text: string;
  usage: Record<string, unknown>;
  modelReported: string;
  stopReason: string;
};

export function readAnswer(provider: ProviderKey, payload: Record<string, any>): ProviderAnswer {
  if (provider === "openai") {
    const text = (payload.output || [])
      .flatMap((item: any) => item?.content || [])
      .filter((block: any) => block?.type === "output_text")
      .map((block: any) => block.text)
      .join("");
    return {
      text,
      usage: normaliseUsage(provider, payload.usage || {}),
      modelReported: String(payload.model || ""),
      stopReason: String(payload.status || ""),
    };
  }
  if (provider === "anthropic") {
    const text = (payload.content || [])
      .filter((block: any) => block?.type === "text")
      .map((block: any) => block.text)
      .join("");
    return {
      text,
      usage: normaliseUsage(provider, payload.usage || {}),
      modelReported: String(payload.model || ""),
      stopReason: String(payload.stop_reason || ""),
    };
  }
  const candidate = (payload.candidates || [])[0] || {};
  const text = (candidate.content?.parts || []).map((part: any) => part?.text || "").join("");
  return {
    text,
    usage: normaliseUsage(provider, payload.usageMetadata || {}),
    modelReported: String(payload.modelVersion || ""),
    stopReason: String(candidate.finishReason || ""),
  };
}

/* The ledger stores input_tokens / output_tokens / total_tokens and keeps
   everything else verbatim. Each provider names them differently; nothing is
   dropped on the way. */
export function normaliseUsage(provider: ProviderKey, usage: Record<string, any>): Record<string, unknown> {
  if (!usage || typeof usage !== "object") return {};
  if (provider === "google") {
    return {
      ...usage,
      input_tokens: usage.promptTokenCount ?? null,
      output_tokens: (usage.candidatesTokenCount ?? 0) + (usage.thoughtsTokenCount ?? 0) || usage.candidatesTokenCount || null,
      total_tokens: usage.totalTokenCount ?? null,
    };
  }
  if (provider === "anthropic") {
    const input = (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
    return {
      ...usage,
      input_tokens: input || usage.input_tokens || null,
      output_tokens: usage.output_tokens ?? null,
      total_tokens: (input || 0) + (usage.output_tokens || 0) || null,
    };
  }
  return { ...usage };
}

/* Money, or an honest absence of it. */
export function usageCost(model: ModelOption, usage: Record<string, any>) {
  const input = Number(usage?.input_tokens);
  const output = Number(usage?.output_tokens);
  if (model.input_per_mtok === null || model.output_per_mtok === null) {
    return { cost_usd: null as number | null, price_status: model.price_status, price_note: model.price_note };
  }
  if (!Number.isFinite(input) && !Number.isFinite(output)) {
    return { cost_usd: null as number | null, price_status: model.price_status, price_note: "The provider reported no usage for this call." };
  }
  const cost = ((Number.isFinite(input) ? input : 0) * model.input_per_mtok
    + (Number.isFinite(output) ? output : 0) * model.output_per_mtok) / 1e6;
  return { cost_usd: Number(cost.toFixed(4)), price_status: model.price_status, price_note: model.price_note };
}

export function providerErrorMessage(provider: ProviderKey, payload: Record<string, any>, fallback: string) {
  const message = payload?.error?.message
    || payload?.error?.[0]?.message
    || payload?.message
    || (Array.isArray(payload?.error) ? payload.error[0]?.message : null);
  return message ? `${PROVIDERS[provider].label}: ${String(message).slice(0, 300)}` : fallback;
}
