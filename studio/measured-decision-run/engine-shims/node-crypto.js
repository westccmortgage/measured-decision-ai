/* THE THREE THINGS THE ENGINE ASKS OF node:crypto.
 *
 * `sha256` is the engine's identity function: every workflow, task, attempt,
 * claim and segment id is derived from it, and so is every content hash a
 * piece of material is checked against. It has to be SYNCHRONOUS, because the
 * engine derives ids inline — which rules out WebCrypto, whose digest is a
 * promise. So the digest is computed here, in the browser, by the same FIPS
 * 180-4 procedure node runs; a test compares the two implementations over the
 * engine's own strings rather than taking that on trust.
 *
 * UUID v5 — which is how the engine derives a stable id from a name — is
 * defined over SHA-1, so that is here too. Both digests are compared against
 * node's own output by the suite; neither is trusted because it looks right.
 *
 * Randomness is not identity. It names an executor instance for the life of a
 * process, so it comes from the platform's own CSPRNG.
 */
import { BrowserBuffer } from "./buffer.js";

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const rotr = (x, n) => ((x >>> n) | (x << (32 - n))) >>> 0;

function sha256Bytes(bytes) {
  const length = bytes.length;
  /* message + 0x80 + zero padding + 64-bit big-endian bit length */
  const padded = new Uint8Array((((length + 9) + 63) & ~63));
  padded.set(bytes);
  padded[length] = 0x80;
  const bits = length * 8;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor(bits / 0x100000000), false);
  view.setUint32(padded.length - 4, bits >>> 0, false);

  const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const w = new Uint32Array(64);

  for (let at = 0; at < padded.length; at += 64) {
    for (let i = 0; i < 16; i += 1) w[i] = view.getUint32(at + i * 4, false);
    for (let i = 16; i < 64; i += 1) {
      const s0 = (rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3)) >>> 0;
      const s1 = (rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10)) >>> 0;
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let i = 0; i < 64; i += 1) {
      const S1 = (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) >>> 0;
      const ch = ((e & f) ^ (~e & g)) >>> 0;
      const t1 = (hh + S1 + ch + K[i] + w[i]) >>> 0;
      const S0 = (rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) >>> 0;
      const maj = ((a & b) ^ (a & c) ^ (b & c)) >>> 0;
      const t2 = (S0 + maj) >>> 0;
      hh = g; g = f; f = e; e = (d + t1) >>> 0;
      d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    h[0] = (h[0] + a) >>> 0; h[1] = (h[1] + b) >>> 0; h[2] = (h[2] + c) >>> 0; h[3] = (h[3] + d) >>> 0;
    h[4] = (h[4] + e) >>> 0; h[5] = (h[5] + f) >>> 0; h[6] = (h[6] + g) >>> 0; h[7] = (h[7] + hh) >>> 0;
  }
  const out = new BrowserBuffer(32);
  for (let i = 0; i < 8; i += 1) out.writeUInt32BE(h[i], i * 4);
  return out;
}

function sha1Bytes(bytes) {
  const length = bytes.length;
  const padded = new Uint8Array((((length + 9) + 63) & ~63));
  padded.set(bytes);
  padded[length] = 0x80;
  const view = new DataView(padded.buffer);
  const bits = length * 8;
  view.setUint32(padded.length - 8, Math.floor(bits / 0x100000000), false);
  view.setUint32(padded.length - 4, bits >>> 0, false);

  const h = new Uint32Array([0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0]);
  const w = new Uint32Array(80);
  const rotl = (x, n) => ((x << n) | (x >>> (32 - n))) >>> 0;

  for (let at = 0; at < padded.length; at += 64) {
    for (let i = 0; i < 16; i += 1) w[i] = view.getUint32(at + i * 4, false);
    for (let i = 16; i < 80; i += 1) w[i] = rotl(w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16], 1);
    let [a, b, c, d, e] = h;
    for (let i = 0; i < 80; i += 1) {
      let f;
      let k;
      if (i < 20) { f = ((b & c) | (~b & d)) >>> 0; k = 0x5a827999; }
      else if (i < 40) { f = (b ^ c ^ d) >>> 0; k = 0x6ed9eba1; }
      else if (i < 60) { f = ((b & c) | (b & d) | (c & d)) >>> 0; k = 0x8f1bbcdc; }
      else { f = (b ^ c ^ d) >>> 0; k = 0xca62c1d6; }
      const t = (rotl(a, 5) + f + e + k + w[i]) >>> 0;
      e = d; d = c; c = rotl(b, 30); b = a; a = t;
    }
    h[0] = (h[0] + a) >>> 0; h[1] = (h[1] + b) >>> 0; h[2] = (h[2] + c) >>> 0;
    h[3] = (h[3] + d) >>> 0; h[4] = (h[4] + e) >>> 0;
  }
  const out = new BrowserBuffer(20);
  for (let i = 0; i < 5; i += 1) out.writeUInt32BE(h[i], i * 4);
  return out;
}

const DIGESTS = { sha256: sha256Bytes, sha1: sha1Bytes };

class Digest {
  #parts = [];
  #compute;
  constructor(compute) { this.#compute = compute; }
  update(value, encoding) {
    this.#parts.push(value instanceof Uint8Array ? value : BrowserBuffer.from(String(value), encoding));
    return this;
  }
  digest(encoding) {
    const digest = this.#compute(BrowserBuffer.concat(this.#parts));
    return encoding ? digest.toString(encoding) : digest;
  }
}

export function createHash(algorithm) {
  const compute = DIGESTS[algorithm];
  if (!compute) throw new Error(`core-v2 browser: no stand-in here computes ${algorithm}`);
  return new Digest(compute);
}

export function randomBytes(size) {
  const out = new BrowserBuffer(size);
  globalThis.crypto.getRandomValues(out);
  return out;
}

export function randomUUID() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  const bytes = randomBytes(16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export default { createHash, randomBytes, randomUUID };
