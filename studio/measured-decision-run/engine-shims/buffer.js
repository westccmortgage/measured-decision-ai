/* THE FOUR THINGS THE ENGINE ASKS OF Buffer, AND NOTHING ELSE.
 *
 * The Core V2 kernel and the synthetic-records pack are written for node, and
 * this demonstration runs them in a browser without changing a line of them.
 * That is the whole point: what the screen shows has to be the engine's own
 * output, so the engine may not be reimplemented to suit the screen.
 *
 * So the browser is given the small surface node's Buffer provides that the
 * engine actually uses — from, alloc, concat, byteLength, two big-endian
 * accessors and three encodings — built on Uint8Array, which a Buffer already
 * is. It is deliberately not a general polyfill: anything the engine does not
 * ask for is absent, so a future call that needs more fails loudly here rather
 * than quietly returning something plausible.
 */
const TEXT = new TextEncoder();
const DECODE = new TextDecoder();

export class BrowserBuffer extends Uint8Array {
  static from(value, encoding) {
    if (typeof value === "string") {
      if (encoding === "hex") {
        const out = new BrowserBuffer(value.length >> 1);
        for (let i = 0; i < out.length; i += 1) out[i] = Number.parseInt(value.substr(i * 2, 2), 16);
        return out;
      }
      if (encoding === "base64") {
        const raw = atob(value);
        const out = new BrowserBuffer(raw.length);
        for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
        return out;
      }
      if (encoding === "ascii" || encoding === "latin1" || encoding === "binary") {
        const out = new BrowserBuffer(value.length);
        for (let i = 0; i < value.length; i += 1) out[i] = value.charCodeAt(i) & 0xff;
        return out;
      }
      return new BrowserBuffer(TEXT.encode(value));
    }
    if (value instanceof Uint8Array) return new BrowserBuffer(value.slice());
    if (Array.isArray(value)) return new BrowserBuffer(Uint8Array.from(value));
    if (value instanceof ArrayBuffer) return new BrowserBuffer(new Uint8Array(value));
    throw new TypeError("core-v2 browser: Buffer.from was given something this shim does not carry");
  }

  static alloc(size, fill = 0) {
    const out = new BrowserBuffer(size);
    if (fill !== 0) out.fill(fill);
    return out;
  }

  static concat(list, total) {
    const length = total ?? list.reduce((n, part) => n + part.length, 0);
    const out = new BrowserBuffer(length);
    let at = 0;
    for (const part of list) {
      if (at + part.length > length) { out.set(part.subarray(0, length - at), at); at = length; break; }
      out.set(part, at);
      at += part.length;
    }
    return out;
  }

  static byteLength(value, encoding) {
    if (typeof value !== "string") return value.length;
    if (encoding === "hex") return value.length >> 1;
    return TEXT.encode(value).length;
  }

  static isBuffer(value) { return value instanceof Uint8Array; }

  writeUInt32BE(value, offset = 0) {
    this[offset] = (value >>> 24) & 0xff;
    this[offset + 1] = (value >>> 16) & 0xff;
    this[offset + 2] = (value >>> 8) & 0xff;
    this[offset + 3] = value & 0xff;
    return offset + 4;
  }

  readUInt32BE(offset = 0) {
    return ((this[offset] << 24) | (this[offset + 1] << 16) | (this[offset + 2] << 8) | this[offset + 3]) >>> 0;
  }

  writeUInt16BE(value, offset = 0) {
    this[offset] = (value >>> 8) & 0xff;
    this[offset + 1] = value & 0xff;
    return offset + 2;
  }

  readUInt16BE(offset = 0) { return ((this[offset] << 8) | this[offset + 1]) >>> 0; }

  toString(encoding = "utf8", start = 0, end = this.length) {
    const view = this.subarray(start, end);
    if (encoding === "hex") {
      let out = "";
      for (const byte of view) out += byte.toString(16).padStart(2, "0");
      return out;
    }
    if (encoding === "base64") {
      let raw = "";
      for (const byte of view) raw += String.fromCharCode(byte);
      return btoa(raw);
    }
    if (encoding === "ascii" || encoding === "latin1" || encoding === "binary") {
      let out = "";
      for (const byte of view) out += String.fromCharCode(byte);
      return out;
    }
    return DECODE.decode(view);
  }

  copy(target, targetStart = 0, sourceStart = 0, sourceEnd = this.length) {
    const slice = this.subarray(sourceStart, sourceEnd);
    target.set(slice, targetStart);
    return slice.length;
  }

  /* Uint8Array's own slicers return Uint8Array; the engine expects to keep
     calling Buffer methods on what comes back. */
  subarray(begin, end) { return new BrowserBuffer(super.subarray(begin, end)); }
  slice(begin, end) { return this.subarray(begin, end); }
}

/* The engine says `Buffer.…` as a global, exactly as it does under node. */
export function installBuffer(scope = globalThis) {
  if (!scope.Buffer) scope.Buffer = BrowserBuffer;
  return scope.Buffer;
}

installBuffer();
export default BrowserBuffer;
