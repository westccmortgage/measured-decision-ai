create table if not exists public.project_intake_settings (
  id boolean primary key default true check (id),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

insert into public.project_intake_settings (id, organization_id, owner_user_id)
select true, organization_id, user_id from public.organization_members
where role = 'owner' order by created_at asc limit 1
on conflict (id) do nothing;

create table if not exists public.project_intake_access (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  property_id uuid not null references public.properties(id) on delete cascade,
  default_space_id uuid not null references public.spaces(id) on delete restrict,
  code_hash text not null unique,
  status text not null default 'active' check (status in ('active','submitted','closed')),
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  submitted_at timestamptz, last_opened_at timestamptz
);

create table if not exists public.project_intake_rate_limits (
  request_key_hash text not null, window_start date not null default current_date,
  request_count integer not null default 0, updated_at timestamptz not null default now(),
  primary key (request_key_hash, window_start)
);

create or replace function public.consume_project_intake_create_slot(p_request_key_hash text, p_daily_limit integer default 10)
returns boolean language plpgsql security definer set search_path = public as $$
declare v_count integer;
begin
  insert into public.project_intake_rate_limits(request_key_hash,window_start,request_count)
  values(p_request_key_hash,current_date,1)
  on conflict(request_key_hash,window_start) do update
  set request_count=public.project_intake_rate_limits.request_count+1,updated_at=now()
  returning request_count into v_count;
  return v_count <= greatest(1,p_daily_limit);
end; $$;

alter table public.object_uploads add column if not exists project_intake_access_id uuid references public.project_intake_access(id) on delete set null;
alter table public.evidence_items add column if not exists project_intake_access_id uuid references public.project_intake_access(id) on delete set null;
create index if not exists object_uploads_project_intake_idx on public.object_uploads(project_intake_access_id,status,created_at);
create index if not exists evidence_project_intake_idx on public.evidence_items(project_intake_access_id,created_at);
alter table public.project_intake_settings enable row level security;
alter table public.project_intake_access enable row level security;
alter table public.project_intake_rate_limits enable row level security;
drop policy if exists project_intake_access_manager_read on public.project_intake_access;
create policy project_intake_access_manager_read on public.project_intake_access for select using(public.is_org_member(organization_id));
