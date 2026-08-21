-- The 360 machine reports itself.
--
-- Eight machines were started before this table existed, and after every one of
-- them the only honest answer to "is it working?" was to fetch a log from S3 or
-- read a serial console. Meanwhile the Studio guessed: with nothing marked
-- 'processing' it said the machine was not running, which was a statement about
-- our database, not about the machine. Sometimes it was wrong, and a person
-- waited for a machine that had already stopped.
--
-- One row per boot. The machine writes it with the service role key; a Studio
-- member reads it. Nobody else may write, so a state shown here was reported by
-- the machine itself and by nothing else.

create table if not exists public.worker_machine_runs (
  id uuid primary key default gen_random_uuid(),
  instance_id text not null,
  region text,
  worker_version text,
  -- starting  : booted, still checking what it has
  -- preparing : fetching the SDK, building its image, testing itself
  -- working   : the queue is being worked
  -- finished  : the queue was worked to the end and the machine shut down
  -- stopped   : it refused to go on, and exit_code says at which gate
  state text not null default 'starting'
    check (state in ('starting','preparing','working','finished','stopped')),
  step text not null default 'Starting',
  exit_code integer,
  message text,
  log_url text,
  jobs_claimed integer not null default 0,
  jobs_completed integer not null default 0,
  jobs_failed integer not null default 0,
  started_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  finished_at timestamptz
);

create index if not exists worker_machine_runs_recent_idx
  on public.worker_machine_runs(started_at desc);

create or replace function public.is_studio_member()
returns boolean language sql stable security definer set search_path = public
as $$ select exists(select 1 from public.organization_members m where m.user_id = auth.uid()) $$;

alter table public.worker_machine_runs enable row level security;
drop policy if exists worker_machine_runs_read on public.worker_machine_runs;
-- The stitching machine is shared infrastructure, not a property's possession:
-- any Studio member may see whether it is awake. It carries no evidence and no
-- customer text, only its own state.
create policy worker_machine_runs_read on public.worker_machine_runs
  for select using (public.is_studio_member());
