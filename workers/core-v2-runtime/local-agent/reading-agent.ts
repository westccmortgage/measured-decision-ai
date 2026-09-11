/* A STAND-IN THAT ANSWERS FROM THE REQUEST, AND FROM NOTHING ELSE.
 *
 * This is not a model and does not pretend to be one. It is the smallest
 * thing that can take a request an adapter actually built — the words, and
 * the material attached to them — and produce an envelope, WITHOUT looking
 * anything up.
 *
 * That last part is the whole point. An earlier version of this package
 * answered by finding a prepared result under the task id in the request.
 * That proves a transport works and proves nothing about whether an agent
 * can read evidence: the answer existed before the request did. This one is
 * handed a question and some bytes and has to read them. Change a number in
 * the table and the claim changes. Take the material away and it can only
 * say it was given nothing.
 *
 * What it reads:
 *   · the assignment, as the compiler wrote it — the identity to copy back,
 *     the material it may read, the claims it was shown, the verdicts on
 *     them, the contested subject;
 *   · the material, as the adapter attached it — text as text, an image by
 *     decoding the pixels this repository's fixture renderer wrote.
 *
 * What it never does: consult a truth object, a task id, a fixture map or
 * anything else outside the request. There is no parameter for one.
 *
 * A real deployment replaces this file with a provider. Everything else —
 * resolve, verify, attach, send, parse, validate, persist — is the same.
 */
import type { ClaimValue } from "../../core-v2/kernel/contracts.ts";
import { readTextFromImage } from "../../core-v2/domains/synthetic-records/material.ts";
import { decodePicture, describePicture } from "./picture.ts";
import type { Picture } from "./picture.ts";
import { parseMaterialHeading } from "../providers/provider.ts";

/* ─────────────────────────────────────────── what arrives with a request */

export type AgentPart =
  | { kind: "text"; text: string }
  | { kind: "image"; mimeType: string; bytes: Uint8Array };

export type AgentQuestion = {
  system: string;
  parts: AgentPart[];
};

/* One piece of material, paired with the heading that says what it is. */
type Attached = {
  sourceId: string;
  segmentId: string | null;
  mediaKind: string;
  mimeType: string;
  contentHash: string;
  byteLength: number;
  /* Text when the material IS text, or when it is one of this repository's
     own fixture images, whose pixels are an encoding of text. An ordinary
     picture — a page rendered from somebody's PDF, a frame out of their clip
     — has no text, and says so by leaving this empty rather than by throwing. */
  text: string;
  /* What is measurably in an ordinary picture. Null for text. */
  picture: Picture | null;
};

/* ──────────────────────────────────────────── reading the assignment back */

type Anchor = { anchorId: string; sourceKind: string; sourceId: string | null; segmentId: string | null; locator: Record<string, unknown>; quotedText: string | null };
type Claim = { ref: string; subjectType: string; subjectKey: string; predicate: string; value: ClaimValue; unit: string | null; status: string; anchors: Anchor[] };
type Assessment = { claimRef: string; assessment: string; reasonCode: string; anchorIds: string[]; proposedValue: ClaimValue | null; proposedUnit: string | null };
type Disagreement = { disagreementId: string; kind: string; severity: string; claimRefs: string[] };
type SourceBlock = { sourceId: string; segmentId: string | null; parentSegmentId: string | null; segmentKind: string | null; label: string | null; ordinal: number; locator: Record<string, unknown>; contentHash: string };

export type Assignment = {
  packetVersion: string;
  taskId: string;
  roleKey: string;
  roleVersion: string;
  /* What this assignment is ABOUT, as the assignment says it. A decision is
     titled by its subject, so reading it from anywhere else — the first
     claim, say — would title a decision after whatever happened to be shown
     first. */
  subjectKey: string;
  sources: SourceBlock[];
  claims: Claim[];
  assessments: Assessment[];
  disagreements: Disagreement[];
};

const after = (line: string, label: string): string => line.slice(line.indexOf(label) + label.length).trim();
const jsonOr = <T>(text: string, fallback: T): T => { try { return JSON.parse(text) as T; } catch { return fallback; } };

