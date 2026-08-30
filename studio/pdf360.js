/* Measured Decision · a small, honest PDF writer.
 *
 * The owner report leaves the building as a document anyone can open, with
 * no vendored PDF library: a text-only PDF is a handful of numbered objects,
 * two standard fonts, and an xref table whose byte offsets must simply be
 * true. Everything here is deterministic — the same record produces the same
 * bytes — which is what makes it testable, exactly like the XLSX writer.
 *
 * Supported on purpose: pages of text lines with size, bold, indent, rule
 * separators, and columns — a material list is a table, and a table whose
 * numbers do not line up is a list nobody trusts. Not supported on purpose:
 * images, forms, links — a verification record carries statements and their
 * provenance, not decoration. Text is WinAnsi (Latin-1); a character outside
 * it becomes '?' rather than silently vanishing.
 */
(() => {
  const PAGE_WIDTH = 612;   // US Letter, points
  const PAGE_HEIGHT = 792;
  const MARGIN = 54;
  const encoder = new TextEncoder();

  function pdfEscape(value) {
    let out = "";
    for (const ch of String(value ?? "")) {
      const code = ch.codePointAt(0);
      if (ch === "\\" || ch === "(" || ch === ")") out += `\\${ch}`;
      else if (code >= 32 && code <= 255) out += code > 126 ? `\\${code.toString(8).padStart(3, "0")}` : ch;
      else out += "?";
    }
    return out;
  }

  /* lines: [{ text, size?, bold?, indent?, rule?, gap?, cells? }].
     rule: true draws a horizontal separator; gap: extra points of space
     before the line. Long lines wrap on an estimated character budget —
     Helvetica averages ~0.5em per character, and a conservative budget
     keeps every wrapped line inside the margins.

     cells: [{ text, x, bold?, align? }] places each cell at its own point
     offset from the left margin, so quantities sit under quantities down
     the whole page. A right-aligned cell is nudged back by its estimated
     width — Helvetica has no metrics table here, and half an em per
     character is close enough that a column of numbers reads as a column.
     A cell that would collide with the next one is trimmed with an ellipsis
     rather than allowed to run through its neighbour. */
  const CHAR_EM = 0.5;
  const textWidth = (text, size) => String(text ?? "").length * size * CHAR_EM;
  function fitCell(text, size, room) {
    let shown = String(text ?? "");
    if (room <= 0) return "";
    while (shown.length > 1 && textWidth(shown, size) > room) shown = shown.slice(0, -1);
    return shown.length < String(text ?? "").length ? `${shown.slice(0, -1)}...` : shown;
  }
  function layout(lines) {
    const pages = [];
    let cursor = PAGE_HEIGHT - MARGIN;
    let ops = [];
    const newPage = () => {
      if (ops.length) pages.push(ops);
      ops = [];
      cursor = PAGE_HEIGHT - MARGIN;
    };
    newPage();
    for (const line of lines) {
      const size = line.size || 10;
      const leading = Math.round(size * 1.45);
      const indent = MARGIN + (line.indent || 0);
      if (line.gap) cursor -= line.gap;
      if (line.rule) {
        if (cursor - 8 < MARGIN) newPage();
        cursor -= 4;
        ops.push(`0.75 w ${MARGIN} ${cursor} m ${PAGE_WIDTH - MARGIN} ${cursor} l S`);
        cursor -= 8;
        continue;
      }
      if (Array.isArray(line.cells) && line.cells.length) {
        if (cursor - leading < MARGIN) newPage();
        cursor -= leading;
        const cells = line.cells;
        for (const [index, cell] of cells.entries()) {
          const start = MARGIN + (cell.x || 0);
          /* How much room this cell has before the next one begins. The
             last cell runs to the right margin. */
          const next = cells[index + 1];
          const limit = next ? MARGIN + (next.x || 0) - 6 : PAGE_WIDTH - MARGIN;
          const shown = fitCell(cell.text, size, limit - start);
          if (!shown) continue;
          const at = cell.align === "right"
            ? Math.max(start, limit - textWidth(shown, size))
            : start;
          ops.push(`BT /${cell.bold || line.bold ? "F2" : "F1"} ${size} Tf ${Math.round(at)} ${cursor} Td (${pdfEscape(shown)}) Tj ET`);
        }
        continue;
      }
      const budget = Math.max(20, Math.floor((PAGE_WIDTH - MARGIN - indent) / (size * 0.5)));
      const words = String(line.text ?? "").split(/\s+/).filter(Boolean);
      const rows = [];
      let row = "";
      for (const word of words) {
        if (row && (row.length + 1 + word.length) > budget) { rows.push(row); row = word; }
        else row = row ? `${row} ${word}` : word;
      }
      rows.push(row);
      for (const text of rows) {
        if (cursor - leading < MARGIN) newPage();
        cursor -= leading;
        ops.push(`BT /${line.bold ? "F2" : "F1"} ${size} Tf ${indent} ${cursor} Td (${pdfEscape(text)}) Tj ET`);
      }
    }
    if (ops.length) pages.push(ops);
    return pages;
  }

  function buildPdf(lines, { title = "Measured Decision" } = {}) {
    const pages = layout(lines);
    /* Object numbering, fixed by construction: 1 catalog, 2 page tree,
       3 and 4 the two fonts, 5..4+n the content streams, 5+n..4+2n the
       page objects. The xref is computed from real byte offsets below, so
       the file is valid because the arithmetic is, not by luck. */
    const objects = [];   // 1-indexed object bodies, without "N 0 obj"
    const pageObjectIds = pages.map((_, index) => 5 + pages.length + index);
    objects.push(`<< /Type /Catalog /Pages 2 0 R >>`);                                     // 1
    objects.push(`<< /Type /Pages /Kids [${pageObjectIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pages.length} >>`); // 2
    objects.push(`<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>`);      // 3
    objects.push(`<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>`); // 4
    const contentIds = pages.map((_, index) => 5 + index);
    for (const ops of pages) {
      const stream = ops.join("\n");
      objects.push(`<< /Length ${encoder.encode(stream).length} >>\nstream\n${stream}\nendstream`);
    }
    for (const [index] of pages.entries()) {
      objects.push(
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] `
        + `/Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${contentIds[index]} 0 R >>`,
      );
    }
    /* The second line is the conventional binary marker: bytes above 127 so
       transfer tools treat the file as binary. */
    let body = `%PDF-1.4\n%µ¶·¸\n`;
    const offsets = [0];
    objects.forEach((object, index) => {
      offsets.push(encoder.encode(body).length);
      body += `${index + 1} 0 obj\n${object}\nendobj\n`;
    });
    const xrefOffset = encoder.encode(body).length;
    body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
    for (let index = 1; index <= objects.length; index += 1) {
      body += `${String(offsets[index]).padStart(10, "0")} 00000 n \n`;
    }
    body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info << /Title (${pdfEscape(title)}) >> >>\n`;
    body += `startxref\n${xrefOffset}\n%%EOF\n`;
    return encoder.encode(body);
  }

  const api = { buildPdf };
  if (typeof window !== "undefined") window.MDAIPdf360 = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
