/* A LONG READING FITS THE FUNCTION IT RUNS IN.
 *
 * The deployed edge function stops answering a request after 150 seconds of
 * idleness, and stops a worker altogether at its wall clock — 150 seconds on
 * the free plan, 400 paid. Claude and Gemini take longer than that first
 * number to read a plan chunk. Before this, a synchronous reading was awaited
 * inside the request that started it, so the gateway cut the connection at
 * 150 seconds on a reading that was already sent and already being billed.
 *
 * This holds the fix in place: a synchronous reading is handed to the
 * runtime's `waitUntil`, the request answers immediately, the chunk row is
 * where the answer lands, and a chunk still held past a deadline longer than
 * any worker's life is an unknown outcome a person decides about — never a
 * silent retry of a reading that may already be on the invoice.
 *
 * `waitUntil` is not immortality. Supabase's own documentation says it
 * prevents an idle worker being retired early and does not extend the hard
 * wall clock — 400 seconds on this project's Pro plan, counted from when the
 * worker booted and shared across every request it serves. So the two things
 * this file also holds are: a reading is never started on a worker without
 * the life left to finish it, and a reading that is started is cut off
 * inside that remaining life rather than at a fixed number that could
 * outlast the worker.
 */
import fs from "node:fs";

let bad = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "  ok  " : "  FAIL"} ${label}${detail ? `\n         ${detail}` : ""}`);
  if (!ok) bad++;
};

const plan = fs.readFileSync("supabase/functions/plan-analyze/index.ts", "utf8");
const providers = fs.readFileSync("supabase/functions/_shared/ai-providers.ts", "utf8");
const assets = fs.readFileSync("supabase/functions/_shared/reading-assets.ts", "utf8");
const number = (name, source = plan) => {
  const match = source.match(new RegExp(`const ${name} = ([0-9_ */]+);`));
  return match ? Number(eval(match[1])) : NaN;
};

console.log("── the reading outlives the request ──");
check("a synchronous reading is handed to the runtime, not awaited by the request",
  /EdgeRuntime/.test(plan) && /typeof runtime\.waitUntil === "function"/.test(plan)
  && /runAfterResponse\(readChunk\(\)\)/.test(plan)
  && !/await runAfterResponse/.test(plan));
check("and it still runs where there is no such runtime, so a local run behaves the same",
  /if \(runtime && typeof runtime\.waitUntil === "function"\) runtime\.waitUntil\(settled\);/.test(plan)
  && /const settled = work\.catch\(/.test(plan));

console.log("\n── the deadlines are the deployed ones ──");
const readingTimeout = number("SYNC_READING_TIMEOUT_MS");
const chunkDeadline = number("SYNC_CHUNK_DEADLINE_MS");
const wallClock = number("WORKER_WALL_CLOCK_MS");
const safety = number("WORKER_SAFETY_MS");
const floor = number("MIN_READING_MS");
check("the wall clock this code plans against is the paid one this project is on",
  wallClock === 400_000, `${wallClock} ms — Pro plan, confirmed on the organisation`);
check("a reading is cut off inside that wall clock, not after it",
  readingTimeout > 150_000 && readingTimeout + safety <= wallClock,
  `${readingTimeout} ms reading + ${safety} ms to record the result, against ${wallClock} ms`);
check("and a chunk is only given up on past any worker's life, so a live reading is never abandoned",
  chunkDeadline > wallClock, `${chunkDeadline} ms against a ${wallClock} ms worker`);
check("the clock is read from when the worker booted, not from when the reading started",
  /const WORKER_BOOTED_AT = Date\.now\(\);/.test(plan)
  && /workerBudget\(WORKER_BOOTED_AT, Date\.now\(\), WORKER_WALL_CLOCK_MS, WORKER_SAFETY_MS, MIN_READING_MS\)/.test(plan));
check("and the reading's own deadline is whichever runs out first",
  /const deadlineMs = Math\.min\(SYNC_READING_TIMEOUT_MS, room\.remaining_ms\);/.test(plan));

console.log("\n── a worker too near its end buys nothing ──");
const { workerBudget, heldReadingVerdict } = await import("../../supabase/functions/plan-analyze/chunking.js");
{
  const fresh = workerBudget(0, 1_000, wallClock, safety, floor);
  const warm = workerBudget(0, wallClock - safety - floor + 1_000, wallClock, safety, floor);
  const spent = workerBudget(0, wallClock, wallClock, safety, floor);
  check("a fresh worker has room for a reading",
    fresh.enough && fresh.remaining_ms === wallClock - safety - 1_000, JSON.stringify(fresh));
  check("a worker with less left than a reading needs has none",
    !warm.enough && warm.remaining_ms < floor, JSON.stringify(warm));
  check("and one at its ceiling has nothing at all", spent.remaining_ms === 0 && !spent.enough);
  check("the refusal is raised before any request is sent",
    plan.indexOf("NOT_ENOUGH_WORKER_TIME") < plan.indexOf("const uploads: UploadedAsset[] = [];"));
  check("nothing was sent, so the chunk goes back to pending rather than to an unknown outcome",
    /if \(\/\^NOT_ENOUGH_WORKER_TIME\/\.test\(message\)\) \{[\s\S]{0,400}state: "pending"/.test(plan));
  check("and the ledger row closes as a failure that cost nothing, not as an unknown one",
    /finishAiRun\(admin, ledger\.runId, "failed", \{\}, "worker_out_of_time"\)/.test(plan));
}

console.log("\n── a worker killed mid-reading, and what is left behind ──");
{
  const running = heldReadingVerdict(0, chunkDeadline - 1, chunkDeadline);
  const abandoned = heldReadingVerdict(0, chunkDeadline + 1, chunkDeadline);
  check("while a worker could still be holding it, a poll reports it running and touches nothing",
    running.state === "running" && !running.message, JSON.stringify(running));
  check("past any worker's life it is an unknown outcome, not a failure and not a retry",
    abandoned.state === "outcome_unknown" && /before an answer came back/.test(abandoned.message), abandoned.state);
  check("the poll takes its answer from exactly that decision",
    /const held = heldReadingVerdict\(/.test(plan) && /if \(held\.state === "outcome_unknown"\)/.test(plan));
  check("and the row a person then sees says the reading may already have been billed",
    /may already have run and been billed — confirm before running it again/.test(plan));
  check("an unreadable timestamp is treated as still running, never as an abandoned reading",
    heldReadingVerdict(null, Date.now(), chunkDeadline).state === "running");
}

console.log("\n── one kit, the same for every reader ──");
{
  const providers = await import("../../supabase/functions/_shared/ai-providers.ts");
  const chunking = await import("../../supabase/functions/plan-analyze/chunking.js");
  const split = fs.readFileSync("studio/pdf-split.js", "utf8");
  check("every reader carries the same number of enlargements",
    providers.readingImageBudget("openai") === providers.readingImageBudget("anthropic")
    && providers.readingImageBudget("anthropic") === providers.readingImageBudget("google"),
    `${providers.readingImageBudget("openai")} / ${providers.readingImageBudget("anthropic")} / ${providers.readingImageBudget("google")}`);
  check("and that number is the strictest of the three readers' own rules",
    providers.READING_IMAGE_BUDGET === providers.MANY_IMAGE_THRESHOLD && providers.READING_IMAGE_BUDGET === 20);
  check("the chunker and the browser's splitter cut to the same number",
    chunking.MAX_RENDER_IMAGES === providers.READING_IMAGE_BUDGET
    && new RegExp(`PART_MAX_IMAGES = ${providers.READING_IMAGE_BUDGET};`).test(split));

  /* Coverage is what a smaller budget must not cost. Twenty-five sheets of
     five tiles each: split on bytes alone they would arrive as one chunk
     carrying twenty tiles and twenty-one sheets without any. Split on tiles
     they arrive as thirteen chunks carrying every tile of every sheet. */
  const sheets = Array.from({ length: 25 }, (_, index) => ({ id: `s${index}`, byte_size: 1_000_000 }));
  const tiles = new Map(sheets.map((sheet) => [sheet.id, 5]));
  const byBytes = chunking.planChunks(sheets, chunking.CHUNK_BYTE_LIMIT);
  const byTiles = chunking.planChunks(sheets, chunking.CHUNK_BYTE_LIMIT, chunking.MAX_RENDER_IMAGES, tiles);
  check("splitting on bytes alone would put every sheet in one chunk",
    byBytes.length === 1 && byBytes[0].document_ids.length === 25);
  check("splitting on tiles too gives every sheet its tiles, in more chunks",
    byTiles.length === 7
    && byTiles.every((chunk) => chunk.images <= chunking.MAX_RENDER_IMAGES)
    && byTiles.reduce((sum, chunk) => sum + chunk.images, 0) === 125,
    `${byTiles.length} chunks, ${byTiles.reduce((sum, chunk) => sum + chunk.images, 0)} tiles carried`);
  check("no sheet is dropped and none is read twice",
    byTiles.flatMap((chunk) => chunk.document_ids).join(",") === sheets.map((sheet) => sheet.id).join(","));
  check("a document whose own tiles exceed the budget still travels, and says what it could not carry",
    chunking.planChunks([{ id: "big", byte_size: 1 }], chunking.CHUNK_BYTE_LIMIT, 20, { big: 125 }).length === 1
    && /Split the set into finer parts and read again/.test(fs.readFileSync("supabase/functions/plan-analyze/chunking.js", "utf8")));
  check("the chunked reading is planned from the tiles each document actually has",
    /planChunks\(orderedDocuments, CHUNK_BYTE_LIMIT, MAX_RENDER_IMAGES, tilesByDocument\)/.test(plan));
}

console.log("\n── the kit that was sent is recorded, and can be compared ──");
{
  check("the digest is taken over the very arrays the request carries",
    /documents: signedDocuments\.map\(\(\{ row \}\) => `\$\{row\.id\}:\$\{row\.original_filename\}`\)/.test(assets)
    && /images: images\.map\(\(image\) => image\.label\)/.test(assets));
  check("and never over the signed URLs, which differ on every call and show nothing",
    !/signedUrl.*digest|digest.*signedUrl/.test(assets) && !/url/.test(assets.slice(assets.indexOf("const manifest = {"), assets.indexOf("const fingerprint"))));
  check("it is written to the row when the request goes out, not reconstructed later",
    /image_fingerprint: reading\.manifest\.fingerprint/.test(plan));
  check("a chunked reading's kit is its chunks' kits in order",
    /fingerprint: \(chunkRows \|\| \[\]\)\.map\(\(row\) => row\.image_fingerprint \|\| "\?"\)\.join\("\+"\)/.test(plan));
  check("and every reading carries it, so two readings can be checked against each other",
    /image_fingerprint: manifest\?\.fingerprint \|\| null/.test(plan) && /images_sent: manifest\?\.images_sent \?\? null/.test(plan));
}

console.log("\n── the chunk row is where the answer lands ──");
check("a synchronous reader always goes through the chunk table, even for a set that fits one request",
  /totalBytes <= CHUNK_BYTE_LIMIT && transport\.mode === "background"/.test(plan));
check("a reading in one part is not told it is chunk 1 of 1",
  /if \(Number\(chunkTotal\) <= 1\) return null;/.test(fs.readFileSync("supabase/functions/plan-analyze/chunking.js", "utf8")));
check("a held chunk is marked as held rather than left looking abandoned",
  /provider_job_id: INLINE_CHUNK_HANDLE/.test(plan));
check("a poll under the deadline reports progress instead of failing a running reading",
  /const held = heldReadingVerdict\(/.test(plan) && /return progress\(\);/.test(plan));
check("past the deadline it is an unknown outcome — sent, possibly billed, never silently retried",
  /failChunk\(processing, held\.message, "outcome_unknown"\)/.test(plan));
check("nothing in the fix reruns a reading on its own",
  !/retry|relaunch/i.test(plan.split("INLINE_CHUNK_HANDLE")[2] || ""));

console.log("\n── the body is small enough to build ──");
check("Claude is given URLs, so a 50 MB chunk is never encoded into a request",
  /type: "url", url: document\.url/.test(providers) && !/btoa\(/.test(providers));
check("Gemini's copies go through its file store one asset at a time",
  /uploads\.push\(await uploadToGoogle\(transport, asset\)\)/.test(plan)
  && /await waitForGoogleFiles\(transport, uploads\)/.test(plan));
check("and every copy is deleted whether the reading succeeded or failed",
  /\} finally \{[\s\S]{0,400}await releaseGoogleFiles\(transport, uploads\);/.test(plan));

console.log("\n── what each reading saw is recorded, so two readings are never called equal by accident ──");
check("every reading records the enlargement budget it was given",
  /image_budget: readingImageBudget\(transport\.provider\)/.test(plan));
check("and the task version it was read under",
  /image_budget: readingImageBudget\(transport\.provider\),\n    agent_contract_version: AGENT_CONTRACT_VERSION,/.test(plan));
check("the coverage note names the budget of the reading that produced it, not a constant",
  /tileCoverageGaps\(coverage, maxImages = MAX_RENDER_IMAGES\)/.test(fs.readFileSync("supabase/functions/plan-analyze/chunking.js", "utf8")));

console.log(bad ? `\n${bad} FAILURES` : "\nALL OK");
process.exit(bad ? 1 : 0);
