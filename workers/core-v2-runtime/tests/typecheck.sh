#!/usr/bin/env bash
# Type-check the universal kernel, the execution layer, the canary and the
# production runner TOGETHER, so that a change to one that breaks another is
# caught here rather than at run time.
#
# This repository has no node_modules and no @types/node by design: the code
# runs under `node --experimental-strip-types`, which erases types and
# compiles nothing. So the shims below declare the small part of node's own
# surface these two trees use — no more — and the whole thing is written to a
# temporary directory rather than into the repository.
#
# Requires `tsc` on the path. It checks; it emits nothing.
set -uo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/../.." && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

cat > "$work/globals.d.ts" <<'DTS'
declare const process: { argv: string[]; env: Record<string, string | undefined>; exitCode?: number; exit(code?: number): never;
  on(event: string, cb: (...a: any[]) => void): void; getuid?: () => number; pid: number; execPath: string };
declare const console: { log(...a: unknown[]): void; error(...a: unknown[]): void; warn(...a: unknown[]): void };
declare function setTimeout(cb: (...a: any[]) => void, ms?: number): { unref?: () => void };
declare function clearTimeout(handle: unknown): void;
declare function queueMicrotask(cb: () => void): void;
declare class Buffer extends Uint8Array {
  static from(data: string | ArrayLike<number> | ArrayBuffer | Uint8Array, encoding?: string): Buffer;
  static alloc(n: number, fill?: number): Buffer;
  static concat(list: Uint8Array[], total?: number): Buffer;
  static byteLength(s: string, encoding?: string): number;
  static isBuffer(v: unknown): v is Buffer;
  toString(encoding?: string, start?: number, end?: number): string;
  equals(other: Uint8Array): boolean;
  copy(target: Uint8Array, targetStart?: number, sourceStart?: number, sourceEnd?: number): number;
  subarray(start?: number, end?: number): Buffer; slice(start?: number, end?: number): Buffer;
  readUInt32BE(offset: number): number; writeUInt32BE(value: number, offset: number): number;
}
declare class AbortController { readonly signal: AbortSignal; abort(reason?: unknown): void }
interface AbortSignal { readonly aborted: boolean; readonly reason: unknown;
  addEventListener(t: "abort", cb: () => void, o?: { once?: boolean }): void; removeEventListener(t: "abort", cb: () => void): void; throwIfAborted(): void }
declare class URL {
  constructor(input: string, base?: string);
  protocol: string; hostname: string; host: string; port: string; pathname: string; search: string;
  username: string; password: string; href: string;
}
DTS

cat > "$work/modules.d.ts" <<'DTS'
declare module "node:crypto" {
  export function createHash(algorithm: string): {
    update(data: string | Uint8Array, encoding?: string): { digest(): Buffer; digest(encoding: string): string };
  };
  export function randomBytes(n: number): Buffer;
  export function randomUUID(): string;
}
declare module "node:fs" { export function realpathSync(p: string): string; export function readFileSync(p: string, enc?: string): string; export function existsSync(p: string): boolean; }
declare module "node:url" { export function fileURLToPath(u: string): string; }
declare module "node:child_process" { const m: Record<string, unknown>; export default m; }
declare module "node:dns" { const m: { promises: Record<string, unknown> } & Record<string, unknown>; export default m; }
declare module "node:http" { const m: Record<string, unknown>; export default m; }
declare module "node:https" { const m: Record<string, unknown>; export default m; }
declare module "node:module" { export function syncBuiltinESMExports(): void; }
declare module "node:tls" { const m: Record<string, unknown>; export default m; }
declare module "node:zlib" {
  export function deflateSync(data: Uint8Array, options?: { level?: number }): Buffer;
  export function inflateSync(data: Uint8Array): Buffer;
}
declare module "node:net" {
  export type Socket = {
    connect(path: string, cb?: () => void): Socket; connect(port: number, host: string, cb?: () => void): Socket;
    on(event: string, cb: (...a: any[]) => void): Socket; once(event: string, cb: (...a: any[]) => void): Socket;
    off(event: string, cb: (...a: any[]) => void): Socket; write(data: Uint8Array, cb?: (err?: Error) => void): boolean;
    end(): void; destroy(err?: Error): void; setNoDelay(v: boolean): Socket; readonly destroyed: boolean;
  };
  export function createConnection(path: string, cb?: () => void): Socket;
  export function createConnection(opts: { path?: string; port?: number; host?: string }, cb?: () => void): Socket;
  const m: { Socket: { prototype: object; new (): Socket }; createConnection: typeof createConnection } & Record<string, unknown>;
  export default m;
}
DTS

cat > "$work/tsconfig.json" <<JSON
{
  "compilerOptions": {
    "target": "es2022", "module": "nodenext", "moduleResolution": "nodenext",
    "strict": true, "noEmit": true, "allowImportingTsExtensions": true,
    "lib": ["es2022"], "verbatimModuleSyntax": true, "noImplicitAny": true,
    "erasableSyntaxOnly": true, "skipLibCheck": true
  },
  "include": [
    "$root/workers/core-v2/**/*.ts",
    "$root/workers/core-v2-runtime/**/*.ts",
    "$root/workers/core-v2-canary/**/*.ts",
    "$root/workers/core-v2-runner/**/*.ts",
    "$work/globals.d.ts", "$work/modules.d.ts"
  ]
}
JSON

if ! command -v tsc > /dev/null 2>&1; then
  echo "  tsc is not on the path; nothing was checked"
  exit 1
fi
if tsc -p "$work/tsconfig.json"; then
  echo "  the kernel, the runtime, the canary and the runner type-check together"
else
  echo "  TYPE ERRORS — see above"
  exit 1
fi
