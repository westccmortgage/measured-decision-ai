/* THE OWNER'S OWN FILES, READ TWICE AND CHECKED.
 *
 * WHAT THIS PACK IS FOR.
 *
 * `synthetic-records` invents its material from a seed, which is what made it
 * useful: a test can compute the truth and check the engine against it. It is
 * not a product. This pack reads what somebody actually uploaded — pages of a
 * PDF, frames of a video — and it is the pack a real analysis runs.
 *
 * WHAT A SUBJECT IS HERE, AND WHY IT IS SHAPED THIS WAY.
 *
 * One page is one subject. One sampled moment of a video is one subject. Two
 * readers, blind to each other, are asked the SAME bounded question about that
 * one place, and each answers in a closed vocabulary — yes, no, or unclear —
 * with an anchor that names where it looked and quotes what is there.
 *
 * The closed vocabulary is not a simplification for its own sake. The kernel
 * compares two readings mechanically: same value, same attributes, or they
 * differ. Free prose never matches free prose, so a pack whose readers answer
 * in sentences produces a disagreement on every subject and hands the whole
 * analysis to a person — technically honest, practically useless. Putting the
 * ANSWER in the compared field and the EVIDENCE in the anchor gives both: two
 * readers can genuinely corroborate each other, and every corroboration comes
 * with the words on the page that support it.
 *
 * WHAT IT DOES NOT DO.
 *
 *   · it does not invent a place. An anchor names a page and a box inside that
 *     page, or a second inside a video. Nothing here derives a position in
 *     space from a picture, and nothing here guesses a direction inside a
 *     panorama that the material did not carry;
 *   · it does not read what it was not given. A reader receives one page or
 *     one frame, and the text of that page when the file had text;
 *   · it does not claim a video was watched. What was sampled is what was
 *     sampled, and the record says which moments those were.
 */
import type {
  AgentResultEnvelope, AgentRoleDefinition, ClaimRecord, ProposedClaim, SegmentRecord,
  SourceDescriptor, TaskRecord, WorkPacket,
} from "../../kernel/contracts.ts";
import { KERNEL_TASK_TYPES } from "../../kernel/contracts.ts";
import { DEFAULT_NORMALISERS } from "../../kernel/comparison.ts";
import type { DomainPack, ExpansionInput, TaskSpec } from "../../kernel/domain.ts";
import { INDEPENDENCE_GROUPS } from "../../kernel/domain.ts";

export const PACK_ID = "source-documents";
export const PACK_VERSION = "1.0";

export const TASK = {
  readPage: `${PACK_ID}:read_page`,
  readMoment: `${PACK_ID}:read_moment`,
  /* THE TWO ASSIGNMENTS THAT CAN ANSWER A COMPARISON.
     A reader handed one page can say what is on it and no more. Whether a set
     agrees with itself, and whether what the camera saw is what the sheet
     called for, are questions about TWO pieces of material, and they are only
     answerable when both are in the same assignment — the same two, for both
     blind readers. */
  comparePages: `${PACK_ID}:compare_pages`,
  momentAgainstPage: `${PACK_ID}:moment_against_page`,
};

/* The three answers a reader may give, and nothing else. `unclear` is a real
   answer and the most important one: it is how a reader says the material does
   not settle the question, which is a fact the owner needs and which a reader
   forced to choose yes or no would bury. */
export const ANSWERS = new Set(["yes", "no", "unclear"]);

/* Every segment kind this pack understands, and what it is. */
export const SEGMENT_KINDS = {
  page: "page",
  pageText: "page_text",
  moment: "moment",
};

/* WHAT A SUBJECT KEY SAYS, so that a screen, a claim and a task all name the
   same thing the same way. Every one of these is places in the owner's own
   material — file ordinal and page or moment ordinal — and nothing else. */
