/* The framing calculator, checked by hand.
 *
 * Every expected number below was worked out on paper before the code ran,
 * because a takeoff test that trusts the calculator to generate its own
 * expectations tests nothing. The rules are the standard platform-framing
 * conventions stated at the top of takeoff360.js; if a rule changes, the
 * arithmetic here changes with it, visibly.
 *
 * The other half of the contract matters as much as the numbers: a dimension
 * the parser cannot read is a gap to report, never a zero to compute with —
 * a wall order that silently omits a wall reads as a smaller house.
 */
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const { parseFeetInches, takeoffWall, takeoff, stockLengthFor, headerDepthFor } = require("../takeoff360.js");

let bad = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "  ok  " : "  FAIL"} ${label}${detail ? `\n         ${detail}` : ""}`);
  if (!ok) bad++;
};

console.log("\n── reading what a drawing writes ──");
check(`12'-6" is 150 inches`, parseFeetInches(`12'-6"`) === 150, String(parseFeetInches(`12'-6"`)));
check(`12' alone is 144`, parseFeetInches("12'") === 144, String(parseFeetInches("12'")));
check(`96" alone is 96`, parseFeetInches(`96"`) === 96, String(parseFeetInches(`96"`)));
check(`12 ft 6 in works too`, parseFeetInches("12 ft 6 in") === 150, String(parseFeetInches("12 ft 6 in")));
check(`a half inch survives: 12'-6 1/2"`, parseFeetInches(`12'-6 1/2"`) === 150.5, String(parseFeetInches(`12'-6 1/2"`)));
check("a number passes through", parseFeetInches(150) === 150);
/* The rule the whole thing rests on: unreadable is null, not zero. */
check("prose is not a length", parseFeetInches("verify in field") === null, String(parseFeetInches("verify in field")));
check("empty is not a length", parseFeetInches("") === null);
check("zero is not a length", parseFeetInches("0'") === null);

