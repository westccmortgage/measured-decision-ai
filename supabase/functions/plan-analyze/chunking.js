/* Measured Decision · plan-set chunking, shared verbatim between runtimes.
 *
 * A 200-sheet project must never depend on one LLM context window. This
 * module is the deterministic half of chunked analysis: how a document set
 * partitions into chunks that each fit the provider's input limit, and how
 * the per-chunk readings merge back into one baseline proposal.
 *
 * Plain ESM JavaScript on purpose: the Deno edge function imports it to run
 * production, and the Node test suite imports the same file to prove it on a
 * 200-sheet fixture. One file, one behavior, no drift.
 *
 * The merge is honest about what chunking costs. A schedule in one chunk
 * cannot resolve a mark drawn in another; the merge never papers over that —
 * it records the chunking itself as an assumption, keeps every chunk's gaps,
 * and dedupes only by exact identity (a document id, a phase code, a
 * building|level|name key), never by similarity. Silently connecting
 * almost-matching rooms is the believable wrong this product refuses.
 */

export const CHUNK_BYTE_LIMIT = 49 * 1024 * 1024;

/* How many page images one reading carries. The Studio renders every sheet
   into ~200 dpi tiles (an E-size sheet is six quadrants and an overview, a
   D-size sheet four and one); the request can hold this many of them. The
   number also lives in studio/pdf-split.js, so a part is cut to fit it —
   the site and the server must agree, and a test holds them to it. */
export const MAX_RENDER_IMAGES = 80;

/* Which tiles a reading actually carries, and which pages it therefore
   reads at PDF resolution only. `documents` arrive in reading order, each
   with its stored tiles ({ name, page }); the budget is spent page by page
   in that order, a page's overview before its quadrants, exactly as the
   request is composed. Nothing here decides what to read — it says, out
   loud, what the reading could see. On 4423 Noble the first part carried
   167 tiles into an 80-image budget: pages 1–11 arrived whole, page 12 in
   part, and the door, window, fixture and framing schedules on pages
   14–25 arrived at the provider's own rasterisation. The reader then wrote
   "the plan is cropped" — the plan was whole; our request was not. */
export function tileCoverage(documents, maxImages = MAX_RENDER_IMAGES) {
  const kept = [];
  const coverage = [];
  let omitted = 0;
  let used = 0;
  const overviewFirst = (name) => (/-full\.jpg$/.test(String(name)) ? 0 : 1);
  for (const doc of documents) {
    const pages = new Map();
    const sorted = [...list(doc.tiles)].sort((a, b) =>
      (a.page - b.page) || (overviewFirst(a.name) - overviewFirst(b.name)) || String(a.name).localeCompare(String(b.name)));
    for (const tile of sorted) {
      const entry = pages.get(tile.page) || { total: 0, kept: 0 };
      entry.total += 1;
      if (used < maxImages) { kept.push({ document_id: doc.id, name: tile.name }); entry.kept += 1; used += 1; }
      else omitted += 1;
      pages.set(tile.page, entry);
    }
    const whole = [], partial = [], none = [];
    for (const [page, entry] of [...pages.entries()].sort((a, b) => a[0] - b[0])) {
      if (entry.kept === entry.total) whole.push(page);
      else if (entry.kept > 0) partial.push(page);
      else none.push(page);
    }
    coverage.push({ id: doc.id, filename: doc.filename, pages_whole: whole, pages_partial: partial, pages_without: none });
  }
  return { kept, coverage, omitted };
}

/* "13–25" for a run, "3, 7" for scattered pages. */
export function pageRanges(pages) {
  const sorted = [...new Set(list(pages).map(Number).filter(Number.isFinite))].sort((a, b) => a - b);
  const runs = [];
  for (const page of sorted) {
    const last = runs[runs.length - 1];
    if (last && page === last[1] + 1) last[1] = page;
    else runs.push([page, page]);
  }
  return runs.map(([from, to]) => (from === to ? String(from) : `${from}–${to}`)).join(", ");
}

