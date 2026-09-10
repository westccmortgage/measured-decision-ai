/* TURNING A FILE INTO PIECES A READER CAN ACTUALLY BE GIVEN.
 *
 * WHY THIS RUNS IN THE BROWSER. Rasterising a PDF page needs a canvas, and
 * decoding an MP4 needs a video decoder. This deployment has neither on the
 * server: an Edge Function has no canvas and no ffmpeg, and putting a whole
 * file through one short HTTP call is exactly the shape that fails on the
 * files that matter. The browser already has both, and the tab the owner is
 * looking at is the cheapest correct place to do it.
 *
 * WHAT THAT COSTS, SAID PLAINLY. Preparation needs this tab open. It does not
 * need it open for long, it does not need it open twice, and nothing is lost
 * if it closes: every page image and every frame is uploaded and recorded the
 * moment it is made, so coming back resumes at the first piece that is not in
 * the record. The analysis itself — the readings, the checking, the result —
 * runs on the server after the press, and needs no tab at all.
 *
 * WHAT IS WRITTEN DOWN. For a page: the page number, the pixel size the image
 * was actually reduced to, and the page's own point size, so a fragment can
 * be pointed at in the original. For a frame: the second the decoder actually
 * landed on, which is not always the second that was asked for.
 */
import { MAXIMUM_PART_BYTES } from "./formats.js";

const HERE = new URL(".", import.meta.url);

/* ─────────────────────────────────────────────────────────────────── PDF */

let pdfjsPromise = null;
export function loadPdfJs() {
  if (!pdfjsPromise) {
    pdfjsPromise = import(new URL("../vendor/pdfjs/pdf.min.mjs", HERE).href).then((lib) => {
      lib.GlobalWorkerOptions.workerSrc = new URL("../vendor/pdfjs/pdf.worker.min.mjs", HERE).href;
      return lib;
    });
  }
  return pdfjsPromise;
}

/* Opens the bytes and says what is in them. It never throws for a bad file:
   a refusal a person can act on is the product here. */
export async function probePdf(bytes) {
  try {
    const pdfjs = await loadPdfJs();
    const document = await pdfjs.getDocument({ data: bytes, isEvalSupported: false }).promise;
    return { ok: true, pages: document.numPages, encrypted: false, document };
  } catch (error) {
    const message = String(error?.message || error);
    if (/password/i.test(message)) return { ok: false, pages: 0, encrypted: true, reason: message };
    return { ok: false, pages: 0, encrypted: false, reason: message.slice(0, 200) };
  }
}

/* The page as a PNG small enough to be sent, plus what it took to get there.
   A provider is declared to accept a quarter of a megabyte for one piece of
   material; a plan sheet at full resolution is many times that, so the image
   is reduced until it fits and the size it ended at is recorded beside it.
   That number is not decoration: it is how much of the sheet a reader could
   possibly have seen. */
export async function renderPdfPage(document, pageNumber, options = {}) {
  const limit = options.limitBytes ?? MAXIMUM_PART_BYTES;
  const page = await document.getPage(pageNumber);
  const base = page.getViewport({ scale: 1 });
  const canvas = createCanvas();
  const context = canvas.getContext("2d", { willReadFrequently: false });

  let width = Math.min(options.startWidth ?? 1700, Math.max(700, Math.round(base.width * 2)));
  let grey = false;
  let blob = null;
  for (let attempt = 0; attempt < 9; attempt += 1) {
    const scale = width / base.width;
    const viewport = page.getViewport({ scale });
    canvas.width = Math.max(1, Math.round(viewport.width));
    canvas.height = Math.max(1, Math.round(viewport.height));
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.filter = grey ? "grayscale(1)" : "none";
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: context, viewport, background: "#ffffff" }).promise;
    blob = await toPng(canvas);
    if (blob.size <= limit) break;
    if (width > 900) width = Math.round(width * 0.75);
    else if (!grey) { grey = true; }
    else if (width > 560) width = Math.round(width * 0.8);
    else break;
  }
  return {
    blob,
    pixelWidth: canvas.width,
    pixelHeight: canvas.height,
    pointWidth: Math.round(base.width),
    pointHeight: Math.round(base.height),
    reduced: grey,
    withinLimit: blob.size <= limit,
  };
}

/* Whatever text the PDF itself carries for that page. A scan carries none,
   and none is a fact worth recording rather than an error: it is why the page
   image is the material and why a reader is told to quote what it sees. */
