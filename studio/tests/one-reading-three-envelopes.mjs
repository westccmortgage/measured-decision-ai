/* One reading, three envelopes.
 *
 * The comparison is only worth something if the three readers are asked the
 * same question. This proves it at the wire: the same documents in the same
 * order, the same enlargements with the same labels, the same task, the same
 * result schema and the same output ceiling reach OpenAI, Claude and Gemini —
 * and that the streamed bodies really are the JSON each API expects, with the
 * file bytes in the right field and no key anywhere in them.
 */
globalThis.Deno = { env: { get: (name) => (name.endsWith("_API_KEY") ? "test-key-do-not-log" : "") } };
const {
  PROVIDERS, providerTransport, providerCatalogue, providerConfigured,
  openAIRequestBody, syncRequest, jsonStreamBody, readAnswer, normaliseUsage, usageCost,
  readingManifest, modelOptionOrUnknown,
} = await import("../../supabase/functions/_shared/ai-providers.ts");

let bad = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "  ok  " : "  FAIL"} ${label}${detail ? `\n         ${detail}` : ""}`);
  if (!ok) bad++;
};

const content = {
  instructions: "You are executing the controlled Plan Intelligence workflow.",
  taskText: "Analyze this project document set. Database source register:\n[{\"id\":\"doc-1\"}]",
  registerText: "[{\"id\":\"doc-1\"}]",
  chunkNote: "This is chunk 1 of 2 of one reading.",
  imageNote: "High-resolution page renders accompany the PDFs, in this order:\n1. Set.pdf · p24-full.jpg",
  documents: [
    { label: "Set (pages 1-11).pdf", url: "https://files.example/one?sig=a", mediaType: "application/pdf" },
    { label: "Set (pages 12-22).pdf", url: "https://files.example/two?sig=b", mediaType: "application/pdf" },
  ],
  images: [
    { label: "Set.pdf · p24-full.jpg", url: "https://files.example/t1?sig=c", mediaType: "image/jpeg" },
    { label: "Set.pdf · p24-r1c1.jpg", url: "https://files.example/t2?sig=d", mediaType: "image/jpeg" },
    { label: "Set.pdf · p24-r1c2.jpg", url: "https://files.example/t3?sig=e", mediaType: "image/jpeg" },
  ],
  schema: { type: "object", properties: { project_summary: { type: "string" }, structural_members: { type: "array" } }, required: ["project_summary"] },
  maxOutputTokens: 32000,
};

console.log("── the registry ──");
check("three readers, each with its own secret name and a checked model id",
  Object.keys(PROVIDERS).join(",") === "openai,anthropic,google"
  && PROVIDERS.openai.models[0].id === "gpt-5.6-sol"
  && PROVIDERS.anthropic.models[0].id === "claude-opus-5"
  && PROVIDERS.google.models[0].id === "gemini-3.1-pro-preview",
  Object.values(PROVIDERS).map((p) => `${p.key}:${p.models[0].id}`).join(" "));
check("a model whose published price was not confirmed carries no price at all",
  PROVIDERS.google.models[0].input_per_mtok === null && PROVIDERS.google.models[0].price_status === "not_confirmed");
check("the catalogue says whether a provider has a key and never what it is",
  providerCatalogue().every((entry) => entry.configured === true) && !JSON.stringify(providerCatalogue()).includes("test-key"));
check("a model id the registry does not carry still runs, with an unknown price",
  modelOptionOrUnknown("openai", "gpt-9-unreleased").price_status === "not_confirmed"
  && modelOptionOrUnknown("openai", "gpt-9-unreleased").input_per_mtok === null);

console.log("\n── the same reading, three envelopes ──");
const openai = providerTransport("openai", "gpt-5.6-sol");
const anthropic = providerTransport("anthropic", "claude-opus-5");
const google = providerTransport("google", "gemini-3.1-pro-preview");
const manifest = readingManifest(content);
check("the manifest names the pages and the enlargements in order",
  manifest.documents.length === 2 && manifest.images.length === 3 && manifest.images[0].endsWith("p24-full.jpg"), JSON.stringify(manifest.images));

const openAiBody = openAIRequestBody(openai, content);
const openAiJson = JSON.stringify(openAiBody);
const anthropicParts = syncRequest(anthropic, content);
const googleParts = syncRequest(google, content);

/* Each streamed body is assembled with a stubbed fetch, so the bytes of every
   asset are known and can be found in the right field. */
const bytesFor = (url) => new TextEncoder().encode(`BYTES:${url}`);
const stubFetch = async (url) => ({ ok: true, arrayBuffer: async () => bytesFor(url).buffer });
async function collect(parts) {
  const stream = jsonStreamBody(parts, stubFetch);
  const chunks = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(new TextDecoder().decode(value));
  }
  return chunks.join("");
}
const anthropicText = await collect(anthropicParts.parts);
const googleText = await collect(googleParts.parts);
let anthropicBody, googleBody;
try { anthropicBody = JSON.parse(anthropicText); } catch (error) { check("the Claude body is valid JSON", false, String(error).slice(0, 120) + " :: " + anthropicText.slice(0, 200)); }
try { googleBody = JSON.parse(googleText); } catch (error) { check("the Gemini body is valid JSON", false, String(error).slice(0, 120) + " :: " + googleText.slice(0, 200)); }
check("both streamed bodies are valid JSON", Boolean(anthropicBody && googleBody));

if (anthropicBody && googleBody) {
  const anthropicBlocks = anthropicBody.messages[0].content;
  const googleParts2 = googleBody.contents[0].parts;
  const openAiBlocks = openAiBody.input[0].content;

  check("every reader is asked for the same model it was chosen as",
    openAiBody.model === "gpt-5.6-sol" && anthropicBody.model === "claude-opus-5" && googleParts.url.includes("gemini-3.1-pro-preview"),
    `${openAiBody.model} / ${anthropicBody.model} / ${googleParts.url.split("/").pop()}`);

  const documentsIn = {
    openai: openAiBlocks.filter((b) => b.type === "input_file").map((b) => b.file_url),
    anthropic: anthropicBlocks.filter((b) => b.type === "document").map((b) => new TextDecoder().decode(Uint8Array.from(atob(b.source.data), (c) => c.charCodeAt(0)))),
    google: googleParts2.filter((p) => p.inlineData?.mimeType === "application/pdf").map((p) => new TextDecoder().decode(Uint8Array.from(atob(p.inlineData.data), (c) => c.charCodeAt(0)))),
  };
  check("all three carry both documents, in the same order",
    documentsIn.openai.length === 2 && documentsIn.anthropic.length === 2 && documentsIn.google.length === 2
    && documentsIn.openai[0] === content.documents[0].url
    && documentsIn.anthropic[0] === `BYTES:${content.documents[0].url}`
    && documentsIn.google[1] === `BYTES:${content.documents[1].url}`,
    JSON.stringify({ openai: documentsIn.openai.length, anthropic: documentsIn.anthropic[0], google: documentsIn.google[1] }));

  const imagesIn = {
    openai: openAiBlocks.filter((b) => b.type === "input_image").map((b) => b.image_url),
    anthropic: anthropicBlocks.filter((b) => b.type === "image").map((b) => new TextDecoder().decode(Uint8Array.from(atob(b.source.data), (c) => c.charCodeAt(0)))),
    google: googleParts2.filter((p) => p.inlineData?.mimeType === "image/jpeg").map((p) => new TextDecoder().decode(Uint8Array.from(atob(p.inlineData.data), (c) => c.charCodeAt(0)))),
  };
  check("all three carry the same three enlargements, in the same order",
    imagesIn.openai.length === 3 && imagesIn.anthropic.length === 3 && imagesIn.google.length === 3
    && imagesIn.openai[2] === content.images[2].url
    && imagesIn.anthropic[2] === `BYTES:${content.images[2].url}`
    && imagesIn.google[0] === `BYTES:${content.images[0].url}`,
    JSON.stringify([imagesIn.openai.length, imagesIn.anthropic.length, imagesIn.google.length]));

  const texts = {
    openai: openAiBlocks.filter((b) => b.type === "input_text").map((b) => b.text).join("\n") + "\n" + openAiBody.instructions,
    anthropic: anthropicBlocks.filter((b) => b.type === "text").map((b) => b.text).join("\n") + "\n" + anthropicBody.system,
    google: googleParts2.filter((p) => p.text).map((p) => p.text).join("\n"),
  };
  check("all three are given the same task, the same register, the same chunk note and the same instructions",
    Object.values(texts).every((text) => text.includes(content.taskText) && text.includes(content.chunkNote) && text.includes(content.instructions) && text.includes(content.imageNote)),
    Object.entries(texts).map(([key, text]) => `${key}:${text.includes(content.taskText)}`).join(" "));

  check("all three are held to the same result schema and the same output ceiling",
    openAiBody.text.format.schema.properties.structural_members
    && googleBody.generationConfig.responseJsonSchema.properties.structural_members
    && openAiBody.max_output_tokens === 32000 && anthropicBody.max_tokens === 32000 && googleBody.generationConfig.maxOutputTokens === 32000,
    JSON.stringify([openAiBody.max_output_tokens, anthropicBody.max_tokens, googleBody.generationConfig.maxOutputTokens]));

  check("no key appears in any body — the secret rides in the headers and nowhere else",
    ![openAiJson, anthropicText, googleText].some((body) => body.includes("test-key-do-not-log"))
    && anthropic.headers["x-api-key"] === "test-key-do-not-log" && google.headers["x-goog-api-key"] === "test-key-do-not-log");
}

console.log("\n── three answers, one shape ──");
{
  const fromOpenAi = readAnswer("openai", { model: "gpt-5.6-sol", status: "completed", output: [{ content: [{ type: "output_text", text: '{"ok":1}' }] }], usage: { input_tokens: 100, output_tokens: 20 } });
  const fromClaude = readAnswer("anthropic", { model: "claude-opus-5", stop_reason: "end_turn", content: [{ type: "text", text: '{"ok":1}' }], usage: { input_tokens: 90, output_tokens: 15, cache_read_input_tokens: 10 } });
  const fromGemini = readAnswer("google", { modelVersion: "gemini-3.1-pro-preview", candidates: [{ finishReason: "STOP", content: { parts: [{ text: '{"ok":1}' }] } }], usageMetadata: { promptTokenCount: 80, candidatesTokenCount: 12, totalTokenCount: 92 } });
  check("each answer yields the same text and a model the provider itself reported",
    [fromOpenAi, fromClaude, fromGemini].every((answer) => answer.text === '{"ok":1}')
    && fromClaude.modelReported === "claude-opus-5" && fromGemini.modelReported === "gemini-3.1-pro-preview");
  check("usage is normalised to the names the ledger stores, cached input included",
    fromOpenAi.usage.input_tokens === 100 && fromClaude.usage.input_tokens === 100 && fromGemini.usage.input_tokens === 80 && fromGemini.usage.output_tokens === 12,
    JSON.stringify([fromClaude.usage.input_tokens, fromGemini.usage.output_tokens]));

  const priced = usageCost(PROVIDERS.anthropic.models[0], fromClaude.usage);
  const unpriced = usageCost(PROVIDERS.google.models[0], fromGemini.usage);
  const noUsage = usageCost(PROVIDERS.openai.models[0], {});
  check("a confirmed price gives money; an unconfirmed one gives null, never zero",
    priced.cost_usd === Number(((100 * 5 + 15 * 25) / 1e6).toFixed(4)) && unpriced.cost_usd === null && unpriced.price_status === "not_confirmed",
    JSON.stringify([priced.cost_usd, unpriced.cost_usd]));
  check("and a call the provider reported no usage for is also null, not zero", noUsage.cost_usd === null, JSON.stringify(noUsage));
  check("normalising an empty usage object stays empty rather than inventing zeros",
    Object.keys(normaliseUsage("openai", {})).length === 0);
}

console.log(bad ? `\n${bad} FAILURES` : "\nALL OK");
process.exit(bad ? 1 : 0);
