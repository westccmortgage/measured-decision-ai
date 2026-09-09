/* THE INVENTED SOURCES, RENDERED INTO SOMETHING A READER CAN ACTUALLY READ.
 *
 * A record set is invented from a seed. Until now the only thing that
 * existed of it was the truth object a scripted executor consulted, which is
 * fine for testing an engine and useless for testing whether an agent can
 * read evidence: an agent that is handed a segment id and a hash has been
 * handed nothing.
 *
 * So every segment of this pack now has MATERIAL — the bytes a reader is
 * given — and every segment's content hash is the hash of those bytes. That
 * is what makes verification possible at all: a runtime that resolves
 * material can recompute the hash and say whether it was handed the thing
 * the assignment named.
 *
 * Two kinds are rendered here, on purpose:
 *
 *   · a table and a sheet listing are UTF-8 text — a reader parses lines;
 *   · a note is an IMAGE. Its pixels carry the note's characters: an 8-bit
 *     greyscale bitmap, sixteen bytes to a row, each pixel one byte of the
 *     text, padded with spaces. That is not optical character recognition
 *     and does not pretend to be — it is the simplest rendering that makes
 *     "the reader was handed bytes and had to decode them" literally true,
 *     so that changing the image changes the claim. A real reader would be
 *     handed a photograph and a model would read it; the shape of the
 *     runtime — resolve, verify, attach to the request, decode an answer —
 *     is the same either way, and that shape is what is under test.
 *
 * Nothing here is anybody's document.
 */
import { deflateSync, inflateSync } from "node:zlib";
import type { Note, Region, Sheet } from "./fixture.ts";

export const TEXT_MIME = "text/plain; charset=utf-8";
export const IMAGE_MIME = "image/png";

/* ────────────────────────────────────────────────────────────── the text */

/* One table, as a reader is given it: a header line, then one line per
   entry. The columns are fixed width so that a line is read by position or
   by splitting on whitespace, whichever a reader prefers. */
export function renderTable(region: Region): string {
  const lines = [
    `# ${region.label}`,
    "entry     category   quantity  unit",
  ];
  for (const e of region.entries) {
    lines.push(`${e.id.padEnd(10)}${e.category.padEnd(11)}${String(e.quantity).padEnd(10)}${e.unit}`);
  }
  return `${lines.join("\n")}\n`;
}

/* What a note says: a heading naming the table it annotates, then the note
   itself on a line of its own. The heading carries the table's own content
   hash, which is what makes one world's note different bytes from another
   world's identical-sounding note — a content-addressed store files identical
   content once, and two invented worlds should not share a segment. */
export function renderNoteText(note: Note, tableHash: string): string {
  return `# note about the table ${tableHash}\nnote: ${note.entryId} is ${note.status}\n`;
}

/* A sheet, as the discoverer is given it: what regions it holds, where, and
   the hash of each one's material. A discoverer reads this and reports the
   segments it found; it invents nothing. */
export function renderSheet(sheet: Sheet): string {
  const lines = [`# ${sheet.label}`, "kind  label  ordinal  bbox  content-hash"];
  for (const r of sheet.regions) {
    lines.push(`${r.kind}  ${r.label}  ${r.ordinal}  ${r.bbox.join(",")}  ${r.contentHash}`);
  }
  return `${lines.join("\n")}\n`;
}

/* A whole record set, as the ingest step is given it. Nothing reads this
   with a model — ingestion is code — but material exists for every reference
   a packet can carry, and a source is one. */
export function renderSource(label: string, sheets: Sheet[]): string {
  const lines = [`# ${label}`, "sheet  ordinal  content-hash"];
  for (const s of sheets) lines.push(`${s.label}  ${s.ordinal}  ${s.contentHash}`);
  return `${lines.join("\n")}\n`;
}

/* ───────────────────────────────────────────────────────────── the image */

const ROW_WIDTH = 16;

/* Text as an 8-bit greyscale PNG, sixteen bytes to a row. */
export function renderTextAsImage(text: string): Uint8Array {
  const bytes = Buffer.from(text, "utf8");
  const height = Math.max(1, Math.ceil(bytes.length / ROW_WIDTH));
  const pixels = Buffer.alloc(height * ROW_WIDTH, 0x20);
  bytes.copy(pixels);
  /* One filter byte per row, filter type 0: the bytes are the picture. */
  const raw = Buffer.alloc(height * (ROW_WIDTH + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (ROW_WIDTH + 1)] = 0;
    pixels.copy(raw, y * (ROW_WIDTH + 1) + 1, y * ROW_WIDTH, (y + 1) * ROW_WIDTH);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(ROW_WIDTH, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   /* bit depth */
  ihdr[9] = 0;   /* colour type 0: greyscale */
  ihdr[10] = 0;  /* deflate */
  ihdr[11] = 0;  /* adaptive filtering */
  ihdr[12] = 0;  /* no interlace */
  return new Uint8Array(Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]));
}

/* And back: what the picture says. A reader that is handed the image and
   nothing else can get to this, and to nothing that was not in the bytes. */
export function readTextFromImage(bytes: Uint8Array): string {
  const buffer = Buffer.from(bytes);
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (buffer.length < 8 || !buffer.subarray(0, 8).equals(signature)) throw new Error("synthetic-records: that is not a PNG");
  let at = 8;
  let width = 0;
  let height = 0;
  const parts: Buffer[] = [];
  while (at + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(at);
    const kind = buffer.subarray(at + 4, at + 8).toString("ascii");
    const body = buffer.subarray(at + 8, at + 8 + length);
    if (kind === "IHDR") { width = body.readUInt32BE(0); height = body.readUInt32BE(4); }
    if (kind === "IDAT") parts.push(Buffer.from(body));
    if (kind === "IEND") break;
    at += 12 + length;
  }
  if (width === 0 || height === 0) throw new Error("synthetic-records: the image says it has no size");
  const raw = inflateSync(Buffer.concat(parts));
  const pixels = Buffer.alloc(width * height);
  for (let y = 0; y < height; y++) {
    if (raw[y * (width + 1)] !== 0) throw new Error("synthetic-records: this reader only understands unfiltered rows");
    raw.copy(pixels, y * width, y * (width + 1) + 1, (y + 1) * (width + 1));
  }
  return pixels.toString("utf8").replace(/ +$/, "");
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Buffer): number {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(kind: string, body: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(body.length, 0);
  const named = Buffer.concat([Buffer.from(kind, "ascii"), body]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(named), 0);
  return Buffer.concat([length, named, crc]);
}
