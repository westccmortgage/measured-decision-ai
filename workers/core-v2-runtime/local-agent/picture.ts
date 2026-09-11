/* WHAT IS ACTUALLY IN A PICTURE, FOR A STAND-IN THAT HAS TO READ ONE.
 *
 * The synthetic fixtures encode their text into a PNG's pixels, and the pack
 * that made them has a reader for exactly that encoding. A page rendered from
 * somebody's own PDF, or a frame taken out of their clip, is an ORDINARY PNG:
 * filtered scanlines, RGB or RGBA, eight bits a channel. The stand-in cannot
 * pretend to understand a picture, and it will not — but it must not pretend the
 * bytes are unreadable either, because then a test of an owner's own material
 * would be a test of a failure path.
 *
 * So: a real decoder, and a measurement. What comes back is what can honestly
 * be said about a picture without a model in the room — its size, how much of
 * it is ink rather than paper, and whether a strongly coloured region is in
 * it. Every number here is computed from the pixels of the file in hand.
 *
 * Not supported, on purpose, because a canvas does not produce them: interlace,
 * palettes, and bit depths other than eight. Those return null rather than a
 * guess.
 */
import { inflateSync } from "node:zlib";

export type Picture = {
  width: number;
  height: number;
  /* Fractions of the whole picture, each in 0..1. */
  ink: number;        // anything appreciably darker than paper
  red: number;
  orange: number;
  green: number;
  blue: number;
  paper: number;      // near-white
};

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export function decodePicture(bytes: Uint8Array): Picture | null {
  const buffer = Buffer.from(bytes);
  if (buffer.length < 8) return null;
  for (let i = 0; i < 8; i += 1) if (buffer[i] !== SIGNATURE[i]) return null;

  let width = 0, height = 0, depth = 0, colourType = -1, interlace = 0;
  const idat: Buffer[] = [];
  let at = 8;
  while (at + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(at);
    const kind = buffer.subarray(at + 4, at + 8).toString("ascii");
    const body = buffer.subarray(at + 8, at + 8 + length);
    if (kind === "IHDR") {
      width = body.readUInt32BE(0); height = body.readUInt32BE(4);
      depth = body[8]; colourType = body[9]; interlace = body[12];
    } else if (kind === "IDAT") idat.push(Buffer.from(body));
    else if (kind === "IEND") break;
    at += 12 + length;
  }
  if (width <= 0 || height <= 0 || depth !== 8 || interlace !== 0) return null;
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[colourType as 0 | 2 | 4 | 6];
  if (!channels) return null;

  let raw: Buffer;
  try { raw = inflateSync(Buffer.concat(idat)); } catch { return null; }
  const stride = width * channels;
  if (raw.length < (stride + 1) * height) return null;

  /* The five filters, exactly as the format defines them. */
  const line = Buffer.alloc(stride);
  const previous = Buffer.alloc(stride);
  let red = 0, orange = 0, green = 0, blue = 0, ink = 0, paper = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    raw.copy(line, 0, y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x += 1) {
      const left = x >= channels ? line[x - channels] : 0;
      const up = previous[x];
      const upLeft = x >= channels ? previous[x - channels] : 0;
      let value = line[x];
      if (filter === 1) value += left;
      else if (filter === 2) value += up;
      else if (filter === 3) value += (left + up) >> 1;
      else if (filter === 4) {
        const p = left + up - upLeft;
        const dl = Math.abs(p - left), du = Math.abs(p - up), dul = Math.abs(p - upLeft);
        value += dl <= du && dl <= dul ? left : du <= dul ? up : upLeft;
      } else if (filter !== 0) return null;
      line[x] = value & 0xff;
    }
    for (let x = 0; x < width; x += 1) {
      const i = x * channels;
      const r = line[i];
      const g = channels >= 3 ? line[i + 1] : r;
      const b = channels >= 3 ? line[i + 2] : r;
      const bright = (r + g + b) / 3;
      if (bright > 232) paper += 1; else ink += 1;
      if (r > 150 && g < 110 && b < 100) red += 1;
      else if (r > 190 && g > 110 && g < 200 && b < 110) orange += 1;
      else if (g > 130 && r < 130 && b < 140) green += 1;
      else if (b > 140 && r < 130 && g < 150) blue += 1;
    }
    line.copy(previous);
  }
  const total = width * height;
  const share = (n: number) => Math.round((n / total) * 10000) / 10000;
  return { width, height, ink: share(ink), paper: share(paper), red: share(red), orange: share(orange), green: share(green), blue: share(blue) };
}

/* One sentence a stand-in can honestly put in an anchor: what it measured,
   and nothing about what the picture MEANS. */
export function describePicture(picture: Picture): string {
  const parts: string[] = [`${picture.width}×${picture.height} picture`];
  parts.push(`${(picture.ink * 100).toFixed(1)}% of it darker than paper`);
  for (const [name, share] of [["red", picture.red], ["orange", picture.orange], ["green", picture.green], ["blue", picture.blue]] as const) {
    if (share >= 0.004) parts.push(`${(share * 100).toFixed(1)}% strongly ${name}`);
  }
  return parts.join(", ");
}
