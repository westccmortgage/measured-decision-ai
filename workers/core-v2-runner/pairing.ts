/* WHAT GETS COMPARED WITH WHAT, DECIDED ONCE AND WRITTEN DOWN.
 *
 * A reader handed one page can say what is on it. It cannot say whether the
 * set AGREES WITH ITSELF, and a reader handed one frame cannot say whether
 * what is in front of the camera is what the plan called for. Those questions
 * need two pieces of material in the same assignment, and both blind readers
 * need THE SAME two — otherwise they are not two readings of one thing.
 *
 * So pairing happens here: once, when the analysis is started, from the record
 * of what was prepared. The pairs go into the workflow's requested scope, so
 * they are fixed for the life of the run, identical for every reader, and
 * visible to anybody reading the record afterwards.
 *
 * WHERE A PAIR COMES FROM, IN ORDER:
 *
 *   1. the owner said so. `analysis_runs.pairing` holds their own choice and
 *      it always wins;
 *   2. the sheets say so. A plan sheet carries its own number and names the
 *      sheets it refers to; that is a correspondence the file itself asserts,
 *      and it is read out of the page text rather than guessed;
 *   3. there is only one candidate. One plan page in the whole analysis is the
 *      page a frame is compared with, because there is no other.
 *
 * AND WHEN NONE OF THOSE HOLDS, NOTHING IS INVENTED. The place is returned as
 * unpaired, with the question the owner would have to answer, and it reaches
 * the screen as "Needs a check". A guessed correspondence is worse than an
 * admitted gap: it produces a confident answer about two things that were
 * never related.
 */
import type { AnalysisFile, AnalysisRecord } from "./analysis.ts";

/* A place in the owner's own material: which file, and which page or moment
   of it. Both numbers are the ordinals the record already holds. */
export type PlaceRef = { file: number; ordinal: number };

export type PagePair = { kind: "pages"; a: PlaceRef; b: PlaceRef; why: string };
export type MomentPagePair = { kind: "moment_page"; moment: PlaceRef; page: PlaceRef; why: string };
export type Pair = PagePair | MomentPagePair;

export type Unpaired = {
  kind: "page" | "moment";
  place: PlaceRef;
  /* Said to the owner, in their words, so the gap is actionable rather than
     merely reported. */
  question: string;
};

export type Pairing = { pairs: Pair[]; unpaired: Unpaired[]; note: string };

/* The owner's own choice, as it is stored on the analysis. Both halves are
   optional and either may be empty. */
export type ChosenPairing = {
  pagePairs?: { a: PlaceRef; b: PlaceRef }[];
  /* For each video file, the plan pages this clip should be compared against. */
  momentPages?: { file: number; pages: PlaceRef[] }[];
};

/* A sheet number as plan sets actually write them: one or two letters, a
   hyphen, two or three digits, optionally a point and more digits. Deliberately
   narrow — "D01" is a door, "1000 x 2100" is a size, and neither is a sheet. */
const SHEET_CODE = /\b([A-Z]{1,2}-\d{2,3}(?:\.\d{1,2})?)\b/g;

export function sheetCodesIn(text: string): string[] {
  const found: string[] = [];
  for (const match of String(text ?? "").matchAll(SHEET_CODE)) {
    if (!found.includes(match[1])) found.push(match[1]);
  }
  return found;
}

const place = (file: number, ordinal: number): PlaceRef => ({ file, ordinal });
const samePlace = (a: PlaceRef, b: PlaceRef) => a.file === b.file && a.ordinal === b.ordinal;
export const placeKey = (p: PlaceRef) => `${p.file}/${p.ordinal}`;

/* Every page of every PDF in the analysis, with whatever text that page
   carried. A page with no text layer — a scan — has an empty string, which is
   a fact rather than a failure. */
export function pagesOf(analysis: AnalysisRecord): { place: PlaceRef; text: string }[] {
  const out: { place: PlaceRef; text: string }[] = [];
  for (const file of analysis.files) {
    if (file.kind !== "pdf") continue;
    for (const part of file.parts) {
      if (part.partKind !== "pdf_page_image") continue;
      const text = file.parts.find(
        (p) => p.partKind === "pdf_page_text" && p.ordinal === part.ordinal)?.inlineText ?? "";
      out.push({ place: place(file.ordinal, part.ordinal), text });
    }
  }
  return out.sort((x, y) => x.place.file - y.place.file || x.place.ordinal - y.place.ordinal);
}

export function momentsOf(analysis: AnalysisRecord): PlaceRef[] {
  const out: PlaceRef[] = [];
  for (const file of analysis.files) {
    if (file.kind !== "video" && file.kind !== "video360") continue;
    for (const part of file.parts) {
      if (part.partKind !== "video_frame") continue;
      out.push(place(file.ordinal, part.ordinal));
    }
  }
  return out.sort((x, y) => x.file - y.file || x.ordinal - y.ordinal);
}

