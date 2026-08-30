-- 043 · How long it took.
--
-- The pipeline recorded that a capture was stitched, never how long the
-- stitching took. A processing record that cannot answer "is this fast
-- enough to do every week" is missing the number the whole automation
-- exists to earn — and the question a person holding a camera actually
-- asks before they agree to do this again.
--
-- Two stamps, set by the database rather than reported by the machine:
-- the machine cannot flatter its own timing, and the worker on EC2 needs
-- no change at all — it keeps patching state exactly as it does today.
--
-- They are kept apart on purpose. Waiting for a sleeping machine to wake
-- is not stitching, and rolling the two together would quietly turn a
-- cold start into a slow stitch.

alter table public.capture_360_jobs
  add column if not exists started_at timestamptz,
  add column if not exists finished_at timestamptz;

comment on column public.capture_360_jobs.started_at is
  'When the machine actually began this attempt. Queue time is created_at to started_at; stitch time is started_at to finished_at.';
comment on column public.capture_360_jobs.finished_at is
  'When this attempt ended, whether it completed or failed. Cleared when the job goes back to work.';

create or replace function public.stamp_capture_360_job_timing()
returns trigger
language plpgsql
as $$
begin
  if new.state = 'processing' and old.state is distinct from 'processing' then
    /* A retry is a new attempt, and its timing is its own: the stamps
       describe the attempt on screen, not the first one ever made. */
    new.started_at := now();
    new.finished_at := null;
  elsif new.state in ('completed', 'failed') and old.state not in ('completed', 'failed') then
    new.finished_at := now();
    /* A job that reached the end without ever being seen as processing —
       a fast machine, or a state that skipped ahead — still gets an honest
       start rather than a null that reads as "instant". */
    if new.started_at is null then new.started_at := old.updated_at; end if;
  end if;
  return new;
end;
$$;

comment on function public.stamp_capture_360_job_timing() is
  'Records when a stitch attempt started and ended. Set by the database so the machine cannot misreport its own timing.';

drop trigger if exists capture_360_jobs_timing on public.capture_360_jobs;
create trigger capture_360_jobs_timing
  before update on public.capture_360_jobs
  for each row execute function public.stamp_capture_360_job_timing();
