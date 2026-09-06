/* Which table a stored object lives in, and which columns that table has.
 *
 * Two kinds of file share the file service: a project document (a plan set,
 * a submittal, an invoice) and an evidence item (a capture, a photo, a
 * video). They are stored the same way and opened the same way, so one
 * `get_url` serves both — but the two tables are not the same shape. An
 * evidence row remembers the capture session or drop box it came through
 * and whether it has since been deleted; a project document has none of
 * that.
 *
 * Asking a table for a column it does not have is not a miss, it is an
 * error — and a lookup that discards its error and reads an empty result
 * as "not found" turns every plan set into a 404. That is what happened to
 * every project document since the evidence columns were added to a select
 * both kinds ran. The list lives here, once, per table, and the test suite
 * runs exactly these selects against the migrated schema.
 */

export type StoredObjectEntity = "project_document" | "evidence";

export const STORED_OBJECT_TABLES: Record<StoredObjectEntity, string> = {
  project_document: "project_documents",
  evidence: "evidence_items",
};

/* What every stored object needs to be found, authorised and signed. */
const COMMON_COLUMNS = [
  "id",
  "organization_id",
  "property_id",
  "storage_provider",
  "storage_bucket",
  "storage_path",
  "field_assignment_id",
];

/* What only an evidence row carries: the door it came through, and whether
   the file behind it still exists. */
const EVIDENCE_ONLY_COLUMNS = [
  "capture_session_id",
  "project_intake_access_id",
  "deleted_at",
  "purged_at",
];

export function storedObjectTable(entityType: string): string | null {
  return entityType === "project_document" || entityType === "evidence"
    ? STORED_OBJECT_TABLES[entityType]
    : null;
}

export function storedObjectColumns(entityType: string): string[] {
  if (entityType === "evidence") return [...COMMON_COLUMNS, ...EVIDENCE_ONLY_COLUMNS];
  if (entityType === "project_document") return [...COMMON_COLUMNS];
  return [];
}

/* The select as the file service sends it — one string, no spaces, the form
   PostgREST parses. Tests run this same string as SQL. */
export function storedObjectSelect(entityType: string): string {
  return storedObjectColumns(entityType).join(",");
}