/* The sentence a reading gets about what it cannot see — and the gap the
   result keeps, so a person reads "our request", never "your drawing". */
export function tileCoverageLines(coverage) {
  return list(coverage)
    .filter((entry) => list(entry.pages_without).length || list(entry.pages_partial).length)
    .map((entry) => {
      const parts = [];
      if (list(entry.pages_partial).length) parts.push(`page${entry.pages_partial.length === 1 ? "" : "s"} ${pageRanges(entry.pages_partial)} in part`);
      if (list(entry.pages_without).length) parts.push(`page${entry.pages_without.length === 1 ? "" : "s"} ${pageRanges(entry.pages_without)} not at all`);
      return `${entry.filename}: ${parts.join("; ")}`;
    });
}
export function tileCoverageGaps(coverage) {
  return tileCoverageLines(coverage).map((line) => ({
    severity: "important",
    question: `Read without high-resolution tiles — ${line}. This is the limit of one reading's image budget (${MAX_RENDER_IMAGES} images), not a gap in the drawings: the sheets are whole. Counts and fine print on these pages came from the PDF at the provider's own resolution. Split the set into finer parts and read again to count them.`,
    source_refs: [],
    blocks_activation: false,
    origin: "reader",
  }));
}

/* Greedy, order-preserving partition. Documents arrive in the owner's
   selection order — usually discipline order — and staying in order keeps a
   discipline's schedules in the same chunk as its plans whenever they fit.
   A single document over the limit is the caller's error to refuse; this
   function assumes each fits alone. */
export function planChunks(documents, byteLimit = CHUNK_BYTE_LIMIT) {
  const chunks = [];
  let current = { document_ids: [], bytes: 0 };
  for (const doc of documents) {
    const size = Number(doc.byte_size || 0);
    if (current.document_ids.length && current.bytes + size > byteLimit) {
      chunks.push(current);
      current = { document_ids: [], bytes: 0 };
    }
    current.document_ids.push(doc.id);
    current.bytes += size;
  }
  if (current.document_ids.length) chunks.push(current);
  return chunks;
}

const text = (value) => (typeof value === "string" ? value : "");
const list = (value) => (Array.isArray(value) ? value : []);

function dedupeBy(items, keyOf) {
  const seen = new Set();
  const kept = [];
  for (const item of items) {
    const key = keyOf(item);
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(item);
  }
  return kept;
}

/* Names that are the same name. "2ND FLOOR" and "Second Floor" are one
   level written by two sheets; so are "ROOF" and "Roof". This is spelling,
   not similarity: case, spacing and the ordinal numerals, nothing else.
   "Level 2" and "Second Floor" stay two levels, because deciding they are one
   is a reading, and readings are what a person confirms. */
const ORDINALS = {
  "1st": "first", "2nd": "second", "3rd": "third", "4th": "fourth", "5th": "fifth",
  "6th": "sixth", "7th": "seventh", "8th": "eighth", "9th": "ninth", "10th": "tenth",
};
export function normaliseName(value) {
  return text(value).toLowerCase().replace(/[\s_]+/g, " ").trim()
    .split(" ").map((word) => ORDINALS[word] || word).join(" ");
}

/* A document says which file it is a part of either as `part_of` (the merge's
   own metadata) or as `source_metadata.derived_from` (the database row). */
const partOf = (doc) => {
  const part = doc?.part_of || doc?.source_metadata?.derived_from;
  return part && typeof part === "object" ? part : null;
};
const pageFrom = (doc) => Number(partOf(doc)?.page_from || 0);

/* The order a set is read in. Parts of one file belong together and in page
   order — the cover before the schedules, the schedules before the details —
   whatever order the person happened to select them in. Whole documents keep
   their selection order; a file's parts take the place of the first of them. */
