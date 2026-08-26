-- A PDF declares itself.
--
-- The router had one stub left: an undeclared PDF was promised "per-page
-- classification downstream" with nothing downstream. This migration gives
-- the classification a place to live:
--
--   1. project_documents.page_classification — the AI's page-by-page reading
--      of what the file contains, stored beside the document it describes.
--      It is a reading, never a fact: the UI wears it as "Read by AI · not
--      confirmed", and nothing in the takeoff or the order sheets consumes
--      it as truth. The original file is never altered.
--
--   2. intelligence_jobs gains the 'routing' channel, so a classification
--      run is a governed, auditable job like every other channel's work —
--      not an invisible side effect.
--
-- The classifier itself is the document-classify edge function. It may also
-- settle document_type when the whole file is uniformly delivery paperwork
-- and the type was 'other' — a routing correction on metadata, still never
-- a construction fact.

alter table public.project_documents
  add column if not exists page_classification jsonb;

comment on column public.project_documents.page_classification is
  'AI page-by-page reading of an undeclared PDF: {contract, classified_at, pages:[{page_number, kind, note}]}. Read by AI · not confirmed; routing metadata, never a construction fact.';

alter table public.intelligence_jobs drop constraint if exists intelligence_jobs_channel_check;
alter table public.intelligence_jobs add constraint intelligence_jobs_channel_check
  check (channel in ('technical', 'visual', 'documents', 'reconciliation', 'routing'));
