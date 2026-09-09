/* WHAT AN AGENT IS GIVEN TO READ, AND WHAT IS CHECKED BEFORE IT GOES.
 *
 * The boundary this file is about exists because of one earlier mistake: the
 * runtime used to send a model a segment id, a locator and a hash, and call
 * that "the material". A model handed identities cannot read anything, and a
 * stand-in that answers from a task id proves nothing about whether it could.
 *
 * So there is now a resolver, and everything it returns is checked against
 * what was asked for BEFORE a request exists. This file is that check, held
 * to every way it can fail:
 *
 *   · material that never came back;
 *   · material for something the assignment does not authorise;
 *   · bytes that do not hash to what the assignment names;
 *   · a resolver whose own hash does not match its own bytes;
 *   · a locator wider than the one that was authorised;
 *   · a media type this provider is not configured to be sent;
 *   · a piece too large, or a request too large in total;
 *   · a transcript that does not say what time range it covers;
 *   · the same segment answered twice.
 *
 * And the structural promise: what a resolver returns has nowhere to put a
 * storage address. Not "we strip URLs" — there is no field.
 *
 * The network is sealed before the first line.
 */
import { harness, closeNetwork } from "../../core-v2/tests/harness.mjs";
import { sha256Bytes } from "../../core-v2/kernel/ids.ts";
import { verifyResolvedMaterial, bytesOf, describeMaterial, isTextual } from "../material/material.ts";
import { InMemoryMaterialResolver } from "../material/memory-resolver.ts";
import { syntheticRecordSet } from "../../core-v2/domains/synthetic-records/fixture.ts";
import { readTextFromImage } from "../../core-v2/domains/synthetic-records/material.ts";

const tripped = closeNetwork();
const t = harness("what an agent is given to read, and what is checked before it goes");

const TEXT = "entry     category   quantity  unit\nE-001     alpha      12        units\n";
const TEXT_BYTES = new Uint8Array(Buffer.from(TEXT, "utf8"));
const TEXT_HASH = sha256Bytes(TEXT_BYTES);
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02]);
const PNG_HASH = sha256Bytes(PNG_BYTES);
const TRANSCRIPT = "00:12 speaker one: the delivery arrived on the second\n";
const TRANSCRIPT_BYTES = new Uint8Array(Buffer.from(TRANSCRIPT, "utf8"));
const TRANSCRIPT_HASH = sha256Bytes(TRANSCRIPT_BYTES);

const LIMITS = {
  maximumItems: 4,
  maximumBytesPerItem: 4096,
  maximumBytesTotal: 8192,
  allowedMimeTypes: ["text/plain; charset=utf-8", "image/png", "text/plain"],
};

const reference = (segmentId, contentHash, over = {}) => ({
  sourceId: "src-1", segmentId, kind: "segment", sourceKind: "record_set", segmentKind: "table",
  parentSegmentId: null, label: null, ordinal: 0, locator: { bbox: [0, 0, 1, 1] }, contentHash, ...over,
});

const resolved = (ref, over = {}) => ({
  sourceId: ref.sourceId, segmentId: ref.segmentId, mediaKind: "text", mimeType: "text/plain; charset=utf-8",
  contentHash: ref.contentHash, byteLength: TEXT_BYTES.length, locator: ref.locator, content: { text: TEXT }, ...over,
});

/* ═════════════════════════════════════════ 1 · the resolver answers what it is asked */