export function parseAssignment(text: string): Assignment {
  const lines = text.split("\n");
  const first = (pattern: RegExp): string => {
    for (const line of lines) { const m = line.match(pattern); if (m) return m[1]; }
    return "";
  };
  const assignment: Assignment = {
    packetVersion: first(/^packetVersion: (.+)$/),
    taskId: first(/^taskId: (.+)$/),
    roleKey: first(/^roleKey: (.+)$/),
    roleVersion: first(/^roleVersion: (.+)$/),
    subjectKey: first(/^subject: (.+)$/),
    sources: [], claims: [], assessments: [], disagreements: [],
  };

  let source: SourceBlock | null = null;
  let claim: Claim | null = null;
  let assessment: Assessment | null = null;
  const closeSource = () => { if (source) assignment.sources.push(source); source = null; };
  const closeClaim = () => { if (claim) assignment.claims.push(claim); claim = null; };
  const closeAssessment = () => { if (assessment) assignment.assessments.push(assessment); assessment = null; };

  for (const line of lines) {
    if (/^ {2}material \d+ — /.test(line)) {
      closeSource(); closeClaim(); closeAssessment();
      source = { sourceId: "", segmentId: null, parentSegmentId: null, segmentKind: null, label: null, ordinal: 0, locator: {}, contentHash: "" };
      continue;
    }
    if (/^ {2}claim /.test(line)) {
      closeSource(); closeClaim(); closeAssessment();
      claim = { ref: line.trim().slice("claim ".length), subjectType: "", subjectKey: "", predicate: "", value: { known: false, quantity: null, text: null }, unit: null, status: "", anchors: [] };
      continue;
    }
    if (/^ {2}assessment of claim /.test(line)) {
      closeSource(); closeClaim(); closeAssessment();
      const m = line.match(/^ {2}assessment of claim (\S+): (\S+) \((.+)\)$/);
      if (m) assessment = { claimRef: m[1], assessment: m[2], reasonCode: m[3], anchorIds: [], proposedValue: null, proposedUnit: null };
      continue;
    }
    if (/^ {2}contested subject /.test(line)) {
      closeSource(); closeClaim(); closeAssessment();
      const m = line.match(/^ {2}contested subject (\S+): (\S+), (\S+)$/);
      if (m) assignment.disagreements.push({ disagreementId: m[1], kind: m[2], severity: m[3], claimRefs: [] });
      continue;
    }
    if (/^ {4}over claims: /.test(line)) {
      const last = assignment.disagreements[assignment.disagreements.length - 1];
      if (last) last.claimRefs = after(line, "over claims:").split(",").map((x) => x.trim()).filter(Boolean);
      continue;
    }

    if (source) {
      if (line.startsWith("    sourceId: ")) source.sourceId = after(line, "sourceId:");
      else if (line.startsWith("    segmentId: ")) { const v = after(line, "segmentId:"); source.segmentId = v.startsWith("none") ? null : v; }
      else if (line.startsWith("    parentSegmentId: ")) source.parentSegmentId = after(line, "parentSegmentId:");
      else if (line.startsWith("    segmentKind: ")) source.segmentKind = after(line, "segmentKind:");
      else if (line.startsWith("    label: ")) { const v = after(line, "label:"); source.label = v === "none" ? null : v; }
      else if (line.startsWith("    ordinal: ")) source.ordinal = Number(after(line, "ordinal:"));
      else if (line.startsWith("    locator: ")) source.locator = jsonOr(after(line, "locator:"), {});
      else if (line.startsWith("    contentHash: ")) source.contentHash = after(line, "contentHash:");
      continue;
    }
    if (claim) {
      if (line.startsWith("    subject: ")) {
        const rest = after(line, "subject:").split(" ");
        claim.subjectType = rest[0] ?? "";
        claim.subjectKey = rest.slice(1).join(" ");
      } else if (line.startsWith("    predicate: ")) claim.predicate = after(line, "predicate:");
      else if (line.startsWith("    value: ")) claim.value = jsonOr(after(line, "value:"), claim.value);
      else if (line.startsWith("    unit: ")) { const v = after(line, "unit:"); claim.unit = v === "none given" ? null : v; }
      else if (line.startsWith("    status: ")) claim.status = after(line, "status:");
      else if (line.startsWith("    anchor ")) {
        const m = line.match(/^ {4}anchor (\S+): (\S+) sourceId=(\S+) segmentId=(\S+) locator=(\{.*?\})(?: quoted=(.*))?$/);
        if (m) {
          claim.anchors.push({
            anchorId: m[1], sourceKind: m[2],
            sourceId: m[3] === "none" ? null : m[3], segmentId: m[4] === "none" ? null : m[4],
            locator: jsonOr(m[5], {}), quotedText: m[6] === undefined ? null : jsonOr<string | null>(m[6], null),
          });
        }
      }
      continue;
    }
    if (assessment) {
      if (line.startsWith("    anchors: ")) assessment.anchorIds = after(line, "anchors:").split(",").map((x) => x.trim()).filter(Boolean);
      else if (line.startsWith("    read instead: ")) {
        const rest = after(line, "read instead:");
        const split = rest.indexOf("} unit ");
        if (split >= 0) {
          assessment.proposedValue = jsonOr<ClaimValue | null>(rest.slice(0, split + 1), null);
          assessment.proposedUnit = rest.slice(split + " unit ".length + 1).trim();
        } else {
          assessment.proposedValue = jsonOr<ClaimValue | null>(rest, null);
        }
      }
      continue;
    }
  }
  closeSource(); closeClaim(); closeAssessment();
  return assignment;
}

/* ───────────────────────────────────────────── reading what was attached */

export function attachedMaterial(parts: AgentPart[]): Attached[] {
  const out: Attached[] = [];
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (part.kind !== "text") continue;
    const heading = parseMaterialHeading(part.text);
    if (!heading) continue;
    const content = parts[i + 1];
    if (!content) continue;
    i++;
    let text = "";
    let picture: Picture | null = null;
    if (content.kind === "text") {
      text = content.text;
    } else {
      /* The fixture encoding first, because a fixture image IS its text. An
         ordinary PNG makes that reader throw, and then it is measured
         instead. Neither path guesses: the picture reader returns null for
         anything it cannot actually decode. */
      try { text = readTextFromImage(content.bytes); }
      catch { picture = decodePicture(content.bytes); }
    }
    out.push({ ...heading, text, picture });
  }
  return out;
}

/* ─────────────────────────────────────────────── what the material says */

