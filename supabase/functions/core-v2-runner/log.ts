/* ONE LINE OF JSON, AND WHAT IT IS NOT ALLOWED TO CARRY.
 *
 * An operator needs to scan a log and answer: which workflow, which task,
 * which attempt, what happened, how long. Everything else in this system —
 * a source's words, a person's words, a prompt, a provider's payload, a key —
 * has a place it lives, and a log is not that place. A log is copied,
 * forwarded, pasted into tickets and kept for years by people who never
 * decided to keep it.
 *
 * So the values are filtered rather than trusted, on the same rule the
 * dispatcher's own event sink uses: an id, a short token, a number, a boolean
 * or a time. A string that is long, that looks like a credential, or that
 * carries characters an identifier would not, is replaced by a marker saying
 * something was refused — never by the value, and never silently dropped,
 * because an operator reading a log should be able to tell "nothing happened"
 * from "something happened that this line may not repeat".
 */

/* What an operational value may look like: ids, tokens, states, short
   machine words. Deliberately narrow. */
const OPERATIONAL = /^[A-Za-z0-9_.:/@+-]{1,120}$/;
/* Anything shaped like something worth stealing, whatever it is called. */
const CREDENTIAL_SHAPED = /(^|[^A-Za-z0-9])(sk|pk|rk|api|key|token|secret|bearer|password|pat)[-_A-Za-z0-9]{6,}/i;
const REFUSED = "[not operational]";

export type LogValue = string | number | boolean | null;

export function operational(value: unknown): LogValue {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "boolean") return value;
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value !== "string") return REFUSED;
  if (!OPERATIONAL.test(value) || CREDENTIAL_SHAPED.test(value)) return REFUSED;
  return value;
}

/* One line, ready for console.log. `at` is added here so every line has one
   and no caller has to remember. */
export function line(fields: Record<string, unknown>): string {
  const out: Record<string, LogValue> = { at: new Date().toISOString() };
  for (const [key, value] of Object.entries(fields)) {
    if (key === "at") continue;
    if (!OPERATIONAL.test(key)) continue;
    out[key] = operational(value);
  }
  return JSON.stringify(out);
}

/* An array of ids, capped, for the one case where a line is about several
   workflows: the watchdog's own summary. */
export function operationalList(values: unknown[], cap = 20): LogValue[] {
  return values.slice(0, cap).map(operational);
}