t.section("a resolver is given references, never a query");
{
  const store = new Map([
    [TEXT_HASH, { mediaKind: "text", mimeType: "text/plain; charset=utf-8", bytes: TEXT_BYTES }],
    [PNG_HASH, { mediaKind: "image", mimeType: "image/png", bytes: PNG_BYTES }],
    [TRANSCRIPT_HASH, { mediaKind: "transcript", mimeType: "text/plain", bytes: TRANSCRIPT_BYTES, timeRange: { startSeconds: 12, endSeconds: 19 } }],
  ]);
  const resolver = new InMemoryMaterialResolver(store);
  const asked = [reference("seg-1", TEXT_HASH), reference("seg-2", PNG_HASH), reference("seg-3", TRANSCRIPT_HASH)];
  const material = await resolver.resolve(asked);

  t.check("it returns one piece per reference and not one more", material.length === 3, `${material.length}`);
  t.check("and it was asked about exactly the references it was given, in order",
    resolver.asked.length === 3 && resolver.asked.every((r, i) => r === asked[i]));
  t.check("each piece carries the identity of the reference it answers, not of wherever it was stored",
    material.every((m, i) => m.sourceId === asked[i].sourceId && m.segmentId === asked[i].segmentId));
  t.check("each carries the authorised locator, unchanged",
    material.every((m, i) => JSON.stringify(m.locator) === JSON.stringify(asked[i].locator)));
  t.check("each carries its media kind, its type, its size and the hash of its bytes",
    material.every((m) => typeof m.mediaKind === "string" && typeof m.mimeType === "string"
      && m.byteLength === bytesOf(m).length && m.contentHash === sha256Bytes(bytesOf(m))));

  t.check("text comes back as text and an image as bytes",
    isTextual(material[0]) && "text" in material[0].content && "bytes" in material[1].content);
  t.check("and a transcript says what time range it covers, because a quotation without a place cannot be anchored",
    material[2].timeRange.startSeconds === 12 && material[2].timeRange.endSeconds === 19);

  /* The structural promise. */
  const fields = new Set(material.flatMap((m) => Object.keys(m)));
  t.check("nothing a resolver returns has anywhere to put a storage address, a signed url, a path or an expiry",
    [...fields].every((name) => !/url|uri|path|bucket|token|expires|signature|credential|key$/i.test(name)),
    [...fields].join(", "));
  t.check("and nothing in what it returned is one",
    !/https?:\/\/|s3:\/\/|gs:\/\/|X-Amz-|signature=/i.test(JSON.stringify(material.map((m) => ({ ...m, content: "…" })))));

  t.check("what a person may be told about a piece is what it is, not what it says",
    describeMaterial(material[0]).includes("seg-1") && describeMaterial(material[0]).includes(TEXT_HASH)
    && !describeMaterial(material[0]).includes("E-001"), describeMaterial(material[0]));

  const verdict = verifyResolvedMaterial(asked, material, LIMITS);
  t.check("and all of it passes the check that runs before anything is sent", verdict.ok === true, verdict.ok ? "" : verdict.problems.join("; "));
  t.check("which returns it in the order the assignment listed it",
    verdict.ok && verdict.material.map((m) => m.segmentId).join(",") === "seg-1,seg-2,seg-3");
}

/* ═══════════════════════════════════════════════ 2 · every way it can be wrong */

t.section("nothing is sent unless what came back is what was asked for");
{
  const ref = reference("seg-1", TEXT_HASH);
  const other = new Uint8Array(Buffer.from("something else entirely\n", "utf8"));
  const BIG_BYTES = new Uint8Array(Buffer.alloc(5000, 0x61));
  const BIG_HASH = sha256Bytes(BIG_BYTES);

  const cases = [
    ["nothing came back at all", [], /no material came back/],
    ["something the assignment does not authorise came back",
      [resolved(ref), { ...resolved(ref), segmentId: "seg-9" }], /does not authorise/],
    ["the same segment was answered twice",
      [resolved(ref), resolved(ref)], /was returned twice/],
    ["the bytes are not the bytes the hash beside them names",
      [{ ...resolved(ref), content: { bytes: other } }], /does not hash to what the resolver says/],
    ["the material is self-consistent but is not what the assignment names",
      [{ ...resolved(ref), contentHash: sha256Bytes(other), byteLength: other.length, content: { bytes: other } }],
      /is not what this assignment names/],
    ["the size it declares is not the size it is", [{ ...resolved(ref), byteLength: 2 }], /says it is 2 bytes/],
    ["the material is empty",
      [{ ...resolved(ref), contentHash: sha256Bytes(new Uint8Array()), byteLength: 0, content: { bytes: new Uint8Array() } }], /is empty/,
      [reference("seg-1", sha256Bytes(new Uint8Array()))]],
    ["the place it covers is wider than the one authorised",
      [{ ...resolved(ref), locator: { bbox: [0, 0, 2, 2] } }], /covers a different place/],
    ["the type does not match the kind it claims to be",
      [{ ...resolved(ref), mediaKind: "image" }], /is not a image/],
    ["the type is one this provider is not configured to be sent",
      [{ ...resolved(ref), mediaKind: "image", mimeType: "image/gif", content: { bytes: PNG_BYTES }, contentHash: PNG_HASH, byteLength: PNG_BYTES.length }],
      /not configured to be sent/, [reference("seg-1", PNG_HASH)]],
    ["a kind this runtime does not carry at all", [{ ...resolved(ref), mediaKind: "hologram" }], /not a kind of material/],
    ["a transcript that does not say when it is from",
      [{ ...resolved(ref), mediaKind: "transcript", mimeType: "text/plain", timeRange: null }], /does not say what time range/],
    ["one piece larger than a piece may be",
      [{ ...resolved(ref), contentHash: BIG_HASH, byteLength: BIG_BYTES.length, content: { bytes: BIG_BYTES } }],
      /at most 4096 may be sent for one piece/, [reference("seg-1", BIG_HASH)]],
  ];

  for (const [what, material, reason, refs] of cases) {
    const verdict = verifyResolvedMaterial(refs ?? [ref], material, LIMITS);
    t.check(`${what}: refused`, verdict.ok === false, verdict.ok ? "it was allowed" : "");
    t.check(`${what}: and it says which, in a sentence`,
      verdict.ok === false && verdict.problems.some((line) => reason.test(line)),
      verdict.ok ? "" : verdict.problems.join(" | ").slice(0, 140));
  }

  /* Two pieces, each small enough, too much together. */
  const halfBytes = new Uint8Array(Buffer.alloc(4000, 0x62));
  const halfHash = sha256Bytes(halfBytes);
  const refs = [reference("seg-1", halfHash), reference("seg-2", halfHash)];
  const both = refs.map((r) => ({ ...resolved(r), contentHash: halfHash, byteLength: halfBytes.length, content: { bytes: halfBytes } }));
  const tooMuch = verifyResolvedMaterial(refs, both, { ...LIMITS, maximumBytesTotal: 6000 });
  t.check("two pieces that each fit and together do not are refused as a request, not trimmed",
    tooMuch.ok === false && tooMuch.problems.some((line) => /in one request/.test(line)),
    tooMuch.ok ? "" : tooMuch.problems.join("; "));

  const tooMany = verifyResolvedMaterial(refs, both, { ...LIMITS, maximumItems: 1 });
  t.check("more pieces than the assignment allows is refused too",
    tooMany.ok === false && tooMany.problems.some((line) => /at most 1 may be sent/.test(line)));
}

