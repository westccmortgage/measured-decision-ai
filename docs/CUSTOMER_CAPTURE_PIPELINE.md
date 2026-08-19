# Customer 360 capture pipeline

This is the production intake contract for a person who does not have a Studio account.

## Customer flow

1. A project manager opens **Field operations** and creates a room capture session.
2. The customer receives a private, expiring link by email. Only the token hash is stored.
3. The customer selects up to 100 full-360 MP4 files. Uploads go directly to private S3 through resumable multipart URLs; the browser never receives AWS credentials.
4. For every file, the browser reads duration and frame dimensions. A file must be approximately 2:1 to be submitted as equirectangular 360.
5. The customer enters a room name, plays or scrubs the source, marks the first and last clean frame, and confirms the range.
6. Submission creates one server-owned processing job per source.

## Evidence rules

- The uploaded S3 object is the immutable source evidence.
- Trimming never overwrites the source. A processor creates a new derivative evidence object and links it to the source.
- The first trim range is only a deterministic guard-band suggestion. It is not presented as person detection.
- The uploader must confirm the room name and range before submission.
- Wrongly selected files may be removed only before submission.
- After submission the guest link is read-only; managers can revoke an active link.

## Camera handling window

A 360 walkthrough is filmed with nobody holding the camera: the operator starts
the recording, walks out of the space, and walks back in to stop it. Those
seconds are the operator, not the object.

One policy decides the usable window and every consumer reads it
(`studio/trim360.js`, mirrored in `workers/insta360/worker.py`):

- ten seconds off the head and the tail by default;
- five seconds when ten would not leave enough footage;
- no trim at all when fewer than fifteen seconds would remain — a short capture
  keeps every second of itself.

The window is recorded on the evidence as `source_metadata.trim` at upload and
is never cut out of an uploaded original. The AI reads keyframes only from
inside the window, and the viewer opens, scrubs and loops inside it; one button
plays the untouched original. A capture uploaded before the policy existed
carries no window, so the policy is applied to the stream at playback.

The GPU master is the exception, because it is a file this system creates and
other players open: the worker cuts it with a stream copy (no re-encode) and
records `trim.mode = "cut_at_processing"`, which tells the viewer the file is
already clean and must not be trimmed twice. If the cut cannot be made, the
whole master is published with the window recorded instead.

## Storage split

- S3 stores MP4 originals and later derivatives.
- Supabase stores sessions, room labels, geometry, trim decisions, processing state, and provenance.
- Signed URLs expire and are never stored as evidence.

## Processing boundary

### Serverless MVP path

For the initial demonstration release, Insta360 Studio performs the licensed
stitching step on the operator's Mac. Export a full 2:1 equirectangular MP4 at
the source resolution and keep the camera filename. Uploading that MP4 causes
Studio to register it as the capture's VR master immediately; no persistent EC2
worker is required. The protected INSV files remain the immutable originals.

The GPU worker remains an optional scale path for later unattended batch
stitching. It is not a dependency for creating or demonstrating a project.

`capture_processing_jobs` is the durable queue for the media processor. The processor must:

1. verify the real stream geometry and codec server-side;
2. trim at the confirmed timestamps without changing the 360 projection;
3. create a derivative object under the same organization and property prefix;
4. insert a new `evidence_items` row with `derivative_of` set to the source;
5. run capture quality checks and update the job and session state;
6. route the result to a named human reviewer.

The queue is intentionally separate from the upload request so a multi-gigabyte upload is not coupled to a long-running transcoder.
