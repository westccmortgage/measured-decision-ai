-- Measured Decision AI: customer-facing, multi-room 360 capture sessions.
-- Originals remain immutable in S3. Trim decisions and processed derivatives are
-- separate governed records so the source evidence is never overwritten.

create table if not exists public.capture_sessions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  property_id uuid not null references public.properties(id) on delete cascade,
  default_space_id uuid not null references public.spaces(id) on delete restrict,
  label text not null default 'Room capture session',
  recipient_name text not null,
  recipient_email text not null,
  status text not null default 'sent'
    check (status in (
      'sent', 'opened', 'uploading', 'reviewing', 'submitted',
      'processing', 'ready_for_review', 'completed', 'needs_attention',
      'revoked', 'expired'
    )),
  token_hash text not null unique,
  email_delivery_state text not null default 'pending'
    check (email_delivery_state in ('pending', 'sent', 'not_configured', 'failed')),
  email_message_id text,
  email_delivery_error text,
  expires_at timestamptz not null default (now() + interval '14 days'),
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  opened_at timestamptz,
  submitted_at timestamptz,
  completed_at timestamptz
);

alter table public.object_uploads
  add column if not exists capture_session_id uuid references public.capture_sessions(id) on delete set null;

alter table public.evidence_items
  add column if not exists capture_session_id uuid references public.capture_sessions(id) on delete set null;

create table if not exists public.capture_session_items (
  id uuid primary key references public.evidence_items(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  property_id uuid not null references public.properties(id) on delete cascade,
  session_id uuid not null references public.capture_sessions(id) on delete cascade,
  room_name text,
  item_order integer not null default 0,
  state text not null default 'uploaded'
    check (state in ('uploaded', 'trim_review', 'approved', 'submitted', 'processing', 'ready', 'failed')),
  source_duration_seconds numeric,
  source_width integer,
  source_height integer,
  projection text not null default 'unknown'
    check (projection in ('equirectangular', 'rectilinear', 'unknown')),
  suggested_trim_start_seconds numeric,
  suggested_trim_end_seconds numeric,
  trim_suggestion_source text not null default 'guard_band'
    check (trim_suggestion_source in ('guard_band', 'presence_detection', 'manual')),
  confirmed_trim_start_seconds numeric,
  confirmed_trim_end_seconds numeric,
  trim_confirmed boolean not null default false,
  quality_result jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint capture_session_items_duration_check check (
    source_duration_seconds is null or source_duration_seconds > 0
  ),
  constraint capture_session_items_trim_check check (
    confirmed_trim_start_seconds is null
    or confirmed_trim_end_seconds is null
    or confirmed_trim_end_seconds > confirmed_trim_start_seconds
  )
);

create table if not exists public.capture_processing_jobs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  property_id uuid not null references public.properties(id) on delete cascade,
  session_id uuid not null references public.capture_sessions(id) on delete cascade,
  item_id uuid not null references public.capture_session_items(id) on delete cascade,
  source_evidence_id uuid not null references public.evidence_items(id) on delete cascade,
  output_evidence_id uuid references public.evidence_items(id) on delete set null,
  operation text not null default 'trim_360' check (operation = 'trim_360'),
  state text not null default 'queued'
    check (state in ('queued', 'processing', 'completed', 'failed', 'cancelled')),
  parameters jsonb not null,
  provider text,
  provider_job_id text,
  error_code text,
  error_message text,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz,
  unique (item_id, operation)
);

create index if not exists capture_sessions_project_status_idx
  on public.capture_sessions(organization_id, property_id, status, updated_at desc);
create index if not exists capture_session_items_session_idx
  on public.capture_session_items(session_id, item_order, created_at);
create index if not exists capture_processing_jobs_queue_idx
  on public.capture_processing_jobs(state, created_at);
create index if not exists evidence_capture_session_idx
  on public.evidence_items(capture_session_id);
create index if not exists object_uploads_capture_session_idx
  on public.object_uploads(capture_session_id);

alter table public.capture_sessions enable row level security;
alter table public.capture_session_items enable row level security;
alter table public.capture_processing_jobs enable row level security;

drop policy if exists capture_sessions_read on public.capture_sessions;
create policy capture_sessions_read on public.capture_sessions for select
using (public.is_org_member(organization_id));

drop policy if exists capture_session_items_read on public.capture_session_items;
create policy capture_session_items_read on public.capture_session_items for select
using (public.is_org_member(organization_id));

drop policy if exists capture_processing_jobs_read on public.capture_processing_jobs;
create policy capture_processing_jobs_read on public.capture_processing_jobs for select
using (public.is_org_member(organization_id));

comment on table public.capture_sessions is
  'One secure customer link for a multi-room capture visit. Guests use the capture-session Edge Function.';