/* ═════════════════════════════════════ 3 · the invented pack's own material */

t.section("the invented record set is material, and its hashes are hashes of it");
{
  const truth = syntheticRecordSet({ seed: "material/one", sources: 1, sheetsPerSource: 1, entriesPerTable: 3 });
  const table = truth.sheets[0].regions[0];
  const note = truth.sheets[0].regions[1];

  t.check("every segment of the fixture has material filed under the hash of that material",
    truth.material.size >= 4
    && [...truth.material].every(([hash, item]) => sha256Bytes(item.bytes) === hash), `${truth.material.size} pieces`);
  t.check("a table is text a reader can parse",
    Buffer.from(truth.material.get(table.contentHash).bytes).toString("utf8").includes("E-001"));
  t.check("a note is an image — bytes, with a media type, that are not text",
    truth.material.get(note.contentHash).mediaKind === "image"
    && truth.material.get(note.contentHash).mimeType === "image/png");
  t.check("and the image really carries the note: decoding its pixels gives the words back",
    /^note: E-\d+ is \w+$/m.test(readTextFromImage(truth.material.get(note.contentHash).bytes)),
    JSON.stringify(readTextFromImage(truth.material.get(note.contentHash).bytes)));

  /* The property the whole correction turns on: change the material, and
     what a reader can say about it changes with it. */
  const other = syntheticRecordSet({ seed: "material/two", sources: 1, sheetsPerSource: 1, entriesPerTable: 3 });
  const otherTable = other.sheets[0].regions[0];
  t.check("two seeds are two worlds: different bytes, different hashes",
    otherTable.contentHash !== table.contentHash
    && Buffer.from(other.material.get(otherTable.contentHash).bytes).toString("utf8")
      !== Buffer.from(truth.material.get(table.contentHash).bytes).toString("utf8"));

  const resolver = new InMemoryMaterialResolver(new Map([...truth.material].map(([hash, item]) => [hash, { mediaKind: item.mediaKind, mimeType: item.mimeType, bytes: item.bytes }])));
  const ref = reference("seg-table", table.contentHash, { locator: { bbox: table.bbox } });
  const got = await resolver.resolve([ref]);
  const verdict = verifyResolvedMaterial([ref], got, LIMITS);
  t.check("the fixture's own material passes the check the runtime runs before it sends anything",
    verdict.ok === true, verdict.ok ? "" : verdict.problems.join("; "));

  /* And a store whose bytes were tampered with under an unchanged hash is
     caught by the recompute, which is the only reason to recompute. */
  const tampered = new Map([[table.contentHash, { mediaKind: "text", mimeType: "text/plain; charset=utf-8", bytes: new Uint8Array(Buffer.from("tampered\n", "utf8")) }]]);
  const bad = await new InMemoryMaterialResolver(tampered).resolve([ref]);
  const caught = verifyResolvedMaterial([ref], bad, LIMITS);
  t.check("material tampered with under an unchanged hash is caught by recomputing it",
    caught.ok === false && caught.problems.some((line) => /does not hash to what the resolver says/.test(line)),
    caught.ok ? "it was allowed" : caught.problems[0]);
}

t.section("every door stayed closed");
t.check("nothing in this file tried the network", tripped() === 0, `${tripped()} attempts`);

t.finish();
