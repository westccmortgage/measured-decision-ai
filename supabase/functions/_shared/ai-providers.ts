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
  /* How many drawing-desk enlargements one reading may carry to this
     provider. Not a taste — each number is the provider's own rule at our
     tile resolution, and it is recorded with every reading so two readings
     taken under different budgets are never called equal. */
  imageBudget: number;
  /* Where the model ids and prices in this row were read. */
  source: string;
};

/* Above this many images in one request, Claude applies a stricter per-image
   size limit (2000 px per side) than our ~200 dpi tiles satisfy. A reading
   that would cross it is refused before it is bought, not silently degraded. */
export const MANY_IMAGE_THRESHOLD = 20;

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
    imageBudget: 80,
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
    imageBudget: MANY_IMAGE_THRESHOLD,
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
    imageBudget: MANY_IMAGE_THRESHOLD,
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
    image_budget: definition.imageBudget,
    source: definition.source,
    models: definition.models.map((model) => ({ ...model })),
  }));
}

/* How many enlargements this reader may be given in one reading. */
export function readingImageBudget(key: ProviderKey) {
  return PROVIDERS[key].imageBudget;
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

/* NOTHING IS CARRIED THAT CAN BE POINTED AT.
 *
 * A plan chunk is a 50 MB PDF plus up to eighty ~200 dpi tiles. Encoding
 * that into a request body costs memory and CPU an edge function does not
 * have, so neither synchronous reader is given bytes:
 *
 *   Claude takes a signed URL per document and per image and fetches them
 *   itself, so the request body stays a few kilobytes.
 *   Gemini will not fetch a URL, and its inline limit is 20 MB — under one
 *   chunk — so each asset is uploaded to Google's Files API first, streamed
 *   through one at a time, and deleted again when the reading is over.
 *
 * "Inline" was never a retention promise. What limits retention here is that
 * the signed URLs expire and the uploaded copies are deleted; Google keeps an
 * undeleted file for 48 hours on its own schedule.
 */

const GOOGLE_UPLOAD_BASE = "https://generativelanguage.googleapis.com/upload/v1beta";

export type UploadedAsset = {
  /* The signed URL this copy was made from, which is how a request part finds it. */
  url: string;
  fileUri: string;
  mimeType: string;
  /* Google's own name for the stored file — "files/xxxx" — used to delete it. */
  name: string;
};

/* One asset, uploaded and released from memory before the next one starts. */
export async function uploadToGoogle(
  transport: ProviderTransport,
  asset: ReadingAsset,
  fetchImpl: typeof fetch = fetch,
): Promise<UploadedAsset> {
  const source = await fetchImpl(asset.url);
  if (!source.ok) throw new Error(`Could not read an input file for the reading (${source.status})`);
  const bytes = new Uint8Array(await source.arrayBuffer());
  const start = await fetchImpl(`${GOOGLE_UPLOAD_BASE}/files`, {
    method: "POST",
    headers: {
      ...transport.headers,
      "X-Goog-Upload-Protocol": "resumable",
      "X-Goog-Upload-Command": "start",
      "X-Goog-Upload-Header-Content-Length": String(bytes.byteLength),
      "X-Goog-Upload-Header-Content-Type": asset.mediaType,
    },
    body: JSON.stringify({ file: { display_name: asset.label } }),
  });
  const uploadUrl = start.headers.get("x-goog-upload-url");
  if (!start.ok || !uploadUrl) {
    const payload = await start.json().catch(() => ({}));
    throw new Error(providerErrorMessage("google", payload, `Gemini would not accept an upload for ${asset.label} (${start.status})`));
  }
  const finish = await fetchImpl(uploadUrl, {
    method: "POST",
    headers: {
      "Content-Length": String(bytes.byteLength),
      "X-Goog-Upload-Offset": "0",
      "X-Goog-Upload-Command": "upload, finalize",
    },
    body: bytes,
  });
  const payload = await finish.json().catch(() => ({}));
  const file = (payload as Record<string, any>)?.file || payload;
  if (!finish.ok || !file?.uri) {
    throw new Error(providerErrorMessage("google", payload as Record<string, any>, `Gemini did not store ${asset.label} (${finish.status})`));
  }
  return {
    url: asset.url,
    fileUri: String(file.uri),
    mimeType: asset.mediaType,
    name: String(file.name || ""),
  };
}

/* A stored PDF is not readable the instant it lands. Reading it before it is
   ACTIVE is how a reading fails for a reason that has nothing to do with the
   drawings. */
export async function waitForGoogleFiles(
  transport: ProviderTransport,
  uploads: UploadedAsset[],
  fetchImpl: typeof fetch = fetch,
  deadlineMs = 120_000,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
) {
  const until = Date.now() + deadlineMs;
  for (const item of uploads) {
    if (!item.name) continue;
    for (;;) {
      const response = await fetchImpl(`${transport.baseUrl}/${item.name}`, { headers: transport.headers });
      const payload = await response.json().catch(() => ({}));
      const state = String((payload as Record<string, any>)?.state || "");
      if (!response.ok) throw new Error(providerErrorMessage("google", payload as Record<string, any>, `Gemini lost a stored page (${response.status})`));
      if (state === "ACTIVE" || state === "") break;
      if (state === "FAILED") throw new Error(`Gemini could not process ${item.name} and the reading was not started.`);
      if (Date.now() > until) throw new Error("Gemini did not finish preparing the uploaded pages in time. Nothing was read and nothing was billed.");
      await sleep(2000);
    }
  }
}

/* Best effort, and deliberately so: a copy left behind is deleted by Google
   within 48 hours, and failing to delete it must never fail a reading that
   already happened. */
export async function releaseGoogleFiles(
  transport: ProviderTransport,
  uploads: UploadedAsset[],
  fetchImpl: typeof fetch = fetch,
) {
  for (const item of uploads) {
    if (!item.name) continue;
    try {
      await fetchImpl(`${transport.baseUrl}/${item.name}`, { method: "DELETE", headers: transport.headers });
    } catch {
      /* Left to Google's own expiry. */
    }
  }
}

/* A reading this provider cannot be asked for honestly, named before it is
   bought rather than after it fails. */
export function readingRefusal(transport: ProviderTransport, content: ReadingContent): string | null {
  if (transport.provider === "anthropic" && content.images.length > MANY_IMAGE_THRESHOLD) {
    return `This reading carries ${content.images.length} enlargements. Above ${MANY_IMAGE_THRESHOLD} images in one request Claude requires every image to be no more than 2000 pixels per side, `
      + "and these tiles are drawn larger than that so schedules and marks stay legible. Read this set in smaller parts.";
  }
  return null;
}

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

/* Claude and Gemini each take one request with the same pages, the same
   enlargements in the same order, the same task and the same schema. Only
   the way each one reaches the bytes differs. */
export function syncRequest(
  transport: ProviderTransport,
  content: ReadingContent,
  uploads: UploadedAsset[] = [],
): { url: string; body: Record<string, unknown> } {
  if (transport.provider === "anthropic") {
    const blocks: Array<Record<string, unknown>> = [];
    for (const document of content.documents) {
      blocks.push({ type: "text", text: `Document: ${document.label}` });
      blocks.push({ type: "document", source: { type: "url", url: document.url } });
    }
    if (content.images.length && content.imageNote) blocks.push({ type: "text", text: content.imageNote });
    for (const image of content.images) {
      blocks.push({ type: "text", text: `Image ${image.label}` });
      blocks.push({ type: "image", source: { type: "url", url: image.url } });
    }
    blocks.push({ type: "text", text: content.taskText });
    if (content.chunkNote) blocks.push({ type: "text", text: content.chunkNote });
    return {
      url: `${transport.baseUrl}/messages`,
      body: {
        model: transport.model.id,
        max_tokens: content.maxOutputTokens,
        system: content.instructions,
        messages: [{ role: "user", content: blocks }],
      },
    };
  }

  const stored = new Map(uploads.map((item) => [item.url, item]));
  const filePart = (asset: ReadingAsset) => {
    const copy = stored.get(asset.url);
    if (!copy) throw new Error(`Gemini was not given a stored copy of ${asset.label}`);
    return { fileData: { fileUri: copy.fileUri, mimeType: copy.mimeType } };
  };
  const parts: Array<Record<string, unknown>> = [{ text: content.instructions }];
  for (const document of content.documents) {
    parts.push({ text: `Document: ${document.label}` });
    parts.push(filePart(document));
  }
  if (content.images.length && content.imageNote) parts.push({ text: content.imageNote });
  for (const image of content.images) {
    parts.push({ text: `Image ${image.label}` });
    parts.push(filePart(image));
  }
  parts.push({ text: content.taskText });
  if (content.chunkNote) parts.push({ text: content.chunkNote });
  return {
    url: `${transport.baseUrl}/models/${encodeURIComponent(transport.model.id)}:generateContent`,
    body: {
      contents: [{ role: "user", parts }],
      generationConfig: {
        responseMimeType: "application/json",
        maxOutputTokens: content.maxOutputTokens,
        responseJsonSchema: content.schema,
      },
    },
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