console.log("\n── one plain wall, worked by hand ──");
/* 12' wall, 16" o.c., two corners, no openings.
   Run studs: ceil(144/16)+1 = 10. Corners: 2×2 = 4. Total 14.
   Plates: 3×144 = 432" = 36' → 3 pieces of 12' stock. */
{
  const result = takeoffWall({ label: "A", length: "12'", stud_spacing_inches: 16, corners: 2 });
  const studs = result.lines.find((line) => /stud/.test(line.item));
  const plates = result.lines.find((line) => /plate/.test(line.item));
  check("10 run studs + 4 corner studs = 14", studs?.quantity === 14, JSON.stringify(studs));
  check("standard height uses precut studs", /92 5\/8/.test(studs?.item || ""), studs?.item);
  check("plates: 36 feet in three 12' pieces", plates?.quantity === 3 && /12'/.test(plates.item), JSON.stringify(plates));
  check("and the trace shows the arithmetic",
    result.trace.some((step) => /ceil\(144" \/ 16"\) \+ 1 = 10/.test(step)), result.trace[0]);
}

console.log("\n── a wall with a door and a window ──");
/* 20' wall @16, 2 corners. Run: ceil(240/16)+1 = 16, corners 4 → 20.
   3' door: 2 kings + 2 trimmers = 4. 5' window: 2 kings + 2 trimmers = 4.
   Total studs 28.
   Headers: 3' span (36") → 2×6, 42" long → 2 pieces of 8' stock.
            5' span (60") → 2x8, 66" → 2 pieces of 8'. */
{
  const result = takeoffWall({
    label: "B", length: "20'", stud_spacing_inches: 16, corners: 2,
    openings: [
      { label: "door D1", width: "3'" },
      { label: "window W2", width: "5'" },
    ],
  });
  const studs = result.lines.find((line) => /stud/.test(line.item));
  check("16 + 4 + 4 + 4 = 28 studs", studs?.quantity === 28, JSON.stringify(studs));
  const header26 = result.lines.find((line) => /2x6 header/.test(line.item));
  const header28 = result.lines.find((line) => /2x8 header/.test(line.item));
  check("the 3' door gets a doubled 2x6 header", header26?.quantity === 2, JSON.stringify(header26));
  check("the 5' window gets a doubled 2x8 header", header28?.quantity === 2, JSON.stringify(header28));
}

console.log("\n── the header depth table ──");
check("4' span → 2x6", headerDepthFor(48) === "2x6");
check("6' span → 2x8", headerDepthFor(72) === "2x8");
check("8' span → 2x10", headerDepthFor(96) === "2x10");
check("wider → 2x12", headerDepthFor(120) === "2x12");
/* A 9' opening is past the table's confidence, and the order line says so
   rather than pricing it as routine. */
{
  const result = takeoffWall({ label: "G", length: "16'", openings: [{ label: "slider", width: "9'" }] });
  const wide = result.lines.find((line) => /REVIEW: span over 8'/.test(line.item));
  check("a 9' span is flagged for review on the order line", Boolean(wide), JSON.stringify(result.lines));
}

console.log("\n── wide openings and tall walls ──");
{
  /* Over 6' of span carries two trimmers a side: 2 kings + 4 trimmers = 6. */
  const result = takeoffWall({ label: "C", length: "10'", openings: [{ label: "opening", width: "7'" }] });
  const studs = result.lines.find((line) => /stud/.test(line.item));
  /* Run: ceil(120/16)+1 = 9, no corners; + 6 = 15. */
  check("a 7' opening carries doubled trimmers: 9 + 6 = 15", studs?.quantity === 15, JSON.stringify(studs));
}
{
  const result = takeoffWall({ label: "D", length: "10'", height: "10'" });
  const studs = result.lines.find((line) => /stud/.test(line.item));
  check("a 10' wall uses 10' stock, not precuts", /10'/.test(studs?.item || ""), studs?.item);
}
check("stock steps up, never down", stockLengthFor(97) === 10 && stockLengthFor(145) === 14);

console.log("\n── the whole set, with the gaps said out loud ──");
{
  const result = takeoff([
    { label: "A", length: "12'", corners: 2, source_refs: ["A-201"] },
    { label: "B", length: "20'", corners: 2, source_refs: ["A-201"], openings: [{ label: "D1", width: "3'" }] },
    /* The wall the drawings did not dimension. */
    { label: "C", length: "verify in field", source_refs: ["A-202"] },
    /* And an opening with no width. */
    { label: "D", length: "8'", openings: [{ label: "W9", width: "" }], source_refs: ["A-203"] },
  ]);
  check("measured walls are counted", result.measuredWalls === 3, String(result.measuredWalls));
  check("the unmeasured wall is returned, not dropped",
    result.unmeasured.length === 1 && result.unmeasured[0].label === "C", JSON.stringify(result.unmeasured));
  check("the widthless opening is a named gap",
    result.gaps.some((gap) => /W9/.test(gap) && /no readable width/.test(gap)), JSON.stringify(result.gaps));
  check("lines merge across walls",
    result.lines.filter((line) => /plate/.test(line.item)).length >= 1, JSON.stringify(result.lines.map((l) => l.item)));
  check("every trace names its sheets",
    result.traces.every((trace) => Array.isArray(trace.source_refs)), JSON.stringify(result.traces[0]));
}

console.log("\n── a deck, worked by hand from the Sarita sheets ──");
/* The set that exposed the gap: a nine-sheet wood deck — S-2.0 schedules,
   A-210 printed dimensions — read by a calculator that only knew stud walls
   and answered "no framing dimensions". These numbers follow the sheets:
   area 1,640 sq ft as printed; joists 2x6 F.R.T.; the schedules' marks.
   Hand arithmetic: joists 1640 × 12 / 16 = 1230 LF.
   Decking 2x6 at zero gap: 1640 × 12 / 5.5 = 3578.18 → 3579 LF. */
{
  const { takeoffDeck } = require("../takeoff360.js");
  const result = takeoffDeck({
    label: "Exterior deck", area_sqft: "1640",
    joist_size: "2x6", joist_spacing: '16"', joist_treatment: "F.R.T.",
    decking: "2x6 decking",
    beams: [{ mark: "BM.1", description: "Parallam PSL 2.0E 7.0\"x14.0\"", count_drawn: 4 }],
    columns: [{ mark: "COL.2", description: "8x8 #1", count_drawn: 12 }],
    piles: { count_drawn: 14, description: '18" dia concrete pile' },
    guardrail: '42" guardrail', guardrail_length: "",
    source_refs: ["S-2.0", "A-210"],
  });
  const joists = result.lines.find((line) => /joist/.test(line.item));
  const decking = result.lines.find((line) => /decking/.test(line.item));
  check("joist footage is area over spacing: 1230 LF", joists?.quantity === 1230, JSON.stringify(joists));
  check("decking is area over face width, called an upper bound",
    decking?.quantity === 3579 && /upper bound/.test(decking.item), JSON.stringify(decking));
  check("drawn marks are counted, not measured",
    result.lines.some((line) => line.quantity === 14 && /pile/.test(line.item))
    && result.lines.some((line) => line.quantity === 4 && /BM\.1/.test(line.item)),
    JSON.stringify(result.lines.map((l) => `${l.quantity} ${l.item}`)));
  check("a guardrail with no printed run is a gap, not a guess",
    result.gaps.some((gap) => /guardrail/.test(gap) && /no printed run length/.test(gap)), JSON.stringify(result.gaps));
  check("and every step is written out",
    result.steps.some((step) => /1640 sq ft × 12 \/ 16/.test(step)), JSON.stringify(result.steps));
}

console.log("\n── the deck as the sheets actually spell it ──");
/* The re-run on the real set came back with the sheets' own spellings and the
   calculator refused them: joist size "2×6 D.J." (a mark suffix and a Unicode
   multiplication sign), spacing "@6\" O.C." from the FLOOR JOIST SCHEDULE,
   area "1,640 SQ. FT." whose label periods broke the old digit strip, and the
   finish legend's decking "2\" x 6\" x 6' DECKING". Hand arithmetic at the
   printed spacing: 1640 × 12 / 6 = 3280 LF of joists; decking 1640 × 12 / 5.5
   = 3578.18 → 3579 LF. The printed area governs over the 82' × 25.33' outer
   bound the overalls imply. */
{
  const { takeoffDeck, normalizeLumberSize, parsePrintedNumber } = require("../takeoff360.js");
  check('"2×6 D.J." is the lumber size 2x6', normalizeLumberSize("2×6 D.J.") === "2x6");
  check("the finish legend's board size reads as 2x6", normalizeLumberSize("2\" x 6\" x 6' DECKING") === "2x6");
  check("prose is not a size", normalizeLumberSize("composite planks") === null);
  check('"1,640 SQ. FT." is 1640, label periods and all', parsePrintedNumber("1,640 SQ. FT.") === 1640);
  const result = takeoffDeck({
    label: "(N) Type V-B Wood Deck", area_sqft: "1,640 SQ. FT.",
    length: "82'-0\"", width: "25'-4\"",
    joist_size: "2×6 D.J.", joist_spacing: '@6" O.C.', joist_treatment: "F.R.T.",
    decking: "WD-1: 2\" x 6\" x 6' DECKING",
    sheathing: 'DECK DIAPHRAGM TO BE 19/32" PLYWOOD (PANEL INDEX 40/20)',
    beams: [], columns: [], piles: null, guardrail: "", guardrail_length: "",
    source_refs: ["S-2.0", "A-210"],
  });
  const joists = result.lines.find((line) => /deck boards|joist/.test(line.item));
  check("printed area governs over the overalls' bound",
    result.steps.some((s) => /1640 sq ft as printed/.test(s)) && result.steps.some((s) => /printed area governs/.test(s)),
    JSON.stringify(result.steps));
  check("the boards at the schedule's 6\" o.c.: 3280 LF", joists?.quantity === 3280, JSON.stringify(joists));
  /* The permeable-deck read: the finish legend's 2x6 IS the joist schedule's
     2x6 — 6" o.c. module over a 5.5" face leaves the ½" drainage gap. One
     order line; a separate decking line would buy the same boards twice
     (the double count a side-by-side list would not catch). */
  check("structure and surface are one order line, not two",
    /structure and walking surface in one/.test(joists?.item || "")
    && !result.lines.some((line) => /decking 2x6/.test(line.item)),
    JSON.stringify(result.lines.map((line) => line.item)));
  check("and the trace says why",
    result.steps.some((s) => /one member, two jobs/.test(s) && /0\.5" gap/.test(s)), JSON.stringify(result.steps));
  /* Framing note 3 prints the diaphragm: 1640 / 32 sq ft per 4×8 sheet =
     51.25 → 52 sheets. */
  const sheathing = result.lines.find((line) => /sheathing/.test(line.item));
  check("the framing note's diaphragm is 52 sheets", sheathing?.quantity === 52 && /19\/32/.test(sheathing.item), JSON.stringify(sheathing));
  /* One gap remains, and it is TRUE: the printed diaphragm note conflicts
     with the permeable deck the same sheets draw. The product raises that
     RFI itself — a person never has to spot the contradiction. */
  check("the only remaining gap is the real printed conflict, raised automatically",
    result.gaps.length === 1 && /HOLD — the printed diaphragm note conflicts/.test(result.gaps[0]),
    JSON.stringify(result.gaps));
  const sheathingLine = result.lines.find((line) => /sheathing/.test(line.item));
  check("and the sheet count stays computed but on HOLD",
    sheathingLine?.status === "hold" && /engineer to confirm/.test(sheathingLine.hold_reason || ""),
    JSON.stringify(sheathingLine));
  check("provenance rides on every line",
    result.lines.every((line) => ["PRINTED_FACT", "AI_PLAN_COUNT", "DERIVED_FROM_PRINTED_DIMENSIONS", "AI_SCALED_ESTIMATE"].includes(line.method)),
    JSON.stringify(result.lines.map((line) => [line.item.slice(0, 30), line.method])));
  const pieces = result.lines.find((line) => /net pieces/.test(line.item));
  check("the legend's printed 6' stock turns LF into 547 net pieces, allowance not computed",
    pieces?.quantity === 547 && /no purchase allowance/.test(pieces.item), JSON.stringify(pieces));
}

console.log("\n── a deck the sheets did not dimension ──");
{
  const { takeoffDeck } = require("../takeoff360.js");
  const result = takeoffDeck({
    label: "Mystery deck", area_sqft: "", length: "", width: "",
    joist_size: "2x6", joist_spacing: "", joist_treatment: "",
    decking: "composite planks", beams: [], columns: [],
    piles: { count_drawn: 0, description: "" }, guardrail: "", guardrail_length: "",
    source_refs: ["S-9"],
  });
  check("no area and no spacing produce gaps, never quantities",
    result.lines.length === 0 && result.gaps.length >= 2, JSON.stringify(result.gaps));
}

console.log("\n── determinism, the whole point ──");
{
  const walls = [{ label: "A", length: "17'-3 1/2\"", corners: 3, openings: [{ label: "D", width: "2'-8\"" }] }];
  const a = JSON.stringify(takeoff(walls));
  const b = JSON.stringify(takeoff(walls));
  check("the same walls produce the same order, byte for byte", a === b);
}

console.log(bad ? `\n${bad} FAILURES` : "\nALL OK");
process.exit(bad ? 1 : 0);
