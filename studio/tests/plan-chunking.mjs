/* A 200-sheet set never depends on one context window.
 *
 * This imports the exact chunking module the plan-analyze edge function
 * runs in production — one file, shared verbatim between Deno and Node —
 * and proves it on a project the size the product promises to handle:
 * nine discipline documents, 220 sheets, 118 MB.
 *
 * What the test guards:
 *   - the partition: every document lands in exactly one chunk, order is
 *     preserved (a discipline's schedules stay beside its plans), and no
 *     chunk exceeds one reading's input limit;
 *   - the merge: exact-identity dedupe only (a document id, a phase code,
 *     a building|level|name key) — never similarity; framing concatenates
 *     because every printed dimension must survive; and the chunking is
 *     recorded out loud as a gap and an assumption, never papered over.
 */
import { CHUNK_BYTE_LIMIT, mergeChunkAnalyses, planChunks } from "../../supabase/functions/plan-analyze/chunking.js";

let bad = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "  ok  " : "  FAIL"} ${label}${detail ? `\n         ${detail}` : ""}`);
  if (!ok) bad++;
};

console.log("── the 220-sheet project partitions ──");
const MB = 1024 * 1024;
const bigSet = [
  { id: "doc-a", sheets: 30, byte_size: 18 * MB },  // architectural
  { id: "doc-s1", sheets: 28, byte_size: 22 * MB }, // structural, plans + schedules
  { id: "doc-s2", sheets: 26, byte_size: 16 * MB },
  { id: "doc-m", sheets: 24, byte_size: 14 * MB },  // mechanical
  { id: "doc-e", sheets: 22, byte_size: 12 * MB },  // electrical
  { id: "doc-p", sheets: 20, byte_size: 10 * MB },  // plumbing
  { id: "doc-c", sheets: 25, byte_size: 11 * MB },  // civil
  { id: "doc-l", sheets: 21, byte_size: 8 * MB },   // landscape
  { id: "doc-sp", sheets: 24, byte_size: 7 * MB },  // specifications
];
const totalSheets = bigSet.reduce((sum, doc) => sum + doc.sheets, 0);
check("the fixture is a genuinely large project: 200+ sheets over one reading's limit",
  totalSheets >= 200 && bigSet.reduce((sum, doc) => sum + doc.byte_size, 0) > CHUNK_BYTE_LIMIT,
  `${totalSheets} sheets`);

const chunks = planChunks(bigSet);
check("the set needs more than one chunk", chunks.length > 1, String(chunks.length));
check("no chunk exceeds one reading's input limit",
  chunks.every((chunk) => chunk.bytes <= CHUNK_BYTE_LIMIT),
  JSON.stringify(chunks.map((chunk) => Math.round(chunk.bytes / MB))));
const flattened = chunks.flatMap((chunk) => chunk.document_ids);
check("every document lands in exactly one chunk, in selection order",
  JSON.stringify(flattened) === JSON.stringify(bigSet.map((doc) => doc.id)),
  JSON.stringify(flattened));
check("chunks pack greedily: each break happens only because the next file would not fit",
  chunks.slice(0, -1).every((chunk, index) => {
    const nextFirstId = chunks[index + 1].document_ids[0];
    const nextSize = bigSet.find((doc) => doc.id === nextFirstId).byte_size;
    return chunk.bytes + nextSize > CHUNK_BYTE_LIMIT;
  }));

console.log("\n── a small set stays whole ──");
const single = planChunks([{ id: "doc-1", byte_size: 9 * MB }, { id: "doc-2", byte_size: 12 * MB }]);
check("a set that fits one reading is one chunk", single.length === 1 && single[0].document_ids.length === 2);

console.log("\n── the readings merge by exact identity ──");
const chunkOne = {
  project_summary: "Structural half of the deck project.",
  source_register: [{ document_id: "doc-s1", title: "S-set", document_type: "structural", revision: "A", issued_date: null, sheets: ["S-2.0"], notes: "" }],
  levels: [{ building: "Main House", name: "Deck level", source_refs: ["S-2.0"] }],
  spaces: [
    { building: "Main House", level: "Deck level", name: "Deck — west half", classification: "deck", source_refs: ["S-2.0"] },
    { building: "Main House", level: "Deck level", name: "Deck — east half", classification: "deck", source_refs: ["S-2.0"] },
  ],
  space_links: [],
  framing_walls: [],
  framing_decks: [{ label: "Deck", building: "Main House", level: "Deck level", length: "82'-0\"", width: "", area_sqft: "1640", joist_size: "2x6", joist_spacing: "16\"", joist_treatment: "", decking: "", sheathing: "", beams: [], columns: [], piles: { description: "18in pile", count_drawn: 14, count_proposed: 14, count_confidence: "high", count_note: "" }, guardrail: "", guardrail_length: "", source_refs: ["S-2.0"] }],
  systems: [{ name: "Structural framing", scope: "deck", source_refs: ["S-2.0"] }],
  phases: [
    { code: "FOUNDATION", name: "Foundation", sequence: 1, objective: "", starts_when: "", ends_when: "", concealment_risk: "", source_refs: [] },
    { code: "FRAMING", name: "Framing", sequence: 2, objective: "", starts_when: "", ends_when: "", concealment_risk: "", source_refs: [] },
  ],
  capture_requirements: [{ phase_code: "FOUNDATION", title: "Pile placement", building: null, level: null, space_name: null, system: "structural", priority: "critical", capture_type: "360", why: "", instructions: [], must_show: [], completion_criteria: [], before_concealment: "", plan_refs: [], source_document_ids: ["doc-s1"], evidence_tags: [] }],
  gaps: [{ severity: "important", question: "BM.1 schedule row illegible", source_refs: ["S-2.0"], blocks_activation: false }],
  assumptions: ["Sheet order follows the index"],
};
const chunkTwo = {
  project_summary: "Architectural half of the deck project.",
  source_register: [
    { document_id: "doc-s1", title: "S-set", document_type: "structural", revision: "A", issued_date: null, sheets: [], notes: "seen from A-set references" },
    { document_id: "doc-a", title: "A-set", document_type: "architectural", revision: "B", issued_date: null, sheets: ["A-210"], notes: "" },
  ],
  levels: [{ building: "Main House", name: "Deck level", source_refs: ["A-210"] }],
  spaces: [
    { building: "Main House", level: "Deck level", name: "Deck — West Half", classification: "deck", source_refs: ["A-210"] },
    { building: "Main House", level: "Deck level", name: "Stair landing", classification: "stair", source_refs: ["A-210"] },
  ],
  space_links: [{ from_building: "Main House", from_level: "Deck level", from_space_name: "Deck — west half", to_building: "Main House", to_level: "Deck level", to_space_name: "Stair landing", connection: "stairs", source_refs: ["A-210"] }],
  framing_walls: [{ label: "Guard wall", building: "Main House", level: "Deck level", length: "12'-6\"", height: "", stud_size: "2x4", stud_spacing_inches: 16, corners: 2, intersections: 0, openings: [], source_refs: ["A-210"] }],
  framing_decks: [],
  systems: [{ name: "structural framing", scope: "duplicate by case", source_refs: ["A-210"] }],
  phases: [
    { code: "FRAMING", name: "Framing (arch)", sequence: 7, objective: "", starts_when: "", ends_when: "", concealment_risk: "", source_refs: [] },
    { code: "FINISH", name: "Finish", sequence: 9, objective: "", starts_when: "", ends_when: "", concealment_risk: "", source_refs: [] },
  ],
  capture_requirements: [{ phase_code: "FINISH", title: "Decking surface", building: null, level: null, space_name: null, system: "architectural", priority: "normal", capture_type: "photo", why: "", instructions: [], must_show: [], completion_criteria: [], before_concealment: "", plan_refs: [], source_document_ids: ["doc-a"], evidence_tags: [] }],
  gaps: [{ severity: "informational", question: "Finish legend abbreviations", source_refs: ["A-210"], blocks_activation: false }],
  assumptions: ["Sheet order follows the index"],
};

const merged = mergeChunkAnalyses([chunkOne, chunkTwo]);
check("both summaries survive, in chunk order",
  merged.project_summary.startsWith("Structural half") && /Architectural half/.test(merged.project_summary));
check("the register dedupes by document id — first reading wins",
  merged.source_register.length === 2
  && merged.source_register.find((entry) => entry.document_id === "doc-s1").notes === "");
check("rooms dedupe by exact building|level|name (case-insensitive), never by similarity",
  merged.spaces.length === 3
  && merged.spaces.filter((space) => /west half/i.test(space.name)).length === 1
  && merged.spaces.some((space) => space.name === "Stair landing"));
check("levels and systems dedupe the same way",
  merged.levels.length === 1 && merged.systems.length === 1);
check("phases dedupe by code and re-sequence deterministically",
  JSON.stringify(merged.phases.map((phase) => [phase.code, phase.sequence]))
  === JSON.stringify([["FOUNDATION", 1], ["FRAMING", 2], ["FINISH", 3]]));
check("every printed framing dimension survives the merge — nothing dedupes a takeoff away",
  merged.framing_decks.length === 1 && merged.framing_walls.length === 1
  && merged.framing_decks[0].piles.count_drawn === 14);
check("capture requirements and links concatenate for downstream normalisation",
  merged.capture_requirements.length === 2 && merged.space_links.length === 1);
check("the chunking is admitted out loud: an informational, non-blocking gap",
  merged.gaps.length === 3
  && merged.gaps.some((gap) => /analyzed in 2 chunks/i.test(gap.question) && gap.severity === "informational" && gap.blocks_activation === false));
check("and recorded as an assumption, with the shared assumptions deduped",
  merged.assumptions.length === 2
  && merged.assumptions.some((entry) => /2 chunks/.test(entry)));

const untouched = mergeChunkAnalyses([chunkOne]);
check("one chunk merges to itself, untouched — no gap, no assumption, byte for byte",
  untouched === chunkOne);

let threw = false;
try { mergeChunkAnalyses([]); } catch { threw = true; }
check("no readings at all refuses instead of inventing a baseline", threw);

console.log(bad ? `\n${bad} FAILURES` : "\nALL OK");
process.exit(bad ? 1 : 0);