export function orderForReading(documents) {
  const docs = list(documents);
  const emitted = new Set();
  const ordered = [];
  for (const doc of docs) {
    if (emitted.has(doc.id)) continue;
    const parent = partOf(doc)?.document_id;
    const group = parent
      ? docs.filter((other) => partOf(other)?.document_id === parent).sort((a, b) => pageFrom(a) - pageFrom(b))
      : [doc];
    for (const member of group) {
      if (emitted.has(member.id)) continue;
      emitted.add(member.id);
      ordered.push(member);
    }
  }
  return ordered;
}

const pagesOf = (doc) => {
  const part = partOf(doc);
  return part ? `original pages ${part.page_from}–${part.page_to}` : "";
};

/* What one chunk is told about the whole set: the same register every chunk
   sees, plus, per document, whether it is attached to this request or is
   being read in another chunk of this same reading. The distinction is the
   difference between "I cannot see this file" — which is true — and "this
   file is missing" — which is not, and which used to be raised as a
   blocking question by every chunk about every other chunk. */
export function chunkRegister(orderedDocuments, chunkDocumentIds, chunkIndex, chunkTotal) {
  const attached = new Set(list(chunkDocumentIds));
  return list(orderedDocuments).map((row) => ({
    id: row.id,
    filename: row.original_filename,
    document_type: row.document_type,
    revision: row.revision_label,
    issued_at: row.issued_at,
    part_of: partOf(row),
    attached_in_this_chunk: attached.has(row.id),
    read_in: attached.has(row.id)
      ? `this chunk (${chunkIndex + 1} of ${chunkTotal})`
      : `another chunk of this same reading — it is being read, not missing`,
  }));
}

export function chunkNote(chunkIndex, chunkTotal, attachedDocuments, elsewhereDocuments) {
  const name = (row) => {
    const pages = pagesOf({ part_of: row.source_metadata?.derived_from });
    return pages ? `${row.original_filename} (${pages})` : row.original_filename;
  };
  const elsewhere = list(elsewhereDocuments);
  return [
    `This is chunk ${chunkIndex + 1} of ${chunkTotal} of one reading of a plan set larger than one request. `,
    `Attached to this request: ${list(attachedDocuments).map(name).join(", ")}. `,
    elsewhere.length
      ? `Read in the other chunks of this same reading, not attached here: ${elsewhere.map(name).join(", ")}. `
        + "Those files are being read now, by the same reading you are part of. Do not ask for them, and never raise their absence as a gap or as a blocker — a question about pages you cannot see is answered by the chunk that has them. "
      : "",
    "A mark whose schedule lives in a file read elsewhere goes to gaps naming the mark and the sheet you saw it on, so the merge can reconcile it. ",
    "Never invent content from a file you cannot see.",
  ].join("");
}

/* Reads a gap's question for a request of a document or page range that was
   read by another chunk of this same reading. Deliberately narrow: the
   sibling's document id, the sibling part's filename, or the phrase
   "original pages a-b" lying inside the sibling part's page range. A civil
   sheet's own "pages 2-3" is not the set's original pages, and does not
   match. Only the question is read, never the source_refs — a question
   about wall runs that cites the other part as context is still a question
   about wall runs. */
function readElsewhere(gap, position, chunkMeta) {
  const question = text(gap?.question).toLowerCase();
  if (!question) return null;
  for (const [siblingPosition, sibling] of chunkMeta.entries()) {
    if (siblingPosition === position) continue;
    for (const doc of sibling.documents) {
      const part = partOf(doc);
      const id = text(doc.id).toLowerCase();
      const filename = text(doc.filename).toLowerCase();
      let hit = (id && question.includes(id)) || (filename && question.includes(filename));
      if (!hit && part) {
        /* "original pages 3-5" inside the part's range, or "pages 1-25"
           that is exactly the part's range — a civil sheet's own "pages
           2-3" is neither. */
        const within = [...question.matchAll(/original pages?\s*(\d+)\s*[-–—]\s*(\d+)/g)];
        const exact = [...question.matchAll(/\bpages?\s*(\d+)\s*[-–—]\s*(\d+)/g)];
        hit = within.some(([, a, b]) => Number(a) >= Number(part.page_from) && Number(b) <= Number(part.page_to))
          || exact.some(([, a, b]) => Number(a) === Number(part.page_from) && Number(b) === Number(part.page_to));
      }
      if (hit) return { sibling, doc, part };
    }
  }
  return null;
}

