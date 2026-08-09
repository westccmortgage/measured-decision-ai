-- Make long plan-set analysis resumable and observable instead of holding one
-- browser request open until the model finishes.

alter table public.plan_analysis_jobs
  add column if not exists provider_job_id text,
  add column if not exists progress_stage text not null default 'queued',
  add column if not exists progress_percent smallint not null default 0
    check (progress_percent between 0 and 100),
  add column if not exists last_heartbeat_at timestamptz;

create unique index if not exists plan_analysis_provider_job_unique
  on public.plan_analysis_jobs(provider, provider_job_id)
  where provider_job_id is not null;

create index if not exists plan_analysis_active_jobs_idx
  on public.plan_analysis_jobs(property_id, state, created_at desc)
  where state in ('queued', 'processing');

comment on column public.plan_analysis_jobs.provider_job_id is
  'Opaque asynchronous job identifier issued by the model provider.';
comment on column public.plan_analysis_jobs.progress_stage is
  'Coarse, honest workflow stage for Studio polling; never treated as proof of completion.';
