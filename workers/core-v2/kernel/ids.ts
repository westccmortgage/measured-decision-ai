/* IDENTITY, DERIVED — NEVER DRAWN.
 *
 * Every persisted entity of the kernel is named by an RFC 4122 version-5
 * UUID computed from what the entity is: the same manifest plans the same
 * task ids, the same attempt number makes the same attempt id, the same
 * claim key under the same attempt makes the same claim id. That is what
 * makes re-planning, restart and idempotent admission cheap, and what lets
 * an in-memory run and a Postgres run name the same rows.
 *
 * Fingerprints are computed over immutable identities only — never a signed
 * URL, a timestamp, a worker id or a temporary path. Those are excluded by
 * never being passed in, not by being filtered out.
 */
import { createHash } from "node:crypto";

export function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/* One written form for one meaning: keys sorted, nested. Arrays keep their
   order — for a fingerprint, order is part of the identity of a list. */
export function canonical(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((k) => `${JSON.stringify(k)}:${canonical(record[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function fingerprint(parts: Record<string, unknown>): string {
  return sha256(canonical(parts));
}

/* RFC 4122 §4.3: a name-based UUID is SHA-1 over the namespace bytes followed
   by the name, with the version and variant bits set. */
export function uuidV5(namespace: string, name: string): string {
  const ns = Buffer.from(namespace.replace(/-/g, ""), "hex");
  if (ns.length !== 16) throw new Error(`core-v2: ${namespace} is not a UUID namespace`);
  const hash = createHash("sha1").update(Buffer.concat([ns, Buffer.from(name, "utf8")])).digest();
  hash[6] = (hash[6] & 0x0f) | 0x50;
  hash[8] = (hash[8] & 0x3f) | 0x80;
  const hex = hash.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/* The kernel's namespace: itself a name-based UUID under the DNS namespace. */
export const CORE_V2_NAMESPACE = uuidV5("6ba7b810-9dad-11d1-80b4-00c04fd430c8", "core-v2.measured-decision-ai");

/* An entity id from its kind and the parts that make it what it is. */
export function entityId(kind: string, ...parts: unknown[]): string {
  return uuidV5(CORE_V2_NAMESPACE, canonical([kind, ...parts]));
}

export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}
