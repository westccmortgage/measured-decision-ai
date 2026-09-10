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
];

export type SourceDocumentsOptions = {
  /* The owner's question, in the owner's words. It reaches the reader as the
     objective of the assignment and nowhere else — a reader is never told what
     another reader said, or what the analysis has concluded so far. */
  question?: string;
  /* How many blind readers per subject. Two, unless the policy allows fewer. */
  readers?: number;
};

const DEFAULT_QUESTION =
  "Report what this material shows about the analysis question.";

export class SourceDocumentsPack implements DomainPack {
  readonly id = PACK_ID;
  readonly version = PACK_VERSION;
  readonly roles = ROLES;
  readonly objectives: Record<string, string>;
  readonly question: string;
  private readers: number;

  constructor(options: SourceDocumentsOptions = {}) {
    this.question = (options.question ?? "").trim() || DEFAULT_QUESTION;
    this.readers = Math.max(1, Math.min(2, options.readers ?? 2));
    this.objectives = {
      [TASK.readPage]:
        `Look at this one page and answer this question about it: ${this.question}\n`
        + "Answer yes, no, or unclear, and anchor your answer to the place on the page you "
        + "looked at, quoting what is written there. Answer about this page only.",
      [TASK.readMoment]:
        `Look at this one frame and answer this question about it: ${this.question}\n`
        + "Answer yes, no, or unclear, and anchor your answer to what is visible in the frame. "
        + "This is one sampled moment, not the whole video: do not conclude anything about "
        + "moments you were not shown.",
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

    for (const segment of accepted) {
      const isPage = segment.segmentKind === SEGMENT_KINDS.page;
      const isMoment = segment.segmentKind === SEGMENT_KINDS.moment;
      if (!isPage && !isMoment) continue;

      const subject = isPage
        ? `page/${ordinalOf(segment.sourceId)}/${segment.ordinal}`
        : `moment/${ordinalOf(segment.sourceId)}/${segment.ordinal}`;
      const taskType = isPage ? TASK.readPage : TASK.readMoment;
      const roleKey = isPage ? "page_reader" : "moment_reader";

      /* The page's own text, when the file carried any. A scanned page has
         none, and then the reader has the image and says so if it cannot
         read it — which is the honest outcome for a scan. */
      const companion = isPage
        ? texts.find((t) => t.sourceId === segment.sourceId && t.ordinal === segment.ordinal)
        : undefined;
      const sources = companion
        ? [{ sourceId: null, segmentId: segment.segmentId }, { sourceId: null, segmentId: companion.segmentId }]
        : [{ sourceId: null, segmentId: segment.segmentId }];

      const keys = groups.map((g) => `read:${segment.segmentId}:${g}`);
      for (const [i, group] of groups.entries()) {
        specs.push({
          key: keys[i], phase: "analyze", taskType, roleKey, subjectKey: subject,
          sources, independenceGroup: group, priority: 100, dependsOn: [], dependsOnTaskIds: [],
        });
      }
      specs.push({
        key: `compare:${segment.segmentId}`, phase: "compare", taskType: KERNEL_TASK_TYPES.compare,
        roleKey: "claim_comparator", subjectKey: subject, sources: [], independenceGroup: null, priority: 200,
        dependsOn: keys.map((k) => ({ key: k, kind: "requires_claims" as const })), dependsOnTaskIds: [],
      });
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
    if (packet.taskType !== TASK.readPage && packet.taskType !== TASK.readMoment) {
      if (packet.taskType.startsWith(`${PACK_ID}:`)) problems.push(`claim ${claim.claimKey}: ${packet.taskType} produces no claims`);
      return problems;
    }
    const wanted = packet.taskType === TASK.readPage ? "page" : "moment";
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
