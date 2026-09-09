/* THE TWO THINGS THE SYNTHETIC PACK ASKS OF node:zlib.
 *
 * The pack draws its own evidence: a table becomes a PNG, and a PNG's pixels
 * live in a zlib stream. So the browser needs deflate to build one and inflate
 * to read one back.
 *
 * It does NOT need to compress well. A deflate stream may carry STORED blocks
 * — literal bytes with a length and its complement — and every conforming
 * decoder, including every browser's PNG decoder, reads them. That is what
 * this writes: a correct zlib stream, byte for byte, with no compression and
 * no Huffman coding to get subtly wrong. The evidence images in a
 * demonstration are a few kilobytes; the honest simple thing beats the clever
 * one that has to be trusted.
 *
 * Inflate reads back what this wrote, and refuses anything else by saying so
 * rather than by returning wrong pixels.
 */
import { BrowserBuffer } from "./buffer.js";

const MAX_STORED = 0xffff;

function adler32(bytes) {
  let a = 1;
  let b = 0;
  for (let i = 0; i < bytes.length; i += 1) {
    a = (a + bytes[i]) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

export function deflateSync(input) {
  const data = input instanceof Uint8Array ? input : BrowserBuffer.from(String(input));
  const blocks = Math.max(1, Math.ceil(data.length / MAX_STORED));
  const out = new BrowserBuffer(2 + blocks * 5 + data.length + 4);
  let at = 0;
  /* zlib header: deflate, 32K window, no dictionary, check bits make it
     divisible by 31. 0x78 0x01 is the canonical "no compression" pair. */
  out[at++] = 0x78;
  out[at++] = 0x01;
  for (let block = 0; block < blocks; block += 1) {
    const start = block * MAX_STORED;
    const length = Math.min(MAX_STORED, data.length - start);
    const last = block === blocks - 1;
    out[at++] = last ? 1 : 0;              /* BFINAL, BTYPE = 00 (stored) */
    out[at++] = length & 0xff;             /* LEN, little-endian */
    out[at++] = (length >>> 8) & 0xff;
    out[at++] = ~length & 0xff;            /* NLEN, one's complement */
    out[at++] = (~length >>> 8) & 0xff;
    out.set(data.subarray(start, start + length), at);
    at += length;
  }
  out.writeUInt32BE(adler32(data), at);
  return out;
}

export function inflateSync(input) {
  const data = input instanceof Uint8Array ? input : BrowserBuffer.from(String(input));
  if (data.length < 6 || (data[0] & 0x0f) !== 8) throw new Error("core-v2 browser: that is not a zlib stream");
  let at = 2;
  const parts = [];
  for (;;) {
    if (at + 5 > data.length) throw new Error("core-v2 browser: the zlib stream ended inside a block header");
    const header = data[at++];
    const type = (header >>> 1) & 0x03;
    if (type !== 0) {
      throw new Error("core-v2 browser: this shim reads only the stored blocks it writes, and this stream is compressed");
    }
    const length = data[at] | (data[at + 1] << 8);
    const nlength = data[at + 2] | (data[at + 3] << 8);
    at += 4;
    if ((length ^ 0xffff) !== nlength) throw new Error("core-v2 browser: a stored block's length does not match its complement");
    parts.push(data.subarray(at, at + length));
    at += length;
    if (header & 1) break;
  }
  const out = BrowserBuffer.concat(parts);
  const checksum = data.readUInt32BE(data.length - 4);
  if (checksum !== adler32(out)) throw new Error("core-v2 browser: the zlib checksum does not match what was read");
  return out;
}

export default { deflateSync, inflateSync };
