/* Deterministic fingerprints, and nothing that could drift into one.
 *
 * A fingerprint is computed over immutable identities only — role, task type,
 * subject, source hashes, dependency claim hashes, contract versions. Signed
 * URLs, timestamps, worker ids and temporary paths are excluded by never being
 * passed in, not by being filtered out.
 */
import { createHash } from "node:crypto";

export function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/* One written form for one meaning: keys sorted, nested. Arrays keep their
   order — for a fingerprint, order is part of the identity of a source list. */
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

export function shortId(prefix: string, ...parts: unknown[]): string {
  return `${prefix}_${sha256(canonical(parts)).slice(0, 16)}`;
}
