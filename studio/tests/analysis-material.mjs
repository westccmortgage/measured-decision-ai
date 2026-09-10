/* WHAT COMES OUT OF A REAL FILE, AND WHAT A REFUSAL SAYS.
 *
 * Real PDFs and real clips, opened in a real browser by the shipping modules.
 * Nothing here is keyed on a fixture name: every assertion is about bytes that
 * came out of the file during this run.
 *
 * The upload is proved the same way. A minimal tus 1.0.0 server stands in for
 * Supabase Storage — the protocol, not the product — and the transfer is cut
 * in the middle on purpose, because "resumable" is a claim about what happens
 * after an interruption and there is no other way to make one.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { openBench, preparePdfInBrowser, prepareVideoInBrowser, refusalFor, FIXTURES } from "./analysis-browser.mjs";

let bad = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "  ok  " : "  FAIL"} ${label}${detail ? `\n         ${detail}` : ""}`);
  if (!ok) bad += 1;
};
const section = (name) => console.log(`\n── ${name} ──`);
console.log("━━ real files in, real pages and frames out");

const bench = await openBench();
try {
  /* ─────────────────────────────────────────────────────── a plan set */
  section("a PDF with a text layer");
  const plans = await preparePdfInBrowser(bench, "plan-set.pdf");
  check("the file was not refused", !plans.refusal, plans.refusal || "");
  check("every page became its own assignment", plans.pages?.length === 3, `${plans.pages?.length} pages`);
  const everyPageFits = plans.pages.every((p) => p.withinLimit && p.bytes > 4000);
  check("each page image is real and inside the per-item ceiling", everyPageFits,
    plans.pages.map((p) => `p${p.page} ${p.bytes}B ${p.pixelWidth}×${p.pixelHeight}`).join(" · "));
  check("the text of the page came out of the file",
    /GROUND FLOOR PLAN/.test(plans.pages[0].text) && /A-101/.test(plans.pages[0].text),
    plans.pages[0].text.slice(0, 70));
  check("the disagreement this set carries is in the text, on two different pages",
    /CEILING HEIGHT 2700/.test(plans.pages[0].text) && /CEILING HEIGHT 2400/.test(plans.pages[2].text));
  const distinctPages = new Set(plans.pages.map((p) => crypto.createHash("sha256").update(p.png).digest("hex")));
  check("no two pages produced the same image", distinctPages.size === 3, `${distinctPages.size} distinct`);
  check("the page's own size is recorded, so a box in it means something",
    plans.pages.every((p) => p.pointWidth > 500 && p.pointHeight > 400),
    `${plans.pages[0].pointWidth}×${plans.pages[0].pointHeight} points`);

  /* ─────────────────────────────────────────────────────────── a scan */
  section("a PDF that is only pictures");
  const scan = await preparePdfInBrowser(bench, "scan-set.pdf");
  check("a scan is accepted, not refused", !scan.refusal, scan.refusal || "");
  check("its pages still became page images", scan.pages?.length === 2 && scan.pages.every((p) => p.bytes > 10000),
    scan.pages?.map((p) => `${p.bytes}B`).join(" · "));
  check("and it carries no text, which is recorded rather than invented",
    scan.pages.every((p) => p.text === ""),
    JSON.stringify(scan.pages.map((p) => p.text)));

  /* ───────────────────────────────────────────────────────── a clip */
  section("a clip, sampled");
  const clip = await prepareVideoInBrowser(bench, "walkthrough.webm", "video");
  check("the clip was decoded", !clip.refusal && !clip.reason, clip.refusal || clip.reason || "");
  check("its duration came from the decoder", Math.abs(clip.probe.durationSeconds - 8) < 0.2, `${clip.probe.durationSeconds}s`);
  check("frames were taken every two seconds, bounded", clip.frames.length === 5,
    clip.frames.map((f) => f.actualSeconds).join(", "));
  check("each frame records the second it actually came from",
    clip.frames.every((f) => Math.abs(f.actualSeconds - f.requestedSeconds) < 0.35),
    clip.frames.map((f) => `${f.requestedSeconds}→${f.actualSeconds}`).join(" · "));

  /* The clip carries a red panel that exists ONLY between 4.0s and 5.0s. If
     the frames really come out of those seconds, exactly one of them has it. */
  const withRed = clip.frames.filter((f) => f.redFraction > 0.005);
  check("the frame at four seconds carries the thing that is only there then",
    withRed.length === 1 && Math.abs(withRed[0].actualSeconds - 4) < 0.35,
    clip.frames.map((f) => `${f.actualSeconds}s red=${(f.redFraction * 100).toFixed(2)}%`).join(" · "));
  const distinctFrames = new Set(clip.frames.map((f) => crypto.createHash("sha256").update(f.png).digest("hex")));
  check("no two moments produced the same frame", distinctFrames.size === clip.frames.length);

  /* The sentence the screen has to print. */
  const { coverageSentence } = await import("../analysis/plan.js");
  const said = coverageSentence(clip.probe.durationSeconds, clip.probe.momentsRead);
  check("the coverage sentence says what was NOT read", /cannot say that something is absent/.test(said), said);

  /* And the proof that the caution is not decoration: sample it more coarsely
     and the thing that is genuinely in the clip is genuinely missed. */
  const coarse = await prepareVideoInBrowser(bench, "walkthrough.webm", "video", { maximumMoments: 4 });
  const coarseRed = coarse.frames.filter((f) => f.redFraction > 0.005);
  check("a coarser sample misses it entirely, which is why absence is never claimed",
    coarse.frames.length === 4 && coarseRed.length === 0,
    coarse.frames.map((f) => `${f.actualSeconds}s red=${(f.redFraction * 100).toFixed(2)}%`).join(" · "));

  /* ───────────────────────────────────────────────────────── 360 */
  section("equirectangular, and what is not");
  const pano = await prepareVideoInBrowser(bench, "pano-360.webm", "video360");
  check("a 2:1 export is accepted as 360", !pano.refusal && pano.probe.width === 2 * pano.probe.height,
    pano.refusal || `${pano.probe.width}×${pano.probe.height}`);
  check("its frames are marked equirectangular", pano.probe.equirectangular === true);
  const notPano = await prepareVideoInBrowser(bench, "walkthrough.webm", "video360");
  check("a 16:9 clip offered as 360 is refused, with its own numbers in the refusal",
    /1\.78:1/.test(notPano.refusal || "") && /640×360/.test(notPano.refusal || ""), notPano.refusal);

  /* ───────────────────────────────────────────── refusals that help */
  section("refusals name the thing that is wrong");
  const asPdf = await refusalFor(bench, "pdf", "walkthrough.webm", "video/webm");
  check("a clip offered as a PDF is refused by what it is",
    /video\/webm/.test(asPdf.refusal || "") && /\.pdf/.test(asPdf.refusal || ""), asPdf.refusal);
  const h264 = await refusalFor(bench, "video", "walkthrough.mp4", "video/mp4");
  if (h264.probe?.decodable) {
    check("this browser decodes H.264, so the MP4 is accepted", !h264.refusal, h264.refusal || "");
  } else {
    check("a file this browser cannot decode is refused by its CODEC, not by its name",
      /codec|decode/i.test(h264.refusal || "") && /H\.264|VP9|AV1/.test(h264.refusal || ""), h264.refusal);
  }

  /* ─────────────────────────────────── the upload, cut in the middle */
  section("an upload that survives being cut");
  const store = fs.mkdtempSync(path.join(os.tmpdir(), "mdai-tus-"));
  const tus = await startTus(store);
  try {
    const source = fs.readFileSync(path.join(FIXTURES, "walkthrough.webm"));
    const chunk = 16 * 1024;
    const firstRun = await uploadInBrowser(bench, tus.base, "walkthrough.webm", chunk, 2);
    check("the first attempt was cut on purpose", firstRun.cut === true, firstRun.said || "");
    const landed = tus.bytesOf("org/analysis/a/1-source.webm");
    check("what got through is on the server, and it is less than the file",
      landed > 0 && landed < source.length, `${landed} of ${source.length} bytes`);

    const secondRun = await uploadInBrowser(bench, tus.base, "walkthrough.webm", chunk, 0);
    check("the second attempt finished it", secondRun.done === true, secondRun.said || "");
    check("it resumed rather than restarting", secondRun.startedAt > 0, `carried on from byte ${secondRun.startedAt}`);
    const stored = tus.readOf("org/analysis/a/1-source.webm");
    check("and the bytes on the server are the file, exactly",
      stored.length === source.length && Buffer.compare(stored, source) === 0,
      `${stored.length} bytes, sha ${crypto.createHash("sha256").update(stored).digest("hex").slice(0, 12)}`);
  } finally {
    await tus.close();
    fs.rmSync(store, { recursive: true, force: true });
  }

  const real = bench.noise.filter((line) => !/ERR_CERT_AUTHORITY_INVALID|404 \(Not Found\)|favicon/.test(line));
  check("the page raised no errors of its own", real.length === 0, real.slice(0, 3).join(" | "));
} finally {
  await bench.close();
}