comment on table public.capture_session_items is
  'Room label, source geometry, and human-confirmed trim decision for one immutable source evidence item.';
comment on table public.capture_processing_jobs is
  'Server-owned derivative queue. A completed job points to a new evidence row and never overwrites its source.';
comment on column public.capture_session_items.trim_suggestion_source is
  'guard_band is a deterministic first/last-seconds proposal, not AI person detection.';

-- These two service-role RPCs keep the guest workflow transactional. The Edge
-- Function authenticates the session token; PostgreSQL then commits each human
-- confirmation and the final queue handoff as one database operation.
create or replace function public.confirm_capture_session_item(
  p_session_id uuid,
  p_item_id uuid,
  p_room_name text,
  p_trim_start_seconds numeric,
  p_trim_end_seconds numeric,
  p_source_metadata_patch jsonb
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_item public.capture_session_items%rowtype;
begin
  select * into v_item
  from public.capture_session_items
  where id = p_item_id and session_id = p_session_id
  for update;

  if not found then raise exception 'Capture item not found'; end if;
  if nullif(btrim(p_room_name), '') is null then raise exception 'Room name is required'; end if;
  if p_trim_start_seconds < 0 or p_trim_end_seconds <= p_trim_start_seconds then
    raise exception 'A valid trim range is required';
  end if;
  if v_item.source_duration_seconds is not null
     and p_trim_end_seconds > v_item.source_duration_seconds + 0.05 then
    raise exception 'Trim end exceeds the source duration';
  end if;

  update public.evidence_items
  set source_metadata = coalesce(source_metadata, '{}'::jsonb) || coalesce(p_source_metadata_patch, '{}'::jsonb)
  where id = p_item_id and capture_session_id = p_session_id;
  if not found then raise exception 'Source evidence not found'; end if;

  update public.capture_session_items
  set room_name = btrim(p_room_name),
      confirmed_trim_start_seconds = p_trim_start_seconds,
      confirmed_trim_end_seconds = p_trim_end_seconds,
      trim_confirmed = true,
      state = 'approved',
      updated_at = now()
  where id = p_item_id and session_id = p_session_id;
end;
$$;

create or replace function public.enqueue_capture_session(p_session_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_session public.capture_sessions%rowtype;
  v_item_count integer;
begin
  select * into v_session
  from public.capture_sessions
  where id = p_session_id
  for update;

  if not found then raise exception 'Capture session not found'; end if;
  if v_session.status in ('submitted', 'processing', 'ready_for_review', 'completed') then
    raise exception 'This capture session has already been submitted';
  end if;
  if v_session.status in ('revoked', 'expired') then raise exception 'This capture session is no longer active'; end if;

  select count(*) into v_item_count
  from public.capture_session_items
  where session_id = p_session_id;
  if v_item_count = 0 then raise exception 'Upload at least one 360 room video before submitting'; end if;

  if exists (
    select 1 from public.capture_session_items
    where session_id = p_session_id and (nullif(btrim(room_name), '') is null or not trim_confirmed)
  ) then raise exception 'Every video requires a confirmed room name and trim range'; end if;

  if exists (
    select 1 from public.capture_session_items
    where session_id = p_session_id and projection <> 'equirectangular'
  ) then raise exception 'Every video must be confirmed as 2:1 equirectangular 360'; end if;

  insert into public.capture_processing_jobs (
    organization_id, property_id, session_id, item_id, source_evidence_id, parameters
  )
  select
    v_session.organization_id,
    v_session.property_id,
    p_session_id,
    item.id,
    item.id,
    jsonb_build_object(
      'trim_start_seconds', item.confirmed_trim_start_seconds,
      'trim_end_seconds', item.confirmed_trim_end_seconds,
      'room_name', item.room_name,
      'preserve_projection', item.projection,
      'source_immutable', true
    )
  from public.capture_session_items item
  where item.session_id = p_session_id
  on conflict (item_id, operation) do nothing;

  update public.capture_session_items
  set state = 'submitted', updated_at = now()
  where session_id = p_session_id;

  update public.capture_sessions
  set status = 'submitted', submitted_at = now(), updated_at = now()
  where id = p_session_id;

  insert into public.audit_events (organization_id, action, entity_type, entity_id, detail)
  values (
    v_session.organization_id,
    'capture_session.submitted',
    'capture_sessions',
    p_session_id::text,
    jsonb_build_object('item_count', v_item_count)
  );

  return v_item_count;
end;
$$;

revoke all on function public.confirm_capture_session_item(uuid, uuid, text, numeric, numeric, jsonb) from public, anon, authenticated;
revoke all on function public.enqueue_capture_session(uuid) from public, anon, authenticated;
grant execute on function public.confirm_capture_session_item(uuid, uuid, text, numeric, numeric, jsonb) to service_role;
grant execute on function public.enqueue_capture_session(uuid) to service_role;