export async function pdfPageText(document, pageNumber) {
  try {
    const page = await document.getPage(pageNumber);
    const content = await page.getTextContent();
    /* LINES, NOT A WALL OF WORDS.
     *
     * pdf.js hands back one item per run of glyphs, in no particular order and
     * with no line breaks. Joining them with spaces produces a page whose
     * every statement runs into the next — "CEILING HEIGHT 2700 DOOR SCHEDULE
     * REF" — and a reader given that cannot say which words belong together,
     * let alone quote a line.
     *
     * Each item carries its own position. Items sharing a baseline are a line;
     * lines run down the page; words run across it. That is all this does, and
     * it is what makes a quotation from a page mean something. */
    const rows = new Map();
    for (const item of content.items || []) {
      const text = item.str ?? "";
      if (!text.trim()) continue;
      const transform = item.transform || [];
      const y = Math.round(Number(transform[5] ?? 0));
      const x = Number(transform[4] ?? 0);
      /* Two baselines within a couple of points are the same line: superscripts
         and mixed font sizes sit a hair off their neighbours. */
      let key = y;
      for (const existing of rows.keys()) if (Math.abs(existing - y) <= 2) { key = existing; break; }
      const row = rows.get(key) ?? [];
      row.push({ x, text });
      rows.set(key, row);
    }
    return [...rows.entries()]
      .sort((a, b) => b[0] - a[0])
      .map(([, row]) => row.sort((a, b) => a.x - b.x).map((w) => w.text).join(" ").replace(/[ \t]+/g, " ").trim())
      .filter(Boolean)
      .join("\n")
      .trim();
  } catch {
    return "";
  }
}

/* ───────────────────────────────────────────────────────────────── video */

/* Opens the file in a real decoder and reports what came back. `decodable` is
   the browser's own answer to "can you show me a picture from this", asked by
   seeking to the first frame and drawing it — not by asking canPlayType,
   which guesses from the container and is wrong about exactly the .mov files
   people actually have. */
export async function probeVideo(file, options = {}) {
  const element = createVideo();
  const url = URL.createObjectURL(file);
  try {
    const loaded = await once(element, url, ["loadedmetadata"], options.timeoutMs ?? 30000);
    if (!loaded.ok) {
      return { ok: false, decodable: false, durationSeconds: 0, width: 0, height: 0, reason: loaded.reason };
    }
    const durationSeconds = Number(element.duration);
    const width = Number(element.videoWidth) || 0;
    const height = Number(element.videoHeight) || 0;
    if (!(width > 0 && height > 0)) {
      return {
        ok: false, decodable: false, width, height,
        durationSeconds: Number.isFinite(durationSeconds) ? durationSeconds : 0,
        reason: "the container opened but carries no picture this browser can decode",
      };
    }
    /* One real frame, so "decodable" means a picture actually arrived. */
    const first = await seekAndDraw(element, 0, options.timeoutMs ?? 30000);
    if (!first.ok) {
      return { ok: false, decodable: false, width, height, durationSeconds, reason: first.reason };
    }
    return {
      ok: true, decodable: true, width, height,
      durationSeconds: Number.isFinite(durationSeconds) ? durationSeconds : 0,
      reason: "",
    };
  } finally {
    URL.revokeObjectURL(url);
    element.removeAttribute("src");
    try { element.load(); } catch { /* the element is going away anyway */ }
  }
}

/* An open clip that frames can be taken out of, one at a time, without
   reloading it between them. Close it when the file is finished. */
export async function openVideo(file, options = {}) {
  const element = createVideo();
  const url = URL.createObjectURL(file);
  const loaded = await once(element, url, ["loadedmetadata"], options.timeoutMs ?? 30000);
  if (!loaded.ok) {
    URL.revokeObjectURL(url);
    throw new Error(loaded.reason);
  }
  return {
    element,
    durationSeconds: Number(element.duration) || 0,
    width: Number(element.videoWidth) || 0,
    height: Number(element.videoHeight) || 0,
    close() {
      URL.revokeObjectURL(url);
      element.removeAttribute("src");
      try { element.load(); } catch { /* going away */ }
    },
  };
}

/* THE FRAME, AND THE SECOND IT REALLY CAME FROM.
   A decoder seeks to a frame it can decode, which is not always the second it
   was asked for. Recording the asked-for second as if it were the frame's own
   is how a result ends up pointing at a moment that never existed, so both
   are returned and the record keeps the real one. */