/* A part's summary, with the sentences that were true of the part and are
   false of the whole taken out: "pages 1-25 are unavailable", "chunk-limited
   … based on original pages 26-30". They are dropped only when the pages
   they speak of were read by another chunk of this same reading; a sentence
   about a file no chunk held stays. Everything else the part wrote stands. */
function cleanSummary(summary, position, chunkMeta) {
  const sentences = text(summary).trim().split(/(?<=[.!?])\s+/).filter(Boolean);
  const kept = sentences.filter((sentence) => {
    const lower = sentence.toLowerCase();
    if (/\bchunk(-limited|s?\b)/.test(lower)) return false;
    const speaksOfAbsence = /(unavailable|not attached|unattached|missing|not analy[sz]ed)/.test(lower);
    if (!speaksOfAbsence) return true;
    return !readElsewhere({ question: sentence }, position, chunkMeta);
  });
  return kept.join(" ").trim();
}

const CONFIDENCE_RANK = { high: 1, medium: 2, low: 3, none: 4 };
const betterConfidence = (a, b) => (CONFIDENCE_RANK[a] || 4) <= (CONFIDENCE_RANK[b] || 4) ? a : b;
const lowerText = (value) => text(value).trim().toLowerCase();
const scheduleIdentity = (entry) => `${lowerText(entry.category)}|${lowerText(entry.mark)}`;
const memberIdentity = (entry) => `${lowerText(entry.member_type)}|${lowerText(entry.mark)}`;
const sameSchedule = (a, b) =>
  lowerText(a.unit) === lowerText(b.unit)
  && normaliseName(a.description) === normaliseName(b.description)
  && Number(a.count_scheduled || 0) === Number(b.count_scheduled || 0)
  && Number(a.count_drawn || 0) === Number(b.count_drawn || 0)
  && Number(a.count_proposed || 0) === Number(b.count_proposed || 0);
const unionRefs = (a, b) => dedupeBy([...list(a), ...list(b)].map(text).filter(Boolean), (ref) => ref);
const describeCounts = (entry) =>
  `scheduled ${Number(entry.count_scheduled || 0)}, drawn ${Number(entry.count_drawn || 0)}, proposed ${Number(entry.count_proposed || 0)} ${text(entry.unit) || ""}`.trim();

/* The one building that two title blocks name differently.
 *
 * When every document in the reading is a part of one file, and each chunk
 * names exactly one building, and those names differ, the parts are not
 * describing two buildings: one PDF was split, and its cover and its
 * structural title blocks disagree about the name. The name from the part
 * holding the lowest page — the cover — stands, the other names are
 * recorded as a question, and the levels and rooms of every part meet under
 * one building instead of two. A reading that names two buildings itself is
 * left exactly as it is: that may be two buildings. */