export const SUBJECT = {
  page: (file: number, page: number) => `page/${file}/${page}`,
  moment: (file: number, moment: number) => `moment/${file}/${moment}`,
  /* Sorted, so the same two sheets are one subject however they were found. */
  pages: (a: { file: number; ordinal: number }, b: { file: number; ordinal: number }) => {
    const [first, second] = [a, b].sort((x, y) => x.file - y.file || x.ordinal - y.ordinal);
    return `pages/${first.file}/${first.ordinal}/${second.file}/${second.ordinal}`;
  },
  momentAgainstPage: (m: { file: number; ordinal: number }, p: { file: number; ordinal: number }) =>
    `moment/${m.file}/${m.ordinal}/page/${p.file}/${p.ordinal}`,
};

/* The pairs a workflow was started over, as the manifest carries them. The
   pack does not decide them: deciding what corresponds to what needs the page
   TEXT, which segments do not carry, and it must be settled once rather than
   recomputed differently on some later pass. workers/core-v2-runner/pairing.ts
   decides; this reads. */
export type ScopePlace = { file: number; ordinal: number };
export type ScopePair =
  | { kind: "pages"; a: ScopePlace; b: ScopePlace; why?: string }
  | { kind: "moment_page"; moment: ScopePlace; page: ScopePlace; why?: string };

/* ─────────────────────────────────────────────────────────── the contracts
 *
 * Written out in full, because a rule a reader is judged by belongs in the
 * instruction the reader is handed. Every clause below is a clause the
 * envelope checker enforces; the first paid canary spent four readings
 * discovering rules that lived only in the checker.
 */
const ANCHOR_RULE =
  "Every claim names at least one anchor in anchors[], and every anchorKey it "
  + "names is an anchor you also returned. An anchor sets segmentId to the "
  + "segment you were handed and quotedText to the words at that place copied "
  + "character for character when the material has words, or a short plain "
  + "description of what is visible there when it does not. Two anchor kinds "
  + "and no others: sourceKind \"segment_locator\" when you can bound the "
  + "region you read, and sourceKind \"segment\" with locator \"{}\" when you "
  + "cannot. Bounding it is better; guessing at it is worse than not bounding "
  + "it at all.";

const LOCATOR_RULE_PAGE =
  "For a \"segment_locator\" anchor, locator is {\"bbox\":[left,top,right,bottom]} "
  + "— four numbers normalised 0..1 against the page image you were given, "
  + "left <= right and top <= bottom. The image is the whole page, so your box "
  + "lies inside [0,0,1,1]. No other key of locator is read.";

const LOCATOR_RULE_MOMENT =
  "For a \"segment_locator\" anchor, locator is {\"bbox\":[left,top,right,bottom]} "
  + "normalised 0..1 against the frame you were given. The TIME is already in "
  + "the record and is not yours to set; neither is a compass direction or a "
  + "position in space. Do not invent one. If you cannot bound the region, use "
  + "sourceKind \"segment\" and locator {}.";

const ANSWER_RULE =
  "value.known true with value.text exactly one of \"yes\", \"no\" or \"unclear\", "
  + "and unit null. Nothing else is a valid answer. Use \"unclear\" when the "
  + "material does not settle the question — that is an answer, not a failure. "
  + "Use value.known false ONLY when you could not read the material at all, and "
  + "then say why in limitations[].";

const ONE_CLAIM_RULE =
  "Exactly one claim: predicate \"finding\", subjectType and subjectKey copied "
  + "unchanged from the assignment you were given. You are answering about that "
  + "one place and no other.";

/* WHAT "YES" MEANS WHEN THERE ARE TWO PIECES OF MATERIAL.
   A closed vocabulary is only useful if every reader means the same thing by
   it, so the pair contracts say what each word claims rather than leaving a
   reader to decide. */
const PAIR_ANSWER_RULE_PAGES =
  "value.text is exactly one of \"yes\", \"no\" or \"unclear\". \"yes\" means the "
  + "two sheets AGREE on everything you were asked about. \"no\" means you found "
  + "something one sheet states and the other contradicts — quote BOTH, one in "
  + "each anchor. \"unclear\" means the two sheets do not settle it between them, "
  + "which is an answer and not a failure.";