type Row = { id: string; category: string; quantity: number; unit: string };

function tableRows(text: string): Row[] {
  const rows: Row[] = [];
  for (const line of text.split("\n")) {
    const m = line.match(/^(\S+)\s+(\S+)\s+(-?\d+(?:\.\d+)?)\s+(\S+)\s*$/);
    if (!m || m[1] === "entry") continue;
    rows.push({ id: m[1], category: m[2], quantity: Number(m[3]), unit: m[4] });
  }
  return rows;
}

function noteOf(text: string): { entryId: string; status: string } | null {
  const m = text.match(/^note: (\S+) is (\S+)\s*$/m);
  return m ? { entryId: m[1], status: m[2] } : null;
}

type SheetRegion = { kind: string; label: string; ordinal: number; bbox: number[]; contentHash: string };

function sheetRegions(text: string): SheetRegion[] {
  const out: SheetRegion[] = [];
  for (const line of text.split("\n")) {
    if (line.startsWith("#") || line.startsWith("kind")) continue;
    const columns = line.split(/\s{2,}/).map((x) => x.trim()).filter(Boolean);
    if (columns.length !== 5) continue;
    out.push({ kind: columns[0], label: columns[1], ordinal: Number(columns[2]), bbox: columns[3].split(",").map(Number), contentHash: columns[4] });
  }
  return out;
}

/* A box for row i of n inside the region's own box: a reading points at the
   line it was read from, not at the whole table. */
function rowBox(outer: number[], i: number, n: number): number[] {
  const [x0, y0, x1, y1] = outer as [number, number, number, number];
  const h = (y1 - y0) / Math.max(1, n);
  const top = y0 + i * h;
  const round = (v: number) => Math.round(v * 1e6) / 1e6;
  return [round(x0), round(top), round(x1), round(Math.min(y1, top + h))];
}

/* ────────────────────────────────────────────────────── the answer */

type Envelope = Record<string, unknown>;

function envelope(assignment: Assignment): Envelope {
  return {
    packetVersion: assignment.packetVersion,
    taskId: assignment.taskId,
    roleKey: assignment.roleKey,
    roleVersion: assignment.roleVersion,
    outcome: "completed",
    claims: [], anchors: [], segments: [], assessments: [], disagreements: [], requestedActions: [],
    limitations: [], rawResponseReference: null, adjudication: null, decisions: [], calculations: [],
  };
}

function nothingToRead(assignment: Assignment, why: string): Envelope {
  const env = envelope(assignment);
  env.outcome = "insufficient_evidence";
  env.limitations = [why];
  return env;
}

const same = (a: string | null | undefined, b: string | null | undefined) => (a ?? "").trim().toLowerCase() === (b ?? "").trim().toLowerCase();

