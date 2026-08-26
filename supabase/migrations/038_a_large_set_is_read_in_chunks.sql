-- A large set is read in chunks.
--
-- One LLM context window was the quiet ceiling on project size: a plan set
-- over the provider's input limit simply could not be analyzed. The ceiling
-- comes off — not by trusting a bigger window, but by never relying on one:
-- the analysis job partitions the selected documents into chunks that each
-- fit, runs them as separate provider jobs, and checkpoints every finished
-- chunk here. A failure after chunk 3 of 5 resumes at chunk 4; the finished
-- readings are not re-bought and not re-invented.
--
-- Each row is one chunk's complete, parsed reading — an AI proposal like
-- every other reading in this product, merged deterministically into one
-- baseline that a person then reviews. The chunks are working state, written
-- only by the analysis worker (service role); the project's own people may
-- watch them, nobody may forge them.

create table if not exists public.plan_analysis_chunks (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.plan_analysis_jobs(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  chunk_index integer not null check (chunk_index >= 0),
  document_ids uuid[] not null,
  provider_job_id text,
  state text not null default 'pending'
    check (state in ('pending', 'processing', 'complete', 'failed')),
  analysis jsonb,
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (job_id, chunk_index)
);

comment on table public.plan_analysis_chunks is
  'Checkpointed chunks of a large plan analysis. Each row is one provider job''s parsed reading; a failed run resumes from the first non-complete chunk. Written only by the analysis worker.';

alter table public.plan_analysis_chunks enable row level security;

drop policy if exists plan_analysis_chunks_read on public.plan_analysis_chunks;
create policy plan_analysis_chunks_read on public.plan_analysis_chunks for select
using (public.is_org_member(organization_id));

-- No insert/update/delete policies on purpose: chunks are the worker's
-- working state, written through the service role only.