const PAIR_ANSWER_RULE_MOMENT =
  "value.text is exactly one of \"yes\", \"no\" or \"unclear\". \"yes\" means what "
  + "this frame shows MATCHES what the sheet calls for. \"no\" means the sheet "
  + "calls for something this frame contradicts — anchor to the line on the "
  + "sheet and to the place in the frame. \"unclear\" means this frame does not "
  + "settle it. A \"no\" is about THIS MOMENT: it is not a statement that the "
  + "thing is missing from the video, and you must not write one.";

const TWO_ANCHORS_RULE =
  "Your claim names an anchor in EACH piece of material you were given — one "
  + "on each sheet, or one on the sheet and one in the frame. A comparison "
  + "anchored to only one side is an assertion about a pair that only looked "
  + "at half of it.";

export const ROLES: AgentRoleDefinition[] = [
  {
    roleKey: "page_reader", version: "1.0", kind: "analyst", phase: "analyze", taskTypes: [TASK.readPage],
    description: "Reads one page of one document and answers the analysis question about that page alone.",
    inputContract: "one page image, and the text of that page when the file carried any",
    outputContract: `${ONE_CLAIM_RULE} ${ANSWER_RULE} ${ANCHOR_RULE} ${LOCATOR_RULE_PAGE} `
      + "You are one of two readers working separately on this page. You cannot see the other "
      + "reading and must not guess at it.",
    maximumSources: 2, maximumClaims: 1, maximumFollowUpDepth: 0, requiresVisualInput: true, requiresIndependentReading: true,
    allowedActions: ["request_human_review"], routingProfile: "visual_analysis", executorKind: "model",
    producesAssessments: false, producesAdjudication: false, producesDecisions: false, producesCalculations: false, producesSegments: false,
  },
  {
    roleKey: "moment_reader", version: "1.0", kind: "analyst", phase: "analyze", taskTypes: [TASK.readMoment],
    description: "Reads one sampled frame of a video and answers the analysis question about that moment alone.",
    inputContract: "one frame image, taken at a time the record holds",
    outputContract: `${ONE_CLAIM_RULE} ${ANSWER_RULE} ${ANCHOR_RULE} ${LOCATOR_RULE_MOMENT} `
      + "This is ONE sampled frame, not the whole video. Answer about what this frame shows. "
      + "Not seeing something in this frame is not evidence that it is absent from the video, "
      + "and you must not say that it is. You are one of two readers working separately on this "
      + "frame and cannot see the other reading.",
    maximumSources: 1, maximumClaims: 1, maximumFollowUpDepth: 0, requiresVisualInput: true, requiresIndependentReading: true,
    allowedActions: ["request_human_review"], routingProfile: "visual_analysis", executorKind: "model",
    producesAssessments: false, producesAdjudication: false, producesDecisions: false, producesCalculations: false, producesSegments: false,
  },
  {
    roleKey: "page_pair_reader", version: "1.0", kind: "analyst", phase: "analyze", taskTypes: [TASK.comparePages],
    description: "Reads two sheets of one set together and answers whether they agree.",
    inputContract: "two page images, and the text of each page where the file carried any",
    outputContract: `${ONE_CLAIM_RULE} ${PAIR_ANSWER_RULE_PAGES} ${ANCHOR_RULE} ${TWO_ANCHORS_RULE} ${LOCATOR_RULE_PAGE} `
      + "You were given exactly these two sheets. Do not reason about a third, and do not "
      + "assume what a sheet you were not shown says. You are one of two readers working "
      + "separately on this same pair and cannot see the other reading.",
    maximumSources: 4, maximumClaims: 1, maximumFollowUpDepth: 0, requiresVisualInput: true, requiresIndependentReading: true,
    allowedActions: ["request_human_review"], routingProfile: "visual_analysis", executorKind: "model",
    producesAssessments: false, producesAdjudication: false, producesDecisions: false, producesCalculations: false, producesSegments: false,
  },
  {
    roleKey: "moment_page_reader", version: "1.0", kind: "analyst", phase: "analyze", taskTypes: [TASK.momentAgainstPage],
    description: "Reads one sampled frame against one plan sheet and answers whether what is visible matches what the sheet calls for.",
    inputContract: "one frame image taken at a time the record holds, one page image, and the text of that page where the file carried any",
    outputContract: `${ONE_CLAIM_RULE} ${PAIR_ANSWER_RULE_MOMENT} ${ANCHOR_RULE} ${TWO_ANCHORS_RULE} ${LOCATOR_RULE_MOMENT} `
      + "This is ONE sampled frame, not the whole video, and one sheet, not the whole set. "
      + "You are one of two readers working separately on this same pair and cannot see the "
      + "other reading.",
    maximumSources: 3, maximumClaims: 1, maximumFollowUpDepth: 0, requiresVisualInput: true, requiresIndependentReading: true,
    allowedActions: ["request_human_review"], routingProfile: "visual_analysis", executorKind: "model",
    producesAssessments: false, producesAdjudication: false, producesDecisions: false, producesCalculations: false, producesSegments: false,
  },
];