export function answerFromRequest(question: AgentQuestion): Envelope {
  const prompt = question.parts.find((p) => p.kind === "text" && p.text.includes("taskId: "));
  if (!prompt || prompt.kind !== "text") throw new Error("core-v2-runtime: the request carries no assignment");
  const assignment = parseAssignment(prompt.text);
  const material = attachedMaterial(question.parts);
  const forSegment = (segmentId: string | null) => material.find((m) => m.segmentId === segmentId) ?? null;

  switch (assignment.roleKey) {
    case "region_discoverer": {
      const sheet = assignment.sources[0];
      const shown = sheet ? forSegment(sheet.segmentId) : null;
      if (!sheet || !shown) return nothingToRead(assignment, "no sheet was attached to this assignment");
      const env = envelope(assignment);
      env.segments = sheetRegions(shown.text).map((r) => ({
        segmentKey: `${r.kind}-${r.ordinal}`, sourceId: sheet.sourceId, parentSegmentId: sheet.segmentId,
        segmentKind: r.kind, label: r.label, ordinal: r.ordinal, locator: { bbox: r.bbox }, contentHash: r.contentHash,
      }));
      if ((env.segments as unknown[]).length === 0) env.limitations = ["the sheet lists no regions"];
      return env;
    }

    case "table_reader": {
      const ref = assignment.sources[0];
      const shown = ref ? forSegment(ref.segmentId) : null;
      if (!ref || !shown) return nothingToRead(assignment, "no table was attached to this assignment");
      const rows = tableRows(shown.text);
      if (rows.length === 0) return nothingToRead(assignment, "the material attached is not a table this reader can read");
      const box = (ref.locator.bbox as number[] | undefined) ?? [0, 0, 1, 1];
      const env = envelope(assignment);
      const anchors: unknown[] = [];
      const claims: unknown[] = [];
      rows.forEach((row, i) => {
        const key = `row-${i}`;
        anchors.push({
          anchorKey: key, sourceKind: "segment_locator", sourceId: ref.sourceId, segmentId: ref.segmentId,
          locator: { bbox: rowBox(box, i, rows.length) }, quotedText: `${row.id} ${row.category} ${row.quantity} ${row.unit}`,
        });
        claims.push({
          claimKey: key, subjectType: "entry", subjectKey: `entry/${row.id}`, predicate: "quantity",
          value: { known: true, quantity: row.quantity, text: `${row.quantity} ${row.unit}`, attributes: { category: row.category } },
          unit: row.unit, observationBasis: "observed", scope: { segment: ref.label ?? "" }, anchorKeys: [key], machineConfidence: 0.9,
        });
      });
      env.anchors = anchors;
      env.claims = claims;
      return env;
    }

    case "note_reader": {
      const ref = assignment.sources[0];
      const shown = ref ? forSegment(ref.segmentId) : null;
      if (!ref || !shown) return nothingToRead(assignment, "no note was attached to this assignment");
      const note = noteOf(shown.text);
      if (!note) return nothingToRead(assignment, "the material attached does not read as a note");
      const box = (ref.locator.bbox as number[] | undefined) ?? [0, 0, 1, 1];
      const env = envelope(assignment);
      env.anchors = [{
        anchorKey: "note", sourceKind: "segment_locator", sourceId: ref.sourceId, segmentId: ref.segmentId,
        locator: { bbox: rowBox(box, 0, 1) }, quotedText: `${note.entryId}: ${note.status}`,
      }];
      env.claims = [{
        claimKey: "note", subjectType: "entry", subjectKey: `entry/${note.entryId}`, predicate: "revision_status",
        value: { known: true, quantity: null, text: note.status }, unit: null, observationBasis: "observed",
        scope: { segment: ref.label ?? "" }, anchorKeys: ["note"], machineConfidence: 0.85,
      }];
      return env;
    }

    case "evidence_critic":
    case "disagreement_verifier": {
      const env = envelope(assignment);
      const anchors: unknown[] = [];
      const assessments: unknown[] = [];
      for (const claim of assignment.claims) {
        const at = claim.anchors[0];
        const key = `at-${claim.ref}`;
        if (!at) {
          assessments.push({ claimRef: claim.ref, assessment: "unreadable", reasonCode: "no_anchor", explanation: "the claim points nowhere; there is nothing to reopen", anchorKeys: [] });
          continue;
        }
        const shown = forSegment(at.segmentId);
        if (!shown) {
          assessments.push({ claimRef: claim.ref, assessment: "unreadable", reasonCode: "place_unreadable", explanation: "the place the claim names was not attached to this assignment", anchorKeys: [] });
          continue;
        }
        anchors.push({ anchorKey: key, sourceKind: at.sourceKind, sourceId: at.sourceId, segmentId: at.segmentId, locator: at.locator, quotedText: at.quotedText });
        const entryId = claim.subjectKey.replace(/^entry\//, "");

        /* A COMPARISON IS RE-DONE, NOT SPOT-CHECKED.
           When the claim names two places, checking it means opening both and
           answering the same question again — with the same code the reader
           used, so a difference is a difference in the material rather than in
           two people's arithmetic. Looking at one side would let a critic
           "support" a comparison it never made. */
        const places = new Set(claim.anchors.map((a) => a.segmentId).filter(Boolean));
        const claimSides = sidesOf(assignment, material);
        if (places.size >= 2 && claimSides.length >= 2) {
          const again = compareSides(claimSides[0], claimSides[1]);
          const said = String(claim.value.text ?? "").trim().toLowerCase();
          assessments.push({
            claimRef: claim.ref,
            ...(same(again.answer, said)
              ? { assessment: "supports", reasonCode: "matches_source", explanation: `reading both places again gives ${again.answer}: ${again.said[0]} / ${again.said[1]}`.slice(0, 300) }
              : { assessment: "contradicts", reasonCode: "value_differs", explanation: `reading both places again gives ${again.answer}, not ${said}`.slice(0, 300), proposedValue: { known: true, quantity: null, text: again.answer }, proposedUnit: null }),
            anchorKeys: [key],
          });
          continue;
        }

        const verdict = readVerdict(claim, entryId, shown.text, questionIn(prompt.text));
        assessments.push({ claimRef: claim.ref, ...verdict, anchorKeys: [key] });
      }
      env.anchors = anchors;
      env.assessments = assessments;
      if (assignment.claims.length === 0) env.limitations = ["nothing to assess"];
      return env;
    }

    case "evidence_arbiter": {
      const env = envelope(assignment);
      env.adjudication = adjudicate(assignment);
      return env;
    }

    case "decision_composer": {
      const env = envelope(assignment);
      env.decisions = [compose(assignment)];
      return env;
    }

    /* THE OWNER'S OWN PAGES AND MOMENTS.
     *
     * What this stand-in can honestly do with a real page or a real frame,
     * and what it cannot. It cannot understand a picture; no arrangement of if
     * statements can. What it CAN do is exactly two things, both of them
     * measurements of the material in front of it:
     *
     *   · when the file carried a text layer, look for the words of the
     *     question in it, and quote the line it found them on — verbatim,
     *     from the owner's own file;
     *   · when it did not — a scan, a video frame — decode the picture and
     *     say what is measurably in it, and answer `unclear`, because a
     *     measurement of colour is not an answer to a question about what
     *     the picture shows.
     *
     * That second branch is the important one. A stand-in that answered
     * anyway would make every offline run look like a product that works.
     */
    case "page_reader":
    case "moment_reader": {
      const asked = questionIn(prompt.text);
      const shown = assignment.sources.map((s) => forSegment(s.segmentId)).filter((m): m is Attached => m !== null);
      if (shown.length === 0) return nothingToRead(assignment, "no material was attached to this assignment");

      const written = shown.find((m) => m.text.trim().length > 0);
      const seen = shown.find((m) => m.picture !== null);
      /* THE ANCHOR NAMES WHERE THE ANSWER CAME FROM.
         Not the prettiest place to open, the place that was read. A reading
         taken from the page's text anchors to that text; a measurement of the
         picture anchors to the picture. Anchoring a text reading to the image
         beside it looks tidier and is a lie about provenance — and it breaks
         the check that follows, because a critic reopening "the place this
         claim names" would be handed a picture with no words in it. */
      const from = written ?? seen ?? null;
      const place = assignment.sources.find((s) => s.segmentId === from?.segmentId)
        ?? assignment.sources[0];

      const env = envelope(assignment);
      let answer: string;
      let quoted: string;
      if (written) {
        const found = lookFor(asked, written.text);
        answer = found.answer;
        quoted = found.quoted;
      } else if (seen && seen.picture) {
        answer = "unclear";
        quoted = describePicture(seen.picture);
        env.limitations = ["this reader was given a picture with no text layer and can measure it but not read it"];
      } else {
        return nothingToRead(assignment, "the material attached could not be read at all");
      }

      /* Where it read. A picture it measured whole is bounded by the whole
         picture, which is true and checkable; a line of text carries no
         geometry this stand-in can honestly turn into a box, so that anchor
         names the segment and stops there. */
      env.anchors = [{
        anchorKey: "seen",
        sourceKind: written ? "segment" : "segment_locator",
        sourceId: place.sourceId, segmentId: place.segmentId,
        locator: written ? {} : { bbox: [0, 0, 1, 1] },
        quotedText: quoted.slice(0, 400),
      }];
      env.claims = [{
        claimKey: "seen", subjectType: assignment.subjectKey.split("/")[0],
        subjectKey: assignment.subjectKey, predicate: "finding",
        value: { known: true, quantity: null, text: answer },
        unit: null, observationBasis: "observed", scope: {},
        anchorKeys: ["seen"], machineConfidence: answer === "unclear" ? 0.3 : 0.7,
      }];
      return env;
    }

    /* TWO PIECES OF MATERIAL, AND THE ONE COMPARISON A STAND-IN CAN HONESTLY
     * MAKE OF EACH KIND.
     *
     * TWO TEXTS. A statement is a line whose last word is a number. A key
     * stated ONCE on each side with a different number is a contradiction —
     * that is a real reading of both texts, it quotes both lines, and it says
     * nothing about anything it did not find. A key stated twice on a side is
     * a list rather than a statement and is left alone.
     *
     * A PICTURE AGAINST A TEXT. The stand-in cannot see what is in a picture.
     * It can measure colour, so when the text names a colour it can measure —
     * and only then — it measures that colour in the picture and answers. When
     * the text names none, the answer is "unclear" and the limitation says
     * why, because measuring something the assignment did not ask about would
     * be answering a different question.
     */
    case "page_pair_reader":
    case "moment_page_reader": {
      const sides = sidesOf(assignment, material);
      if (sides.length < 2) return nothingToRead(assignment, "this assignment is about two pieces of material and fewer than two were attached");
      const [left, right] = sides;
      const env = envelope(assignment);

      const anchorFor = (side: Side, key: string, quoted: string, from: "text" | "picture" | "nothing") => {
        const onPicture = from === "picture" && side.pictureSegmentId !== null;
        return {
          anchorKey: key,
          sourceKind: onPicture ? "segment_locator" : "segment",
          sourceId: side.sourceId,
          segmentId: onPicture ? side.pictureSegmentId : (side.textSegmentId ?? side.pictureSegmentId),
          locator: onPicture ? { bbox: [0, 0, 1, 1] } : {},
          quotedText: quoted.slice(0, 400),
        };
      };

      const compared = compareSides(left, right);
      const answer = compared.answer;
      if (compared.limitation) env.limitations = [compared.limitation];
      const anchors = [
        anchorFor(left, "left", compared.said[0], compared.read[0]),
        anchorFor(right, "right", compared.said[1], compared.read[1]),
      ];

      env.anchors = anchors;
      env.claims = [{
        claimKey: "compared",
        subjectType: assignment.subjectKey.startsWith("pages/") ? "pages" : "moment_page",
        subjectKey: assignment.subjectKey, predicate: "finding",
        value: { known: true, quantity: null, text: answer },
        unit: null, observationBasis: "observed", scope: {},
        anchorKeys: (anchors as { anchorKey: string }[]).map((a) => a.anchorKey),
        machineConfidence: answer === "unclear" ? 0.3 : 0.7,
      }];
      return env;
    }

    default:
      return nothingToRead(assignment, `this stand-in has no behaviour for ${assignment.roleKey}`);
  }
}


/* THE COMPARISON ITSELF, IN ONE PLACE.
 *
 * The reader answers it and the critic answers it again from the same
 * material. They must be the same piece of code: a critic that re-derives the
 * answer differently is not checking the reading, it is holding a second
 * opinion — and the difference between those two is the whole of what a check
 * is worth. */
/* `read` is what each side was read FROM, in the order the sides were passed.
   It is what an anchor has to name: a comparison made out of two texts is
   anchored to those texts, and one made out of a picture is anchored to the
   picture. Anchoring to whichever piece looks better on a screen would send
   the next reader — the critic — to material the finding was never made
   from. */
export type Comparison = {
  answer: string;
  limitation: string | null;
  said: [string, string];
  read: ["text" | "picture" | "nothing", "text" | "picture" | "nothing"];
};

export function compareSides(left: Side, right: Side): Comparison {
  if (left.text.trim() && right.text.trim()) {
    const found = contradiction(left.text, right.text);
    return found
      ? { answer: "no", limitation: null, said: [found.left, found.right], read: ["text", "text"] }
      : { answer: "yes", limitation: null, said: [firstLine(left.text), firstLine(right.text)], read: ["text", "text"] };
  }
  const leftIsWritten = left.text.trim().length > 0;
  const written = leftIsWritten ? left : right.text.trim() ? right : null;
  const seen = left.picture ? left : right.picture ? right : null;
  if (!written || !seen || !seen.picture || written === seen) {
    return {
      answer: "unclear", limitation: "neither piece of material could be read: one carries no text and the other no picture this reader can measure",
      said: [firstLine(left.text) || "(nothing readable)", firstLine(right.text) || "(nothing readable)"],
      read: [left.text.trim() ? "text" : left.picture ? "picture" : "nothing", right.text.trim() ? "text" : right.picture ? "picture" : "nothing"],
    };
  }
  const order = (a: string, b: string): [string, string] => (leftIsWritten ? [a, b] : [b, a]);
  const asked = colourNamed(written.text);
  if (!asked) {
    return {
      answer: "unclear",
      limitation: "this reader can measure colour in a picture and nothing else, and the other side names no colour to look for",
      said: order(firstLine(written.text), describePicture(seen.picture)),
      read: order("text", "picture") as Comparison["read"],
    };
  }
  const share = seen.picture[asked.colour];
  return {
    answer: share >= 0.004 ? "yes" : "no",
    limitation: null,
    said: order(asked.line, `${describePicture(seen.picture)} — ${(share * 100).toFixed(2)}% of it ${asked.colour}`),
    read: order("text", "picture") as Comparison["read"],
  };
}

/* ────────────────────────────── the two sides of a comparison assignment */

type Side = {
  sourceId: string | null;
  /* One place, and the two segments it can be pointed at: the words on it and
     the picture of it. Which one an anchor names is decided by which one the
     answer was read from. */
  textSegmentId: string | null;
  pictureSegmentId: string | null;
  ordinal: number;
  text: string;
  picture: Picture | null;
};

/* One side is one PLACE — a page and its own text are one side, not two. The
   sources block says which segment belongs to which source and ordinal, so the
   grouping is read from the assignment rather than assumed from the order the
   material happened to arrive in. */
export function sidesOf(assignment: Assignment, material: Attached[]): Side[] {
  const sides = new Map<string, Side>();
  for (const source of assignment.sources) {
    const shown = material.find((m) => m.segmentId === source.segmentId);
    if (!shown) continue;
    const key = `${source.sourceId}/${source.segmentKind === "page_text" ? source.ordinal : source.ordinal}`;
    const side = sides.get(key) ?? {
      sourceId: source.sourceId, textSegmentId: null, pictureSegmentId: null,
      ordinal: source.ordinal, text: "", picture: null,
    };
    if (shown.text.trim() && !side.text) { side.text = shown.text; side.textSegmentId = source.segmentId; }
    if (shown.picture && !side.picture) { side.picture = shown.picture; side.pictureSegmentId = source.segmentId; }
    sides.set(key, side);
  }
  return [...sides.values()];
}

export const firstLine = (text: string): string =>
  (text.split("\n").map((l) => l.trim()).find((l) => l.length > 2) ?? text.slice(0, 120));

/* A statement: a line whose last word is a number, keyed by the words before
   it. A key that appears more than once on a side is a list, not a statement,
   and is left out — two bedrooms numbered 1 and 2 do not contradict each
   other, and a reader that said they did would be inventing a finding. */
function statements(text: string): Map<string, { value: string; line: string }> {
  const seen = new Map<string, { value: string; line: string; times: number }>();
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const words = line.split(/\s+/);
    if (words.length < 2) continue;
    const value = words[words.length - 1];
    if (!/^[-+]?\d+(?:[.,]\d+)?$/.test(value)) continue;
    const key = words.slice(0, -1).join(" ").toUpperCase().replace(/[^A-Z0-9 ]+/g, "").trim();
    if (!key) continue;
    const already = seen.get(key);
    if (already) already.times += 1;
    else seen.set(key, { value, line, times: 1 });
  }
  const once = new Map<string, { value: string; line: string }>();
  for (const [key, found] of seen) if (found.times === 1) once.set(key, { value: found.value, line: found.line });
  return once;
}

