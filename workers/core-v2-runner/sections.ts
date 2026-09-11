/* WHICH OF THE THREE SECTIONS A FINDING BELONGS IN.
 *
 *   Confirmed        the record ACCEPTED the finding — through a check
 *                    against the source, a deterministic rule, or a person —
 *                    and nothing contradicted it. Two readings agreeing is
 *                    not this. It is what sends the claim to be checked.
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
 * Two things it will not do. It will not call an agreement a confirmation —
 * corroboration is a step on the way to acceptance, not a substitute for it,
 * and a run whose critic never finished has findings that are agreed and
 * unconfirmed. And it will not let two readers agreeing on "unclear" count as
 * a discrepancy or as a confirmation: it is agreement about not knowing.
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
  /* Whether this place is a COMPARISON of two pieces of material. It changes
     what "no" means, and nothing else: for a comparison, "no" is the finding
     that the two do not agree — the discrepancy the analysis was run to look
     for. For a single place, "no" is simply the answer to the question. */
  comparison?: boolean;
};

/* A comparison names two places; a single reading names one. The key says
   which, because the key is built from the places themselves. */
export function isComparisonSubject(subjectKey: string): boolean {
  return subjectKey.startsWith("pages/") || /\/page\/\d+\/\d+$/.test(subjectKey);
}

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

  /* SOMETHING DOES NOT LINE UP — in the material, or between the readings.
     A reviewer that reopened the source and read otherwise outranks everything
     else on the page, and two independent readers who differ is the conflict
     the whole arrangement exists to surface. Both belong here rather than in
     "needs a check", because a person should look at them BECAUSE something
     conflicts, not merely because nothing was settled. */
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

  /* CONFIRMED MEANS DECIDED, NOT MERELY AGREED.
   *
   * Two readers saying the same thing is `corroborated`, and the engine is
   * right to call it that: two independent readings did agree. It is not a
   * confirmation. Corroboration is what STARTS the check — the claim goes to a
   * critic that reopens the source, and only after that does the acceptance
   * discipline let it become `accepted` or carry a decided decision.
   *
   * This used to promote `corroborated` on its own, which meant a run whose
   * critic never finished — killed container, exhausted authority, a provider
   * that refused — showed its findings as confirmed anyway. That is the exact
   * failure this whole engine exists to prevent, committed by the screen at
   * the last moment.
   *
   * So the two things that confirm are the two things that are decisions:
   * a claim the record ACCEPTED, and a decision the record made to accept it.
   * Nothing here promotes anything. */
  const decided = decisions.some((d) =>
    d.type === "accept_claim" && (d.status === "machine_decided" || d.status === "human_decided"));
  const settledReadings = readings.filter((r) => r.status === "accepted" || r.status === "verified");
  const accepted = settledReadings.length > 0;
  const stillWorking = taskStates.some((state) => STILL_MOVING.has(state));

  if (!(decided || accepted) || stillWorking) return "needsCheck";

  /* AND WHAT THE SETTLED FINDING ACTUALLY SAYS.
     A comparison that was checked and accepted, and whose answer is "no", is
     a discrepancy the record STANDS BEHIND — which is a stronger and more
     useful thing than a pair of readers who could not agree, and it belongs
     under the same heading a person is looking for it under. */
  if (subject.comparison) {
    const said = settledReadings
      .map((r) => String((r.value ?? {}).text ?? "").trim().toLowerCase())
      .filter(Boolean);
    if (said.includes("no")) return "discrepancy";
  }
  return "confirmed";
}
