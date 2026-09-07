/* THE PAGES AND THE ENLARGEMENTS, GATHERED ONCE.
 *
 * Two different jobs need exactly the same view of a plan set: the reading
 * itself, and the check that later asks which reading was better. If they
 * gathered their own pages, they could drift — and a checker looking at a
 * different set of enlargements than the readers had is a checker judging
 * work it cannot see. So the signing, the tiles and the coverage note live
 * here, in one place, and both callers ask for them the same way.
 *
 * Nothing here decides what to read. It says, out loud, what a request could
 * see: which pages arrived at drawing-desk resolution, and which arrived only
 * as the provider's own rasterisation of the PDF. A page the budget could not
 * carry is a limit of our request, never a gap in the drawings.
 */
import { createClient } from "npm:@supabase/supabase-js@2";
import { signedObjectReadUrl } from "./aws-object-store.ts";
import { tileCoverage, tileCoverageLines } from "../plan-analyze/chunking.js";

export type AssetDocumentRow = {
  id: string;
  organization_id: string;
  storage_path: string;
  storage_provider?: string | null;
  storage_bucket?: string | null;
  original_filename: string;
};

export type ReadingAsset = { label: string; url: string; mediaType: string };

export type GatheredAssets = {
  documents: ReadingAsset[];
  images: ReadingAsset[];
  /* One line per document that could not carry all its tiles. */
  unseen: string[];
  coverage: Array<Record<string, unknown>>;
  imageNote: string | null;
  /* WHAT WAS ACTUALLY SENT.
   *
   * A digest over the documents and the enlargements this reading carried,
   * in the order it carried them. Recorded with every reading, so "the three
   * readers were given the same kit" is something that can be checked
   * against the record rather than assumed from the code. The signed URLs
   * are deliberately not part of it: they differ on every call and say
   * nothing about what was shown. */
  fingerprint: string;
  manifest: { documents: string[]; images: string[] };
  imagesSent: number;
};

const SIGNED_URL_SECONDS = 3600;

/* The stored tiles of one document, named p<page>-full / p<page>-r<row>c<col>,
   with the original set's page numbers. */
export async function listPageTiles(
  admin: ReturnType<typeof createClient>,
  row: AssetDocumentRow,
) {
  const { data: renderRecord } = await admin.from("plan_page_renders")
    .select("document_id").eq("document_id", row.id).maybeSingle();
  if (!renderRecord) return [];
  const prefix = `${row.organization_id}/page-renders/${row.id}`;
  const { data: objects } = await admin.storage.from("project-documents").list(prefix, { limit: 1000 });
  return (objects || [])
    .filter((object: { name: string }) => object.name.endsWith(".jpg"))
    .map((object: { name: string }) => ({ name: object.name, page: Number((object.name.match(/^p(\d+)-/) || [])[1] || 0) }));
}

export async function gatherReadingAssets(
  admin: ReturnType<typeof createClient>,
  documents: AssetDocumentRow[],
  imageBudget: number,
): Promise<GatheredAssets> {
  const signedDocuments: Array<{ row: AssetDocumentRow; url: string }> = [];
  for (const row of documents) {
    if (row.storage_provider === "aws-s3") {
      signedDocuments.push({ row, url: await signedObjectReadUrl(row.storage_path, SIGNED_URL_SECONDS) });
    } else {
      const { data: signed, error: signedError } = await admin.storage
        .from(row.storage_bucket || "project-documents")
        .createSignedUrl(row.storage_path, SIGNED_URL_SECONDS);
      if (signedError || !signed?.signedUrl) throw new Error(`Could not read ${row.original_filename}`);
      signedDocuments.push({ row, url: signed.signedUrl });
    }
  }

  /* Drawing-desk resolution. The Studio renders each plan page into
     high-resolution tiles, because a provider's own PDF rasteriser draws an
     E-size sheet too small to read a schedule or count a pile mark. When
     tiles exist they ride along as images; when they do not, the PDFs still
     go alone — reduced sharpness, never a dead end. */
  const withTiles: Array<{ id: string; filename: string; tiles: Array<{ name: string; page: number }> }> = [];
  for (const { row } of signedDocuments) {
    withTiles.push({ id: row.id, filename: row.original_filename, tiles: await listPageTiles(admin, row) });
  }
  const budget = tileCoverage(withTiles, imageBudget);
  const images: ReadingAsset[] = [];
  for (const tile of budget.kept) {
    const row = signedDocuments.find((entry) => entry.row.id === tile.document_id)?.row;
    if (!row) continue;
    const prefix = `${row.organization_id}/page-renders/${row.id}`;
    const { data: signedTile } = await admin.storage.from("project-documents")
      .createSignedUrl(`${prefix}/${tile.name}`, SIGNED_URL_SECONDS);
    if (signedTile?.signedUrl) {
      images.push({ label: `${row.original_filename} · ${tile.name}`, url: signedTile.signedUrl, mediaType: "image/jpeg" });
    }
  }
  const unseen = tileCoverageLines(budget.coverage);

  /* Built from the very arrays that go into the request, so it cannot
     describe a kit other than the one sent. */
  const manifest = {
    documents: signedDocuments.map(({ row }) => `${row.id}:${row.original_filename}`),
    images: images.map((image) => image.label),
  };
  const fingerprint = await digest(JSON.stringify(manifest));

  const imageNote = images.length
    ? [
      "A document whose register entry has part_of is a page range copied from a larger file; treat all parts of one file as one set, and cite pages by the numbers in their tile names, which are the original file's page numbers.",
      "High-resolution page renders accompany the PDFs, in this order:",
      ...images.map((image, index) => `${index + 1}. ${image.label}`),
      "Tile names: p<page>-r<row>c<col> is one quadrant of that page at ~200 dpi; p<page>-full is the whole page. "
      + "Read fine print — schedules, legends, keynotes, title blocks — from these tiles, and count drawn marks tile by tile, summing across a page without double-counting the overlap-free tile edges.",
      ...(unseen.length ? [
        `Pages whose high-resolution tiles this request could not carry — ${unseen.join(" · ")}. `
        + "That is the limit of this reading's image budget, not a gap in the drawings: those sheets are whole and are attached in the PDF at the provider's own resolution. "
        + "Read them there. Where a count or a line of fine print on such a page is not legible at that resolution, write \"not legible at this reading's resolution\" in the row's count_note with count_confidence none — "
        + "never describe the sheet as cropped, partial or unavailable, and never raise it as a question to the designer.",
      ] : []),
    ].filter(Boolean).join("\n")
    : null;

  return {
    documents: signedDocuments.map(({ row, url }) => ({ label: row.original_filename, url, mediaType: "application/pdf" })),
    images,
    unseen,
    coverage: budget.coverage,
    imageNote,
    fingerprint,
    manifest,
    imagesSent: images.length,
  };
}

/* A short, stable digest: SHA-256 of the manifest text, its first sixteen
   bytes in hex — far enough apart that two different kits do not collide,
   short enough to sit in a row and be compared by eye. */
async function digest(text: string) {
  const bytes = new TextEncoder().encode(text);
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...hash.slice(0, 16)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
