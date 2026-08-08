-- Measured Decision AI: plan-first construction intelligence
-- Apply after the existing Studio migrations.

alter table public.properties
  add column if not exists workflow_state text not null default 'intake'
    check (workflow_state in ('intake', 'analyzing_plans', 'baseline_review', 'active', 'closed')),
  add column if not exists active_baseline_id uuid;

create table if not exists public.project_documents (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  property_id uuid not null references public.properties(id) on delete cascade,
  storage_path text not null unique,
  original_filename text not null,
  mime_type text not null default 'application/pdf',
  byte_size bigint,
  document_type text not null default 'other'
    check (document_type in (
      'architectural', 'structural', 'mechanical', 'electrical', 'plumbing',
      'civil', 'landscape', 'specification', 'schedule', 'permit',
      'addendum', 'change_order', 'other'
    )),
  revision_label text,
  issued_at date,
  status text not null default 'uploaded'
    check (status in ('uploaded', 'processing', 'ready', 'failed', 'superseded')),
  processing_error text,
  source_metadata jsonb not null default '{}'::jsonb,
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.plan_analysis_jobs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  property_id uuid not null references public.properties(id) on delete cascade,
  document_ids uuid[] not null,
  state text not null default 'queued'
    check (state in ('queued', 'processing', 'completed', 'failed', 'cancelled')),
  profile text not null default 'construction-plan-baseline',
  profile_version text not null default '1.0',
  provider text,
  model text,
  baseline_id uuid,
  error_code text,
  error_message text,
  requested_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz
);

create table if not exists public.document_baselines (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  property_id uuid not null references public.properties(id) on delete cascade,
  version integer not null,
  state text not null default 'draft'
    check (state in ('draft', 'review', 'approved', 'superseded', 'rejected')),
  source_document_ids uuid[] not null,
  project_summary text not null default '',
  analysis jsonb not null,
  gaps jsonb not null default '[]'::jsonb,
  model text,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  approved_by uuid references auth.users(id),
  approved_at timestamptz,
  unique (property_id, version)
);

alter table public.properties
  drop constraint if exists properties_active_baseline_id_fkey;
alter table public.properties
  add constraint properties_active_baseline_id_fkey
  foreign key (active_baseline_id) references public.document_baselines(id) on delete set null;

alter table public.plan_analysis_jobs
  drop constraint if exists plan_analysis_jobs_baseline_id_fkey;
alter table public.plan_analysis_jobs
  add constraint plan_analysis_jobs_baseline_id_fkey
  foreign key (baseline_id) references public.document_baselines(id) on delete set null;

create table if not exists public.plan_spaces (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  property_id uuid not null references public.properties(id) on delete cascade,
  baseline_id uuid not null references public.document_baselines(id) on delete cascade,
  building text not null,
  level text not null,
  name text not null,
  classification text not null default 'room',
  source_refs jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);

alter table public.spaces
  add column if not exists plan_space_id uuid references public.plan_spaces(id) on delete set null;
create unique index if not exists spaces_plan_space_unique
  on public.spaces(plan_space_id) where plan_space_id is not null;

create table if not exists public.construction_phases (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  property_id uuid not null references public.properties(id) on delete cascade,
  baseline_id uuid not null references public.document_baselines(id) on delete cascade,
  code text not null,
  name text not null,
  sequence integer not null,
  objective text not null,
  starts_when text not null,
  ends_when text not null,
  concealment_risk text not null,
  source_refs jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  unique (baseline_id, code),
  unique (baseline_id, sequence)
);

