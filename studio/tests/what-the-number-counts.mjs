/* What the number counts.
 *
 * The v3 reading of 4423 Noble recorded "12 × R.R.1" — twelve framing
 * zones of 2x10 rafters @ 16'' O.C., which are not twelve rafters —
 * "3 × RIDGE BM 2" where the schedule prints an assembly of two plies, and
 * "20 × RHDR 1" for unnumbered RHDR labels the sheet resolves through a
 * header table, not to the first numbered row. HDR4, printed on S-3, had
 * no row at all. A count that does not say what it counted is a wrong
 * number with a confidence attached.
 *
 * The contract now makes every count say what it counted and every size
 * say how it was reached; the schema carries the words; the distiller and
 * the calculator refuse to turn zones or labels into members.
 */
import fs from "fs";
let bad = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "  ok  " : "  FAIL"} ${label}${detail ? `\n         ${detail}` : ""}`);
  if (!ok) bad++;
};
const CONTRACT = fs.readFileSync("supabase/functions/_shared/agent-contracts.ts", "utf8");
const SCHEMA = fs.readFileSync("supabase/functions/plan-analyze/index.ts", "utf8");
const MIGRATION = fs.readFileSync("supabase/migrations/054_what_the_number_counts.sql", "utf8");

console.log("── the contract ──");
check("every count says what it counted: members, assemblies, zones, labels, none",
  /What the number counts\. Every structural_member count says what it counted in counted: members/.test(CONTRACT) && /assemblies — a built-up member/.test(CONTRACT) && /zones — a framing zone/.test(CONTRACT) && /labels — callouts seen/.test(CONTRACT));
check("twelve zones are not twelve rafters, and low confidence does not repair the wrong thing",
  /twelve R\.R\.1 zones are not twelve rafters, and saying so with low confidence does not repair saying the wrong thing/.test(CONTRACT));
check("an assembly is counted once, its plies recorded, never multiplied", /count the assemblies, put the ply count in plies, and never multiply/.test(CONTRACT));
check("a mark reaches its size by a path a person can check, and RHDR is not RHDR 1",
  /named in size_basis/.test(CONTRACT) && /An unnumbered label never resolves to the first numbered row of a schedule: RHDR is not RHDR 1/.test(CONTRACT));
check("every printed schedule row is a row, HDR4 included, seen on a plan or not",
  /HDR4 printed in the header schedule with no HDR4 callout found on the plans read is still recorded/.test(CONTRACT) && /Dropping HDR4 because it was not seen on a plan is the failure this rule refuses/.test(CONTRACT));
check("a printed rule says what kind of rule it is, so the rules read as a specification", /say what kind of rule it is in kind \(studs, plates, sheathing, blocking, nailing, headers, joists, rafters, connectors, lumber, other\)/.test(CONTRACT));

console.log("\n── the schema ──");
check("structural_members carry counted, plies and size_basis, all required",
  /"counted", "plies", "size_basis",/.test(SCHEMA) && /counted: \{ type: "string", enum: \["members", "labels", "zones", "assemblies", "none"\] \}/.test(SCHEMA)
    && /size_basis: \{ type: "string", enum: \["schedule_row", "printed_rule", "plan_label", "not_resolved"\] \}/.test(SCHEMA));
check("framing_defaults carry their kind", /required: \["rule", "kind", "applies_to", "exception", "source_refs"\]/.test(SCHEMA));

console.log("\n── the distiller ──");
check("zones and labels become an open RFI with the count in the description, never a quantity of members",
  /member_counted in \('zones', 'labels'\)/.test(MIGRATION) && /member_quantity := null;\s*member_method := 'OPEN_RFI';/.test(MIGRATION) && /on plan; member count not determined/.test(MIGRATION));
check("an assembly keeps its plies in the description and its unit says assembly", /plies per assembly/.test(MIGRATION) && /then 'assembly' else/.test(MIGRATION));
check("a reading made before the word existed counted members", /coalesce\(nullif\(trim\(member->>'counted'\), ''\), 'members'\)/.test(MIGRATION));

console.log(bad ? `\n${bad} FAILURES` : "\nALL OK");
process.exit(bad ? 1 : 0);
