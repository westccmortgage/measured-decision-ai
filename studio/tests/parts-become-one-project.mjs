/* The parts of one file become one project.
 *
 * A plan set split into parts is read in chunks, and the chunks used to meet
 * badly: each chunk was shown a register naming both parts while holding
 * one, so each asked for the other as a blocking question; the first
 * chunk's "not attached" stub outranked the reading that held the file;
 * "2ND FLOOR" and "Second Floor" were two levels; the cover's building and
 * the structural title block's building were two buildings; and the
 * component schedules — every door, window and fixture row the reader had
 * copied — were not carried by the merge at all. Sixty-five paid-for rows
 * vanished between two chunks and one baseline.
 *
 * This imports the shipping chunking module and proves each of those on a
 * synthetic two-part set, with no provider anywhere. The prompt a chunk is
 * given is also read here, as text, because a promise about what the model
 * is told is only a promise until the text is looked at.
 */
import {
  chunkNote,
  chunkRegister,
  mergeChunkAnalyses,
  normaliseName,
  orderForReading,
} from "../../supabase/functions/plan-analyze/chunking.js";

let bad = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "  ok  " : "  FAIL"} ${label}${detail ? `\n         ${detail}` : ""}`);
  if (!ok) bad++;
};

/* One 30-page file, split at upload into two parts, plus a separate civil set. */
const PARENT = "parent-1";
const part = (id, from, to, n) => ({
  id, original_filename: `Set (pages ${from}-${to}).pdf`, document_type: "architectural", revision_label: "A", issued_at: null,
  byte_size: 10, source_metadata: { derived_from: { document_id: PARENT, page_from: from, page_to: to, pages_total: 30, part: n, parts: 2 } },
});
const partOne = part("part-1", 1, 25, 1);
const partTwo = part("part-2", 26, 30, 2);
const civil = { id: "civil", original_filename: "Civil.pdf", document_type: "civil", revision_label: "B", issued_at: null, byte_size: 10, source_metadata: {} };
const meta = (row) => ({ id: row.id, filename: row.original_filename, part_of: row.source_metadata?.derived_from || null });

console.log("── the order a set is read in ──");
{
  const ordered = orderForReading([civil, partTwo, partOne]);
  check("a file's parts are read together and in page order, whatever the selection order",
    ordered.map((d) => d.id).join(",") === "civil,part-1,part-2", ordered.map((d) => d.id).join(","));
  const whole = orderForReading([partOne, civil]);
  check("whole documents keep their place", whole.map((d) => d.id).join(",") === "part-1,civil");
}

console.log("\n── what a chunk is told, read as text ──");
{
  const register = chunkRegister([partOne, partTwo], ["part-2"], 1, 2);
  check("every document is in every chunk's register", register.length === 2);
  check("the attached part says so, the other says it is being read — not missing",
    register.find((r) => r.id === "part-2").attached_in_this_chunk === true
    && register.find((r) => r.id === "part-1").attached_in_this_chunk === false
    && /being read, not missing/.test(register.find((r) => r.id === "part-1").read_in));
  check("a part's page range rides along", register[0].part_of?.page_from === 1 && register[0].part_of?.page_to === 25);
  const note = chunkNote(1, 2, [partTwo], [partOne]);
  check("the chunk note names what is attached and what is read elsewhere, with pages",
    /Attached to this request: Set \(pages 26-30\)\.pdf \(original pages 26–30\)/.test(note)
    && /not attached here: Set \(pages 1-25\)\.pdf \(original pages 1–25\)/.test(note), note);
  check("and tells the model never to raise those pages as a gap or a blocker",
    /Do not ask for them/.test(note) && /never raise their absence as a gap or as a blocker/.test(note));
  check("while still forbidding invention from a file it cannot see", /Never invent content from a file you cannot see/.test(note));
  const alone = chunkNote(0, 1, [partOne], []);
  check("a chunk with nothing elsewhere is not told about other chunks", !/not attached here/.test(alone));
}

console.log("\n── names that are the same name ──");
{
  check("case, spacing and ordinals are spelling", normaliseName("2ND  FLOOR") === "second floor" && normaliseName("Roof") === "roof");
  check("anything else is a different name", normaliseName("Level 2") !== normaliseName("Second Floor"));
}

/* The two chunk readings, in the order they happened to run: the
   structural part first, the cover second — as the Noble job ran. */
const door = (mark, extra = {}) => ({
  mark, category: "door", description: "Type A; 3'-0\" x 6'-8\"", unit: "each",
  count_scheduled: 1, count_drawn: 1, count_proposed: 1, count_confidence: "high", count_note: "", source_refs: ["A-710 (original p20)"], ...extra,
});
const structural = {
  project_summary: "Structural part.",
  source_register: [
    { document_id: "part-2", title: "pages 26-30", document_type: "structural", revision: "A", issued_date: null, sheets: ["S-4", "S-5"], notes: "attached" },
    { document_id: "part-1", title: "pages 1-25", document_type: "architectural", revision: "A", issued_date: null, sheets: [], notes: "Not attached to this reading" },
  ],
  levels: [{ building: "NOBLE APARTMENTS", name: "2ND FLOOR", source_refs: ["S-4"] }, { building: "NOBLE APARTMENTS", name: "ROOF", source_refs: ["S-4"] }],
  spaces: [{ building: "NOBLE APARTMENTS", level: "ROOF", name: "CALI. ROOF", classification: "roof", source_refs: ["S-4"] }],
  space_links: [],
  framing_walls: [], framing_decks: [],
  component_schedules: [
    door("101", { source_refs: ["S-3 (original p25) header schedule"] }),
    door("102", { description: "Type B; 2'-8\" x 6'-8\"", source_refs: ["S-3 (original p25)"] }),
  ],
  systems: [{ name: "Wood Framing", scope: "", source_refs: ["S-4"] }],
  phases: [{ code: "FRAME", name: "Framing gate", sequence: 1, objective: "", starts_when: "", ends_when: "", concealment_risk: "", source_refs: [] }],
  capture_requirements: [{ phase_code: "FRAME", title: "Roof framing", building: "NOBLE APARTMENTS", level: "ROOF", space_name: null, system: "Wood Framing", priority: "high", capture_type: "360", why: "", instructions: [], must_show: [], completion_criteria: [], before_concealment: "", plan_refs: [], source_document_ids: ["part-2"], evidence_tags: [] }],
  gaps: [
    { severity: "critical", question: "Provide and reconcile original pages 1-25. The database lists them under document part-1, but that file is not attached to this reading.", source_refs: ["Database metadata"], blocks_activation: true },
    { severity: "critical", question: "Framing-wall records cannot be completed from this chunk: wall-run identities require the architectural plans.", source_refs: ["S-4", "Unattached original pages 1-25"], blocks_activation: true },
    { severity: "important", question: "Provide the civil LID plan pages 2-3 referenced for the storm-drain tank.", source_refs: ["S-4 note 9"], blocks_activation: true },
    { severity: "important", question: "Provide document soils-report which the notes reference.", source_refs: ["S-4"], blocks_activation: true },
  ],
  assumptions: ["Only pages 26-30 were attached."],
};
const cover = {
  project_summary: "Architectural part.",
  source_register: [
    { document_id: "part-1", title: "pages 1-25", document_type: "architectural", revision: "A", issued_date: null, sheets: ["A-0II", "A-210", "A-710"], notes: "attached" },
    { document_id: "part-2", title: "pages 26-30", document_type: "architectural", revision: "A", issued_date: null, sheets: [], notes: "Not attached" },
  ],
  levels: [
    { building: "NOBLE RESIDENCE", name: "First Floor", source_refs: ["A-210"] },
    { building: "NOBLE RESIDENCE", name: "Second Floor", source_refs: ["A-210"] },
    { building: "NOBLE RESIDENCE", name: "Roof", source_refs: ["A-220"] },
  ],
  spaces: [
    { building: "NOBLE RESIDENCE", level: "First Floor", name: "GARAGE 1", classification: "garage", source_refs: ["A-210"] },
    { building: "NOBLE RESIDENCE", level: "Second Floor", name: "MASTER BEDROOM 13", classification: "bedroom", source_refs: ["A-210"] },
  ],
  space_links: [{ from_building: "NOBLE RESIDENCE", from_level: "First Floor", from_space_name: "GARAGE 1", to_building: "NOBLE RESIDENCE", to_level: "First Floor", to_space_name: "ENTRY 2", connection: "door", source_refs: ["A-210"] }],
  framing_walls: [], framing_decks: [],
  component_schedules: [
    door("101"),
    door("102", { description: "Type B; 2'-8\" x 6'-8\"", count_scheduled: 2, count_drawn: 2, count_proposed: 2 }),
    { mark: "01", category: "window", description: "Type A; 5'-6\" x 4'-1\"", unit: "each", count_scheduled: 1, count_drawn: 1, count_proposed: 1, count_confidence: "high", count_note: "", source_refs: ["A-710 (original p20)"] },
    { mark: "F1", category: "electrical_fixture", description: "6\" recessed downlight", unit: "each", count_scheduled: 36, count_drawn: 0, count_proposed: 36, count_confidence: "high", count_note: "printed QTY", source_refs: ["A-310 (original p16)"] },
  ],
  systems: [{ name: "wood framing", scope: "same name, other case", source_refs: ["A-210"] }],
  phases: [{ code: "FINISH", name: "Finish", sequence: 5, objective: "", starts_when: "", ends_when: "", concealment_risk: "", source_refs: [] }],
  capture_requirements: [{ phase_code: "FINISH", title: "Doors", building: "NOBLE RESIDENCE", level: "First Floor", space_name: "GARAGE 1", system: "Doors", priority: "normal", capture_type: "photo", why: "", instructions: [], must_show: [], completion_criteria: [], before_concealment: "", plan_refs: [], source_document_ids: ["part-1"], evidence_tags: [] }],
  gaps: [
    { severity: "critical", question: "Original pages 26-30 are listed in the database but were not attached to this chunk. Provide and reconcile that part.", source_refs: ["Database source register"], blocks_activation: true },
    { severity: "important", question: "Resolve the fire-sprinkler conflict between A-002 and A-210.", source_refs: ["A-002", "A-210"], blocks_activation: true },
  ],
  assumptions: ["Only pages 1-25 were attached."],
};
const chunkMeta = [
  { chunk_index: 0, documents: [meta(partTwo)] },
  { chunk_index: 1, documents: [meta(partOne)] },
];
const before = mergeChunkAnalyses([structural, cover]);
const merged = mergeChunkAnalyses([structural, cover], chunkMeta);
const scheduleCount = (reading) => reading.component_schedules.length;

console.log("\n── every schedule row read survives the merge ──");
{
  check("even without chunk knowledge every row survives — the loss was the merge's, not the chunks'", before.component_schedules.length === 5);
  const rowsIn = scheduleCount(structural) + scheduleCount(cover);
  const rowsOut = merged.component_schedules.length;
  const dup = merged.component_schedules.filter((row) => row.read_in_chunks.length > 1);
  check("six rows in, five out: the one identical row read by both chunks is one row with both sources",
    rowsIn === 6 && rowsOut === 5 && dup.length === 1 && dup[0].mark === "101"
    && dup[0].source_refs.includes("A-710 (original p20)") && dup[0].source_refs.includes("S-3 (original p25) header schedule")
    && JSON.stringify(dup[0].read_in_chunks) === "[2,1]",
    `${rowsIn} in, ${rowsOut} out, duplicates ${dup.map((d) => d.mark).join(",")}`);
  const both102 = merged.component_schedules.filter((row) => row.mark === "102");
  check("the same mark read with different counts is two rows, not one — nothing is erased",
    both102.length === 2 && both102.map((r) => r.count_scheduled).sort().join(",") === "1,2");
  const conflict = merged.gaps.find((gap) => /"102" \(door\) was read with different values/.test(gap.question));
  check("and a question says which chunk said what, without blocking",
    !!conflict && conflict.blocks_activation === false && /chunk 2 says scheduled 2/.test(conflict.question) && /chunk 1 says scheduled 1/.test(conflict.question),
    conflict?.question);
  check("rows only one chunk read are kept whole, with their sources",
    merged.component_schedules.some((row) => row.mark === "F1" && row.count_scheduled === 36 && row.source_refs[0] === "A-310 (original p16)")
    && merged.component_schedules.some((row) => row.mark === "01" && row.category === "window"));
  check("every row says which chunks read it", merged.component_schedules.every((row) => Array.isArray(row.read_in_chunks) && row.read_in_chunks.length));
}

console.log("\n── a file read elsewhere is not a file that is missing ──");
{
  const rewritten = merged.gaps.filter((gap) => gap.read_in_chunk);
  check("the two questions that asked for the other part stop blocking and say where it was read",
    rewritten.length === 2
    && rewritten.every((gap) => gap.severity === "informational" && gap.blocks_activation === false)
    && rewritten.some((gap) => /^Read in chunk 2 of 2 of this same reading — part 1 of 2 \(original pages 1–25\)/.test(gap.question))
    && rewritten.some((gap) => /^Read in chunk 1 of 2 of this same reading — part 2 of 2 \(original pages 26–30\)/.test(gap.question)),
    rewritten.map((g) => g.question.slice(0, 80)).join(" | "));
  check("the original wording is kept after the note", rewritten.every((gap) => /This question stood only because that file was attached to another chunk: (Provide and reconcile|Original pages)/.test(gap.question)));
  const framing = merged.gaps.find((gap) => /Framing-wall records/.test(gap.question));
  check("a question that only cites the other part as context is untouched — it is still a question about wall runs",
    framing.blocks_activation === true && framing.severity === "critical");
  const civilGap = merged.gaps.find((gap) => /civil LID plan pages 2-3/.test(gap.question));
  check("a civil sheet's own \"pages 2-3\" are not the set's original pages: still blocking", civilGap.blocks_activation === true);
  const soils = merged.gaps.find((gap) => /soils-report/.test(gap.question));
  check("a document no chunk read is still asked for", soils.blocks_activation === true);
  check("the sprinkler conflict, a real finding, is untouched", merged.gaps.find((gap) => /fire-sprinkler/.test(gap.question)).blocks_activation === true);
  const blockingBefore = before.gaps.filter((gap) => gap.blocks_activation).length;
  const blockingAfter = merged.gaps.filter((gap) => gap.blocks_activation).length;
  check("exactly the two part-requests stopped blocking", blockingBefore === 6 && blockingAfter === 4, `${blockingBefore} → ${blockingAfter}`);
  const noMeta = mergeChunkAnalyses([structural, cover]);
  check("without chunk knowledge nothing is downgraded — the register alone is not proof the pages were read",
    noMeta.gaps.filter((gap) => gap.read_in_chunk).length === 0 && noMeta.gaps.filter((gap) => gap.blocks_activation).length === 6);
}

console.log("\n── the chunk that held a document describes it ──");
{
  const one = merged.source_register.find((entry) => entry.document_id === "part-1");
  const two = merged.source_register.find((entry) => entry.document_id === "part-2");
  check("part 1's entry is the cover chunk's reading, with its sheets, not the stub", one.sheets.length === 3 && one.notes === "attached");
  check("part 2's entry is the structural chunk's reading", two.sheets.length === 2 && two.notes === "attached");
  check("the older merge let the first chunk's stub win", before.source_register.find((entry) => entry.document_id === "part-1").sheets.length === 0);
}

console.log("\n── one building, three levels ──");
{
  check("the cover's name for the building stands for every part",
    merged.levels.every((level) => level.building === "NOBLE RESIDENCE")
    && merged.spaces.every((space) => space.building === "NOBLE RESIDENCE")
    && merged.capture_requirements.every((req) => req.building === "NOBLE RESIDENCE"));
  check("and the other name is a question, not a second building",
    merged.gaps.some((gap) => /name the building differently: "NOBLE RESIDENCE" \(original pages 1–25\) and "NOBLE APARTMENTS" \(original pages 26–30\)/.test(gap.question) && !gap.blocks_activation));
  check("2ND FLOOR and Second Floor are one level; ROOF and Roof are one level: three levels, the cover's spellings",
    merged.levels.map((level) => level.name).join("|") === "First Floor|Second Floor|Roof", merged.levels.map((l) => l.name).join("|"));
  check("the older merge had five", before.levels.length === 5);
  check("systems merge by the same spelling rule", merged.systems.length === 1 && merged.systems[0].name === "wood framing");
  check("the cover's summary comes first, in page order, whatever order the chunks ran",
    merged.project_summary.startsWith("Architectural part."));
  check("rooms of both parts meet under one building", merged.spaces.length === 3);
  const twoBuildings = mergeChunkAnalyses([
    { ...structural, levels: [...structural.levels, { building: "GARAGE BUILDING", name: "Level 1", source_refs: [] }] },
    cover,
  ], chunkMeta);
  check("a reading that itself names two buildings is left alone — that may be two buildings",
    twoBuildings.levels.some((level) => level.building === "NOBLE APARTMENTS") && !twoBuildings.gaps.some((gap) => /name the building differently/.test(gap.question)));
  const notOneFile = mergeChunkAnalyses([structural, cover], [
    { chunk_index: 0, documents: [meta(civil)] },
    { chunk_index: 1, documents: [meta(partOne)] },
  ]);
  check("and so are chunks that are not parts of one file", notOneFile.levels.some((level) => level.building === "NOBLE APARTMENTS"));
}

console.log("\n── a part's summary loses only what was true of the part alone ──");
{
  const withSummaries = mergeChunkAnalyses([
    { ...structural, project_summary: "Chunk-limited structural roadmap based on original pages 26-30. The sheets show a roof framing plan. Activation is blocked because pages 1-25 are unavailable, and the sheets are marked NOT FOR CONSTRUCTION. The soils report is missing from the set." },
    { ...cover, project_summary: "NOBLE RESIDENCE is a two-story dwelling. Activation is blocked pending reconciliation of missing original pages 26-30 and the sprinkler notes." },
  ], chunkMeta);
  const summary = withSummaries.project_summary;
  check("a sentence about the chunk itself is dropped", !/Chunk-limited/.test(summary));
  check("a sentence that calls the other part unavailable is dropped — those pages were read", !/pages 1-25 are unavailable/.test(summary) && !/missing original pages 26-30/.test(summary));
  check("a sentence about a file no chunk held stays", /soils report is missing/.test(summary));
  check("and what the part actually read stays, cover first", /^NOBLE RESIDENCE is a two-story dwelling\./.test(summary) && /roof framing plan/.test(summary), summary);
}

console.log("\n── what did not change ──");
{
  check("the chunking is still admitted as a gap and an assumption",
    merged.gaps.some((gap) => /analyzed in 2 chunks/i.test(gap.question)) && merged.assumptions.some((entry) => /2 chunks/.test(entry)));
  check("phases still merge by code and re-sequence", merged.phases.map((p) => `${p.code}:${p.sequence}`).join(",") === "FINISH:1,FRAME:2" || merged.phases.length === 2);
  check("capture requirements and links concatenate", merged.capture_requirements.length === 2 && merged.space_links.length === 1);
  check("the inputs were not mutated", structural.levels[0].building === "NOBLE APARTMENTS" && cover.component_schedules.length === 4);
}

console.log(bad ? `\n${bad} FAILURES` : "\nALL OK");
process.exit(bad ? 1 : 0);