function unifyBuilding(readings, chunkMeta) {
  const allDocs = chunkMeta.flatMap((meta) => meta.documents);
  if (!allDocs.length || chunkMeta.some((meta) => !meta.documents.length)) return { readings, gaps: [] };
  const parents = new Set(allDocs.map((doc) => partOf(doc)?.document_id || ""));
  if (parents.size !== 1 || parents.has("")) return { readings, gaps: [] };
  const buildingsOf = (reading) => dedupeBy(
    ["levels", "spaces", "capture_requirements"].flatMap((key) => list(reading[key]).map((entry) => text(entry.building).trim())).filter(Boolean),
    (name) => name.toLowerCase(),
  );
  const named = readings.map(buildingsOf);
  if (named.some((names) => names.length !== 1)) return { readings, gaps: [] };
  const distinct = dedupeBy(named.map((names) => names[0]), (name) => name.toLowerCase());
  if (distinct.length < 2) return { readings, gaps: [] };
  const firstPage = (meta) => Math.min(...meta.documents.map(pageFrom));
  const coverIndex = chunkMeta.map((meta, index) => ({ index, page: firstPage(meta) })).sort((a, b) => a.page - b.page)[0].index;
  const canonical = named[coverIndex][0];
  const gaps = [];
  const rewritten = readings.map((reading, index) => {
    const other = named[index][0];
    if (other.toLowerCase() === canonical.toLowerCase()) return reading;
    const rename = (value) => (text(value).trim().toLowerCase() === other.toLowerCase() ? canonical : value);
    const refs = list(reading.levels).flatMap((level) => list(level.source_refs)).slice(0, 3);
    gaps.push({
      severity: "important",
      question: `The parts of one file name the building differently: "${canonical}" (${pagesOf(chunkMeta[coverIndex].documents[0])}) and "${other}" (${pagesOf(chunkMeta[index].documents[0])}). The record uses "${canonical}" for every part; confirm the project name.`,
      source_refs: refs,
      blocks_activation: false,
    });
    return {
      ...reading,
      levels: list(reading.levels).map((entry) => ({ ...entry, building: rename(entry.building) })),
      spaces: list(reading.spaces).map((entry) => ({ ...entry, building: rename(entry.building) })),
      capture_requirements: list(reading.capture_requirements).map((entry) => ({ ...entry, building: rename(entry.building) })),
      space_links: list(reading.space_links).map((entry) => ({ ...entry, from_building: rename(entry.from_building), to_building: rename(entry.to_building) })),
      framing_walls: list(reading.framing_walls).map((entry) => ({ ...entry, building: rename(entry.building) })),
      framing_decks: list(reading.framing_decks).map((entry) => ({ ...entry, building: rename(entry.building) })),
    };
  });
  return { readings: rewritten, gaps };
}

/* Whether a finished reading can be put back together from its saved parts.
   The parts are the paid, saved readings of each chunk; putting them
   together again is the same deterministic merge the reading ended with,
   and costs nothing. It is possible only when there are parts — a set read
   in one request has none — and every part completed with a reading. */
export function rebuildableFrom(job, chunks) {
  const parts = list(chunks);
  if (!job || job.state !== "completed") return { ok: false, reason: "Only a completed reading can be rebuilt from its saved parts." };
  if (!parts.length) return { ok: false, reason: "This reading was made in one request; there are no saved parts to rebuild from." };
  const unfinished = parts.filter((chunk) => chunk.state !== "complete" || !chunk.analysis || typeof chunk.analysis !== "object");
  if (unfinished.length) {
    return { ok: false, reason: `${unfinished.length} of ${parts.length} parts ${unfinished.length === 1 ? "has" : "have"} no saved reading; nothing can be rebuilt from a part that was not read.` };
  }
  return { ok: true, parts: parts.length };
}

/* One baseline from many chunk readings.
 *
 * `chunks`, when given, is one entry per reading in the same order:
 *   { chunk_index, documents: [{ id, filename, part_of }] }
 * — which documents each chunk actually attached. It is what lets the merge
 * tell a file that was read elsewhere from a file that is missing, let the
 * chunk that held a document describe it in the register, and put a split
 * file's parts under one building. Without it the merge is the older,
 * blinder one: first occurrence wins every exact-identity collision.
 *
 * What never merges away: a printed dimension, a schedule row, a gap. A
 * schedule row read twice with the same values is one row with both
 * sources; read twice with different values it is two rows and a question,
 * because choosing between them is a reading and readings are confirmed by
 * people. */
