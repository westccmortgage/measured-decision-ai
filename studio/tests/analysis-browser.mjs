/* THE REAL PREPARATION, IN A REAL BROWSER, ON REAL FILES.
 *
 * Rendering a PDF page needs a canvas and taking a frame out of a clip needs a
 * decoder, so the code that does both runs in a browser and nowhere else. That
 * makes it exactly the code most likely to be tested against a stand-in, and a
 * stand-in here would prove nothing at all — which is why this helper starts
 * Chromium, serves the repository, and imports the SHIPPING modules from the
 * same paths the Studio loads them from.
 *
 * Two suites use it: the material suite next door, and the runner's own
 * acceptance test, which takes the bytes that come out of here and gives them
 * to the engine. Neither of them ever makes up a page image.
 *
 * WHAT THE TEST BROWSER CANNOT DO. Playwright's Chromium is built without the
 * proprietary codecs, so it cannot decode H.264. That is not worked around:
 * the WebM fixtures exercise the decoding path, and the H.264 fixtures are
 * kept precisely to prove the refusal names the codec. A person's own Chrome,
 * Safari or Edge decodes H.264, and that is checked on the deployed platform.
 */
import { chromium } from "/opt/node22/lib/node_modules/playwright/index.mjs";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/* From this file, not from the working directory: two suites in two
   directories use this helper and neither of them is run from the root. */
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const FIXTURES = path.join(REPO_ROOT, "studio/tests/fixtures/analysis");
export const CHROME = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";

const TYPES = {
  ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript",
  ".css": "text/css", ".json": "application/json", ".pdf": "application/pdf",
  ".webm": "video/webm", ".mp4": "video/mp4", ".png": "image/png",
};

export async function serveRepository(root = REPO_ROOT) {
  const server = http.createServer((request, response) => {
    let file = path.join(root, decodeURIComponent(request.url.split("?")[0]));
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, "index.html");
    if (!fs.existsSync(file)) { response.writeHead(404); return response.end(); }
    response.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream" });
    fs.createReadStream(file).pipe(response);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((r) => server.close(r)),
  };
}

export async function openBench() {
  const site = await serveRepository();
  const browser = await chromium.launch({
    executablePath: CHROME,
    args: ["--no-sandbox", "--no-proxy-server", "--autoplay-policy=no-user-gesture-required"],
  });
  const page = await browser.newPage();
  const noise = [];
  page.on("pageerror", (error) => noise.push(String(error?.message || error)));
  page.on("console", (message) => { if (message.type() === "error") noise.push(message.text()); });
  await page.goto(`${site.base}/studio/analysis/index.html`, { waitUntil: "domcontentloaded" });

  /* The shipping modules, from the paths the Studio itself uses. */
  await page.evaluate(async (base) => {
    const at = (name) => `${base}/studio/analysis/${name}`;
    window.MDAI_TEST = {
      formats: await import(at("formats.js")),
      plan: await import(at("plan.js")),
      prepare: await import(at("prepare.js")),
      resumable: await import(at("resumable.js")),
    };
    window.MDAI_TEST.fileFrom = async (url, name, type) => {
      const response = await fetch(url);
      const bytes = await response.arrayBuffer();
      return new File([bytes], name, { type, lastModified: 1700000000000 });
    };
  }, site.base);

  return {
    page, browser, site, noise,
    fixtureUrl: (name) => `${site.base}/studio/tests/fixtures/analysis/${name}`,
    async close() { await browser.close(); await site.close(); },
  };
}

/* Everything the record layer would get out of one PDF: the probe, and for
   every page the PNG bytes and whatever text the file carried. */
export async function preparePdfInBrowser(bench, fileName, { mediaType = "application/pdf" } = {}) {
  const produced = await bench.page.evaluate(async ({ url, name, type }) => {
    const { prepare, plan, formats, fileFrom } = window.MDAI_TEST;
    const file = await fileFrom(url, name, type);
    const early = formats.nameAndSizeRefusal("pdf", file);
    if (early) return { refusal: early };
    const opened = await prepare.probePdf(await file.arrayBuffer());
    const refusal = formats.probeRefusal("pdf", file, { pages: opened.pages, encrypted: opened.encrypted, reason: opened.reason });
    if (refusal) return { refusal };
    const pages = [];
    for (const { page } of plan.pagePlan(opened.pages)) {
      const rendered = await prepare.renderPdfPage(opened.document, page, { limitBytes: formats.MAXIMUM_PART_BYTES });
      const text = await prepare.pdfPageText(opened.document, page);
      const buffer = new Uint8Array(await rendered.blob.arrayBuffer());
      let binary = "";
      for (const byte of buffer) binary += String.fromCharCode(byte);
      pages.push({
        page, text,
        pngBase64: btoa(binary),
        bytes: rendered.blob.size,
        pixelWidth: rendered.pixelWidth, pixelHeight: rendered.pixelHeight,
        pointWidth: rendered.pointWidth, pointHeight: rendered.pointHeight,
        withinLimit: rendered.withinLimit, reduced: rendered.reduced,
      });
    }
    return { probe: { pages: opened.pages }, pages, fileBytes: file.size, mediaType: type };
  }, { url: bench.fixtureUrl(fileName), name: fileName, type: mediaType });
  if (produced.pages) for (const p of produced.pages) p.png = Buffer.from(p.pngBase64, "base64");
  return produced;
}