export type SourceDocumentsOptions = {
  /* The owner's question, in the owner's words. It reaches the reader as the
     objective of the assignment and nowhere else — a reader is never told what
     another reader said, or what the analysis has concluded so far. */
  question?: string;
  /* How many blind readers per subject. Two, unless the policy allows fewer. */
  readers?: number;
  /* The pairs this workflow was started over, decided once from the record.
     Empty means every place is read on its own, which is what a "check one
     thing" analysis asks for. */
  pairs?: ScopePair[];
};

const DEFAULT_QUESTION =
  "Report what this material shows about the analysis question.";

export class SourceDocumentsPack implements DomainPack {
  readonly id = PACK_ID;
  readonly version = PACK_VERSION;
  readonly roles = ROLES;
  readonly objectives: Record<string, string>;
  readonly question: string;
  readonly pairs: ScopePair[];
  private readers: number;

  constructor(options: SourceDocumentsOptions = {}) {
    this.question = (options.question ?? "").trim() || DEFAULT_QUESTION;
    this.readers = Math.max(1, Math.min(2, options.readers ?? 2));
    this.pairs = options.pairs ?? [];
    this.objectives = {
      /* THE OWNER'S QUESTION ON A LINE OF ITS OWN, under a marker.
         An instruction is mostly instruction; the question inside it is the
         one part that changes from analysis to analysis, and it is the part
         anything reading the record afterwards — a person, a test, the
         stand-in that answers offline — needs to be able to pick out exactly.
         Marking it costs a word and removes a whole class of "the reader
         answered about the wrong thing". */
      [TASK.readPage]:
        `Look at this one page and answer this question about it.\nQUESTION: ${this.question}\n`
        + "Answer yes, no, or unclear, and anchor your answer to the place on the page you "
        + "looked at, quoting what is written there. Answer about this page only.",
      [TASK.readMoment]:
        `Look at this one frame and answer this question about it.\nQUESTION: ${this.question}\n`
        + "Answer yes, no, or unclear, and anchor your answer to what is visible in the frame. "
        + "This is one sampled moment, not the whole video: do not conclude anything about "
        + "moments you were not shown.",
      [TASK.comparePages]:
        `Here are two sheets from the same set. Read them together and answer this question.\nQUESTION: ${this.question}\n`
        + "Answer yes if they agree, no if one states something the other contradicts, or "
        + "unclear if they do not settle it between them. Quote the line you read on EACH "
        + "sheet. These two sheets are all you were given; do not reason about a third.",
      [TASK.momentAgainstPage]:
        `Here is one sampled frame of a video and one plan sheet. Answer this question.\nQUESTION: ${this.question}\n`
        + "Answer yes if what the frame shows matches what the sheet calls for, no if the "
        + "sheet calls for something this frame contradicts, or unclear if this frame does "
        + "not settle it. Quote the line on the sheet and say what you saw in the frame. "
        + "A no is about this moment only: it is not a statement that the thing is missing "
        + "from the video.",

      /* THE CRITIC IS TOLD THE QUESTION. It is checking an ANSWER, and an
         answer cannot be checked by somebody who was not told what was asked.
         Without this the critic reads the kernel's generic objective, judges
         the claim against a question nobody put, and disputes findings that
         the material plainly supports — which is worse than not checking at
         all, because it looks like diligence. */
      [KERNEL_TASK_TYPES.verifyClaim]:
        `A reader was asked this question about the material you are being shown.\nQUESTION: ${this.question}\n`
        + "They answered yes, no or unclear. Open the material again and say whether it "
        + "supports that answer: supports if reading it yourself gives the same answer, "
        + "contradicts if it gives a different one — and then say which — insufficient if "
        + "the material cannot settle it either way. Judge the answer, not the wording.",
      [KERNEL_TASK_TYPES.verifyDisagreement]:
        `Two readers gave different answers to this question about the same place.\nQUESTION: ${this.question}\n`
        + "Open the material yourself and say which answer it supports, if either. "
        + "You are not choosing between the readers; you are reading the source.",
    };
  }