export function contradiction(left: string, right: string): { left: string; right: string; key: string } | null {
  const a = statements(left);
  const b = statements(right);
  for (const [key, one] of a) {
    const other = b.get(key);
    if (other && other.value !== one.value) return { left: one.line, right: other.line, key };
  }
  return null;
}

/* The only four things this stand-in can look for in a picture, and it looks
   for one only when the other side of the comparison names it. */
const COLOURS = ["red", "orange", "green", "blue"] as const;

export function colourNamed(text: string): { colour: typeof COLOURS[number]; line: string } | null {
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    const low = line.toLowerCase();
    for (const colour of COLOURS) {
      if (new RegExp(`\\b${colour}\\b`).test(low)) return { colour, line };
    }
  }
  return null;
}

/* THE QUESTION, AS THE ASSIGNMENT PUT IT.
   The compiler writes the pack's objective under `objective:`, indented. The
   pack puts the owner's own words in it, so this is where they are. */
export function questionIn(prompt: string): string {
  const lines = prompt.split("\n");
  const at = lines.findIndex((line) => line.trim() === "objective:");
  if (at < 0) return "";
  const said: string[] = [];
  for (let i = at + 1; i < lines.length; i += 1) {
    if (!/^\s{2,}\S/.test(lines[i])) break;
    said.push(lines[i].trim());
  }
  /* A pack that marks the question gets the question. One that does not gets
     the whole objective, which is the best that can be done with it — and is
     why a pack whose readers are judged on the words of a question should
     mark it. */
  const marked = said.find((line) => /^QUESTION:/i.test(line));
  return marked ? marked.replace(/^QUESTION:\s*/i, "").trim() : said.join(" ");
}

