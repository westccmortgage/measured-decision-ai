/* THE ENGINE, COMPILED FOR A BROWSER — AND NOTHING ELSE DONE TO IT.
 *
 * The screen has to show what the Core V2 engine actually produced, which
 * means the engine itself has to run where the screen is. It is written in
 * TypeScript for node, so this does the two mechanical things that stand
 * between those facts and nothing more:
 *
 *   1. strips the types, with tsc, using the repository's own erasable-syntax
 *      rule — no transform, no bundler, no minifier. What lands in engine/ is
 *      the same code with the annotations removed;
 *   2. points the four node built-in calls at the shims beside it, which are
 *      checked against node's own output by the suite.
 *
 * Nothing here rewrites a rule, inlines a constant or "adapts" a behaviour. If
 * an engine file ever reaches for a node built-in nobody has shimmed, this
 * REFUSES to write the bundle rather than emitting something that will fail
 * silently in a browser at the worst moment.
 *
 *     node studio/measured-decision-run/build-engine.mjs
 *
 * The output is committed, because the Studio is served as static files and
 * has no build step of its own. tests/measured-decision-run.mjs rebuilds and
 * fails if what is committed is not what this produces.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../..");
const OUT = path.join(HERE, "engine");

/* What the demonstration needs. tsc follows the imports from here. */
const ENTRIES = [
  "workers/core-v2/kernel/scheduler.ts",
  "workers/core-v2/kernel/memory-repository.ts",
  "workers/core-v2/kernel/executors.ts",
  "workers/core-v2/kernel/ids.ts",
  "workers/core-v2/kernel/domain.ts",
  "workers/core-v2/domains/simulate.ts",
  "workers/core-v2/domains/synthetic-records/fixture.ts",
  "workers/core-v2/domains/synthetic-records/pack.ts",
  "workers/core-v2/domains/synthetic-records/mocks.ts",
];

/* node built-ins the browser is given a checked stand-in for. Anything else
   is a refusal. */
const SHIMMED = {
  "node:crypto": "node-crypto.js",
  "node:zlib": "node-zlib.js",
};

/* node's own surface is not on this machine as a package, and the engine uses
   a small, known part of it. Declared here — no more than the engine asks for
   — the same way workers/core-v2-runtime/tests/typecheck.sh does it, and
   written to a temporary directory rather than into the repository. */
const AMBIENT = `
declare class Buffer extends Uint8Array {
  static from(data: string | ArrayLike<number> | ArrayBuffer | Uint8Array, encoding?: string): Buffer;
  static alloc(n: number, fill?: number): Buffer;
  static concat(list: Uint8Array[], total?: number): Buffer;
  static byteLength(s: string, encoding?: string): number;
  static isBuffer(v: unknown): v is Buffer;
  toString(encoding?: string, start?: number, end?: number): string;
  subarray(begin?: number, end?: number): Buffer;
  slice(begin?: number, end?: number): Buffer;
  writeUInt32BE(value: number, offset?: number): number;
  readUInt32BE(offset?: number): number;
  writeUInt16BE(value: number, offset?: number): number;
  readUInt16BE(offset?: number): number;
  equals(other: Uint8Array): boolean;
  copy(target: Uint8Array, targetStart?: number, sourceStart?: number, sourceEnd?: number): number;
}
declare module "node:crypto" {
  export function createHash(algorithm: string): {
    update(data: string | Uint8Array, encoding?: string): { digest(): Buffer; digest(encoding: string): string };
  };
  export function randomBytes(n: number): Buffer;
  export function randomUUID(): string;
}
declare module "node:zlib" {
  export function deflateSync(data: Uint8Array, options?: { level?: number }): Buffer;
  export function inflateSync(data: Uint8Array): Buffer;
}
`;

export function buildEngine({ quiet = false } = {}) {
  const say = (line) => { if (!quiet) console.log(line); };
  fs.rmSync(OUT, { recursive: true, force: true });

  const work = fs.mkdtempSync(path.join(os.tmpdir(), "core-v2-browser-"));
  const ambient = path.join(work, "node-surface.d.ts");
  fs.writeFileSync(ambient, AMBIENT);

  const args = [
    ...ENTRIES,
    ambient,
    "--target", "es2022",
    "--module", "esnext",
    "--moduleResolution", "bundler",
    "--allowImportingTsExtensions",
    "--rewriteRelativeImportExtensions",
    "--skipLibCheck",
    "--removeComments", "false",
    "--outDir", OUT,
  ];
  try {
    execFileSync("tsc", args, { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    /* tsc reports on stdout and exits non-zero. Show what it said rather than
       a wall of buffer bytes. */
    const said = String(error.stdout ?? "").trim();
    fs.rmSync(OUT, { recursive: true, force: true });
    fs.rmSync(work, { recursive: true, force: true });
    throw new Error(`the browser engine did not compile:\n${said || error.message}`);
  }
  fs.rmSync(work, { recursive: true, force: true });

  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".js")) files.push(full);
    }
  };
  walk(OUT);

  const refusals = [];
  let rewired = 0;
  for (const file of files) {
    let text = fs.readFileSync(file, "utf8");
    const toShims = path.relative(path.dirname(file), path.join(HERE, "engine-shims")).split(path.sep).join("/");

    for (const [builtin, shim] of Object.entries(SHIMMED)) {
      const before = text;
      text = text.replaceAll(`"${builtin}"`, `"${toShims}/${shim}"`);
      if (text !== before) rewired += 1;
    }

    /* Anything still reaching for node is a build failure, by name. */
    for (const match of text.matchAll(/from\s+"(node:[a-z_/]+)"/g)) refusals.push(`${path.relative(OUT, file)} imports ${match[1]}`);

    /* Buffer is a global under node. A file that uses one is given the
       checked stand-in explicitly, so nothing depends on load order. */
    if (/\bBuffer\./.test(text) && !text.includes("engine-shims/buffer.js")) {
      text = `import "${toShims}/buffer.js";\n${text}`;
    }
    fs.writeFileSync(file, text);
  }

  if (refusals.length > 0) {
    fs.rmSync(OUT, { recursive: true, force: true });
    throw new Error(`the browser engine was not written — nothing shims these:\n  ${refusals.join("\n  ")}`);
  }

  say(`  ${files.length} engine files written, ${rewired} node imports pointed at checked shims`);
  return { files: files.map((f) => path.relative(ROOT, f)).sort(), count: files.length };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const built = buildEngine();
  console.log(`  engine/ is current — ${built.count} files`);
}
