-- 056 · What each reading actually carried.
--
-- Three readers now read one plan set, and the whole point of comparing them
-- is that they were shown the same drawings. "The same" was, until now, a
-- property of the code: the same budget, the same order, the same gatherer.
-- Code can be right and still be believed for the wrong reason, and a
-- comparison resting on an assumption is a comparison resting on nothing.
--
-- So every reading records the digest of the pages and enlargements it
-- actually sent, and how many there were. Two readings carried the same kit
-- if and only if these match — a fact about the record, checkable long after
-- the run, rather than a claim about the source.
--
-- The digest is taken over document ids and tile names in the order they
-- were sent. Signed URLs are deliberately not part of it: they differ on
-- every call and say nothing about what was shown.

alter table public.plan_analysis_chunks
  add column if not exists image_fingerprint text,
  add column if not exists images_sent integer;

alter table public.plan_analysis_jobs
  add column if not exists image_fingerprint text,
  add column if not exists images_sent integer;

comment on column public.plan_analysis_chunks.image_fingerprint is
  'Digest of the documents and enlargements this chunk''s request actually carried, in order. Two readings are comparable only if theirs match.';
comment on column public.plan_analysis_chunks.images_sent is
  'How many enlargements this chunk''s request carried.';
comment on column public.plan_analysis_jobs.image_fingerprint is
  'Digest of the documents and enlargements a single-request reading actually carried. A chunked reading''s digest is its chunks'' digests in order, kept on the baseline.';
