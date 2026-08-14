create table if not exists public.capture_360_groups (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  property_id uuid not null references public.properties(id) on delete cascade,
  space_id uuid not null references public.spaces(id) on delete cascade,
  project_intake_access_id uuid references public.project_intake_access(id) on delete set null,
  capture_key text not null,
  camera_format text not null default 'insta360-dual-insv',
  expected_source_count integer not null default 2 check (expected_source_count between 1 and 4),
  source_evidence_ids uuid[] not null default '{}',
  state text not null default 'waiting_for_pair' check (state in ('waiting_for_pair','ready','queued','stitching','vr_ready','failed')),
  processing_profile jsonb not null default '{"projection":"equirectangular","aspect_ratio":"2:1","video_codec":"hevc","stabilization":"flowstate","vr_target":"apple-projected-media"}'::jsonb,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique (property_id, capture_key)
);

create table if not exists public.capture_360_jobs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  property_id uuid not null references public.properties(id) on delete cascade,
  capture_group_id uuid not null unique references public.capture_360_groups(id) on delete cascade,
  state text not null default 'waiting_for_sdk' check (state in ('waiting_for_sdk','queued','processing','completed','failed')),
  progress integer not null default 0 check (progress between 0 and 100),
  stage text not null default 'Originals received',
  output_manifest jsonb not null default '{}'::jsonb,
  error_code text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);

create index if not exists capture_360_groups_property_idx on public.capture_360_groups(property_id,state,created_at);
create index if not exists capture_360_jobs_property_idx on public.capture_360_jobs(property_id,state,created_at);
alter table public.capture_360_groups enable row level security;
alter table public.capture_360_jobs enable row level security;
drop policy if exists capture_360_groups_member_read on public.capture_360_groups;
create policy capture_360_groups_member_read on public.capture_360_groups for select using(public.is_org_member(organization_id));
drop policy if exists capture_360_jobs_member_read on public.capture_360_jobs;
create policy capture_360_jobs_member_read on public.capture_360_jobs for select using(public.is_org_member(organization_id));

create or replace function public.reconcile_insta360_capture(p_evidence_id uuid)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_evidence public.evidence_items%rowtype;
  v_filename text;
  v_capture_key text;
  v_group_id uuid;
  v_source_ids uuid[];
begin
  select * into v_evidence from public.evidence_items where id = p_evidence_id;
  if not found then raise exception 'Evidence source not found'; end if;
  v_filename := lower(v_evidence.original_filename);
  if v_filename !~ '\.insv$' then return null; end if;
  v_capture_key := regexp_replace(v_filename, '_(00|10)_([0-9]+)\.insv$', '_\2');
  if v_capture_key = v_filename then v_capture_key := regexp_replace(v_filename, '\.insv$', ''); end if;

  insert into public.capture_360_groups(organization_id,property_id,space_id,project_intake_access_id,capture_key)
  values(v_evidence.organization_id,v_evidence.property_id,v_evidence.space_id,v_evidence.project_intake_access_id,v_capture_key)
  on conflict(property_id,capture_key) do update set updated_at=now()
  returning id into v_group_id;

  select array_agg(e.id order by e.original_filename) into v_source_ids
  from public.evidence_items e
  where e.property_id=v_evidence.property_id and lower(e.original_filename) ~ '\.insv$'
    and regexp_replace(lower(e.original_filename), '_(00|10)_([0-9]+)\.insv$', '_\2')=v_capture_key;

  update public.capture_360_groups set source_evidence_ids=coalesce(v_source_ids,array[p_evidence_id]),
    state=case when cardinality(coalesce(v_source_ids,array[p_evidence_id]))>=expected_source_count then 'ready' else 'waiting_for_pair' end,
    updated_at=now() where id=v_group_id;

  if cardinality(coalesce(v_source_ids,array[p_evidence_id]))>=2 then
    insert into public.capture_360_jobs(organization_id,property_id,capture_group_id,state,progress,stage)
    values(v_evidence.organization_id,v_evidence.property_id,v_group_id,'waiting_for_sdk',5,'Original pair verified')
    on conflict(capture_group_id) do update set stage='Original pair verified',progress=greatest(public.capture_360_jobs.progress,5),updated_at=now();
  end if;
  return v_group_id;
end; $$;

revoke all on function public.reconcile_insta360_capture(uuid) from public, anon, authenticated;
