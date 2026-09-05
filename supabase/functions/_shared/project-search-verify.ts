/* ASK THIS PROJECT — the part that decides what a person is allowed to see.
 *
 * It lives in its own file because it is the part worth testing on its own,
 * and because a test of it must run the shipping code rather than a copy.
 * Nothing here reaches the network, the database or the clock: records in, a
 * verdict out.
 *
 * The rule it exists to enforce, stated once: a sentence is shown only when
 * every source under it is a record this project actually returned. The model
 * proposes; this file decides.
 */

export const REFUSAL_SENTENCE =
  "I could not find enough evidence in this project to answer reliably.";

export type ContextRow = {
  source_id: string;
  kind: string;
  title: string | null;
  body: string | null;
  filename: string | null;
  sheet_ref: string | null;
  page_number: number | null;
  room_id: string | null;
  room_name: string | null;
  happened_at: string | null;
  document_id: string | null;
  evidence_id: string | null;
  record_id: string | null;
  version: string | null;
};

/* The same question asked twice must be the same purchase. Case, spacing and
   trailing punctuation are not different questions. */
export function normaliseQuestion(question: string) {
  return String(question || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[?!.,;:]+$/g, "")
    .trim();
}

/* Exactly what leaves this building.
 *
 * Four fields per record and no more. Sheet numbers, page numbers, room ids,
 * evidence ids, filenames and timestamps stay here — which is why a model
 * cannot cite a sheet it was never shown, and why a citation's click target is
 * never something a model wrote. */
export function recordsForModel(context: ContextRow[]) {
  return context.map((row) => ({
    source_id: row.source_id,
    kind: row.kind,
    title: row.title,
    detail: row.body,
  }));
}

/* Where a source opens, built from the row the database returned. */
export function citationFor(row: ContextRow, why: string) {
  const base = {
    source_id: row.source_id,
    kind: row.kind,
    why,
    label: row.title || row.kind,
    when: row.happened_at,
  };
  switch (row.kind) {
    case "document":
      return {
        ...base,
        opens: "document",
        document_id: row.document_id,
        filename: row.filename,
        sheet_ref: row.sheet_ref,
        page_number: row.page_number,
      };
    case "capture":
      return {
        ...base,
        opens: "capture",
        evidence_id: row.evidence_id,
        room_id: row.room_id,
        room_name: row.room_name,
        filename: row.filename,
      };
    case "room":
      return { ...base, opens: "room", room_id: row.room_id, room_name: row.room_name };
    case "observation":
      return {
        ...base,
        opens: row.evidence_id ? "capture" : "comparison",
        evidence_id: row.evidence_id,
        room_id: row.room_id,
        room_name: row.room_name,
      };
    /* A derived record must never be a citation on its own: the person has to
       be able to reach what it was derived FROM. The sheet refs the reading was
       measured against ride along, and the evidence rows behind it are
       retrieved as their own citations beside it. */
    case "requirement":
    case "reconciliation":
    case "gap":
    default:
      return { ...base, opens: "comparison", sheet_ref: row.sheet_ref, record_id: row.record_id };
  }
}

export type Reading = {
  answer?: unknown;
  citations?: unknown;
  limitations?: unknown;
  confidence?: unknown;
};

export type Verdict = {
  answer: string;
  citations: Array<Record<string, unknown>>;
  limitations: string | null;
  confidence: string;
  refused: boolean;
  refusalReason: string | null;
  dropped: number;
  /* The prose the model actually produced, kept for the record even when it is
     refused — so a later question about why nothing was shown has an answer.
     It is never returned to the browser. */
  modelAnswer: string;
};

/* The decision.
 *
 * Three outcomes, and only the first shows the model's words:
 *   verified   — at least one citation is a record that really went out
 *   refused    — the model itself said the record does not support an answer
 *   refused    — the model asserted something and cited nothing that survived
 *
 * The third is the one that matters. A confident paragraph with no surviving
 * source is not a weaker answer to be hedged; it is an unverifiable claim, and
 * showing it would be the single thing this product promises never to do. */
export function verifyReading(context: ContextRow[], reading: Reading): Verdict {
  const byId = new Map(context.map((row) => [row.source_id, row]));
  const claimed = Array.isArray(reading?.citations) ? reading.citations : [];

  const citations: Array<Record<string, unknown>> = [];
  const seen = new Set<string>();
  let dropped = 0;
  for (const entry of claimed) {
    const id = String((entry as { source_id?: unknown })?.source_id ?? "");
    const row = byId.get(id);
    if (!row) { dropped += 1; continue; }
    if (seen.has(id)) continue;
    seen.add(id);
    citations.push(citationFor(row, String((entry as { why?: unknown })?.why ?? "").slice(0, 200)));
  }

  const modelAnswer = String(reading?.answer ?? "").slice(0, 2000);
  const modelRefused = modelAnswer.trim().length === 0
    || /could not find enough evidence/i.test(modelAnswer);
  const nothingStands = !modelRefused && citations.length === 0;
  const refused = modelRefused || nothingStands;

  const limitations = [
    String(reading?.limitations ?? "").slice(0, 600),
    dropped
      ? `${dropped} reference${dropped === 1 ? "" : "s"} could not be matched to this project's record and ${dropped === 1 ? "was" : "were"} dropped.`
      : "",
  ].filter(Boolean).join(" ");

  const confidence = ["high", "medium", "low"].includes(String(reading?.confidence ?? ""))
    ? String(reading.confidence)
    : "low";

  return {
    answer: refused ? REFUSAL_SENTENCE : modelAnswer,
    citations: refused ? [] : citations,
    limitations: limitations || null,
    confidence: refused ? "low" : confidence,
    refused,
    refusalReason: nothingStands
      ? "no citation survived verification"
      : (modelRefused ? "the record did not support an answer" : null),
    dropped,
    modelAnswer,
  };
}
