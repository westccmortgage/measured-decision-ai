/* Two files uploaded into Hallway 200A, then: "This room is empty."

   The upload was resumable, and a stored session was matched on organization,
   property, filename, size and modified date — never on the room. A file that
   had already been uploaded to another room therefore matched its earlier
   session, resumed it, and handed back that first record. The screen counted a
   successful upload and the project total went up, while the room the person
   had actually chosen received nothing.

   The room is part of what identifies a session. */
import fs from "fs";
const src = fs.readFileSync("studio/s3-upload.js", "utf8");

const i = src.indexOf("function fingerprint(");
if (i < 0) throw new Error("missing fingerprint");
let depth = 0;
let body;
for (let k = src.indexOf("{", i); k < src.length; k++) {
  if (src[k] === "{") depth++;
  else if (src[k] === "}") { depth--; if (!depth) { body = src.slice(i, k + 1); break; } }
}
const { fingerprint } = await import(
  "data:text/javascript," + encodeURIComponent(`export ${body}`)
);

const file = { name: "IMG_0421.insv", size: 4_182_003_712, lastModified: 1724544000000 };
const org = "0f4d2a2e-7c1a-4a1e-9d0e-2b7c6f9a1111";
const property = "9a1c3b55-2d4e-4f6a-8b0c-1e2f3a4b5c6d";
const hallway200A = "3c8e1f22-5b7a-4c9d-8e1f-6a2b3c4d5e6f";
const livingRoom103 = "77b0d9c4-1a2b-4c3d-9e8f-0a1b2c3d4e5f";

const key = (spaceId) => fingerprint("evidence", org, property, spaceId, file, null, null, null);

let failures = 0;
const check = (label, condition) => {
  if (condition) return;
  failures += 1;
  console.log(`FINDING ${label}`);
};

// The bug, stated directly: the same file offered to a second room must not
// resume the first room's upload.
check(
  "the same file in a different room is a different upload",
  key(hallway200A) !== key(livingRoom103),
);

// Resuming is the point of the key — an interrupted upload of the same file to
// the same room still has to find its session again.
check(
  "the same file in the same room still resumes",
  key(hallway200A) === key(hallway200A),
);

// A key that ignored the room would be the key that shipped the bug.
check(
  "the room appears in the key",
  key(hallway200A).includes(hallway200A),
);

// Sessions stored under the old room-blind key must never be matched by the new
// one, or the first upload after this fix resumes into the wrong room.
check(
  "keys written before the fix cannot be resumed",
  key(hallway200A).startsWith("mdai-s3-upload-v4:"),
);

// A document upload carries no room. It still needs a stable, distinct key.
check(
  "an unfiled upload still has a key",
  key(null) === key(undefined) && key(null) !== key(hallway200A),
);

/* The checks above all call fingerprint() directly, so they prove the function
   is right and prove nothing about whether the room ever reaches it. Drop the
   argument at the call site and every one of them still passes while the bug is
   back: `file` slides into the spaceId position, the key stays unique per file,
   and uploads silently go room-blind again.
   So the call site is asserted too, against the shipping source. */
const call = src.match(/const storageKey\s*=\s*fingerprint\(([^)]*)\)/);
check("the uploader passes a room into the key", Boolean(call));
if (call) {
  const args = call[1].split(",").map((part) => part.trim());
  check(
    "and passes it in the position the key reads it from",
    args[3] === "spaceId",
    );
  check(
    "with the file after it, not in its place",
    args[4] === "file",
  );
}

console.log(failures ? `${failures} FINDING(S)` : "ALL OK");
process.exit(failures ? 1 : 0);
