/* Measured Decision · a small, honest XLSX writer.
 *
 * The signed takeoff leaves the building as a workbook a supplier and an
 * estimator can both open. No vendored spreadsheet library: an .xlsx file is
 * a ZIP of small XML parts, and a ZIP with stored (uncompressed) entries is
 * ~100 lines of arithmetic. Everything here is deterministic — the same
 * record produces the same bytes — which is what makes it testable.
 *
 * Supported on purpose: multiple sheets, text and number cells, bold rows,
 * column widths. Not supported on purpose: formulas, merged cells, charts —
 * a verification record carries values and their provenance, not live math
 * that could drift after signature.
 */
(() => {
  const textEncoder = new TextEncoder();

  /* Standard CRC-32, the only arithmetic a stored ZIP needs. */
  const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
    return table;
  })();

  function crc32(bytes) {
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i += 1) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }

  function xmlEscape(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&apos;");
  }

  function columnRef(index) {
    let ref = "";
    let n = index;
    do { ref = String.fromCharCode(65 + (n % 26)) + ref; n = Math.floor(n / 26) - 1; } while (n >= 0);
    return ref;
  }

  /* One sheet: { name, rows: [[cell, ...]], bold: [rowIndexes], widths: [ch] }.
     A finite number cell is written as a number; everything else as inline text. */
  function sheetXml(sheet) {
    const cols = (sheet.widths || []).map((width, index) =>
      `<col min="${index + 1}" max="${index + 1}" width="${width}" customWidth="1"/>`).join("");
    const bold = new Set(sheet.bold || []);
    const rows = (sheet.rows || []).map((row, rowIndex) => {
      const cells = row.map((value, cellIndex) => {
        if (value === null || value === undefined || value === "") return "";
        const ref = `${columnRef(cellIndex)}${rowIndex + 1}`;
        const style = bold.has(rowIndex) ? ' s="1"' : "";
        if (typeof value === "number" && Number.isFinite(value)) return `<c r="${ref}"${style}><v>${value}</v></c>`;
        return `<c r="${ref}"${style} t="inlineStr"><is><t xml:space="preserve">${xmlEscape(value)}</t></is></c>`;
      }).join("");
      return `<row r="${rowIndex + 1}">${cells}</row>`;
    }).join("");
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${cols ? `<cols>${cols}</cols>` : ""}<sheetData>${rows}</sheetData></worksheet>`;
  }

  const STYLES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Arial"/></font><font><b/><sz val="11"/><name val="Arial"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf/></cellStyleXfs><cellXfs count="2"><xf xfId="0"/><xf xfId="0" fontId="1" applyFont="1"/></cellXfs></styleSheet>`;

  function workbookParts(sheets) {
    /* [Content_Types].xml must be the FIRST entry in the package — several
       readers (LibreOffice among them) refuse the file otherwise. Sheets are
       appended after the package skeleton. */
    const parts = [];
    const sheetParts = [];
    const overrides = [];
    const sheetRefs = [];
    const rels = [];
    sheets.forEach((sheet, index) => {
      const id = index + 1;
      sheetParts.push({ path: `xl/worksheets/sheet${id}.xml`, content: sheetXml(sheet) });
      overrides.push(`<Override PartName="/xl/worksheets/sheet${id}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`);
      sheetRefs.push(`<sheet name="${xmlEscape(sheet.name).slice(0, 31)}" sheetId="${id}" r:id="rId${id}"/>`);
      rels.push(`<Relationship Id="rId${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${id}.xml"/>`);
    });
    const stylesId = sheets.length + 1;
    rels.push(`<Relationship Id="rId${stylesId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>`);
    parts.push({
      path: "[Content_Types].xml",
      content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${overrides.join("")}</Types>`,
    });
    parts.push({
      path: "_rels/.rels",
      content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    });
    parts.push({
      path: "xl/workbook.xml",
      content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheetRefs.join("")}</sheets></workbook>`,
    });
    parts.push({
      path: "xl/_rels/workbook.xml.rels",
      content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels.join("")}</Relationships>`,
    });
    parts.push({ path: "xl/styles.xml", content: STYLES_XML });
    parts.push(...sheetParts);
    return parts;
  }

  /* A stored ZIP: local headers, central directory, end record. No
     compression — the parts are small and stored bytes are reproducible.
     A part's content may be a string (encoded as UTF-8) or raw bytes, so
     the same writer packs XML worksheets and finished binary files alike. */
  function zipStored(parts) {
    const chunks = [];
    const central = [];
    let offset = 0;
    const u16 = (v) => [v & 0xFF, (v >>> 8) & 0xFF];
    const u32 = (v) => [v & 0xFF, (v >>> 8) & 0xFF, (v >>> 16) & 0xFF, (v >>> 24) & 0xFF];
    for (const part of parts) {
      const name = textEncoder.encode(part.path);
      const data = part.content instanceof Uint8Array ? part.content : textEncoder.encode(part.content);
      const crc = crc32(data);
      const header = new Uint8Array([
        0x50, 0x4B, 0x03, 0x04, ...u16(20), ...u16(0x0800), ...u16(0), ...u16(0), ...u16(0),
        ...u32(crc), ...u32(data.length), ...u32(data.length), ...u16(name.length), ...u16(0),
      ]);
      chunks.push(header, name, data);
      central.push(new Uint8Array([
        0x50, 0x4B, 0x01, 0x02, ...u16(20), ...u16(20), ...u16(0x0800), ...u16(0), ...u16(0), ...u16(0),
        ...u32(crc), ...u32(data.length), ...u32(data.length), ...u16(name.length), ...u16(0), ...u16(0),
        ...u16(0), ...u16(0), ...u32(0), ...u32(offset),
      ]), name);
      offset += header.length + name.length + data.length;
    }
    let centralSize = 0;
    for (const chunk of central) centralSize += chunk.length;
    const end = new Uint8Array([
      0x50, 0x4B, 0x05, 0x06, ...u16(0), ...u16(0), ...u16(parts.length), ...u16(parts.length),
      ...u32(centralSize), ...u32(offset), ...u16(0),
    ]);
    const total = offset + centralSize + end.length;
    const out = new Uint8Array(total);
    let cursor = 0;
    for (const chunk of [...chunks, ...central, end]) { out.set(chunk, cursor); cursor += chunk.length; }
    return out;
  }

  /* sheets: [{ name, rows, bold?, widths? }] → xlsx bytes. */
  function buildXlsx(sheets) {
    return zipStored(workbookParts(sheets));
  }

  /* parts: [{ path, content: string | Uint8Array }] → zip bytes. The door
     the project-record export walks through: one deterministic archive of
     finished files. */
  function buildZip(parts) {
    return zipStored(parts);
  }

  const api = { buildXlsx, buildZip, crc32, columnRef };
  if (typeof window !== "undefined") window.MDAIXlsx360 = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