/* Everything the record layer would get out of one clip: the probe, and for
   every sampled moment the PNG bytes and the second the decoder landed on. */
export async function prepareVideoInBrowser(bench, fileName, kind = "video", { mediaType = "video/webm", maximumMoments } = {}) {
  const produced = await bench.page.evaluate(async ({ url, name, type, kind: k, maximumMoments: cap }) => {
    const { prepare, plan, formats, fileFrom } = window.MDAI_TEST;
    const file = await fileFrom(url, name, type);
    const early = formats.nameAndSizeRefusal(k, file);
    if (early) return { refusal: early };
    const probe = await prepare.probeVideo(file);
    const refusal = formats.probeRefusal(k, file, probe);
    if (refusal) return { refusal, probe };
    const open = await prepare.openVideo(file);
    try {
      const moments = plan.momentPlan(open.durationSeconds, {
        maximumMoments: cap ?? formats.KINDS[k].maximumParts,
      });
      const frames = [];
      for (const moment of moments) {
        const frame = await prepare.captureFrame(open, moment.seconds, { limitBytes: formats.MAXIMUM_PART_BYTES });
        if (!frame.ok) return { failedAt: moment.seconds, reason: frame.reason };
        const buffer = new Uint8Array(await frame.blob.arrayBuffer());
        let binary = "";
        for (const byte of buffer) binary += String.fromCharCode(byte);
        /* Measured off the PNG THAT WILL BE STORED, decoded again, not off the
           canvas it was drawn on. It is how a test can say "this frame came
           from that second" about a real file rather than about a promise. */
        const bitmap = await createImageBitmap(frame.blob);
        const sheet = new OffscreenCanvas(bitmap.width, bitmap.height);
        const paint = sheet.getContext("2d");
        paint.drawImage(bitmap, 0, 0);
        const pixels = paint.getImageData(0, 0, bitmap.width, bitmap.height).data;
        let red = 0, orange = 0;
        for (let i = 0; i < pixels.length; i += 4) {
          const [r, g, b] = [pixels[i], pixels[i + 1], pixels[i + 2]];
          if (r > 150 && g < 110 && b < 100) red += 1;
          if (r > 190 && g > 110 && g < 200 && b < 110) orange += 1;
        }
        const total = bitmap.width * bitmap.height;

        frames.push({
          ordinal: moment.ordinal,
          redFraction: red / total,
          orangeFraction: orange / total,
          requestedSeconds: frame.requestedSeconds,
          actualSeconds: frame.actualSeconds,
          pngBase64: btoa(binary),
          bytes: frame.blob.size,
          pixelWidth: frame.pixelWidth, pixelHeight: frame.pixelHeight,
          withinLimit: frame.withinLimit,
        });
      }
      return {
        probe: {
          durationSeconds: open.durationSeconds, width: open.width, height: open.height,
          equirectangular: k === "video360",
          momentsRead: frames.map((f) => ({ ordinal: f.ordinal, seconds: f.actualSeconds })),
        },
        frames, fileBytes: file.size, mediaType: type,
      };
    } finally { open.close(); }
  }, { url: bench.fixtureUrl(fileName), name: fileName, type: mediaType, kind, maximumMoments });
  if (produced.frames) for (const f of produced.frames) f.png = Buffer.from(f.pngBase64, "base64");
  return produced;
}

/* Asks the browser what a particular file would be refused for, without
   preparing anything. */
export async function refusalFor(bench, kind, fileName, mediaType) {
  return bench.page.evaluate(async ({ url, name, type, kind: k }) => {
    const { prepare, formats, fileFrom } = window.MDAI_TEST;
    const file = await fileFrom(url, name, type);
    const early = formats.nameAndSizeRefusal(k, file);
    if (early) return { stage: "name", refusal: early };
    if (k === "pdf") {
      const opened = await prepare.probePdf(await file.arrayBuffer());
      return { stage: "probe", refusal: formats.probeRefusal(k, file, { pages: opened.pages, encrypted: opened.encrypted, reason: opened.reason }) };
    }
    const probe = await prepare.probeVideo(file);
    return { stage: "probe", probe, refusal: formats.probeRefusal(k, file, probe) };
  }, { url: bench.fixtureUrl(fileName), name: fileName, type: mediaType, kind });
}