console.log("");
if (bad) { console.log(`  ${bad} FAILURE${bad === 1 ? "" : "S"}`); process.exit(1); }
console.log("  ALL OK");

/* ───────────────────────────────────────────────────────── the tus stand-in */

/* Just enough of tus 1.0.0 for the client to be exercised against the protocol
   rather than against a mock of itself: create, ask the offset, append. */
async function startTus(root) {
  const uploads = new Map();
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, "http://tus.local");
    const cors = { "tus-resumable": "1.0.0", "access-control-allow-origin": "*",
      "access-control-allow-headers": "*", "access-control-expose-headers": "*",
      "access-control-allow-methods": "POST,PATCH,HEAD,OPTIONS" };
    if (request.method === "OPTIONS") { response.writeHead(204, cors); return response.end(); }

    if (request.method === "POST" && url.pathname === "/storage/v1/upload/resumable") {
      const meta = Object.fromEntries(String(request.headers["upload-metadata"] || "").split(",")
        .map((pair) => pair.trim().split(" "))
        .map(([k, v]) => [k, Buffer.from(v || "", "base64").toString("utf8")]));
      const id = crypto.randomUUID();
      const file = path.join(root, `${id}.part`);
      fs.writeFileSync(file, Buffer.alloc(0));
      uploads.set(id, { file, name: `${meta.bucketName}/${meta.objectName}`, length: Number(request.headers["upload-length"]) });
      response.writeHead(201, { ...cors, location: `/storage/v1/upload/resumable/${id}` });
      return response.end();
    }
    const match = /^\/storage\/v1\/upload\/resumable\/([0-9a-f-]+)$/.exec(url.pathname);
    const held = match && uploads.get(match[1]);
    if (!held) { response.writeHead(404, cors); return response.end(); }
    const at = fs.statSync(held.file).size;
    if (request.method === "HEAD") {
      response.writeHead(200, { ...cors, "upload-offset": String(at), "upload-length": String(held.length) });
      return response.end();
    }
    if (request.method === "PATCH") {
      if (Number(request.headers["upload-offset"]) !== at) {
        response.writeHead(409, { ...cors, "upload-offset": String(at) });
        return response.end();
      }
      const parts = [];
      for await (const piece of request) parts.push(piece);
      fs.appendFileSync(held.file, Buffer.concat(parts));
      response.writeHead(204, { ...cors, "upload-offset": String(fs.statSync(held.file).size) });
      return response.end();
    }
    response.writeHead(405, cors); response.end();
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const find = (name) => [...uploads.values()].find((u) => u.name === name);
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    bytesOf: (name) => { const u = find(name); return u ? fs.statSync(u.file).size : 0; },
    readOf: (name) => { const u = find(name); return u ? fs.readFileSync(u.file) : Buffer.alloc(0); },
    close: () => new Promise((r) => server.close(r)),
  };
}

/* Runs the shipping upload client in the page. `cutAfter` chunks it aborts;
   zero means let it finish. */
function uploadInBrowser(bench, base, fixture, chunkBytes, cutAfter) {
  return bench.page.evaluate(async ({ url, name, endpoint, chunk, cut }) => {
    const { resumable, fileFrom } = window.MDAI_TEST;
    const file = await fileFrom(url, name, "video/webm");
    const controller = new AbortController();
    let chunks = 0;
    let startedAt = -1;
    try {
      await resumable.putResumable({
        supabaseUrl: endpoint, bucket: "org", objectName: "analysis/a/1-source.webm",
        file, accessToken: "a-signed-in-person", chunkBytes: chunk, signal: controller.signal,
        onProgress: ({ sent }) => {
          if (startedAt < 0) startedAt = sent;
          chunks += 1;
          if (cut && chunks > cut) controller.abort();
        },
      });
      return { done: true, startedAt, said: `${chunks} chunks` };
    } catch (error) {
      return { cut: true, startedAt, said: String(error?.name || error) };
    }
  }, { url: bench.fixtureUrl(fixture), name: fixture, endpoint: base, chunk: chunkBytes, cut: cutAfter });
}
