-- Measured Decision AI: secure field assignments, automated capture QC,
-- and governed Vision release hardening.

create table if not exists public.field_assignments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  property_id uuid not null references public.properties(id) on delete cascade,
  baseline_id uuid not null references public.document_baselines(id) on delete cascade,
  capture_task_id uuid not null references public.capture_tasks(id) on delete cascade,
  requirement_id uuid not null references public.capture_requirements(id) on delete cascade,
  space_id uuid references public.spaces(id) on delete set null,
  worker_name text not null,
  worker_email text not null,
  status text not null default 'sent'
    check (status in (
      'sent', 'opened', 'in_progress', 'uploading', 'submitted', 'ai_check',
      'ready_for_review', 'retake', 'completed', 'revoked', 'expired'
    )),
  token_hash text not null unique,
  instructions_snapshot jsonb not null,
  due_at timestamptz,
  expires_at timestamptz not null default (now() + interval '14 days'),
  email_delivery_state text not null default 'pending'
    check (email_delivery_state in ('pending', 'sent', 'not_configured', 'failed')),
  email_message_id text,
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  sent_at timestamptz,
  opened_at timestamptz,
  started_at timestamptz,
  submitted_at timestamptz,
  completed_at timestamptz
);

create table if not exists public.field_assignment_events (
  id bigint generated always as identity primary key,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  assignment_id uuid not null references public.field_assignments(id) on delete cascade,
  event_type text not null,
  actor_id uuid references auth.users(id),
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.field_quality_checks (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  property_id uuid not null references public.properties(id) on delete cascade,
  assignment_id uuid not null references public.field_assignments(id) on delete cascade,
  capture_task_id uuid not null references public.capture_tasks(id) on delete cascade,
  evidence_ids uuid[] not null,
  state text not null default 'queued'
    check (state in ('queued', 'processing', 'passed', 'retake', 'needs_review', 'failed')),
  result jsonb not null default '{}'::jsonb,
  provider text,
  model text,
  agent_key text not null default 'field_qc',
  agent_contract_version text not null default '2026-08-09.1',
  created_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz
);

alter table public.object_uploads
  add column if not exists field_assignment_id uuid references public.field_assignments(id) on delete set null;

alter table public.evidence_items
  add column if not exists field_assignment_id uuid references public.field_assignments(id) on delete set null;

alter table public.project_documents
  add column if not exists capture_task_id uuid references public.capture_tasks(id) on delete set null,
  add column if not exists baseline_id uuid references public.document_baselines(id) on delete set null,
  add column if not exists field_assignment_id uuid references public.field_assignments(id) on delete set null;

alter table public.vision_releases
  add column if not exists baseline_id uuid references public.document_baselines(id) on delete set null,
  add column if not exists agent_key text not null default 'verification_guard',
  add column if not exists agent_contract_version text not null default '2026-08-09.1',
  add column if not exists revoked_by uuid references auth.users(id),
  add column if not exists revoked_at timestamptz;

alter table public.analysis_jobs
  alter column agent_contract_version set default '2026-08-09.1';
alter table public.ai_suggestions
  alter column agent_contract_version set default '2026-08-09.1';
alter table public.plan_analysis_jobs
  alter column agent_contract_version set default '2026-08-09.1';
alter table public.document_baselines
  alter column agent_contract_version set default '2026-08-09.1';

create index if not exists field_assignments_project_status_idx
  on public.field_assignments(organization_id, property_id, status, updated_at desc);
create index if not exists field_assignments_task_idx
  on public.field_assignments(capture_task_id, created_at desc);
create index if not exists field_assignment_events_assignment_idx
  on public.field_assignment_events(assignment_id, created_at desc);
create index if not exists field_quality_checks_assignment_idx
  on public.field_quality_checks(assignment_id, created_at desc);
create index if not exists evidence_field_assignment_idx
  on public.evidence_items(field_assignment_id);
create index if not exists project_documents_field_assignment_idx
  on public.project_documents(field_assignment_id);
create index if not exists vision_releases_property_state_idx
  on public.vision_releases(property_id, state, version desc);

alter table public.field_assignments enable row level security;
alter table public.field_assignment_events enable row level security;
alter table public.field_quality_checks enable row level security;

drop policy if exists field_assignments_read on public.field_assignments;
create policy field_assignments_read on public.field_assignments for select
using (public.is_org_member(organization_id));

drop policy if exists field_assignment_events_read on public.field_assignment_events;
create policy field_assignment_events_read on public.field_assignment_events for select
using (public.is_org_member(organization_id));

drop policy if exists field_quality_checks_read on public.field_quality_checks;
create policy field_quality_checks_read on public.field_quality_checks for select
using (public.is_org_member(organization_id));

-- Assignments, field events, QC records, and release mutations are server-owned.
-- Browser clients use narrow Edge Function actions rather than general table writes.
drop policy if exists releases_write on public.vision_releases;

create or replace function public.approve_vision_release(
  target_release uuid,
  approver uuid
)
returns public.vision_releases
language plpgsql
security definer
set search_path = public
as $$
declare
  release_record public.vision_releases;
begin
  select * into release_record from public.vision_releases where id = target_release for update;
  if release_record.id is null then raise exception 'Vision release not found'; end if;
  if release_record.state not in ('draft', 'review') then raise exception 'Only a draft release can be approved'; end if;
  if jsonb_array_length(coalesce(release_record.manifest -> 'blockers', '[]'::jsonb)) > 0 then
    raise exception 'Resolve every release blocker before approval';
  end if;

  update public.vision_releases
    set state = 'revoked', revoked_by = approver, revoked_at = now()
    where property_id = release_record.property_id and state = 'approved' and id <> target_release;

  update public.vision_releases
    set state = 'approved', approved_by = approver, approved_at = now()
    where id = target_release
    returning * into release_record;

  return release_record;
end;
$$;

revoke all on function public.approve_vision_release(uuid, uuid) from public, anon, authenticated;
grant execute on function public.approve_vision_release(uuid, uuid) to service_role;

comment on table public.field_assignments is
  'One secure, expiring field-work link for one governed capture task.';
comment on table public.field_quality_checks is
  'Automated operational quality checks. Passing QC does not verify construction facts.';
comment on column public.field_assignments.token_hash is
  'SHA-256 of the bearer token. The raw field token is never stored.';