  /* Every segment is declared by the source itself — the pages that were
     rendered and the frames that were sampled, each already in the record with
     the hash of its own bytes. There is nothing beneath them to discover. */
  discovererFor(_source: SourceDescriptor): string | null { return null; }

  expand(input: ExpansionInput): TaskSpec[] {
    const specs: TaskSpec[] = [];
    const accepted = input.segments.filter((s) => s.status === "accepted");
    const texts = accepted.filter((s) => s.segmentKind === SEGMENT_KINDS.pageText);
    const groups = INDEPENDENCE_GROUPS.slice(0, Math.min(this.readers, input.policy.maximumIndependentReadersPerSubject));
    const ordinalOf = (sourceId: string) => input.manifest.sources.find((x) => x.sourceId === sourceId)?.ordinal ?? 0;

    /* The places, by where they are in the owner's material rather than by
       segment id, because that is how a pair names them. */
    const at = (kind: string, file: number, ordinal: number) => accepted.find(
      (s) => s.segmentKind === kind && ordinalOf(s.sourceId) === file && s.ordinal === ordinal);
    const textFor = (segment: SegmentRecord | undefined) => segment
      ? texts.find((t) => t.sourceId === segment.sourceId && t.ordinal === segment.ordinal)
      : undefined;
    const ref = (segment: SegmentRecord) => ({ sourceId: null, segmentId: segment.segmentId });

    /* One subject, read blind by each group, then compared. The shape is the
       same whatever the assignment is about; only the material and the task
       type differ, which is the point of doing it in one place. */
    const readTwiceThenCompare = (
      key: string, subject: string, taskType: string, roleKey: string,
      sources: { sourceId: null; segmentId: string }[],
    ) => {
      const keys = groups.map((g) => `read:${key}:${g}`);
      for (const [i, group] of groups.entries()) {
        specs.push({
          key: keys[i], phase: "analyze", taskType, roleKey, subjectKey: subject,
          sources, independenceGroup: group, priority: 100, dependsOn: [], dependsOnTaskIds: [],
        });
      }
      specs.push({
        key: `compare:${key}`, phase: "compare", taskType: KERNEL_TASK_TYPES.compare,
        roleKey: "claim_comparator", subjectKey: subject, sources: [], independenceGroup: null, priority: 200,
        dependsOn: keys.map((k) => ({ key: k, kind: "requires_claims" as const })), dependsOnTaskIds: [],
      });
    };

    /* ── PAIRS, when the analysis was started over any ────────────────────
       A pair is the assignment; the two places inside it are never also read
       on their own, because reading a page alone answers a different question
       and would fill the result with findings nobody asked for. */
    if (this.pairs.length > 0) {
      for (const pair of this.pairs) {
        if (pair.kind === "pages") {
          const a = at(SEGMENT_KINDS.page, pair.a.file, pair.a.ordinal);
          const b = at(SEGMENT_KINDS.page, pair.b.file, pair.b.ordinal);
          if (!a || !b || a.segmentId === b.segmentId) continue;
          const sources = [ref(a), ref(b)];
          const aText = textFor(a); if (aText) sources.push(ref(aText));
          const bText = textFor(b); if (bText) sources.push(ref(bText));
          readTwiceThenCompare(
            `pages:${[a.segmentId, b.segmentId].sort().join(":")}`,
            SUBJECT.pages(pair.a, pair.b), TASK.comparePages, "page_pair_reader", sources);
          continue;
        }
        const moment = at(SEGMENT_KINDS.moment, pair.moment.file, pair.moment.ordinal);
        const page = at(SEGMENT_KINDS.page, pair.page.file, pair.page.ordinal);
        if (!moment || !page) continue;
        const sources = [ref(moment), ref(page)];
        const pageText = textFor(page); if (pageText) sources.push(ref(pageText));
        readTwiceThenCompare(
          `moment-page:${moment.segmentId}:${page.segmentId}`,
          SUBJECT.momentAgainstPage(pair.moment, pair.page), TASK.momentAgainstPage, "moment_page_reader", sources);
      }
      return specs;
    }

    /* ── ONE PLACE AT A TIME, when no pair was asked for ──────────────────
       "Check one thing" is a question about each place on its own, and this
       is the assignment that answers it. */
    for (const segment of accepted) {
      const isPage = segment.segmentKind === SEGMENT_KINDS.page;
      const isMoment = segment.segmentKind === SEGMENT_KINDS.moment;
      if (!isPage && !isMoment) continue;

      const file = ordinalOf(segment.sourceId);
      const subject = isPage ? SUBJECT.page(file, segment.ordinal) : SUBJECT.moment(file, segment.ordinal);
      const companion = isPage ? textFor(segment) : undefined;
      const sources = companion ? [ref(segment), ref(companion)] : [ref(segment)];
      readTwiceThenCompare(
        segment.segmentId, subject,
        isPage ? TASK.readPage : TASK.readMoment,
        isPage ? "page_reader" : "moment_reader", sources);
    }
    return specs;
  }

