#!/usr/bin/env bash
# Type-check the three Core V2 Edge Functions TOGETHER WITH the trees they
# import. The workers' own typecheck cannot reach them: they run under Deno,
# import across the repository root, and use globals node does not have. So the
# shims below declare the small part of Deno's surface these doors use — no
# more — and the whole thing is written to a temporary directory.
set -uo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="${1:-$(cd "$here/../../.." && pwd)}"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# Reuse the node shims the workers' checker writes, then add Deno's.
sed -n "/^cat > \"\$work\/globals.d.ts\"/,/^DTS$/p" "$root/workers/core-v2-runtime/tests/typecheck.sh" \
  | sed '1d;$d' | grep -v '^declare function setTimeout' | grep -v '^declare function clearTimeout' > "$work/globals.d.ts"

# Buffer's binary accessors, which the wire client uses and the workers' shim
# does not name. Appended rather than edited into the original, so the two
# checkers cannot drift apart on the parts they do share.
cat >> "$work/globals.d.ts" <<'DTS'
interface Buffer {
  writeInt16BE(value: number, offset?: number): number;
  writeInt32BE(value: number, offset?: number): number;
  writeUInt8(value: number, offset?: number): number;
  readUInt8(offset?: number): number;
  readInt16BE(offset?: number): number;
  readInt32BE(offset?: number): number;
}
DTS
sed -n "/^cat > \"\$work\/modules.d.ts\"/,/^DTS$/p" "$root/workers/core-v2-runtime/tests/typecheck.sh" \
  | sed '1d;$d' > "$work/modules.d.ts"

cat > "$work/deno.d.ts" <<'DTS'
declare const Deno: {
  env: { get(name: string): string | undefined; toObject(): Record<string, string> };
  serve(handler: (request: Request) => Response | Promise<Response>): unknown;
};
declare module "node:buffer" { export { Buffer } }
declare module "jsr:@db/postgres@^0.19.5" {
  export class Client {
    constructor(url: string | Record<string, unknown>);
    connect(): Promise<void>;
    end(): Promise<void>;
    queryObject<T = Record<string, unknown>>(sql: string | { text: string; args?: unknown[] }, params?: unknown[]): Promise<{ rows: T[] }>;
    queryArray<T = unknown[]>(sql: string | { text: string; args?: unknown[] }, params?: unknown[]): Promise<{ rows: T[] }>;
  }
}
DTS

cat > "$work/tsconfig.json" <<JSON
{
  "compilerOptions": {
    "target": "es2022", "module": "preserve", "moduleResolution": "bundler",
    "strict": true, "noEmit": true, "allowImportingTsExtensions": true,
    "resolveJsonModule": true,
    "lib": ["es2022", "dom"], "noImplicitAny": true,
    "erasableSyntaxOnly": true, "skipLibCheck": true
  },
  "include": [
    "$root/supabase/functions/core-v2-analysis/*.ts",
    "$root/supabase/functions/core-v2-runner/*.ts",
    "$root/supabase/functions/core-v2-runner-tick/*.ts",
    "$root/supabase/functions/_shared/core-v2/*.ts",
    "$work/globals.d.ts", "$work/modules.d.ts", "$work/deno.d.ts"
  ]
}
JSON

command -v tsc > /dev/null 2>&1 || { echo "  tsc is not on the path; nothing was checked"; exit 1; }
if tsc -p "$work/tsconfig.json"; then
  echo "  the three Core V2 doors type-check against the trees they import"
else
  echo "  TYPE ERRORS — see above"; exit 1
fi
