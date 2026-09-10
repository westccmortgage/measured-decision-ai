-- ═══════════════════════════════════════════════════════════════════════════
-- 066 · ONE COLUMN THAT ENDED UP WITH TWO NAMES, AND THE ONE WAY TO FIX IT
--
-- WHAT HAPPENED. 063 created `analysis_files.content_sha256`. A later commit
-- renamed that line inside 063 to `content_fingerprint` — the better name,
-- because the value is not always a SHA-256 — but 063 had ALREADY BEEN
-- APPLIED to a preview database. A migration file is not the schema; it is
-- the instruction that produced the schema, and editing one after it has run
-- changes only what a FUTURE database will be built from.
--
-- So there are now two real databases that disagree: the one that ran 063
-- before the edit has `content_sha256`, and the one that ran it after has
-- `content_fingerprint`. The page selects the second name and the first
-- database answers "column does not exist", which is exactly how this was
-- found — a real upload, on a real deployment, refusing.
--
-- WHY THE FIX IS A NEW MIGRATION AND NOT ANOTHER EDIT. Editing 063 again
-- would repeat the mistake and would not touch either existing database.
-- Only a migration of its own runs everywhere: on the database that is
-- behind it renames the column, and on the database that is already right —
-- and on every database built fresh from the files — it does nothing at all.
--
-- It is written so that running it twice is the same as running it once, and
-- so that it never destroys a value: a rename keeps the rows.
-- ═══════════════════════════════════════════════════════════════════════════

do $$
begin
  if to_regclass('public.analysis_files') is null then
    return;
  end if;

  -- The database that is behind: it has the old name and not the new one.
  if exists (
        select 1 from information_schema.columns
         where table_schema = 'public' and table_name = 'analysis_files'
           and column_name = 'content_sha256')
     and not exists (
        select 1 from information_schema.columns
         where table_schema = 'public' and table_name = 'analysis_files'
           and column_name = 'content_fingerprint')
  then
    alter table public.analysis_files rename column content_sha256 to content_fingerprint;
  end if;
end $$;

comment on column public.analysis_files.content_fingerprint is
  'Whatever this deployment could compute over the uploaded bytes to tell one file from another. Named for what it is rather than for one algorithm: a browser that cannot reach SubtleCrypto records a different kind of fingerprint, and a column called content_sha256 would then be lying.';