/* Do the words of the question appear in this text, and on which line.
   Deliberately crude, and deliberately honest about being crude: it is a word
   search, it says so in its reason, and it never answers from anything but
   the text it was handed. */
const NOISE = new Set(["about", "answer", "anything", "been", "does", "each", "every", "from", "have",
  "look", "material", "question", "shown", "that", "their", "them", "there", "these", "this", "what",
  "when", "where", "which", "with", "your", "page", "frame", "moment", "video", "clip", "plan", "plans",
  "quote", "unclear", "yes", "does", "given", "only", "must", "were", "will", "into", "same", "one"]);

export function lookFor(question: string, text: string): { answer: string; quoted: string } {
  const words = [...new Set(String(question || "").toLowerCase().match(/[a-z][a-z0-9-]{3,}/g) ?? [])]
    .filter((word) => !NOISE.has(word));
  const lines = text.split(/\n|(?<=\.)\s+/).map((line) => line.trim()).filter((line) => line.length > 2);
  const haystack = text.toLowerCase();
  if (words.length === 0) {
    return { answer: text.trim() ? "unclear" : "unclear", quoted: lines[0] ?? text.slice(0, 200) };
  }
  const present = words.filter((word) => haystack.includes(word));
  let best = lines[0] ?? text.slice(0, 200);
  let bestScore = -1;
  for (const line of lines) {
    const low = line.toLowerCase();
    const score = words.reduce((total, word) => total + (low.includes(word) ? 1 : 0), 0);
    if (score > bestScore) { bestScore = score; best = line; }
  }
  const answer = present.length === words.length ? "yes"
    : present.length * 2 < words.length ? "no"
    : "unclear";
  return { answer, quoted: best };
}

