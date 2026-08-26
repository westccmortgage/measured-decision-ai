/* Measured Decision · high-resolution plan page renders.
 *
 * Why this exists: the AI reads plan PDFs through the provider's own
 * rasteriser, which draws an E-size sheet small enough that a FINISH LEGEND
 * in 3/32" text is physically not in the pixels. Three field runs in a row
 * came back "not printed" for things that were printed. No contract wording
 * fixes pixels that are not there.
 *
 * So the browser — which already holds the PDF — renders every page at
 * drawing-desk resolution before analysis, cuts each page into tiles a
 * vision model can actually read, and stores them next to the project's
 * documents. The originals are never touched: tiles are derived copies under
 * their own prefix, and a re-issued sheet is a new document with new tiles.
 *
 * Every failure here falls back to PDF-only analysis, said out loud —
 * a phone that cannot afford the canvas still gets an answer, not a wall.
 */
(() => {
  /* ~200 dpi reads 3/32" schedule text; tiles stay under 4000px on a side so
     the canvas fits every browser this product supports, phones included. */
  const TARGET_DPI = 200;
  const MAX_TILE_PX = 4000;
  const OVERVIEW_PX = 1600;
  const JPEG_QUALITY = 0.8;
  const BUCKET = "project-documents";
  /* This file is a classic script, not a module: the pdf.js module URLs are
     resolved against this script's own address, captured while it loads. */
  const SCRIPT_URL = (typeof document !== "undefined" && document.currentScript?.src) || "";

  /* Pure geometry, tested by hand: how one page becomes tiles.
     PDF user space is 72 units per inch. */
  function tileLayout(widthPt, heightPt) {
    const scale = TARGET_DPI / 72;
    const width = Math.ceil(widthPt * scale);
    const height = Math.ceil(heightPt * scale);
    const cols = Math.max(1, Math.ceil(width / MAX_TILE_PX));
    const rows = Math.max(1, Math.ceil(height / MAX_TILE_PX));
    const tiles = [];
    for (let row = 0; row < rows; row += 1) {
      for (let col = 0; col < cols; col += 1) {
        const x = col * Math.ceil(width / cols);
        const y = row * Math.ceil(height / rows);
        tiles.push({
          row, col,
          x, y,
          width: Math.min(Math.ceil(width / cols), width - x),
          height: Math.min(Math.ceil(height / rows), height - y),
        });
      }
    }
    const overviewScale = Math.min(1, OVERVIEW_PX / Math.max(widthPt, heightPt));
    return { scale, width, height, rows, cols, tiles, overviewScale };
  }

  function tileName(page, layout, tile) {
    if (layout.rows === 1 && layout.cols === 1) return `p${page}-full.jpg`;
    return `p${page}-r${tile.row + 1}c${tile.col + 1}.jpg`;
  }

  async function canvasJpeg(canvas) {
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", JPEG_QUALITY));
    if (!blob) throw new Error("The browser could not encode the page image");
    return blob;
  }

  async function loadPdfJs() {
    const lib = await import(new URL("vendor/pdfjs/pdf.min.mjs", SCRIPT_URL).href);
    lib.GlobalWorkerOptions.workerSrc = new URL("vendor/pdfjs/pdf.worker.min.mjs", SCRIPT_URL).href;
    return lib;
  }

  async function uploadTile(client, path, blob) {
    const { error } = await client.storage.from(BUCKET).upload(path, blob, { contentType: "image/jpeg" });
    /* Already there from an interrupted earlier pass: that is the same file
       content (same document, same geometry), not a conflict. */
    if (error && !/already exists|duplicate/i.test(error.message || "")) throw error;
  }

  /* Renders and stores every page of one project document, once. Returns
     { ok, rendered, reason } — ok:false means analysis proceeds PDF-only. */
  async function ensure({ client, document: documentRow, organizationId, propertyId, onProgress = () => {} }) {
    try {
      const existing = await client.from("plan_page_renders")
        .select("document_id, pages").eq("document_id", documentRow.id).maybeSingle();
      if (existing.data) return { ok: true, rendered: false };

      onProgress(`Preparing high-resolution pages of ${documentRow.original_filename}…`);
      let url = "";
      if (documentRow.storage_provider === "aws-s3") {
        url = await window.MDAIObjectStorage.getSignedUrl(client, "project_document", documentRow.id);
      } else {
        const { data, error } = await client.storage.from(documentRow.storage_bucket || BUCKET)
          .createSignedUrl(documentRow.storage_path, 600);
        if (error || !data?.signedUrl) throw error || new Error("No signed URL for the plan PDF");
        url = data.signedUrl;
      }
      const response = await fetch(url);
      if (!response.ok) throw new Error(`The plan PDF could not be read (${response.status})`);
      const bytes = await response.arrayBuffer();

      const pdfjs = await loadPdfJs();
      const pdf = await pdfjs.getDocument({ data: bytes }).promise;
      const prefix = `${organizationId}/page-renders/${documentRow.id}`;
      const canvas = window.document.createElement("canvas");
      const context = canvas.getContext("2d", { willReadFrequently: false });

      for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
        const page = await pdf.getPage(pageNumber);
        const base = page.getViewport({ scale: 1 });
        const layout = tileLayout(base.width, base.height);
        onProgress(`Rendering ${documentRow.original_filename} — sheet ${pageNumber} of ${pdf.numPages}…`);

        for (const tile of layout.tiles) {
          canvas.width = tile.width;
          canvas.height = tile.height;
          const viewport = page.getViewport({ scale: layout.scale, offsetX: -tile.x, offsetY: -tile.y });
          await page.render({ canvasContext: context, viewport }).promise;
          await uploadTile(client, `${prefix}/${tileName(pageNumber, layout, tile)}`, await canvasJpeg(canvas));
        }
        if (layout.tiles.length > 1) {
          const overview = page.getViewport({ scale: layout.overviewScale });
          canvas.width = Math.ceil(overview.width);
          canvas.height = Math.ceil(overview.height);
          await page.render({ canvasContext: context, viewport: overview }).promise;
          await uploadTile(client, `${prefix}/p${pageNumber}-full.jpg`, await canvasJpeg(canvas));
        }
        page.cleanup();
      }

      const pages = pdf.numPages;
      await pdf.destroy();
      canvas.width = 1; canvas.height = 1;
      const { error: recordError } = await client.from("plan_page_renders").insert({
        document_id: documentRow.id,
        organization_id: organizationId,
        property_id: propertyId,
        pages,
        target_dpi: TARGET_DPI,
      });
      if (recordError && !/duplicate/i.test(recordError.message || "")) throw recordError;
      return { ok: true, rendered: true, pages };
    } catch (error) {
      console.warn("page renders unavailable", error);
      return { ok: false, rendered: false, reason: error?.message || "The page renderer failed" };
    }
  }

  const api = { ensure, tileLayout, tileName, TARGET_DPI, MAX_TILE_PX };
  if (typeof window !== "undefined") window.MDAIPageRenders = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
