/* WHICH OF THE THREE SECTIONS A FINDING BELONGS IN.
 *
 *   Confirmed        two independent readings said the same thing about the
 *                    same place, and nothing contradicted it.
 *   Discrepancy      two readings differ, or a reviewer went back to the
 *                    source and read otherwise.
 *   Needs a check    everything else — and it is not a failure state. A page
 *                    nobody could read, a reading nobody corroborated, an
 *                    answer of "unclear". A thing here has NOT been decided,
 *                    and saying so is the product.
 *
 * IT LIVES HERE, NOT IN THE DOOR, so that the rule a person's screen is
 * arranged by can be read on its own and argued with on its own — and so a
 * test can put a case to it directly rather than through an HTTP handler.
 *
 * The one thing it will not do: call an ambiguous automatic agreement
 * "confirmed". Corroboration means two readings from DIFFERENT independence
 * domains reaching the same answer. One reading is never enough, two readings
 * from the same family are never enough, and an answer of "unclear" agreed
 * twice over is still unclear.
 */

export type Section = "confirmed" | "discrepancy" | "needsCheck";

/* Only the fields the rule reads. Everything else a screen wants to show —
   the model, the quote, the claim id — rides along untouched, which is why
   each of these ends in an index signature rather than a closed shape. */
export type Reading = {
  value?: { text?: unknown; known?: unknown } | null;
  independenceDomain?: string | null;
  status?: string;
  [more: string]: unknown;
};
export type Review = { verdict?: string; [more: string]: unknown };
export type Decision = { type?: string; status?: string; [more: string]: unknown };

export type SubjectShape = {
  readings: Reading[];
  reviews: Review[];
  decisions: Decision[];
  taskStates: string[];
};

/* States that mean the answer for this place is not in yet. */
const STILL_MOVING = new Set(["queued", "leased", "running", "blocked", "created"]);

export function emptySections(): { confirmed: unknown[]; discrepancy: unknown[]; needsCheck: unknown[] } {
  return { confirmed: [], discrepancy: [], needsCheck: [] };
}

/* Read it as a ladder: the first rung that matches wins, so a subject appears
   once and in one place. Contradiction outranks agreement on purpose — a
   reviewer who went back to the source and found otherwise is the strongest
   thing on the page. */
export function sectionFor(subject: SubjectShape): Section {
  const readings = subject.readings ?? [];
  const reviews = subject.reviews ?? [];
  const decisions = subject.decisions ?? [];
  const taskStates = subject.taskStates ?? [];

  if (reviews.some((r) => r.verdict === "contradicts")) return "discrepancy";
  if (decisions.some((d) => d.type === "reject_claim" || d.type === "reject_all")) return "discrepancy";

  /* What each independent family actually said, as the compared answer. */
  const answered = new Map<string, Set<string>>();
  for (const reading of readings) {
    const value = reading.value ?? {};
    const answer = String(value.text ?? value.known ?? "").trim().toLowerCase();
    if (!answer) continue;
    const domain = String(reading.independenceDomain ?? "unknown");
    const said = answered.get(domain) ?? new Set<string>();
    said.add(answer);
    answered.set(domain, said);
  }
  const domains = [...answered.keys()];
  const distinct = new Set([...answered.values()].flatMap((set) => [...set]));

  /* Two independent families, different answers: the discrepancy the whole
     arrangement exists to find. */
  if (domains.length >= 2 && distinct.size > 1) return "discrepancy";

  /* AGREEING ABOUT NOT KNOWING IS NOT A CONFIRMATION.
     The engine will happily mark two "unclear" readings corroborated, and it
     is right to: two independent readers did say the same thing. But what
     they said is that the material does not settle the question, and putting
     that under Confirmed would turn "we could not tell" into "we checked".
     This is the one place the product's word and the engine's word differ,
     and the difference is deliberate. */
  const onlyUnclear = distinct.size > 0 && [...distinct].every((answer) => answer === "unclear");
  if (onlyUnclear) return "needsCheck";

  const decided = decisions.some((d) =>
    d.type === "accept_claim" && (d.status === "machine_decided" || d.status === "human_decided"));
  const corroborated = domains.length >= 2 && distinct.size === 1 && !distinct.has("unclear");
  const accepted = readings.some((r) => r.status === "accepted" || r.status === "verified");
  const stillWorking = taskStates.some((state) => STILL_MOVING.has(state));

  if ((decided || corroborated || accepted) && !stillWorking) return "confirmed";
  return "needsCheck";
}
