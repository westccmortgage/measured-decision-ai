/* One reading, three envelopes.
 *
 * The comparison is only worth something if the three readers are asked the
 * same question. This proves it at the wire: the same documents in the same
 * order, the same enlargements with the same labels, the same task, the same
 * result schema and the same output ceiling reach OpenAI, Claude and Gemini —
 * and that each body really is the JSON its API expects, with every asset in
 * the right field and no key anywhere in them.
 *
 * None of the three is given the bytes. OpenAI and Claude are given signed
 * URLs they fetch themselves; Gemini, which will not fetch a URL, is given
 * uris for copies uploaded to its file store and deleted after the reading.
 * That is what keeps a 50 MB chunk out of an edge function's memory.
 */
globalThis.Deno = { env: { get: (name) => (name.endsWith("_API_KEY") ? "test-key-do-not-log" : "") } };
const {
  PROVIDERS, providerTransport, providerCatalogue, providerConfigured,
  openAIRequestBody, syncRequest, readAnswer, normaliseUsage, usageCost,
  readingManifest, modelOptionOrUnknown, readingImageBudget, readingRefusal,
  MANY_IMAGE_THRESHOLD, uploadToGoogle, waitForGoogleFiles, releaseGoogleFiles,
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

/* Gemini's copies are made with a stubbed transport, so the uris in its body
   can be traced back to the assets they were made from. */
const uploadCalls = [];
const stubFetch = async (url, init = {}) => {
  uploadCalls.push({ url: String(url), method: init.method || "GET", command: init.headers?.["X-Goog-Upload-Command"] || "" });
  if (String(url).startsWith("https://files.example/")) {
    return { ok: true, status: 200, headers: new Map(), arrayBuffer: async () => new TextEncoder().encode(`BYTES:${url}`).buffer };
  }
  if (String(url).endsWith("/files") && init.headers?.["X-Goog-Upload-Command"] === "start") {
    const source = JSON.parse(init.body).file.display_name;
    return { ok: true, status: 200, headers: { get: (name) => (name === "x-goog-upload-url" ? `https://upload.example/${encodeURIComponent(source)}` : null) } };
  }
  if (String(url).startsWith("https://upload.example/")) {
    const label = decodeURIComponent(String(url).split("/").pop());
    return { ok: true, status: 200, json: async () => ({ file: { uri: `https://files.google/v1/${label}`, name: `files/${label}`, state: "ACTIVE" } }) };
  }
  return { ok: true, status: 200, json: async () => ({ state: "ACTIVE" }) };
};

const uploads = [];
for (const asset of [...content.documents, ...content.images]) uploads.push(await uploadToGoogle(google, asset, stubFetch));
await waitForGoogleFiles(google, uploads, stubFetch, 1000, async () => {});

const anthropicRequest = syncRequest(anthropic, content);
const googleRequest = syncRequest(google, content, uploads);
const anthropicBody = anthropicRequest.body;
const googleBody = googleRequest.body;
const anthropicText = JSON.stringify(anthropicBody);
const googleText = JSON.stringify(googleBody);

check("each asset is uploaded to Gemini once and finalised in one command",
  uploads.length === 5
  && uploadCalls.filter((call) => call.command === "start").length === 5
  && uploadCalls.filter((call) => call.command === "upload, finalize").length === 5,
  JSON.stringify(uploadCalls.filter((c) => c.command).map((c) => c.command)));

{
  const anthropicBlocks = anthropicBody.messages[0].content;
  const geminiParts = googleBody.contents[0].parts;
  const openAiBlocks = openAiBody.input[0].content;

  check("every reader is asked for the same model it was chosen as",
    openAiBody.model === "gpt-5.6-sol" && anthropicBody.model === "claude-opus-5" && googleRequest.url.includes("gemini-3.1-pro-preview"),
    `${openAiBody.model} / ${anthropicBody.model} / ${googleRequest.url.split("/").pop()}`);

  const uriFor = (asset) => uploads.find((item) => item.url === asset.url)?.fileUri;
  const documentsIn = {
    openai: openAiBlocks.filter((b) => b.type === "input_file").map((b) => b.file_url),
    anthropic: anthropicBlocks.filter((b) => b.type === "document").map((b) => b.source.url),
    google: geminiParts.filter((p) => p.fileData?.mimeType === "application/pdf").map((p) => p.fileData.fileUri),
  };
  check("all three carry both documents, in the same order",
    documentsIn.openai.length === 2 && documentsIn.anthropic.length === 2 && documentsIn.google.length === 2
    && documentsIn.openai[0] === content.documents[0].url
    && documentsIn.anthropic[0] === content.documents[0].url
    && documentsIn.google[1] === uriFor(content.documents[1]),
    JSON.stringify(documentsIn));

  const imagesIn = {
    openai: openAiBlocks.filter((b) => b.type === "input_image").map((b) => b.image_url),
    anthropic: anthropicBlocks.filter((b) => b.type === "image").map((b) => b.source.url),
    google: geminiParts.filter((p) => p.fileData?.mimeType === "image/jpeg").map((p) => p.fileData.fileUri),
  };
  check("all three carry the same three enlargements, in the same order",
    imagesIn.openai.length === 3 && imagesIn.anthropic.length === 3 && imagesIn.google.length === 3
    && imagesIn.openai[2] === content.images[2].url
    && imagesIn.anthropic[2] === content.images[2].url
    && imagesIn.google[0] === uriFor(content.images[0]),
    JSON.stringify([imagesIn.openai.length, imagesIn.anthropic.length, imagesIn.google.length]));

  check("no reader is handed the bytes — a 50 MB chunk never enters a request body",
    anthropicBlocks.every((b) => b.source?.type !== "base64")
    && geminiParts.every((p) => !p.inlineData)
    && !/BYTES:/.test(anthropicText) && !/BYTES:/.test(googleText));

  const texts = {
    openai: openAiBlocks.filter((b) => b.type === "input_text").map((b) => b.text).join("\n") + "\n" + openAiBody.instructions,
    anthropic: anthropicBlocks.filter((b) => b.type === "text").map((b) => b.text).join("\n") + "\n" + anthropicBody.system,
    google: geminiParts.filter((p) => p.text).map((p) => p.text).join("\n"),
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

console.log("\n── every copy is taken back ──");
{
  const deleted = [];
  await releaseGoogleFiles(google, uploads, async (url, init) => {
    deleted.push(`${init.method} ${url}`);
    return { ok: true, status: 200, json: async () => ({}) };
  });
  check("each uploaded copy is deleted when the reading is over",
    deleted.length === 5 && deleted.every((call) => call.startsWith("DELETE ") && call.includes("/files/")),
    deleted[0]);
  const survived = await releaseGoogleFiles(google, uploads, async () => { throw new Error("network gone"); }).then(() => true, () => false);
  check("and a delete that fails never fails a reading that already happened", survived);
}

console.log("\n── a reading that cannot be asked for honestly is refused before it is bought ──");
{
  check("every reader carries the same enlargement budget, set by the strictest of their own rules",
    readingImageBudget("openai") === MANY_IMAGE_THRESHOLD
    && readingImageBudget("anthropic") === MANY_IMAGE_THRESHOLD
    && readingImageBudget("google") === MANY_IMAGE_THRESHOLD,
    `${readingImageBudget("openai")} / ${readingImageBudget("anthropic")} / ${readingImageBudget("google")}`);
  check("so the catalogue the Studio shows names one budget, not three",
    new Set(providerCatalogue().map((entry) => entry.image_budget)).size === 1,
    JSON.stringify(providerCatalogue().map((entry) => entry.image_budget)));
  const tooMany = { ...content, images: Array.from({ length: MANY_IMAGE_THRESHOLD + 1 }, (_, i) => ({ label: `t${i}`, url: `https://files.example/t${i}`, mediaType: "image/jpeg" })) };
  const refusal = readingRefusal(anthropic, tooMany);
  check("above the threshold Claude is refused with the reason and the way round it",
    Boolean(refusal) && /2000 pixels/.test(refusal) && /smaller parts/.test(refusal), String(refusal).slice(0, 90));
  check("at the budget it is not refused", readingRefusal(anthropic, content) === null);
  check("and the same set is not refused for the readers whose rule it is not",
    readingRefusal(openai, tooMany) === null && readingRefusal(google, tooMany) === null);
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
