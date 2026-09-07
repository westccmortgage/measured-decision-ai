/* COMPARING THREE READINGS OF ONE PLAN SET.
 *
 * Substituted answers, so every case can be checked without buying anything.
 * Each one is a way a comparison can lie, and the point of the test is that
 * it does not:
 *
 *   two readers make the same mistake and the third is right — agreement
 *   must not read as correctness;
 *   all three miss a position — only a control markup can find that, and it
 *   must actually find it;
 *   a count of framing zones is presented as a count of boards — the scope
 *   flag exists for exactly this;
 *   the readings were made from different plan documents — the result must
 *   say so and refuse to be called a fair comparison;
 *   the checked findings do not separate the readers — "no clear winner" is
 *   a real answer and must be given;
 *   the checker names a count without naming the marks — the application
 *   refuses the finding rather than accepting it;
 *   a reading failed — the comparison is incomplete and nothing reruns.
 */
import fs from "node:fs";
const {
  compareReadings, positionsOf, conditionsVerdict, againstTruth, unitKey,
  sanitiseVerdict, tallyFindings,
} = await import("../../supabase/functions/_shared/reading-comparison.ts");

let bad = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "  ok  " : "  FAIL"} ${label}${detail ? `\n         ${detail}` : ""}`);
  if (!ok) bad++;
};

const member = (over) => ({
  mark: "FB1", member_type: "beam", description: "flush beam", size: "(2) 2x10", spacing: "",
  material: "DF #2", level: "Roof", location: "north bay",
  count_scheduled: 4, count_drawn: 4, count_proposed: 4, count_confidence: "high", count_note: "",
  counted: "members", plies: 2, size_basis: "schedule_row",
  length_printed: "", unit: "ea", detail_refs: [], source_refs: ["S-3"], ...over,
});
const reading = (members, extra = {}) => ({
  structural_members: members, component_schedules: [], framing_defaults: [], gaps: [], assumptions: [], ...extra,
});

console.log("── two readers wrong the same way, the third right ──");
{
  const report = compareReadings([
    { id: "a", blind: "A", analysis: reading([member({ count_proposed: 12, count_drawn: 12 })]) },
    { id: "b", blind: "B", analysis: reading([member({ count_proposed: 12, count_drawn: 12 })]) },
    { id: "c", blind: "C", analysis: reading([member({ count_proposed: 4 })]) },
  ]);
  const row = report.rows[0];
  check("the three line up as one position, not three",
    report.rows.length === 1 && row.present.join("") === "ABC", `${report.rows.length} rows`);
  check("the disagreement is named as a count difference", row.differences.includes("count"));
  check("and nothing anywhere calls the agreeing pair correct",
    !JSON.stringify(report).includes("correct") && /Agreement between readers is not evidence/.test(report.caveat));
  check("the summary counts one position with a count difference",
    report.summary.positions === 1 && report.summary.count_differences === 1 && report.summary.all_three === 1);
}

console.log("\n── a count of framing zones presented as a count of boards ──");
{
  const report = compareReadings([
    { id: "a", blind: "A", analysis: reading([member({ mark: "R.R.1", member_type: "rafter", counted: "zones", count_proposed: 12, plies: 1 })]) },
    { id: "b", blind: "B", analysis: reading([member({ mark: "R.R.1", member_type: "rafter", counted: "members", count_proposed: 12, plies: 1 })]) },
    { id: "c", blind: "C", analysis: reading([member({ mark: "R.R.1", member_type: "rafter", counted: "zones", count_proposed: 12, plies: 1 })]) },
  ]);
  const row = report.rows[0];
  check("twelve zones and twelve members are not agreement — the scope difference is named",
    row.differences.includes("counted") && row.flags.includes("zone_read_as_member"),
    `${row.differences.join(",")} / ${row.flags.join(",")}`);
  check("and it is not hidden by the counts being equal", !row.differences.includes("count"));
}

console.log("\n── the boards inside an assembly counted as members ──");
{
  const report = compareReadings([
    { id: "a", blind: "A", analysis: reading([member({ count_drawn: 4, count_proposed: 8, plies: 2, counted: "members", count_note: "" })]) },
    { id: "b", blind: "B", analysis: reading([member({ count_drawn: 4, count_proposed: 4, plies: 2, counted: "assemblies" })]) },
  ]);
  check("an assembly of two plies counted as eight members is flagged",
    report.rows[0].flags.includes("boards_counted_as_members"), report.rows[0].flags.join(","));
}

console.log("\n── one mark, two different schedules ──");
{
  const report = compareReadings([
    { id: "a", blind: "A", analysis: reading([member({ location: "roof", source_refs: ["S-3"] })]) },
    { id: "b", blind: "B", analysis: reading([member({ location: "foundation", member_type: "footing", source_refs: ["S-2"] })]) },
  ]);
  check("the same mark in two schedules stays two positions and is never merged",
    report.rows.length === 2 && report.rows.every((row) => row.present.length === 1),
    `${report.rows.length} positions`);
}

console.log("\n── units ──");
{
  check("ea, each and pcs are one unit; lf is not", unitKey("EA") === "ea" && unitKey("each") === "ea" && unitKey("pcs") === "ea" && unitKey("LF") === "lf");
  const report = compareReadings([
    { id: "a", blind: "A", analysis: reading([member({ unit: "ea", count_proposed: 4 })]) },
    { id: "b", blind: "B", analysis: reading([member({ unit: "lf", count_proposed: 96 })]) },
  ]);
  check("a count in pieces against a count in feet is two quantities, not a disagreement about one",
    report.rows[0].flags.includes("count_in_different_units"), report.rows[0].flags.join(","));
}

console.log("\n── a position all three missed ──");
{
  const report = compareReadings([
    { id: "a", blind: "A", analysis: reading([member()]) },
    { id: "b", blind: "B", analysis: reading([member()]) },
    { id: "c", blind: "C", analysis: reading([member()]) },
  ]);
  const truth = againstTruth(report, [
    { section: "structural_members", category: "beam", mark: "FB1", sheet: "S-3", page: 25, count: 4, counted: "members" },
    { section: "structural_members", category: "footing", mark: "F2", sheet: "S-2", page: 24, count: 3, counted: "members" },
    { section: "structural_members", category: "beam", mark: "HIP BM2", sheet: "S-3", page: 25, count: 6, counted: "members", disputed: true, note: "four marks found, an advisor read six" },
  ], ["A", "B", "C"]);
  check("the markup finds the position no reader reported",
    truth.coverage.missed_by_all === 1 && truth.entries.find((entry) => entry.mark === "F2").missed_by_all,
    JSON.stringify(truth.coverage));
  check("a disputed entry every reader missed is reported apart, never counted against them",
    truth.coverage.missed_by_all_disputed === 1);
  check("a disputed entry is carried, shown, and never scored",
    truth.coverage.entries_disputed === 1 && truth.coverage.entries_scored === 2
    && truth.entries.find((entry) => entry.mark === "HIP BM2").disputed);
  check("and what each reader did with each entry is recorded, not summarised away",
    truth.per_reading.A.matches === 1 && truth.per_reading.A.not_read === 1, JSON.stringify(truth.per_reading.A));
}

console.log("\n── readings made under different conditions ──");
{
  const base = { provider: "openai", model: "m", version: 1, source_document_ids: ["doc-1", "doc-2"], agent_contract_version: "2026-09-07.1", image_budget: 20, image_fingerprint: "a1b2c3", images_sent: 15, state: "review" };
  check("the same documents, budget and task version compare as equals",
    conditionsVerdict([
      { ...base, id: "a" },
      { ...base, id: "b", provider: "anthropic" },
      { ...base, id: "c", provider: "google" },
    ]).comparable);
  const differentPlans = conditionsVerdict([
    { ...base, id: "a" },
    { ...base, id: "b", provider: "anthropic", source_document_ids: ["doc-1"] },
  ]);
  check("different plan documents are named and the comparison is not called equal",
    !differentPlans.comparable && differentPlans.differences.includes("different plan documents"),
    differentPlans.differences.join("; "));
  const differentTask = conditionsVerdict([
    { ...base, id: "a" },
    { ...base, id: "b", provider: "anthropic", agent_contract_version: "2026-08-01.1" },
  ]);
  check("so is a different task version", differentTask.differences.includes("different task versions"));
  const differentBudget = conditionsVerdict([
    { ...base, id: "a" },
    { ...base, id: "b", provider: "anthropic", image_budget: 80 },
  ]);
  check("and so is a different enlargement budget — the readers were not allowed the same drawings",
    differentBudget.differences.includes("different enlargement budgets"));
  /* The budget says what a reading was allowed to carry. The fingerprint says
     what it carried. Equal budgets and different fingerprints is the case a
     budget alone would hide. */
  const differentKit = conditionsVerdict([
    { ...base, id: "a" },
    { ...base, id: "b", provider: "anthropic", image_fingerprint: "d4e5f6" },
  ]);
  check("equal budgets but different pages or enlargements is still not an equal comparison",
    !differentKit.comparable && differentKit.differences.includes("the readers were given different pages or enlargements"),
    differentKit.differences.join("; "));
  check("and the fingerprints are carried into the detail so a person can check them",
    differentKit.detail.map((row) => row.image_fingerprint).join(",") === "a1b2c3,d4e5f6");
  const noKitRecorded = conditionsVerdict([
    { ...base, id: "a" },
    { ...base, id: "b", provider: "anthropic", image_fingerprint: null },
  ]);
  check("a reading that never recorded what it carried is not assumed to match",
    !noKitRecorded.comparable
    && noKitRecorded.differences.some((line) => /did not record which pages and enlargements/.test(line)),
    noKitRecorded.differences.join("; "));
  check("three readings of one kit, at one budget, under one task, do compare as equals",
    conditionsVerdict([
      { ...base, id: "a" },
      { ...base, id: "b", provider: "anthropic" },
      { ...base, id: "c", provider: "google" },
    ]).comparable);
  check("two readings by the same reader are two runs, not two readers",
    conditionsVerdict([{ ...base, id: "a" }, { ...base, id: "b" }]).differences.some((line) => /same reader/.test(line)));
}

console.log("\n── nothing is scored by how much was written ──");
{
  const short = reading([member()]);
  const long = reading(Array.from({ length: 40 }, (_, index) => member({ mark: `X${index}`, source_refs: [] })));
  const report = compareReadings([
    { id: "a", blind: "A", analysis: short },
    { id: "b", blind: "B", analysis: long },
  ]);
  check("a long answer produces more single-reader positions and no advantage anywhere",
    report.summary.single_reader === 41 && !("score" in report.summary) && !("winner" in report),
    JSON.stringify(report.summary));
}

console.log("\n── the shapes the screen and the checker are given ──");
{
  const positions = positionsOf(reading([member()], {
    component_schedules: [{ mark: "D1", category: "door", description: "3068", unit: "ea", count_scheduled: 6, count_drawn: 6, count_proposed: 6, count_confidence: "high", count_note: "", source_refs: ["A-6"] }],
    framing_defaults: [{ rule: "ALL STUDS 2x4 #2 @ 16\" O.C. U.N.O.", kind: "studs", applies_to: "interior walls", exception: "U.N.O.", source_refs: ["S-1"] }],
  }));
  check("a reading is laid out as members, scheduled components and printed rules",
    positions.length === 3 && new Set(positions.map((item) => item.section)).size === 3,
    positions.map((item) => item.section).join(","));
  check("a printed rule read out of the notes is a position like any other",
    positions.find((item) => item.section === "framing_defaults").description.includes("ALL STUDS"));
  check("every position carries what it counts, its unit and its sources — the checker needs all three",
    positions.every((item) => "counted" in item && "unit" in item && Array.isArray(item.sources)));
}

console.log("\n── a finding without evidence is not a finding ──");
{
  const answered = {
    recommended_reader: "A",
    findings: [
      { reader: "A", section: "structural_members", mark: "FB1", kind: "quantity", verdict: "wrong",
        claim: "B counted 12", why: "there are four", evidence: { sheet: "S-3", page: 25, tile: "p25-r1c1.jpg", what_is_drawn: "four flush beams", marks: [] } },
      { reader: "B", section: "structural_members", mark: "R.R.1", kind: "quantity", verdict: "wrong",
        claim: "A counted zones", why: "twelve zones, not twelve rafters",
        evidence: { sheet: "S-3", page: 25, tile: "p25-r2c1.jpg", what_is_drawn: "twelve zone callouts",
          marks: [{ label: "R.R.1", where: "north bay" }, { label: "R.R.1", where: "south bay" }] } },
      { reader: "C", section: "structural_members", mark: "HDR3", kind: "size_or_material", verdict: "verified",
        claim: "(2) 2x10", why: "header schedule row", evidence: { sheet: "", page: null, tile: "", what_is_drawn: "", marks: [] } },
    ],
  };
  const { verdict, downgraded } = sanitiseVerdict(answered);
  check("a count judged without naming the marks counted is not accepted as checked",
    verdict.findings[0].verdict === "could_not_verify" && /does not establish a count/.test(verdict.findings[0].why),
    verdict.findings[0].verdict);
  check("a count judged with the marks identified stands",
    verdict.findings[1].verdict === "wrong");
  check("and a finding that names no place on a sheet at all is not accepted either",
    verdict.findings[2].verdict === "could_not_verify" && downgraded.length === 2, JSON.stringify(downgraded));
}

console.log("\n── a disputed reference decides nothing ──");
{
  const findings = {
    findings: [
      { reader: "A", mark: "FB 1", verdict: "verified" },
      { reader: "A", mark: "HIP BM 2", verdict: "verified" },
      { reader: "A", mark: "HIP BM 2", verdict: "verified" },
      { reader: "B", mark: "FB 1", verdict: "verified" },
    ],
  };
  const counted = tallyFindings(findings, ["A", "B", "C"]);
  check("without a markup, every finding counts and A leads on the disputed marks",
    counted.leader === "A" && counted.per_reader.A.verified === 3, JSON.stringify(counted.per_reader));
  const settled = tallyFindings(findings, ["A", "B", "C"], ["HIP BM 2"]);
  check("with the markup, findings about a disputed mark are set aside and the lead disappears",
    settled.leader === null && settled.per_reader.A.verified === 1 && settled.set_aside_as_disputed.length === 2,
    JSON.stringify(settled));
  check("and what was set aside is named rather than silently dropped",
    settled.set_aside_as_disputed.every((line) => /HIP BM 2/.test(line)), settled.set_aside_as_disputed.join(", "));
  check("the mark is matched however it is punctuated, so HIPBM2 does not slip past",
    tallyFindings({ findings: [{ reader: "A", mark: "HIP-BM-2", verdict: "verified" }] }, ["A"], ["HIP BM 2"]).per_reader.A.verified === 0);
  check("a disputed count is left out of the reason on the screen too",
    /leaving out 2 findings about marks whose reference count is disputed/.test(
      tallyFindings({ findings: [
        { reader: "A", mark: "FB 1", verdict: "verified" }, { reader: "A", mark: "FB 2", verdict: "verified" },
        { reader: "A", mark: "HIP BM 2", verdict: "verified" }, { reader: "B", mark: "HIP BM 2", verdict: "wrong" },
      ] }, ["A", "B"], ["HIP BM 2"]).reason));
}

console.log("\n── the Noble markup counts labels, not members ──");
{
  const markup = JSON.parse(fs.readFileSync("experiments/noble-takeoff/control-markup.json", "utf8"));
  const labels = markup.entries.reduce((sum, entry) => sum + entry.count, 0);
  check("it says in the file itself that a count is a count of printed labels",
    /count of PRINTED LABELS/.test(markup.what_the_count_is) && /not a count of building members/.test(markup.what_the_count_is));
  check("every entry says what it counted, and none of them claims members",
    markup.entries.every((entry) => entry.counted === "labels" || entry.counted === "zones")
    && !markup.entries.some((entry) => entry.counted === "members"),
    [...new Set(markup.entries.map((entry) => entry.counted))].join(","));
  check("the 138 marks are 138 labels across three sheets, and are never presented as 138 members",
    labels === 138 && new Set(markup.entries.map((entry) => entry.sheet)).size === 3, `${labels} labels`);
  check("R.R.1 is recorded as framing zones, which is what is drawn",
    markup.entries.find((entry) => entry.mark === "R.R.1").counted === "zones");
  check("every label can be opened at the enlargement it was read from",
    markup.entries.every((entry) => entry.places.length === entry.count
      && entry.places.every((place) => /^p\d+-r[12]c[12]\.jpg$/.test(place.tile) && place.x > 0 && place.y > 0)));
  check("six groups are marked disputed, with the reason on each",
    markup.entries.filter((entry) => entry.disputed).length === 6
    && markup.entries.filter((entry) => entry.disputed).every((entry) => entry.note.length > 20));
  /* The one thing the markup must never do: decide a winner on a number
     nobody has settled. */
  const report = compareReadings([
    { id: "a", blind: "A", analysis: reading([member({ mark: "HIP BM 2", count_proposed: 4, counted: "labels" })]) },
    { id: "b", blind: "B", analysis: reading([member({ mark: "HIP BM 2", count_proposed: 6, counted: "labels" })]) },
  ]);
  const truth = againstTruth(report, markup.entries.filter((entry) => entry.mark === "HIP BM 2"), ["A", "B"]);
  check("a reading that matches the disputed number earns nothing for it",
    truth.coverage.entries_scored === 0 && truth.per_reading.A.matches === 0 && truth.per_reading.B.matches === 0,
    JSON.stringify(truth.coverage));
  const scoredMarks = markup.entries.filter((entry) => !entry.disputed);
  check("what is left to score by is stated plainly: 26 undisputed groups, 75 labels",
    scoredMarks.length === 26 && scoredMarks.reduce((sum, entry) => sum + entry.count, 0) === 75,
    `${scoredMarks.length} groups / ${scoredMarks.reduce((sum, entry) => sum + entry.count, 0)} labels`);
}

console.log("\n── no clear winner is a real answer ──");
{
  const separated = tallyFindings({ findings: [
    { reader: "A", verdict: "verified" }, { reader: "A", verdict: "verified" },
    { reader: "B", verdict: "wrong" }, { reader: "C", verdict: "could_not_verify" },
  ] }, ["A", "B", "C"]);
  check("a reader ahead on findings that carried evidence is named", separated.leader === "A", JSON.stringify(separated.per_reader));
  const tied = tallyFindings({ findings: [
    { reader: "A", verdict: "verified" }, { reader: "B", verdict: "verified" },
    { reader: "C", verdict: "could_not_verify" },
  ] }, ["A", "B", "C"]);
  check("a tie gives no winner rather than an arbitrary one", tied.leader === null, JSON.stringify(tied));
  const nothingChecked = tallyFindings({ findings: [
    { reader: "A", verdict: "could_not_verify" }, { reader: "B", verdict: "could_not_verify" },
  ] }, ["A", "B", "C"]);
  check("and when nothing could be verified there is no winner at all",
    nothingChecked.leader === null && /do not separate/.test(nothingChecked.reason));
  check("the count the application uses is its own, taken from findings with evidence",
    /named a place on a sheet/.test(separated.reason));
}

console.log("\n── what the worker itself is held to ──");
{
  const worker = fs.readFileSync("supabase/functions/compare-readings/index.ts", "utf8");
  const studio = fs.readFileSync("studio/plans/plans.js", "utf8");
  const migration = fs.readFileSync("supabase/migrations/057_the_comparison_of_readings.sql", "utf8");

  check("the three answers reach the checker as letters, shuffled, and which is which stays on the server",
    /blind_map: blindMap/.test(worker) && /Math\.random\(\)/.test(worker)
    && /You are not told which system produced which/.test(worker)
    && !/provider_label|PROVIDERS\[.*\]\.label/.test(worker.slice(worker.indexOf("const CHECK_INSTRUCTIONS"), worker.indexOf("const verdictSchema"))));
  check("the checker is told that more rows is not better and that refusing to count is not caution",
    /WHAT IS NOT A VIRTUE/.test(worker) && /refusing to count anything is not caution/.test(worker));
  check("and that a sheet reference alone never establishes a quantity",
    /A sheet reference alone never establishes a quantity/.test(worker));
  check("the same reading assets the readers were given are gathered by the one shared gatherer",
    /gatherReadingAssets\(admin, documents as never, readingImageBudget\(provider\)\)/.test(worker));
  check("the comparison is claimed in the ledger before anything is bought",
    worker.indexOf("claimAiRun") < worker.indexOf("runCheck(transport") && /processKey: "compare-readings"/.test(worker));
  check("reopening one already made returns the saved row and buys nothing",
    /if \(action === "status"\)/.test(worker) && /return json\(request, \{ comparison: existing \|\| null, saved: Boolean\(existing\) \}\);/.test(worker));
  check("a reader that failed makes the comparison incomplete and is never run again by this worker",
    /state: incompleteReason \? "incomplete" : "complete"/.test(worker)
    && /The missing reading was not run again/.test(worker)
    /* It cannot re-run one either: it never invokes the plan reader, and the
       only thing it takes from that worker is the pure clock arithmetic both
       share, which cannot start anything. */
    && !/invoke\(\s*["']plan-analyze/.test(worker)
    && !/functions\/v1\/plan-analyze/.test(worker)
    && !/launchNextPendingChunk|createProviderReading/.test(worker)
    && (worker.match(/from "\.\.\/plan-analyze\/[^"]+"/g) || []).every((line) => line.includes("chunking.js"))
    && /import \{ workerBudget \} from "\.\.\/plan-analyze\/chunking\.js";/.test(worker));
  check("nothing here changes the project's active baseline or merges rows into a new schedule",
    !/active_baseline_id/.test(worker) && !/material_takeoffs/.test(worker)
    && /does not become this project's baseline/.test(studio));
  check("a control markup must be checked against the documents it was read from",
    /verified_against/.test(worker) && /byte_size: row\.byte_size/.test(worker) && /page_count: row\.page_count/.test(worker));
  check("and the saved comparison is readable by the organisation and writable by no browser",
    /is_org_member\(organization_id\)/.test(migration)
    && !/for insert/.test(migration) && !/for update/.test(migration));
}

console.log(bad ? `\n${bad} FAILURES` : "\nALL OK");
process.exit(bad ? 1 : 0);
