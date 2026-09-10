/* READING ONE STORED OBJECT, AND NOTHING ELSE ABOUT STORAGE.
 *
 * The engine resolves material by the hash of its bytes; this is the one place
 * that turns a path the record already holds into those bytes. It takes a
 * path, it returns bytes, and it has no opinion about which path is allowed —
 * that decision was made when the packet was built, and widening it here would
 * be exactly the mistake the resolver boundary exists to prevent.
 *
 * The credential is the platform's own service-role key, which every Edge
 * Function is given. It never leaves this function: what the engine sends to a
 * provider is bytes, and `ResolvedMaterial` has nowhere to put a url.
 */
export const STORAGE_BUCKET = "property-evidence";

export async function readStoredObject(storagePath: string): Promise<Uint8Array> {
  const base = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!base || !key) throw new Error("core-v2: this deployment cannot read stored material");

  const bucket = storagePath.startsWith(`${STORAGE_BUCKET}/`) ? "" : `${STORAGE_BUCKET}/`;
  const url = `${base}/storage/v1/object/${bucket}${storagePath.split("/").map(encodeURIComponent).join("/")}`;
  const answer = await fetch(url, { headers: { authorization: `Bearer ${key}`, apikey: key } });
  if (!answer.ok) {
    /* The path is not repeated: a refusal names what failed, not where. */
    throw new Error(`core-v2: stored material could not be read (${answer.status})`);
  }
  return new Uint8Array(await answer.arrayBuffer());
}

/* A link the owner's browser may open, for one object, for a short while.
   Used only to show somebody the page or the frame a finding points at. */
export async function signedUrlFor(storagePath: string, seconds = 900): Promise<string | null> {
  const base = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!base || !key) return null;
  const path = storagePath.startsWith(`${STORAGE_BUCKET}/`) ? storagePath.slice(STORAGE_BUCKET.length + 1) : storagePath;
  const answer = await fetch(`${base}/storage/v1/object/sign/${STORAGE_BUCKET}/${path.split("/").map(encodeURIComponent).join("/")}`, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, apikey: key, "content-type": "application/json" },
    body: JSON.stringify({ expiresIn: seconds }),
  });
  if (!answer.ok) return null;
  const body = await answer.json() as { signedURL?: string };
  return body.signedURL ? `${base}/storage/v1${body.signedURL}` : null;
}
