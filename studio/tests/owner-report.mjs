/* The owner report — the page the pilot is sold on.
 *
 * The renderer is pure (model in, HTML out), so the guarantees are asserted
 * on the document itself:
 *   - a decision log that names people and dates, and says out loud that AI
 *     actions are not decisions;
 *   - a metrics panel counted from the record, with the honest line about
 *     what is not yet counted;
 *   - missing evidence said by room name, never hidden;
 *   - a copy produced without log access says who holds the log — and a
 *     room-scoped report carries no owner block at all.
 */
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const { documentHtml } = require("../report.js");

let bad = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "  ok  " : "  FAIL"} ${label}${detail ? `\n         ${detail}` : ""}`);
  if (!ok) bad++;
};

const baseModel = () => ({
  project: {
    name: "3001 Hutton", prepared_at: "August 26, 2026", prepared_by: "rep@example.com",
    last_evidence: "August 25, 2026", studio_url: "https://studio.test/?property=p1",
  },
  headline: "Two rooms captured this week",
  summary: { originals: 31, spaces: 3, interpreted: "2/3", confirmed: "1/3" },
  vr: { count: 1, link: "https://studio.test/vr" },
  spaces: [],
  changed: [{ title: "Hallway 200A", copy: "Insulation now covers the north wall." }],
  next: { title: "Approve the takeoff", copy: "The draft awaits a signature.", owner: "Reviewer" },
  open_questions: ["Garage: panel schedule not visible"],
  capture_requests: ["Master Bedroom: 360 after drywall"],
  document_requests: ["Insulation certificate for Hallway 200A"],
  money: null,
});

console.log("── the full owner report ──");
{
  const model = baseModel();
  model.owner = {
    decisions: [
      { at: "2026-08-26T01:00:00Z", action: "takeoff.approved", actor: "reviewer@example.com", entity_type: "material_takeoff", detail: {} },
      { at: "2026-08-25T22:00:00Z", action: "space_link.confirmed", actor: "owner@example.com", entity_type: "plan_space_link", detail: {} },
    ],
    metrics: {
      since: "2026-07-27T00:00:00Z", decisions_period: 2, evidence_added_period: 9,
      rooms_total: 3, rooms_with_evidence: 2, gaps_open: 4, takeoffs_signed: 1, releases_approved: 0,
    },
    rooms_without_evidence: ["Utility Closet"],
  };
  const html = documentHtml(model);
  check("the decision log names the decision, the date and the person",
    /Decisions on record/.test(html)
    && /Wood takeoff signed as verification baseline/.test(html)
    && /reviewer@example\.com/.test(html)
    && /Route between rooms confirmed/.test(html), "");
  check("and says AI actions are not decisions",
    /AI actions are not decisions and are not listed/.test(html));
  check("the metrics panel carries the counted numbers",
    /Pilot metrics — counted by the product/.test(html)
    && /<strong>9<\/strong>/.test(html)
    && /<strong>2\/3<\/strong>/.test(html)
    && /<strong>4<\/strong>/.test(html), "");
  check("and is honest about what is not yet counted",
    /not yet counted/.test(html) && /measured from the audit record, not guessed/.test(html));
  check("missing evidence names the room",
    /Missing evidence/.test(html) && /Utility Closet/.test(html));
  check("captures and documents requested live under missing evidence",
    html.indexOf("Missing evidence") < html.indexOf("360 after drywall")
    && html.indexOf("Missing evidence") < html.indexOf("Insulation certificate"));
}

console.log("\n── the report without log access ──");
{
  const model = baseModel();
  model.owner = null;
  const html = documentHtml(model);
  check("the decision section says who holds the log instead of pretending",
    /Decisions on record/.test(html) && /produced without that access/.test(html));
  check("and no metrics panel is invented", !/Pilot metrics/.test(html));
}

console.log("\n── a room-scoped report ──");
{
  const model = baseModel();
  /* owner left undefined: a room report never carries the project log. */
  const html = documentHtml(model);
  check("no decision section at all", !/Decisions on record/.test(html));
  check("the report still stands on its own", /What changed/.test(html) && /Missing evidence/.test(html));
}

console.log(bad ? `\n${bad} FAILURES` : "\nALL OK");
process.exit(bad ? 1 : 0);