export async function captureFrame(open, seconds, options = {}) {
  const limit = options.limitBytes ?? MAXIMUM_PART_BYTES;
  const drawn = await seekAndDraw(open.element, seconds, options.timeoutMs ?? 30000);
  if (!drawn.ok) return { ok: false, reason: drawn.reason };

  const canvas = createCanvas();
  const context = canvas.getContext("2d", { willReadFrequently: false });
  let width = Math.min(options.startWidth ?? 1280, open.width || 1280);
  let grey = false;
  let blob = null;
  for (let attempt = 0; attempt < 9; attempt += 1) {
    const scale = width / (open.width || width);
    canvas.width = Math.max(1, Math.round(width));
    canvas.height = Math.max(1, Math.round((open.height || width / 2) * scale));
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.filter = grey ? "grayscale(1)" : "none";
    context.drawImage(open.element, 0, 0, canvas.width, canvas.height);
    blob = await toPng(canvas);
    if (blob.size <= limit) break;
    if (width > 800) width = Math.round(width * 0.75);
    else if (!grey) { grey = true; }
    else if (width > 480) width = Math.round(width * 0.8);
    else break;
  }
  return {
    ok: true,
    blob,
    /* The decoder's own answer, not the request. */
    actualSeconds: Math.round(Number(open.element.currentTime) * 1000) / 1000,
    requestedSeconds: Math.round(Number(seconds) * 1000) / 1000,
    pixelWidth: canvas.width,
    pixelHeight: canvas.height,
    sourceWidth: open.width,
    sourceHeight: open.height,
    reduced: grey,
    withinLimit: blob.size <= limit,
  };
}

/* ────────────────────────────────────────────────────────── the plumbing */

function createCanvas() {
  return window.document.createElement("canvas");
}

function createVideo() {
  const element = window.document.createElement("video");
  element.muted = true;
  element.playsInline = true;
  element.preload = "auto";
  /* A same-origin blob: URL, so the canvas stays untainted and toBlob works. */
  element.crossOrigin = "anonymous";
  return element;
}

function toPng(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("the browser could not encode this image"))), "image/png");
  });
}

function once(element, url, events, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      for (const name of events) element.removeEventListener(name, onGood);
      element.removeEventListener("error", onBad);
      resolve(value);
    };
    const onGood = () => finish({ ok: true, reason: "" });
    const onBad = () => {
      const code = element.error?.code;
      const said = {
        1: "the browser stopped loading it",
        2: "the file could not be read",
        3: "the picture could not be decoded — the codec is one this browser does not have",
        4: "this browser does not support this file's format",
      }[code] || "the browser refused it without saying why";
      finish({ ok: false, reason: said });
    };
    const timer = setTimeout(() => finish({ ok: false, reason: `nothing came back within ${Math.round(timeoutMs / 1000)} seconds` }), timeoutMs);
    for (const name of events) element.addEventListener(name, onGood);
    element.addEventListener("error", onBad);
    element.src = url;
    try { element.load(); } catch { /* some browsers do not need it */ }
  });
}

function seekAndDraw(element, seconds, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      element.removeEventListener("seeked", onSeeked);
      element.removeEventListener("error", onError);
      resolve(value);
    };
    const onSeeked = () => {
      /* readyState 2 is HAVE_CURRENT_DATA: there is a frame at this time. */
      if (element.readyState >= 2) finish({ ok: true, reason: "" });
      else finish({ ok: false, reason: `no frame was decoded at ${seconds}s` });
    };
    const onError = () => finish({ ok: false, reason: element.error?.code === 3
      ? "the picture could not be decoded — the codec is one this browser does not have"
      : "the browser stopped decoding this clip" });
    const timer = setTimeout(() => finish({ ok: false, reason: `the decoder did not reach ${seconds}s within ${Math.round(timeoutMs / 1000)} seconds` }), timeoutMs);
    element.addEventListener("seeked", onSeeked);
    element.addEventListener("error", onError);
    try {
      const target = Math.max(0, Math.min(Number(seconds) || 0, Math.max(0, (Number(element.duration) || 0) - 0.03)));
      if (Math.abs(element.currentTime - target) < 0.001 && element.readyState >= 2) onSeeked();
      else element.currentTime = target;
    } catch (error) {
      finish({ ok: false, reason: String(error?.message || error).slice(0, 200) });
    }
  });
}