/* What the reopened material says about one claim. */
function readVerdict(claim: Claim, entryId: string, text: string, question = ""): { assessment: string; reasonCode: string; explanation: string; proposedValue?: ClaimValue | null; proposedUnit?: string | null } {
  if (claim.predicate === "quantity") {
    const row = tableRows(text).find((r) => r.id === entryId);
    if (!row) return { assessment: "contradicts", reasonCode: "not_in_source", explanation: "the material holds nothing for this subject at this place", proposedValue: null, proposedUnit: null };
    const value: ClaimValue = { known: true, quantity: row.quantity, text: `${row.quantity} ${row.unit}`, attributes: { category: row.category } };
    if (claim.value.quantity === row.quantity && same(claim.unit, row.unit)) {
      return { assessment: "supports", reasonCode: "matches_source", explanation: "the material shows this value at this place" };
    }
    if (claim.value.quantity === row.quantity) {
      return { assessment: "wrong_unit", reasonCode: "unit_differs", explanation: `the material gives ${row.unit}`, proposedValue: value, proposedUnit: row.unit };
    }
    return { assessment: "contradicts", reasonCode: "value_differs", explanation: `the material shows ${row.quantity} ${row.unit}`, proposedValue: value, proposedUnit: row.unit };
  }
  if (claim.predicate === "finding") {
    /* The critic reopens the same place and asks the same question of it. It
       has no more ability than the reader did, which is why "unclear" is
       supported rather than contradicted: agreeing that a place cannot be
       read from is a real verdict, and calling it a contradiction would
       manufacture a disagreement out of a shared limitation. */
    const asked = question;
    if (!text.trim()) {
      return claim.value.text === "unclear"
        ? { assessment: "supports", reasonCode: "place_not_readable", explanation: "this place carries no text either, so unclear is what the material supports" }
        : { assessment: "insufficient", reasonCode: "not_readable_here", explanation: "this place carries no text, so an answer of yes or no cannot be checked here" };
    }
    const again = lookFor(asked, text);
    if (same(again.answer, String(claim.value.text ?? ""))) {
      return { assessment: "supports", reasonCode: "matches_source", explanation: `the material reads: ${again.quoted.slice(0, 120)}` };
    }
    return {
      assessment: "contradicts", reasonCode: "value_differs",
      explanation: `reading the same place again gives ${again.answer}: ${again.quoted.slice(0, 120)}`,
      proposedValue: { known: true, quantity: null, text: again.answer }, proposedUnit: null,
    };
  }
  if (claim.predicate === "revision_status") {
    const note = noteOf(text);
    if (!note || note.entryId !== entryId) return { assessment: "contradicts", reasonCode: "not_in_source", explanation: "the material holds nothing for this subject at this place", proposedValue: null, proposedUnit: null };
    if (same(claim.value.text, note.status)) return { assessment: "supports", reasonCode: "matches_source", explanation: "the material shows this value at this place" };
    return { assessment: "contradicts", reasonCode: "value_differs", explanation: `the material shows ${note.status}`, proposedValue: { known: true, quantity: null, text: note.status }, proposedUnit: null };
  }
  return { assessment: "insufficient", reasonCode: "not_readable_here", explanation: "this stand-in cannot judge that predicate from the material it was given" };
}