  decisionSubjects(claims: ClaimRecord[]): string[] {
    return [...new Set(
      claims.filter((c) => c.status === "accepted" && c.predicate === "finding").map((c) => c.subjectKey),
    )].sort();
  }

  validateClaim(packet: WorkPacket, claim: ProposedClaim, _envelope: AgentResultEnvelope): string[] {
    const problems: string[] = [];
    /* One subject type per assignment, so a claim cannot quietly answer about
       a different shape of thing than it was asked about. */
    const SUBJECT_TYPE: Record<string, string> = {
      [TASK.readPage]: "page",
      [TASK.readMoment]: "moment",
      [TASK.comparePages]: "pages",
      [TASK.momentAgainstPage]: "moment_page",
    };
    const wanted = SUBJECT_TYPE[packet.taskType];
    if (!wanted) {
      if (packet.taskType.startsWith(`${PACK_ID}:`)) problems.push(`claim ${claim.claimKey}: ${packet.taskType} produces no claims`);
      return problems;
    }
    if (claim.predicate !== "finding") {
      problems.push(`claim ${claim.claimKey}: a reader of this pack reports "finding", not "${claim.predicate}"`);
    }
    if (claim.subjectType !== wanted) {
      problems.push(`claim ${claim.claimKey}: subjectType must be "${wanted}", copied from the assignment`);
    }
    if (this.normaliseKey(claim.subjectKey) !== this.normaliseKey(packet.subjectKey)) {
      problems.push(`claim ${claim.claimKey}: this assignment is about ${packet.subjectKey}, and a reading of it answers about that and nothing else`);
    }
    if (claim.unit !== null && claim.unit !== undefined && String(claim.unit).trim() !== "") {
      problems.push(`claim ${claim.claimKey}: a finding carries no unit`);
    }
    if (claim.value.known) {
      const answer = String(claim.value.text ?? "").trim().toLowerCase();
      if (!ANSWERS.has(answer)) {
        problems.push(`claim ${claim.claimKey}: value.text must be exactly "yes", "no" or "unclear", and is "${claim.value.text}"`);
      }
      if (claim.value.quantity !== null && claim.value.quantity !== undefined) {
        problems.push(`claim ${claim.claimKey}: a finding is an answer, not a quantity`);
      }
    }
    /* A COMPARISON THAT LOOKED AT ONE SIDE IS NOT A COMPARISON.
       The kernel checks that every anchor points somewhere real; only the pack
       knows that THIS assignment was about two places and that an answer
       resting on one of them is an assertion about a pair half of which was
       never opened. */
    if (packet.taskType === TASK.comparePages || packet.taskType === TASK.momentAgainstPage) {
      const named = new Set(
        (_envelope.anchors ?? [])
          .filter((a) => claim.anchorKeys.includes(a.anchorKey))
          .map((a) => a.segmentId)
          .filter((id): id is string => typeof id === "string" && id.length > 0));
      /* The page's own text is the same place as its image, so the two sides
         are counted by which piece of material they belong to rather than by
         how many segments happened to be attached. */
      const sides = new Set<string>();
      for (const id of named) {
        const source = packet.sources.find((x) => x.segmentId === id);
        if (source) sides.add(`${source.sourceId}/${source.locator?.page ?? source.ordinal}`);
      }
      if (sides.size < 2) {
        problems.push(
          `claim ${claim.claimKey}: this assignment is about two pieces of material and the answer anchors to ${sides.size === 1 ? "only one" : "neither"} of them`);
      }
    }
    return problems;
  }

