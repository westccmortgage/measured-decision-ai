-- Every attempt to wake the 360 machine, and what came of it.
--
-- The machine stops itself when the queue empties, which is right. Starting it
-- again was a person opening the AWS console, and that person was the reason
-- the product felt unfinished: a capture uploaded at midnight waited until
-- somebody remembered it. Now the queue itself asks for the machine.
--
-- A thing that can spend money on its own has to be watchable, so every attempt
-- lands here whether it started anything or not — including the refusals. A
-- machine that woke nine times in an hour is a bill, and this is where that is
-- visible before it is a surprise.

create table if not exists public.machine_wake_events (
  id uuid primary key default gen_random_uuid(),
  -- upload      : a capture arrived and created work
  -- person      : somebody pressed the button in Studio
  -- schedule    : a periodic check found work waiting
  requested_by_kind text not null
    check (requested_by_kind in ('upload', 'person', 'schedule')),
  requested_by uuid references auth.users(id),
  instance_id text,
  -- started        : the instance was stopped and is now starting
  -- already_awake  : nothing to do, it is running
  -- nothing_queued : refused, because there was no work to justify the cost
  -- too_soon       : refused, because one was started moments ago
  -- not_configured : this deployment has no machine to start
  -- failed         : AWS refused
  outcome text not null
    check (outcome in ('started', 'already_awake', 'nothing_queued', 'too_soon', 'not_configured', 'failed')),
  queued_jobs integer not null default 0,
  detail text,
  created_at timestamptz not null default now()
);

create index if not exists machine_wake_events_recent_idx
  on public.machine_wake_events(created_at desc);

alter table public.machine_wake_events enable row level security;

-- Readable by anybody who can see the Studio at all: the machine is shared
-- infrastructure, not one organisation's property, exactly like
-- worker_machine_runs. Only the service role writes.
drop policy if exists machine_wake_events_read on public.machine_wake_events;
create policy machine_wake_events_read on public.machine_wake_events
  for select using (public.is_studio_member());

comment on table public.machine_wake_events is
  'Every request to start the 360 machine and its outcome, refusals included. A machine that can spend money on its own has to be watchable.';
