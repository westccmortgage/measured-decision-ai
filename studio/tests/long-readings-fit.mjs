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
 */
import fs from "node:fs";

let bad = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "  ok  " : "  FAIL"} ${label}${detail ? `\n         ${detail}` : ""}`);
  if (!ok) bad++;
};

const plan = fs.readFileSync("supabase/functions/plan-analyze/index.ts", "utf8");
const providers = fs.readFileSync("supabase/functions/_shared/ai-providers.ts", "utf8");
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
check("a reading is cut off inside the worker's own wall clock, not after it",
  readingTimeout > 150_000 && readingTimeout < 400_000, `${readingTimeout} ms against a 400 s paid wall clock`);
check("and a chunk is only given up on past any worker's life, so a live reading is never abandoned",
  chunkDeadline > 400_000, `${chunkDeadline} ms`);

console.log("\n── the chunk row is where the answer lands ──");
check("a synchronous reader always goes through the chunk table, even for a set that fits one request",
  /totalBytes <= CHUNK_BYTE_LIMIT && transport\.mode === "background"/.test(plan));
check("a reading in one part is not told it is chunk 1 of 1",
  /if \(Number\(chunkTotal\) <= 1\) return null;/.test(fs.readFileSync("supabase/functions/plan-analyze/chunking.js", "utf8")));
check("a held chunk is marked as held rather than left looking abandoned",
  /provider_job_id: INLINE_CHUNK_HANDLE/.test(plan));
check("a poll under the deadline reports progress instead of failing a running reading",
  /heldFor > SYNC_CHUNK_DEADLINE_MS/.test(plan) && /return progress\(\);/.test(plan));
check("past the deadline it is an unknown outcome — sent, possibly billed, never silently retried",
  /"this chunk was sent to the provider and the reading ended before an answer came back\.", "outcome_unknown"/.test(plan));
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
  /agent_contract_version: AGENT_CONTRACT_VERSION,\n    usage,/.test(plan));
check("the coverage note names the budget of the reading that produced it, not a constant",
  /tileCoverageGaps\(coverage, maxImages = MAX_RENDER_IMAGES\)/.test(fs.readFileSync("supabase/functions/plan-analyze/chunking.js", "utf8")));

console.log(bad ? `\n${bad} FAILURES` : "\nALL OK");
process.exit(bad ? 1 : 0);
