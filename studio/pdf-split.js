/* Measured Decision · a plan set larger than one AI reading, split into parts.
 *
 * The provider accepts one file of at most 50 MB and about a hundred pages
 * per request. A 200 MB submittal set is neither, and no constant on our side
 * changes that: raise our limit and the failure simply moves from our screen
 * to theirs. What CAN change is the shape of what we send.
 *
 * So the browser — which already holds the PDF at upload — copies its pages
 * into parts that each fit, and stores every part as a derived document
 * beside the original. The original is never touched. Each part remembers
 * which pages of which file it is, so a citation of "page 137" is still page
 * 137 of the set the owner uploaded, and the existing set chunking reads the
 * parts exactly as it reads any other documents.
 *
 * Two honest limits stay. A part is copied with everything its pages need,
 * so a set whose bulk is one enormous shared image can produce parts nearly
 * as large as the whole; a range that comes out too big is halved until it
 * fits, and a single page that does not fit on its own is reported by
 * number, not hidden. And splitting is a browser job: it needs the file in
 * memory twice, which a desktop affords and a phone may not — the failure is
 * said out loud and the original stays exactly where it was.
 */
(() => {
  /* Under the provider's 50 MB and ~100 pages, with room for the part's own
     copied resources and the request envelope around it. */
  const PART_MAX_BYTES = 45 * 1024 * 1024;
  const PART_MAX_PAGES = 90;
  const SCRIPT_URL = (typeof document !== "undefined" && document.currentScript?.src) || "";

  /* Pure geometry, tested on its own: which pages go in which part.
     Pages are 1-based and inclusive, in order, with nothing skipped and
     nothing repeated. The byte estimate is an average per page — only a
     guess, which is why splitPdf re-checks every part after it is written. */
  function planParts({ pageCount, byteSize, maxBytes = PART_MAX_BYTES, maxPages = PART_MAX_PAGES }) {
    const pages = Math.max(0, Math.floor(Number(pageCount) || 0));
    if (!pages) return [];
    const perPage = Math.max(1, Math.ceil((Number(byteSize) || 0) / pages));
    const byBytes = Math.max(1, Math.floor(maxBytes / perPage));
    const span = Math.max(1, Math.min(maxPages, byBytes));
    const parts = [];
    for (let from = 1; from <= pages; from += span) {
      parts.push({ from, to: Math.min(pages, from + span - 1) });
    }
    return parts;
  }

  /* The name a part wears — the original's name with its page range, so a
     person and a model both read it as a piece of one set. */
  function partFilename(originalName, from, to) {
    const name = String(originalName || "document.pdf");
    const stem = name.replace(/\.pdf$/i, "");
    return `${stem} (pages ${from}-${to}).pdf`;
  }

  /* What a derived document remembers about where it came from. */
  function derivedFrom({ documentId, from, to, pagesTotal, part, parts }) {
    return { document_id: documentId, page_from: from, page_to: to, pages_total: pagesTotal, part, parts };
  }

  async function loadPdfLib() {
    if (typeof window === "undefined") throw new Error("PDF splitting needs a browser");
    if (window.PDFLib?.PDFDocument) return window.PDFLib;
    await new Promise((resolve, reject) => {
      const script = window.document.createElement("script");
      script.src = new URL("vendor/pdf-lib/pdf-lib.min.js", SCRIPT_URL).href;
      script.onload = resolve;
      script.onerror = () => reject(new Error("The PDF page-copy library did not load"));
      window.document.head.appendChild(script);
    });
    if (!window.PDFLib?.PDFDocument) throw new Error("The PDF page-copy library did not load");
    return window.PDFLib;
  }

  /* Copies one page range into a new PDF and returns its bytes. */
  async function copyRange(PDFDocument, source, from, to) {
    const target = await PDFDocument.create();
    const indices = [];
    for (let page = from; page <= to; page += 1) indices.push(page - 1);
    const pages = await target.copyPages(source, indices);
    for (const page of pages) target.addPage(page);
    return target.save({ useObjectStreams: true });
  }

  /* Splits a PDF's bytes into parts that each fit. Never modifies `bytes`.
     Returns { parts: [{ from, to, bytes }], skipped: [pageNumber…], pageCount }.
     A range that comes out over the limit is halved and retried; a single
     page that is over the limit on its own is skipped and reported. */
  async function splitPdf({ bytes, byteSize, maxBytes = PART_MAX_BYTES, maxPages = PART_MAX_PAGES, onProgress = () => {}, lib = null }) {
    const PDFLib = lib || await loadPdfLib();
    const source = await PDFLib.PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
    const pageCount = source.getPageCount();
    const queue = planParts({ pageCount, byteSize: byteSize ?? bytes.byteLength, maxBytes, maxPages });
    const parts = [];
    const skipped = [];
    while (queue.length) {
      const range = queue.shift();
      onProgress(`Copying pages ${range.from}–${range.to} of ${pageCount}…`);
      const out = await copyRange(PDFLib.PDFDocument, source, range.from, range.to);
      if (out.byteLength <= maxBytes) {
        parts.push({ from: range.from, to: range.to, bytes: out });
        continue;
      }
      if (range.from === range.to) {
        skipped.push(range.from);
        continue;
      }
      /* Too big even after copying: halve, and put both halves back at the
         front so the output stays in page order. */
      const middle = Math.floor((range.from + range.to) / 2);
      queue.unshift({ from: range.from, to: middle }, { from: middle + 1, to: range.to });
    }
    return { parts, skipped, pageCount };
  }

  const api = { planParts, partFilename, derivedFrom, splitPdf, loadPdfLib, PART_MAX_BYTES, PART_MAX_PAGES };
  if (typeof window !== "undefined") window.MDAIPdfSplit = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
