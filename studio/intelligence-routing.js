/* Measured Decision · source routing for the Project Intelligence Core.
 *
 * Nobody picks an AI agent. A source declares itself by what it is — its
 * type, its mime, its declared document discipline — and the router sends it
 * to the channel that owns it:
 *
 *   plans and specifications      → TECHNICAL_INTELLIGENCE (plan-analyze)
 *   360 / photo / video           → VISUAL_EVIDENCE (evidence pipeline + GPU
 *                                    worker for 360, exactly as today)
 *   invoices / tickets / receipts → the document-evidence worker, inside the
 *                                    visual/reality contour
 *   a mixed PDF                   → per-page classification downstream
 *
 * One source may feed both channels; the router names the primary door.
 */
(() => {
  const TECHNICAL_DOCUMENT_TYPES = new Set([
    "architectural", "structural", "mechanical", "electrical", "plumbing",
    "civil", "landscape", "specification", "schedule", "permit", "addendum", "change_order",
  ]);
  const DOCUMENTARY_HINTS = /invoice|receipt|delivery|ticket|packing|bill of lading|purchase order/i;

  function routeSource({ filename = "", mime = "", document_type = "" } = {}) {
    const name = String(filename).toLowerCase();
    const type = String(mime).toLowerCase();
    if (type.startsWith("image/") || type.startsWith("video/") || /\.(insv|insp|jpe?g|png|heic|mp4|mov)$/.test(name)) {
      return { channel: "visual", worker: /insv|insp/.test(name) ? "gpu-360" : "evidence", reason: "camera media belongs to the visual evidence channel" };
    }
    if (DOCUMENTARY_HINTS.test(name) || document_type === "invoice") {
      return { channel: "documents", worker: "document-evidence", reason: "delivery paperwork is documentary evidence, not a plan" };
    }
    if (TECHNICAL_DOCUMENT_TYPES.has(String(document_type))) {
      return { channel: "technical", worker: "plan-analyze", reason: "a plan discipline routes to technical intelligence" };
    }
    if (type === "application/pdf" || name.endsWith(".pdf")) {
      return { channel: "mixed", worker: "per-page-classification", reason: "an undeclared PDF is classified page by page" };
    }
    return { channel: "visual", worker: "evidence", reason: "field material defaults to the evidence record" };
  }

  const api = { routeSource };
  if (typeof window !== "undefined") window.MDAIIntelligenceRouting = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