/* WHICH SHEET IS WHICH.
 *
 * A sheet's own number is the first one in its text. That is the title block,
 * which pdf.js reports first because it is at the top of the page — a
 * convention, and one this code states out loud rather than relies on
 * silently: where it is wrong, the owner's own pairing overrides it, and where
 * it finds nothing the page is returned unpaired rather than guessed at.
 *
 * Two pages claiming the same number is a set with a duplicate sheet in it.
 * The first wins and the second is left without a home, which is exactly the
 * "say which sheet you mean" case. */
export function homeSheets(pages: { place: PlaceRef; text: string }[]): Map<string, PlaceRef> {
  const home = new Map<string, PlaceRef>();
  for (const page of pages) {
    const codes = sheetCodesIn(page.text);
    if (codes.length === 0) continue;
    if (!home.has(codes[0])) home.set(codes[0], page.place);
  }
  return home;
}

/* ─────────────────────────────────────────────────────────── the decision */

export function decidePairing(
  analysis: AnalysisRecord,
  chosen: ChosenPairing = {},
  limits: { maximumPairs?: number } = {},
): Pairing {
  const maximumPairs = Math.max(1, limits.maximumPairs ?? 120);
  const pages = pagesOf(analysis);
  const moments = momentsOf(analysis);
  const known = new Set(pages.map((p) => placeKey(p.place)));

  const pairs: Pair[] = [];
  const unpaired: Unpaired[] = [];
  const paired = new Set<string>();
  const covered = new Set<string>();
  const add = (pair: Pair) => {
    const id = pair.kind === "pages"
      ? [placeKey(pair.a), placeKey(pair.b)].sort().join("|")
      : `${placeKey(pair.moment)}|${placeKey(pair.page)}`;
    if (paired.has(id) || pairs.length >= maximumPairs) return;
    paired.add(id);
    pairs.push(pair);
    if (pair.kind === "pages") { covered.add(placeKey(pair.a)); covered.add(placeKey(pair.b)); }
    else covered.add(placeKey(pair.moment));
  };

  if (analysis.questionKind === "plan_consistency") {
    for (const own of chosen.pagePairs ?? []) {
      if (!known.has(placeKey(own.a)) || !known.has(placeKey(own.b))) continue;
      if (samePlace(own.a, own.b)) continue;
      add({ kind: "pages", a: own.a, b: own.b, why: "you asked for these two to be compared" });
    }
    const home = homeSheets(pages);
    for (const page of pages) {
      const codes = sheetCodesIn(page.text);
      for (const code of codes.slice(1)) {
        const other = home.get(code);
        if (!other || samePlace(other, page.place)) continue;
        add({ kind: "pages", a: page.place, b: other, why: `this sheet names ${code}, which is the other one` });
      }
    }
    for (const page of pages) {
      if (covered.has(placeKey(page.place))) continue;
      unpaired.push({
        kind: "page", place: page.place,
        question: page.text.trim()
          ? "This sheet names no other sheet in this set, and no other sheet names it. Say which sheet it should be compared with."
          : "This page carries no text, so nothing in it says which sheet it is or which it refers to. Say which sheet it should be compared with.",
      });
    }
    return {
      pairs,
      unpaired,
      note: pairs.length
        ? `${pairs.length} pair${pairs.length === 1 ? "" : "s"} of sheets, from what the sheets themselves name`
        : "no two sheets in this set name each other",
    };
  }

  if (analysis.questionKind === "video_against_plans") {
    const byVideo = new Map<number, PlaceRef[]>();
    for (const said of chosen.momentPages ?? []) {
      const wanted = (said.pages ?? []).filter((p) => known.has(placeKey(p)));
      if (wanted.length) byVideo.set(said.file, wanted);
    }
    /* One page in the whole analysis is the page, because there is no other. */
    const onlyPage = pages.length === 1 ? pages[0].place : null;

    for (const moment of moments) {
      const against = byVideo.get(moment.file) ?? (onlyPage ? [onlyPage] : []);
      if (against.length === 0) {
        unpaired.push({
          kind: "moment", place: moment,
          question: "Nothing says which plan sheet this clip should be compared against. Choose the sheets, and every sampled moment will be read against each of them.",
        });
        continue;
      }
      for (const page of against) {
        add({
          kind: "moment_page", moment, page,
          why: byVideo.has(moment.file)
            ? "you chose this sheet for this clip"
            : "there is one plan page in this analysis, so it is the one",
        });
      }
    }
    return {
      pairs,
      unpaired,
      note: pairs.length
        ? `${pairs.length} moment${pairs.length === 1 ? "" : "s"} to read against a sheet`
        : "no clip has a sheet to be compared against",
    };
  }

  /* specific_question: one place, one question, no pair. Asking about a single
     page is exactly what this kind of analysis is. */
  return { pairs: [], unpaired: [], note: "each place is read on its own, which is what this question asks" };
}
