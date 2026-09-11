/* WHAT THIS PLATFORM ACCEPTS, AND WHY IT WOULD REFUSE A PARTICULAR FILE.
 *
 * Two rules this module exists to keep:
 *
 *   1. the limits are shown BEFORE the picker opens, not discovered after a
 *      two-gigabyte upload;
 *   2. a refusal names the thing that is wrong with THIS file — its type, its
 *      size, its page count, its codec — and never says "unsupported file".
 *
 * Nothing here reads bytes. It answers what can be decided from the name, the
 * declared type and the size, and hands the rest to `probeRefusal`, which is
 * called after the browser has actually opened the file.
 *
 * It is a plain ES module with no imports so that the browser and the test
 * suite run the same copy.
 */

export const MEGABYTE = 1024 * 1024;

/* The three kinds, in the words the screen uses. `accept` is what goes on the
   file input; `mediaTypes` is what a browser is allowed to have decided the
   file is; `extensions` is the fallback, because Windows and some browsers
   hand over an empty type for .mov. */
export const KINDS = Object.freeze({
  pdf: {
    kind: "pdf",
    name: "PDF plan set",
    detail: "Drawings, schedules and specifications. Scanned pages are fine — the page image is what a reader is given.",
    accept: ".pdf,application/pdf",
    mediaTypes: ["application/pdf", "application/x-pdf"],
    extensions: [".pdf"],
    maximumBytes: 200 * MEGABYTE,
    maximumParts: 120,
    partWord: "pages",
  },
  video: {
    kind: "video",
    name: "Ordinary video",
    detail: "MP4, MOV or WebM — H.264, VP8, VP9 or AV1. Your browser has to be able to decode it, and the check below actually opens the file and takes a frame out of it rather than trusting the extension.",
    accept: ".mp4,.mov,.m4v,.webm,video/mp4,video/quicktime,video/webm",
    mediaTypes: ["video/mp4", "video/quicktime", "video/x-m4v", "video/webm"],
    extensions: [".mp4", ".mov", ".m4v", ".webm"],
    maximumBytes: 2048 * MEGABYTE,
    maximumParts: 60,
    partWord: "sampled frames",
  },
  video360: {
    kind: "video360",
    name: "360° video, already equirectangular",
    detail: "A finished equirectangular export — the 2:1 MP4 from Insta360 Studio or similar, or a 2:1 WebM. Raw dual-fisheye camera files are not stitched here.",
    accept: ".mp4,.mov,.webm,video/mp4,video/quicktime,video/webm",
    mediaTypes: ["video/mp4", "video/quicktime", "video/webm"],
    extensions: [".mp4", ".mov", ".webm"],
    maximumBytes: 2048 * MEGABYTE,
    maximumParts: 60,
    partWord: "sampled frames",
  },
});

/* THE CEILING ON ONE ANALYSIS. The door refuses past this too, from the
   record, so a browser that skipped the check cannot get past it. */
export const MAXIMUM_SUBJECTS = 120;
export const MAXIMUM_FILES = 12;

/* A provider is declared to accept one piece of material up to this, and PNG.
   Every page image and every frame is reduced until it fits, and the size it
   was actually reduced to is written down beside it. */
export const MAXIMUM_PART_BYTES = 256 * 1024;

export const humanBytes = (bytes) => {
  const n = Number(bytes) || 0;
  if (n >= 1024 * MEGABYTE) return `${(n / (1024 * MEGABYTE)).toFixed(1)} GB`;
  if (n >= MEGABYTE) return `${(n / MEGABYTE).toFixed(n >= 10 * MEGABYTE ? 0 : 1)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} bytes`;
};

export const extensionOf = (fileName) => {
  const dot = String(fileName || "").lastIndexOf(".");
  return dot < 0 ? "" : String(fileName).slice(dot).toLowerCase();
};

/* WHAT CAN BE DECIDED WITHOUT OPENING THE FILE.
   Returns null when nothing is wrong so far — never "ok", because nothing has
   been read yet and this function is not entitled to say a file is good. */
export function nameAndSizeRefusal(kind, file) {
  const spec = KINDS[kind];
  if (!spec) return `“${kind}” is not one of the three kinds this platform reads.`;

  const extension = extensionOf(file.name);
  const type = String(file.type || "").toLowerCase().split(";")[0];
  const typeKnown = type.length > 0;
  const typeFits = typeKnown && spec.mediaTypes.includes(type);
  const extensionFits = spec.extensions.includes(extension);

  if (!typeFits && !extensionFits) {
    if (typeKnown) {
      return `This file is ${type}${extension ? ` (${extension})` : ""}. ${spec.name} takes ${spec.extensions.join(", ")}.`;
    }
    return `This file is named ${file.name || "(no name)"}, which is not ${spec.extensions.join(" or ")}. ${spec.name} takes those.`;
  }
  /* A .mov whose browser-declared type is video/mp4, or the other way round,
     is normal and is not a refusal: the codec check below is the one that
     matters and it opens the file. */

  if (!(Number(file.size) > 0)) {
    return `${file.name || "This file"} is empty — 0 bytes reached the picker. If it is still copying from a camera or a cloud folder, wait for that to finish.`;
  }
  if (file.size > spec.maximumBytes) {
    return `${file.name} is ${humanBytes(file.size)}. The limit for ${spec.name.toLowerCase()} is ${humanBytes(spec.maximumBytes)}.`;
  }
  return null;
}

/* WHAT ONLY OPENING THE FILE CAN DECIDE.
   `probe` is what prepare.js got out of the file: { pages } for a PDF,
   { durationSeconds, width, height, decodable, reason } for a video. */
export function probeRefusal(kind, file, probe) {
  const spec = KINDS[kind];
  if (!spec) return `“${kind}” is not one of the three kinds this platform reads.`;
  if (!probe) return `${file.name} could not be opened at all, and no reason came back. That is a fault here, not in your file — please say so.`;

  if (kind === "pdf") {
    if (probe.encrypted) {
      return `${file.name} is password-protected. Save an unprotected copy — a reader cannot be given a page it cannot open.`;
    }
    if (!(probe.pages > 0)) {
      return `${file.name} opened as a PDF but reports no pages${probe.reason ? `: ${probe.reason}` : ""}.`;
    }
    if (probe.pages > spec.maximumParts) {
      return `${file.name} has ${probe.pages} pages. One analysis reads up to ${spec.maximumParts}. Split the set, or start with the sheets that matter.`;
    }
    return null;
  }

  if (!probe.decodable) {
    return `Your browser opened ${file.name} but could not decode the picture${probe.reason ? ` — ${probe.reason}` : ""}. That is usually HEVC/H.265 or ProRes in a .mov. Export H.264 (or VP9/AV1) and try again.`;
  }
  if (!(probe.durationSeconds > 0)) {
    return `${file.name} decodes but reports no duration. A file still being written by a camera or a sync client does this; copy it out and try again.`;
  }
  if (probe.durationSeconds > 60 * 60) {
    return `${file.name} is ${Math.round(probe.durationSeconds / 60)} minutes long. One analysis reads up to 60 minutes of video.`;
  }
  if (kind === "video360") {
    const ratio = probe.width > 0 && probe.height > 0 ? probe.width / probe.height : 0;
    if (Math.abs(ratio - 2) > 0.06) {
      return `${file.name} is ${probe.width}×${probe.height}, a ${ratio.toFixed(2)}:1 picture. An equirectangular 360 export is 2:1. If this is an ordinary clip, add it as ordinary video; if it is a raw dual-fisheye camera file, stitch it first.`;
    }
  }
  return null;
}