create table if not exists public.capture_requirements (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  property_id uuid not null references public.properties(id) on delete cascade,
  baseline_id uuid not null references public.document_baselines(id) on delete cascade,
  phase_id uuid not null references public.construction_phases(id) on delete cascade,
  plan_space_id uuid references public.plan_spaces(id) on delete set null,
  title text not null,
  system text not null,
  priority text not null check (priority in ('critical', 'high', 'normal')),
  capture_type text not null check (capture_type in ('360', 'photo', 'video', 'closeup', 'document')),
  rationale text not null,
  instructions jsonb not null default '[]'::jsonb,
  must_show jsonb not null default '[]'::jsonb,
  acceptance_criteria jsonb not null default '[]'::jsonb,
  before_concealment text not null,
  plan_refs jsonb not null default '[]'::jsonb,
  source_document_ids uuid[] not null default '{}'::uuid[],
  evidence_tags jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.capture_tasks (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  property_id uuid not null references public.properties(id) on delete cascade,
  baseline_id uuid not null references public.document_baselines(id) on delete cascade,
  requirement_id uuid not null unique references public.capture_requirements(id) on delete cascade,
  space_id uuid references public.spaces(id) on delete set null,
  status text not null default 'blocked'
    check (status in ('blocked', 'ready', 'in_progress', 'submitted', 'needs_more', 'verified', 'waived')),
  assigned_to uuid references auth.users(id),
  due_before timestamptz,
  submitted_at timestamptz,
  verified_at timestamptz,
  verified_by uuid references auth.users(id),
  reviewer_note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.evidence_items
  add column if not exists capture_task_id uuid references public.capture_tasks(id) on delete set null,
  add column if not exists baseline_id uuid references public.document_baselines(id) on delete set null;

create index if not exists project_documents_property_idx
  on public.project_documents(organization_id, property_id, created_at desc);
create index if not exists plan_jobs_property_idx
  on public.plan_analysis_jobs(organization_id, property_id, created_at desc);
create index if not exists baselines_property_idx
  on public.document_baselines(organization_id, property_id, version desc);
create index if not exists plan_spaces_baseline_idx on public.plan_spaces(baseline_id);
create index if not exists construction_phases_baseline_idx on public.construction_phases(baseline_id, sequence);
create index if not exists capture_requirements_baseline_idx on public.capture_requirements(baseline_id, phase_id);
create index if not exists capture_tasks_property_idx on public.capture_tasks(property_id, status);
create index if not exists evidence_capture_task_idx on public.evidence_items(capture_task_id);

alter table public.project_documents enable row level security;
alter table public.plan_analysis_jobs enable row level security;
alter table public.document_baselines enable row level security;
alter table public.plan_spaces enable row level security;
alter table public.construction_phases enable row level security;
alter table public.capture_requirements enable row level security;
alter table public.capture_tasks enable row level security;

drop policy if exists project_documents_read on public.project_documents;
create policy project_documents_read on public.project_documents for select
using (public.is_org_member(organization_id));

drop policy if exists project_documents_insert on public.project_documents;
create policy project_documents_insert on public.project_documents for insert
with check (
  created_by = auth.uid()
  and public.has_org_role(
    organization_id,
    array['owner','admin','contributor']::public.studio_role[]
  )
  and exists (
    select 1 from public.properties p
    where p.id = project_documents.property_id
      and p.organization_id = project_documents.organization_id
  )
);

drop policy if exists project_documents_delete on public.project_documents;
create policy project_documents_delete on public.project_documents for delete
using (public.has_org_role(
  organization_id,
  array['owner','admin']::public.studio_role[]
));

drop policy if exists plan_analysis_jobs_read on public.plan_analysis_jobs;
create policy plan_analysis_jobs_read on public.plan_analysis_jobs for select
using (public.is_org_member(organization_id));

drop policy if exists plan_analysis_jobs_insert on public.plan_analysis_jobs;
create policy plan_analysis_jobs_insert on public.plan_analysis_jobs for insert
with check (
  requested_by = auth.uid()
  and public.has_org_role(
    organization_id,
    array['owner','admin','reviewer','contributor']::public.studio_role[]
  )
  and exists (
    select 1 from public.properties p
    where p.id = plan_analysis_jobs.property_id
      and p.organization_id = plan_analysis_jobs.organization_id
  )
);

do $$
declare table_name text;
begin
  foreach table_name in array array[
    'document_baselines', 'plan_spaces', 'construction_phases',
    'capture_requirements', 'capture_tasks'
  ] loop
    execute format('drop policy if exists %I on public.%I', table_name || '_read', table_name);
    execute format(
      'create policy %I on public.%I for select using (public.is_org_member(organization_id))',
      table_name || '_read', table_name
    );
  end loop;
end $$;

-- Task mutations are intentionally server-owned. Field submissions use the
-- narrowly scoped link_evidence_to_capture_task RPC below.
drop policy if exists capture_tasks_update on public.capture_tasks;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('project-documents', 'project-documents', false, 524288000, array['application/pdf'])
on conflict (id) do update set
  public = false,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists project_document_objects_read on storage.objects;
create policy project_document_objects_read on storage.objects for select
using (
  bucket_id = 'project-documents'
  and exists (
    select 1 from public.organization_members m
    where m.organization_id::text = (storage.foldername(name))[1]
      and m.user_id = auth.uid()
  )
);

drop policy if exists project_document_objects_insert on storage.objects;
create policy project_document_objects_insert on storage.objects for insert
with check (
  bucket_id = 'project-documents'
  and exists (
    select 1 from public.organization_members m
    where m.organization_id::text = (storage.foldername(name))[1]
      and m.user_id = auth.uid() and m.role in ('owner', 'admin', 'contributor')
  )
);

drop policy if exists project_document_objects_delete on storage.objects;
create policy project_document_objects_delete on storage.objects for delete
using (
  bucket_id = 'project-documents'
  and exists (
    select 1 from public.organization_members m
    where m.organization_id::text = (storage.foldername(name))[1]
      and m.user_id = auth.uid() and m.role in ('owner', 'admin')
  )
);

create or replace function public.approve_document_baseline(target_baseline uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  baseline_record public.document_baselines%rowtype;
  actor_role public.studio_role;
begin
  select * into baseline_record
  from public.document_baselines
  where id = target_baseline
  for update;

  if baseline_record.id is null then
    raise exception 'Baseline not found';
  end if;

  select role into actor_role
  from public.organization_members
  where organization_id = baseline_record.organization_id
    and user_id = auth.uid();

  if actor_role is null or actor_role not in ('owner', 'admin', 'reviewer') then
    raise exception 'Not authorized to approve this baseline';
  end if;

  if baseline_record.state not in ('draft', 'review') then
    raise exception 'Only a draft or review baseline can be approved';
  end if;

  if jsonb_path_exists(baseline_record.gaps, '$[*] ? (@.blocks_activation == true)') then
    raise exception 'Resolve blocking plan gaps and generate a new baseline before approval';
  end if;

  update public.document_baselines
  set state = 'superseded'
  where property_id = baseline_record.property_id
    and state = 'approved'
    and id <> target_baseline;

  update public.document_baselines
  set state = 'approved', approved_by = auth.uid(), approved_at = now()
  where id = target_baseline;

  update public.spaces s
  set plan_space_id = ps.id
  from public.plan_spaces ps
  where ps.baseline_id = target_baseline
    and s.property_id = baseline_record.property_id
    and s.plan_space_id is null
    and lower(trim(s.name)) = lower(trim(ps.name))
    and lower(trim(coalesce(s.building, ''))) = lower(trim(ps.building))
    and lower(trim(coalesce(s.level, ''))) = lower(trim(ps.level));

  insert into public.spaces (
    organization_id, property_id, name, building, level,
    review_state, created_by, plan_space_id
  )
  select
    ps.organization_id, ps.property_id, ps.name, ps.building, ps.level,
    'needs_review', auth.uid(), ps.id
  from public.plan_spaces ps
  where ps.baseline_id = target_baseline
    and not exists (
      select 1 from public.spaces s where s.plan_space_id = ps.id
    );

  update public.capture_tasks task
  set status = 'ready',
      space_id = s.id,
      updated_at = now()
  from public.capture_requirements requirement
  left join public.spaces s on s.plan_space_id = requirement.plan_space_id
  where task.requirement_id = requirement.id
    and task.baseline_id = target_baseline
    and task.status = 'blocked';

  update public.properties
  set workflow_state = 'active', active_baseline_id = target_baseline, updated_at = now()
  where id = baseline_record.property_id;

  insert into public.audit_events (
    organization_id, actor_id, action, entity_type, entity_id, detail
  ) values (
    baseline_record.organization_id, auth.uid(), 'plan_baseline.approved',
    'document_baseline', target_baseline::text,
    jsonb_build_object('property_id', baseline_record.property_id, 'version', baseline_record.version)
  );

  return target_baseline;
end;
$$;

revoke all on function public.approve_document_baseline(uuid) from public;
grant execute on function public.approve_document_baseline(uuid) to authenticated;

create or replace function public.link_evidence_to_capture_task(
  target_task uuid,
  target_evidence uuid[]
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  task_record public.capture_tasks%rowtype;
  actor_role public.studio_role;
  linked_count integer;
begin
  if coalesce(array_length(target_evidence, 1), 0) = 0 then
    raise exception 'At least one evidence item is required';
  end if;

  select * into task_record
  from public.capture_tasks
  where id = target_task
  for update;

  if task_record.id is null then
    raise exception 'Capture task not found';
  end if;

  select role into actor_role
  from public.organization_members
  where organization_id = task_record.organization_id
    and user_id = auth.uid();

  if actor_role is null or actor_role not in ('owner', 'admin', 'reviewer', 'contributor') then
    raise exception 'Not authorized to submit evidence for this task';
  end if;

  update public.evidence_items evidence
  set capture_task_id = task_record.id,
      baseline_id = task_record.baseline_id
  where evidence.id = any(target_evidence)
    and evidence.organization_id = task_record.organization_id
    and evidence.property_id = task_record.property_id
    and (
      evidence.created_by = auth.uid()
      or actor_role in ('owner', 'admin', 'reviewer')
    );

  get diagnostics linked_count = row_count;
  if linked_count <> array_length(target_evidence, 1) then
    raise exception 'One or more evidence items do not belong to this task project';
  end if;

  update public.capture_tasks
  set status = 'submitted', submitted_at = now(), updated_at = now()
  where id = task_record.id;

  insert into public.audit_events (
    organization_id, actor_id, action, entity_type, entity_id, detail
  ) values (
    task_record.organization_id, auth.uid(), 'capture_task.submitted',
    'capture_task', task_record.id::text,
    jsonb_build_object('evidence_ids', target_evidence, 'baseline_id', task_record.baseline_id)
  );

  return linked_count;
end;
$$;

revoke all on function public.link_evidence_to_capture_task(uuid, uuid[]) from public;
grant execute on function public.link_evidence_to_capture_task(uuid, uuid[]) to authenticated;

comment on table public.document_baselines is
  'Human-governed interpretation of a specific immutable set of project documents.';
comment on table public.capture_requirements is
  'Plan-derived instructions describing exactly what evidence must be captured and why.';
comment on function public.approve_document_baseline(uuid) is
  'Approves one baseline, creates/links project spaces, and releases its capture tasks.';
comment on function public.link_evidence_to_capture_task(uuid, uuid[]) is
  'Atomically links uploaded evidence to one governed capture task without exposing general evidence updates.';