const NEGATIVE = new Set(["contradicts", "wrong_scope", "wrong_unit", "duplicate", "insufficient", "unreadable"]);
const REJECTING = new Set(["contradicts", "wrong_scope", "wrong_unit", "duplicate"]);

/* One outcome, from the verdicts and nothing else. It never counts readers,
   because it is never told how many there were. */
function adjudicate(assignment: Assignment): Record<string, unknown> {
  const dispute = assignment.disagreements[0];
  const refs = dispute?.claimRefs.length ? dispute.claimRefs : assignment.claims.map((c) => c.ref);
  const of = (ref: string) => assignment.assessments.filter((a) => a.claimRef === ref);
  const anchorsOf = (ref: string) => assignment.claims.find((c) => c.ref === ref)?.anchors.map((a) => a.anchorId) ?? [];
  const base = {
    disagreementId: dispute?.disagreementId ?? "", acceptedClaimRef: null as string | null,
    correctedValue: null as ClaimValue | null, correctedUnit: null as string | null,
    evidenceAnchorIds: [] as string[], followUp: null as unknown,
  };

  const supported = refs.filter((r) => of(r).some((a) => a.assessment === "supports") && !of(r).some((a) => NEGATIVE.has(a.assessment)));
  if (supported.length === 1) {
    const ref = supported[0];
    const supporting = of(ref).filter((a) => a.assessment === "supports").flatMap((a) => a.anchorIds);
    return { ...base, outcome: "accept_claim", acceptedClaimRef: ref, evidenceAnchorIds: [...new Set([...anchorsOf(ref), ...supporting])], rationale: "the reopened source supports one reading at its own anchor; the others were read against" };
  }
  if (supported.length > 1) {
    return { ...base, outcome: "needs_human", rationale: "the source was read as supporting more than one competing reading; a person decides" };
  }
  const proposals = assignment.assessments.filter((a) => refs.includes(a.claimRef) && a.proposedValue && a.proposedValue.known);
  const distinct = [...new Set(proposals.map((a) => JSON.stringify({ v: a.proposedValue, u: a.proposedUnit ?? null })))];
  if (proposals.length > 0 && distinct.length === 1) {
    const p = proposals[0];
    return { ...base, outcome: "correct", correctedValue: p.proposedValue, correctedUnit: p.proposedUnit ?? null, evidenceAnchorIds: [...new Set(proposals.flatMap((a) => a.anchorIds))], rationale: "the reopened source shows a value none of the readings reported; the correction is what was read there" };
  }
  const allRejected = refs.length > 0 && refs.every((r) => of(r).some((a) => REJECTING.has(a.assessment)));
  if (allRejected) {
    return { ...base, outcome: "reject_all", evidenceAnchorIds: [...new Set(refs.flatMap((r) => of(r).filter((a) => REJECTING.has(a.assessment)).flatMap((a) => a.anchorIds)))], rationale: "the reopened source was read against every reading and shows no value to correct to" };
  }
  return { ...base, outcome: "needs_human", rationale: "the verdicts settle nothing; a person decides" };
}

/* What is known, from the accepted claims it was shown and nothing else. */
function compose(assignment: Assignment): Record<string, unknown> {
  const accepted = assignment.claims.filter((c) => c.status === "accepted");
  const disputes = assignment.disagreements.length;
  const subject = assignment.subjectKey || assignment.claims[0]?.subjectKey || "this subject";
  if (accepted.length === 0) {
    return {
      decisionType: "hold", title: `${subject}: not yet evidenced`,
      summary: {
        known: "nothing about this subject is accepted evidence",
        conflicts: disputes ? `${disputes} disagreement(s) await a person` : "none recorded",
        canProceed: "nothing", mustWait: "everything about this subject", supportingEvidence: "none accepted",
      },
      supportingClaimIds: [], contradictingClaimIds: [], riskLevel: "high", actions: [{ actionType: "review", ownerRole: "reviewer" }],
    };
  }
  const lines = accepted.map((c) => `${c.subjectKey} ${c.predicate} = ${c.value.text ?? c.value.quantity}${c.unit ? ` ${c.unit}` : ""}`);
  return {
    decisionType: "proceed", title: `${subject}: evidenced`,
    summary: {
      known: lines.join("; "), conflicts: disputes ? `${disputes} disagreement(s) on record` : "none",
      canProceed: subject, mustWait: disputes ? "what the disagreements cover" : "nothing",
      supportingEvidence: `${accepted.length} accepted claim(s), each anchored in its source`,
    },
    supportingClaimIds: accepted.map((c) => c.ref), contradictingClaimIds: [], riskLevel: "normal", actions: [{ actionType: "proceed", ownerRole: "reviewer" }],
  };
}
