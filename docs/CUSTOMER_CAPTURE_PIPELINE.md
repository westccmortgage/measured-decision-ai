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

## Storage split

- S3 stores MP4 originals and later derivatives.
- Supabase stores sessions, room labels, geometry, trim decisions, processing state, and provenance.
- Signed URLs expire and are never stored as evidence.

## Processing boundary

`capture_processing_jobs` is the durable queue for the media processor. The processor must:

1. verify the real stream geometry and codec server-side;
2. trim at the confirmed timestamps without changing the 360 projection;
3. create a derivative object under the same organization and property prefix;
4. insert a new `evidence_items` row with `derivative_of` set to the source;
5. run capture quality checks and update the job and session state;
6. route the result to a named human reviewer.

The queue is intentionally separate from the upload request so a multi-gigabyte upload is not coupled to a long-running transcoder.
