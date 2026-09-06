/* The file service asks each table only for the columns it has.
 *
 * A project document and an evidence item are opened through the same
 * `get_url`, but their tables are not the same shape. One select that named
 * evidence-only columns was run against project_documents for weeks; the
 * database refused it, the refusal was thrown away, and every plan set became
 * "Stored object not found" — which is how a 54 MB plan set could be uploaded
 * but never split, rendered or opened.
 *
 * This test imports the shipping TypeScript. The companion check in
 * supabase/tests/run.sh runs the same select strings as SQL against the
 * migrated schema, so a column renamed in a migration fails there.
 */
import assert from "node:assert/strict";
import {
  STORED_OBJECT_TABLES,
  storedObjectColumns,
  storedObjectSelect,
  storedObjectTable,
} from "../../supabase/functions/_shared/stored-object-lookup.ts";

const EVIDENCE_ONLY = ["capture_session_id", "project_intake_access_id", "deleted_at", "purged_at"];
const NEEDED_TO_SIGN = ["id", "organization_id", "property_id", "storage_provider", "storage_bucket", "storage_path", "field_assignment_id"];

/* A project document is never asked for what only evidence has. */
for (const column of EVIDENCE_ONLY) {
  assert.ok(!storedObjectColumns("project_document").includes(column), `project_document must not select ${column}`);
}
/* Both kinds carry everything the handler reads to authorise and sign. */
for (const kind of ["project_document", "evidence"]) {
  for (const column of NEEDED_TO_SIGN) {
    assert.ok(storedObjectColumns(kind).includes(column), `${kind} must select ${column}`);
  }
}
/* Evidence still carries its door and its deletion marks — the 410 answers
   ("this file was destroyed") depend on them. */
for (const column of EVIDENCE_ONLY) {
  assert.ok(storedObjectColumns("evidence").includes(column), `evidence must select ${column}`);
}

/* The table each kind lives in, and nothing for a kind that does not exist. */
assert.equal(storedObjectTable("project_document"), "project_documents");
assert.equal(storedObjectTable("evidence"), "evidence_items");
assert.equal(storedObjectTable("upload"), null);
assert.equal(storedObjectTable(""), null);
assert.deepEqual(storedObjectColumns("upload"), []);
assert.deepEqual(Object.keys(STORED_OBJECT_TABLES).sort(), ["evidence", "project_document"]);

/* The select is one PostgREST column list: no spaces, no duplicates. */
for (const kind of ["project_document", "evidence"]) {
  const select = storedObjectSelect(kind);
  assert.ok(!/\s/.test(select), `${kind} select has whitespace`);
  const columns = select.split(",");
  assert.equal(new Set(columns).size, columns.length, `${kind} select repeats a column`);
}

console.log("ALL OK — each stored-object table is asked only for its own columns");
