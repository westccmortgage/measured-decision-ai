/* BYTES GO STRAIGHT FROM THE BROWSER TO STORAGE, AND CAN BE PICKED UP AGAIN.
 *
 * Supabase Storage speaks tus 1.0.0 at /storage/v1/upload/resumable. That is
 * the whole reason this file is short: creating an upload returns a URL, and
 * that URL remembers how many bytes it already has. Closing the tab, losing
 * the network or reloading the page costs the chunk in flight and nothing
 * more — the next attempt asks the server for the offset and carries on from
 * there.
 *
 * WHAT IS KEPT ON THE DEVICE, AND WHAT IS NOT. The upload URL is kept in
 * localStorage against the file's name, size and modified time, so that
 * picking the same file again resumes rather than restarts. No bytes and no
 * token are kept. The row that describes the file lives in the record, not
 * here, so a different device sees the same material even though it cannot
 * resume this particular transfer.
 *
 * WHY NOT THROUGH A FUNCTION. A function in the byte path is a request size
 * limit, an execution timeout and a bill, three times over for a large file.
 * Storage already does this, with row-level security on the same path.
 */

/* Supabase's tus endpoint requires exactly this chunk size for every part but
   the last. It is not a preference. */
export const CHUNK_BYTES = 6 * 1024 * 1024;
const TUS = "1.0.0";

const b64 = (value) => {
  const bytes = new TextEncoder().encode(String(value));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
};

const metadata = (fields) =>
  Object.entries(fields)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => `${k} ${b64(v)}`)
    .join(",");

const memoryOf = (file, objectName) =>
  `mdai-resumable:${objectName}:${file.size}:${file.lastModified || 0}`;

function remember(key, url) {
  try { localStorage.setItem(key, url); } catch { /* a private window; the upload still works, it just cannot resume */ }
}
function recall(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}
function forget(key) {
  try { localStorage.removeItem(key); } catch { /* nothing to do */ }
}

export class UploadRefused extends Error {
  constructor(message, status) {
    super(message);
    this.name = "UploadRefused";
    this.status = status ?? 0;
  }
}

/* Puts one file at `objectName` inside `bucket`.
 *
 *   accessToken   the signed-in person's own token: storage applies the same
 *                 row-level security it applies to every other read and write.
 *   onProgress    ({ sent, total }) — called after every accepted chunk.
 *   signal        an AbortSignal; aborting leaves the upload resumable.
 */
export async function putResumable({
  supabaseUrl, bucket, objectName, file, accessToken, contentType,
  onProgress, signal, chunkBytes = CHUNK_BYTES,
}) {
  const endpoint = `${String(supabaseUrl).replace(/\/+$/, "")}/storage/v1/upload/resumable`;
  const key = memoryOf(file, `${bucket}/${objectName}`);
  const authorization = `Bearer ${accessToken}`;
  const type = contentType || file.type || "application/octet-stream";

  const create = async () => {
    const response = await fetch(endpoint, {
      method: "POST",
      signal,
      headers: {
        authorization,
        "tus-resumable": TUS,
        "upload-length": String(file.size),
        "upload-metadata": metadata({
          bucketName: bucket, objectName, contentType: type, cacheControl: "3600",
        }),
        /* Replacing a file that is already there is a deliberate act upstream:
           the analysis refuses to change material under a result that has
           already been reached, and this is only how the bytes land. */
        "x-upsert": "true",
      },
    });
    if (response.status !== 201) {
      throw new UploadRefused(await refusalText(response, "the upload could not be started"), response.status);
    }
    const location = response.headers.get("location");
    if (!location) throw new UploadRefused("the upload was started but no address came back", 0);
    const url = new URL(location, endpoint).href;
    remember(key, url);
    return url;
  };

  const offsetOf = async (url) => {
    const response = await fetch(url, {
      method: "HEAD", signal,
      headers: { authorization, "tus-resumable": TUS },
    });
    if (response.status === 404 || response.status === 410 || response.status === 403) return null;
    if (!response.ok) return null;
    const offset = Number(response.headers.get("upload-offset"));
    return Number.isFinite(offset) ? offset : null;
  };

  let url = recall(key);
  let sent = url ? await offsetOf(url) : null;
  if (sent === null) { url = await create(); sent = 0; }
  onProgress?.({ sent, total: file.size });

  while (sent < file.size) {
    const end = Math.min(sent + chunkBytes, file.size);
    const response = await fetch(url, {
      method: "PATCH",
      signal,
      headers: {
        authorization,
        "tus-resumable": TUS,
        "upload-offset": String(sent),
        "content-type": "application/offset+octet-stream",
      },
      body: file.slice(sent, end),
    });
    if (response.status === 409 || response.status === 460) {
      /* Somebody else moved the offset — ask, do not assume. */
      const actual = await offsetOf(url);
      if (actual === null) { url = await create(); sent = 0; continue; }
      sent = actual;
      onProgress?.({ sent, total: file.size });
      continue;
    }
    if (response.status !== 204) {
      throw new UploadRefused(await refusalText(response, "a piece of the file was refused"), response.status);
    }
    const next = Number(response.headers.get("upload-offset"));
    sent = Number.isFinite(next) ? next : end;
    onProgress?.({ sent, total: file.size });
  }

  forget(key);
  return { objectName, bytes: file.size };
}

/* A small file — a page image, a frame — in one request. The tus dance costs
   two round trips it does not need, and these are a quarter of a megabyte. */
export async function putSmall({ supabaseUrl, bucket, objectName, body, accessToken, contentType }) {
  const url = `${String(supabaseUrl).replace(/\/+$/, "")}/storage/v1/object/${bucket}/${objectName
    .split("/").map(encodeURIComponent).join("/")}`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": contentType || "application/octet-stream",
      "cache-control": "3600",
      "x-upsert": "true",
    },
    body,
  });
  if (!response.ok) {
    throw new UploadRefused(await refusalText(response, "the prepared piece was refused"), response.status);
  }
  return { objectName, bytes: body.size ?? body.byteLength ?? 0 };
}

async function refusalText(response, fallback) {
  let detail = "";
  try {
    const text = await response.text();
    try { detail = JSON.parse(text).message || JSON.parse(text).error || text; }
    catch { detail = text; }
  } catch { /* the body is gone; the status is still worth saying */ }
  detail = String(detail || "").slice(0, 300).trim();
  if (response.status === 401 || response.status === 403) {
    return `storage refused this upload (${response.status}). Your sign-in may have expired, or this workspace does not allow you to add files.${detail ? ` It said: ${detail}` : ""}`;
  }
  if (response.status === 413) return "storage refused this upload as too large for the bucket.";
  return `${fallback} (${response.status})${detail ? `: ${detail}` : ""}`;
}
