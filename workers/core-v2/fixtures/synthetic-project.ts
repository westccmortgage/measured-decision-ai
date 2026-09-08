/* A PROJECT THAT DOES NOT EXIST, FOR AN ENGINE THAT MUST WORK BEFORE ONE DOES.
 *
 * Two invented documents, six invented pages, twelve invented regions, three
 * invented symbol families. Every hash is a hash of the string that names it.
 * Nothing here was drawn by anyone, belongs to anyone, or was read from any
 * client's file — and the tests assert that no client identifier appears.
 *
 * The shape is deliberate: it has the things the engine must exercise —
 *   · a legend a locator depends on;
 *   · two plan regions carrying the same symbol family, so counting spans
 *     regions;
 *   · two schedules and a note group read blind by two readers each;
 *   · a detail a dimension reader can be asked to open;
 *   · one schedule row the mock readers will disagree about;
 *   · one plan mark only one mock reader will see.
 */
import type { SourceManifest, TaskType } from "../contracts.ts";
import { sha256 } from "../hash.ts";

const h = (label: string) => sha256(`synthetic:${label}`);

export const SYNTHETIC_WORKFLOW_ID = "wf_synthetic_0001";

export function syntheticManifest(overrides: Partial<SourceManifest> = {}): SourceManifest {
  const independent: TaskType[] = ["extract_schedule", "locate_symbol_family", "extract_notes"];
  return {
    workflowId: SYNTHETIC_WORKFLOW_ID,
    organizationId: "org_synthetic",
    propertyId: "prop_synthetic",
    documents: [
      { documentId: "doc_str", filename: "synthetic-structural.pdf", contentHash: h("doc_str") },
      { documentId: "doc_arch", filename: "synthetic-architectural.pdf", contentHash: h("doc_arch") },
    ],
    pages: [
      { pageId: "pg_x1", documentId: "doc_str", pageIndex: 0, sheetNumber: "X-1", sheetTitle: "FOUNDATION PLAN", discipline: "structural", contentHash: h("pg_x1"), width: 1000, height: 700 },
      { pageId: "pg_x2", documentId: "doc_str", pageIndex: 1, sheetNumber: "X-2", sheetTitle: "FLOOR FRAMING", discipline: "structural", contentHash: h("pg_x2"), width: 1000, height: 700 },
      { pageId: "pg_x3", documentId: "doc_str", pageIndex: 2, sheetNumber: "X-3", sheetTitle: "DETAILS", discipline: "structural", contentHash: h("pg_x3"), width: 1000, height: 700 },
      { pageId: "pg_y1", documentId: "doc_arch", pageIndex: 0, sheetNumber: "Y-1", sheetTitle: "FIRST FLOOR", discipline: "architectural", contentHash: h("pg_y1"), width: 1000, height: 700 },
      { pageId: "pg_y2", documentId: "doc_arch", pageIndex: 1, sheetNumber: "Y-2", sheetTitle: "SCHEDULES", discipline: "architectural", contentHash: h("pg_y2"), width: 1000, height: 700 },
      { pageId: "pg_y3", documentId: "doc_arch", pageIndex: 2, sheetNumber: "Y-3", sheetTitle: "GENERAL NOTES", discipline: "architectural", contentHash: h("pg_y3"), width: 1000, height: 700 },
    ],
    regions: [
      { regionId: "rg_x1_title", pageId: "pg_x1", kind: "title_block", label: null, bbox: [0.86, 0.88, 0.99, 0.99], contentHash: h("rg_x1_title") },
      { regionId: "rg_x1_plan", pageId: "pg_x1", kind: "plan_view", label: "FOUNDATION PLAN", bbox: [0.04, 0.06, 0.62, 0.94], contentHash: h("rg_x1_plan"), symbolFamilies: ["PIER-P"] },
      { regionId: "rg_x1_sched", pageId: "pg_x1", kind: "schedule", label: "PIER SCHEDULE", bbox: [0.66, 0.06, 0.98, 0.40], contentHash: h("rg_x1_sched") },
      { regionId: "rg_x2_plan", pageId: "pg_x2", kind: "plan_view", label: "FLOOR FRAMING", bbox: [0.04, 0.06, 0.62, 0.94], contentHash: h("rg_x2_plan"), symbolFamilies: ["HDR-H", "PIER-P"], linkedDetailRegionIds: ["rg_x3_det"] },
      { regionId: "rg_x2_legend", pageId: "pg_x2", kind: "legend", label: "FRAMING LEGEND", bbox: [0.66, 0.06, 0.98, 0.30], contentHash: h("rg_x2_legend") },
      { regionId: "rg_x2_sched", pageId: "pg_x2", kind: "schedule", label: "HEADER SCHEDULE", bbox: [0.66, 0.34, 0.98, 0.60], contentHash: h("rg_x2_sched") },
      { regionId: "rg_x3_det", pageId: "pg_x3", kind: "detail", label: "HEADER BEARING DETAIL", bbox: [0.05, 0.05, 0.50, 0.50], contentHash: h("rg_x3_det") },
      { regionId: "rg_y1_plan", pageId: "pg_y1", kind: "plan_view", label: "FIRST FLOOR PLAN", bbox: [0.04, 0.06, 0.70, 0.94], contentHash: h("rg_y1_plan"), symbolFamilies: ["WIN-W"] },
      { regionId: "rg_y1_legend", pageId: "pg_y1", kind: "legend", label: "SYMBOL LEGEND", bbox: [0.74, 0.06, 0.98, 0.30], contentHash: h("rg_y1_legend") },
      { regionId: "rg_y2_sched", pageId: "pg_y2", kind: "schedule", label: "WINDOW SCHEDULE", bbox: [0.05, 0.05, 0.95, 0.60], contentHash: h("rg_y2_sched") },
      { regionId: "rg_y3_notes", pageId: "pg_y3", kind: "general_notes", label: "GENERAL NOTES", bbox: [0.05, 0.05, 0.60, 0.95], contentHash: h("rg_y3_notes"), noteGroup: "general" },
      { regionId: "rg_y3_title", pageId: "pg_y3", kind: "title_block", label: null, bbox: [0.86, 0.88, 0.99, 0.99], contentHash: h("rg_y3_title") },
    ],
    symbolFamilies: [
      { familyKey: "PIER-P", definedByRegionId: null, scheduledByRegionId: "rg_x1_sched" },
      { familyKey: "HDR-H", definedByRegionId: "rg_x2_legend", scheduledByRegionId: "rg_x2_sched" },
      { familyKey: "WIN-W", definedByRegionId: "rg_y1_legend", scheduledByRegionId: "rg_y2_sched" },
    ],
    independentReadingTaskTypes: independent,
    ...overrides,
  };
}
