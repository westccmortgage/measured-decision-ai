/* What a caller is told when something fails.
 *
 * A message we wrote — "This capture session has already been submitted" — is
 * for the person reading it and should be shown exactly as written. Anything
 * else is the database or an SDK talking about itself: constraint names, column
 * names, internal identifiers, occasionally a fragment of a query. That helps an
 * attacker map the system and helps nobody else, so it goes to the log with a
 * short reference the person can quote instead.
 *
 * The test for "ours" is the status we attached when we threw. Every deliberate
 * refusal in these functions carries one; a Postgres error does not.
 */

export type SafeError = { status: number; body: Record<string, unknown> };

export function safeError(error: unknown, fallback = "Something went wrong on our side."): SafeError {
  const declared = Number((error as { status?: number })?.status) || 0;
  const status = declared >= 400 && declared <= 599 ? declared : 500;
  const authored = declared >= 400 && declared < 500 && error instanceof Error;
  if (authored) return { status, body: { error: error.message } };
  const reference = crypto.randomUUID().slice(0, 8);
  console.error(`[${reference}]`, error);
  return {
    status,
    body: { error: `${fallback} Quote reference ${reference} if you report this.`, reference },
  };
}