export function mergeChunkAnalyses(analyses, chunks = []) {
  const raw = list(analyses).filter((entry) => entry && typeof entry === "object");
  if (raw.length === 1) return raw[0];
  if (!raw.length) throw new Error("No chunk produced a reading to merge");

  const chunkMeta = raw.map((_, index) => {
    const meta = list(chunks)[index] || {};
    return {
      index,
      chunk_index: Number.isFinite(Number(meta.chunk_index)) ? Number(meta.chunk_index) : index,
      documents: list(meta.documents).map((doc) => ({ id: text(doc.id), filename: text(doc.filename), part_of: partOf(doc) })),
    };
  });
  const total = raw.length;
  let attachedIn = () => -1;

  /* Readings meet in page order, not in the order their chunks happened to
     run: the part holding the cover speaks first, so where first occurrence
     wins it is the cover's name for a level that stands. A chunk without
     page-numbered parts keeps its place. */
  const firstPage = (meta) => (meta.documents.length ? Math.min(...meta.documents.map(pageFrom)) : 0);
  const order = chunkMeta.map((meta) => meta.index).sort((a, b) => firstPage(chunkMeta[a]) - firstPage(chunkMeta[b]) || a - b);
  const orderedRaw = order.map((index) => raw[index]);
  const orderedMeta = order.map((index) => chunkMeta[index]);

  attachedIn = (documentId) => orderedMeta.findIndex((meta) => meta.documents.some((doc) => doc.id === documentId));

  const unified = unifyBuilding(orderedRaw, orderedMeta);
  const readings = unified.readings;

  const lower = lowerText;
  const spaceKey = (space) => `${lower(space.building)}|${normaliseName(space.level)}|${lower(space.name)}`;

  const summaries = dedupeBy(
    readings.map((reading, index) => cleanSummary(reading.project_summary, index, orderedMeta)).filter(Boolean),
    (summary) => summary,
  );

  const phases = dedupeBy(
    readings.flatMap((reading) => list(reading.phases)),
    (phase) => lower(phase.code),
  ).sort((a, b) => Number(a.sequence || 0) - Number(b.sequence || 0))
    .map((phase, index) => ({ ...phase, sequence: index + 1 }));

  /* The register: the chunk that attached a document describes it. A chunk
     that only saw the document's name in the register wrote a stub —
     "not attached, no sheets" — and that stub must not outrank the reading
     that held the file. */
  const registerEntries = readings.flatMap((reading, index) => list(reading.source_register).map((entry) => ({ entry, index })));
  const registerOrder = dedupeBy(registerEntries.map(({ entry }) => text(entry.document_id)), (id) => id);
  const source_register = registerOrder.map((documentId) => {
    const candidates = registerEntries.filter(({ entry }) => text(entry.document_id) === documentId);
    const holder = attachedIn(documentId);
    const attached = candidates.find(({ index }) => index === holder);
    return (attached || candidates[0]).entry;
  });

  /* Schedule rows and structural members: the same row from two chunks is
     one row with both sources; a row with the same mark and different
     values is kept beside it, with a question. Nothing read is thrown
     away. */
  const scheduleGaps = [];
  const mergeRows = (key, identityOf, describe) => {
    const kept = [];
    const conflictsSeen = new Set();
    readings.forEach((reading, index) => {
      for (const entry of list(reading[key])) {
        const identity = identityOf(entry);
        const chunkNumber = orderedMeta[index].chunk_index + 1;
        const twin = kept.find((row) => identityOf(row) === identity && sameSchedule(row, entry));
        if (twin) {
          twin.source_refs = unionRefs(twin.source_refs, entry.source_refs);
          twin.count_confidence = betterConfidence(twin.count_confidence, entry.count_confidence);
          if (!twin.read_in_chunks.includes(chunkNumber)) twin.read_in_chunks.push(chunkNumber);
          continue;
        }
        const rival = kept.find((row) => identityOf(row) === identity);
        if (rival && !conflictsSeen.has(identity)) {
          conflictsSeen.add(identity);
          scheduleGaps.push({
            severity: "important",
            question: `${describe(entry)} was read with different values by different chunks of this reading: chunk ${rival.read_in_chunks[0]} says ${describeCounts(rival)}, "${text(rival.description)}"; chunk ${chunkNumber} says ${describeCounts(entry)}, "${text(entry.description)}". Both rows are kept; confirm which governs.`,
            source_refs: unionRefs(rival.source_refs, entry.source_refs),
            blocks_activation: false,
          });
        }
        kept.push({ ...entry, source_refs: unionRefs(entry.source_refs, []), read_in_chunks: [chunkNumber] });
      }
    });
    return kept;
  };
  const component_schedules = mergeRows("component_schedules", scheduleIdentity, (entry) => `"${text(entry.mark)}" (${text(entry.category)})`);
  const structural_members = mergeRows("structural_members", memberIdentity, (entry) => `"${text(entry.mark)}" (${text(entry.member_type)})`);
  /* A printed rule read by two chunks is one rule; the exception clause is
     part of the rule. */
  const framing_defaults = dedupeBy(
    readings.flatMap((reading) => list(reading.framing_defaults)),
    (rule) => `${normaliseName(rule.rule)}|${normaliseName(rule.exception)}`,
  );

  /* Gaps: every chunk's questions survive. The one rewrite is the question
     that asks for a file this same reading holds in another chunk — it
     stops blocking and says where the file was read. */
  const gaps = readings.flatMap((reading, index) => list(reading.gaps).map((gap) => {
    const elsewhere = readElsewhere(gap, index, orderedMeta);
    if (!elsewhere) return gap;
    const where = elsewhere.part
      ? `part ${elsewhere.part.part} of ${elsewhere.part.parts} (${pagesOf(elsewhere.doc)})`
      : elsewhere.doc.filename || elsewhere.doc.id;
    return {
      ...gap,
      severity: "informational",
      blocks_activation: false,
      read_in_chunk: elsewhere.sibling.chunk_index + 1,
      question: `Read in chunk ${elsewhere.sibling.chunk_index + 1} of ${total} of this same reading — ${where}. This question stood only because that file was attached to another chunk: ${text(gap.question)}`,
    };
  }));

  return {
    project_summary: summaries.join("\n"),
    source_register,
    levels: dedupeBy(
      readings.flatMap((reading) => list(reading.levels)),
      (level) => `${lower(level.building)}|${normaliseName(level.name)}`,
    ),
    spaces: dedupeBy(readings.flatMap((reading) => list(reading.spaces)), spaceKey),
    /* Links and framing concatenate: downstream finalization already dedupes
       links by their normalised space pair and drops the unresolvable. */
    space_links: readings.flatMap((reading) => list(reading.space_links)),
    framing_walls: readings.flatMap((reading) => list(reading.framing_walls)),
    framing_decks: readings.flatMap((reading) => list(reading.framing_decks)),
    component_schedules,
    structural_members,
    framing_defaults,
    systems: dedupeBy(
      readings.flatMap((reading) => list(reading.systems)),
      (system) => normaliseName(system.name),
    ),
    phases,
    capture_requirements: readings.flatMap((reading) => list(reading.capture_requirements)),
    gaps: [
      ...gaps,
      ...unified.gaps,
      ...scheduleGaps,
      {
        severity: "informational",
        question: `This set was analyzed in ${readings.length} chunks because it exceeds one AI reading. A schedule in one chunk cannot resolve a mark drawn in another — review cross-discipline references before activation.`,
        source_refs: [],
        blocks_activation: false,
      },
    ],
    assumptions: [
      ...dedupeBy(
        readings.flatMap((reading) => list(reading.assumptions)).map((entry) => text(entry)).filter(Boolean),
        (entry) => entry,
      ),
      `Analyzed in ${readings.length} chunks; per-chunk readings merged deterministically by exact identity, never by similarity.`,
    ],
  };
}