  normaliseUnit(unit: string | null): string | null {
    if (unit === null || unit === undefined) return null;
    const u = unit.trim().toLowerCase();
    return u === "" ? null : u;
  }
  normaliseKey(key: string): string { return DEFAULT_NORMALISERS.key(key); }

  /* A page's text belongs to that page and to nothing else; a frame stands
     alone. Nothing here relates two pages of one document to each other: a
     reader given page 4 was given page 4. */
  isRelated(target: SegmentRecord, task: TaskRecord, segments: SegmentRecord[]): boolean {
    const own = task.sources
      .map((s) => segments.find((x) => x.segmentId === s.segmentId))
      .filter(Boolean) as SegmentRecord[];
    return own.some((o) => o.sourceId === target.sourceId && o.ordinal === target.ordinal);
  }
  isReference(segment: SegmentRecord): boolean { return segment.segmentKind === SEGMENT_KINDS.pageText; }
  linkedSegments(segment: SegmentRecord, segments: SegmentRecord[]): SegmentRecord[] {
    if (segment.segmentKind !== SEGMENT_KINDS.page) return [];
    return segments.filter((s) =>
      s.segmentKind === SEGMENT_KINDS.pageText && s.sourceId === segment.sourceId && s.ordinal === segment.ordinal);
  }

  /* Nothing in this pack is derived by code. The findings are read, compared
     and criticised; the arithmetic packs do arithmetic and this one does not
     pretend to. */
  async derive(packet: WorkPacket): Promise<AgentResultEnvelope> {
    return {
      packetVersion: packet.packetVersion, taskId: packet.taskId, roleKey: packet.roleKey, roleVersion: packet.roleVersion,
      outcome: "insufficient_evidence", segments: [], claims: [], anchors: [], assessments: [], adjudication: null,
      decisions: [], calculations: [], disagreements: [], requestedActions: [],
      limitations: ["this pack derives nothing; a finding is read, not calculated"],
      rawResponseReference: null,
    } as AgentResultEnvelope;
  }
}
