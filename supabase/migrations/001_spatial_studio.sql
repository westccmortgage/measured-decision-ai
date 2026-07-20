-- Review before applying. This migration is intentionally not auto-deployed.
create extension if not exists pgcrypto;

create type public.studio_role as enum ('owner', 'admin', 'reviewer', 'contributor', 'viewer');
create type public.review_state as enum ('needs_review', 'confirmed', 'rejected');
create type public.job_state as enum ('queued', 'processing', 'completed', 'failed', 'cancelled');
create type public.release_state as enum ('draft', 'review', 'approved', 'revoked');

create table public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz not null default now()
);

create table public.organization_members (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role public.studio_role not null default 'viewer',
  created_at timestamptz not null default now(),
  primary key (organization_id, user_id)
);

create table public.properties (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  name text not null,
  address jsonb not null default '{}'::jsonb,
  access_classification text not null default 'private' check (access_classification in ('private','restricted','publishable')),
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.spaces (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  property_id uuid not null references public.properties(id) on delete cascade,
  parent_space_id uuid references public.spaces(id) on delete set null,
  name text not null,
  building text,
  level text,
  review_state public.review_state not null default 'needs_review',
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now()
);

create table public.evidence_items (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  property_id uuid not null references public.properties(id) on delete cascade,
  space_id uuid references public.spaces(id) on delete set null,
  storage_path text not null unique,
  original_filename text not null,
  media_type text not null,
  mime_type text not null,
  byte_size bigint not null check (byte_size >= 0),
  sha256 text,
  captured_at timestamptz,
  source_metadata jsonb not null default '{}'::jsonb,
  derivative_of uuid references public.evidence_items(id) on delete set null,
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now()
);

create table public.analysis_jobs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  property_id uuid not null references public.properties(id) on delete cascade,
  space_id uuid references public.spaces(id) on delete set null,
  state public.job_state not null default 'queued',
  profile text not null,
  profile_version text not null,
  evidence_ids uuid[] not null,
  requested_by uuid not null references auth.users(id),
  provider text,
  model text,
  error_code text,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz
);

create table public.ai_suggestions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  job_id uuid not null references public.analysis_jobs(id) on delete cascade,
  property_id uuid not null references public.properties(id) on delete cascade,
  space_id uuid references public.spaces(id) on delete set null,
  suggestion_type text not null,
  body jsonb not null,
  evidence_ids uuid[] not null,
  confidence numeric check (confidence is null or (confidence >= 0 and confidence <= 1)),
  created_at timestamptz not null default now()
);

create table public.suggestion_reviews (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  suggestion_id uuid not null references public.ai_suggestions(id) on delete cascade,
  state public.review_state not null,
  edited_body jsonb,
  reviewer_note text,
  reviewed_by uuid not null references auth.users(id),
  reviewed_at timestamptz not null default now(),
  unique (suggestion_id)
);

create table public.vision_releases (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  property_id uuid not null references public.properties(id) on delete cascade,
  version integer not null,
  state public.release_state not null default 'draft',
  manifest jsonb not null,
  created_by uuid not null references auth.users(id),
  approved_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  approved_at timestamptz,
  unique (property_id, version)
);

create table public.audit_events (
  id bigint generated always as identity primary key,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  actor_id uuid references auth.users(id),
  action text not null,
  entity_type text not null,
  entity_id text not null,
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create or replace function public.is_org_member(target_org uuid)
returns boolean language sql stable security definer set search_path = public
as $$ select exists(select 1 from public.organization_members m where m.organization_id = target_org and m.user_id = auth.uid()) $$;

create or replace function public.has_org_role(target_org uuid, allowed public.studio_role[])
returns boolean language sql stable security definer set search_path = public
as $$ select exists(select 1 from public.organization_members m where m.organization_id = target_org and m.user_id = auth.uid() and m.role = any(allowed)) $$;

alter table public.organizations enable row level security;
alter table public.organization_members enable row level security;
alter table public.properties enable row level security;
alter table public.spaces enable row level security;
alter table public.evidence_items enable row level security;
alter table public.analysis_jobs enable row level security;
alter table public.ai_suggestions enable row level security;
alter table public.suggestion_reviews enable row level security;
alter table public.vision_releases enable row level security;
alter table public.audit_events enable row level security;

create policy organizations_read on public.organizations for select using (public.is_org_member(id));
create policy members_read on public.organization_members for select using (public.is_org_member(organization_id));
create policy properties_read on public.properties for select using (public.is_org_member(organization_id));
create policy properties_write on public.properties for all using (public.has_org_role(organization_id, array['owner','admin','contributor']::public.studio_role[])) with check (public.has_org_role(organization_id, array['owner','admin','contributor']::public.studio_role[]));
create policy spaces_read on public.spaces for select using (public.is_org_member(organization_id));
create policy spaces_write on public.spaces for all using (public.has_org_role(organization_id, array['owner','admin','reviewer','contributor']::public.studio_role[])) with check (public.has_org_role(organization_id, array['owner','admin','reviewer','contributor']::public.studio_role[]));
create policy evidence_read on public.evidence_items for select using (public.is_org_member(organization_id));
create policy evidence_insert on public.evidence_items for insert with check (public.has_org_role(organization_id, array['owner','admin','contributor']::public.studio_role[]));
create policy jobs_read on public.analysis_jobs for select using (public.is_org_member(organization_id));
create policy jobs_insert on public.analysis_jobs for insert with check (public.has_org_role(organization_id, array['owner','admin','reviewer','contributor']::public.studio_role[]) and requested_by = auth.uid());
create policy suggestions_read on public.ai_suggestions for select using (public.is_org_member(organization_id));
create policy reviews_read on public.suggestion_reviews for select using (public.is_org_member(organization_id));
create policy reviews_write on public.suggestion_reviews for all using (public.has_org_role(organization_id, array['owner','admin','reviewer']::public.studio_role[])) with check (public.has_org_role(organization_id, array['owner','admin','reviewer']::public.studio_role[]) and reviewed_by = auth.uid());
create policy releases_read on public.vision_releases for select using (public.is_org_member(organization_id));
create policy releases_write on public.vision_releases for all using (public.has_org_role(organization_id, array['owner','admin','reviewer']::public.studio_role[])) with check (public.has_org_role(organization_id, array['owner','admin','reviewer']::public.studio_role[]));
create policy audit_read on public.audit_events for select using (public.has_org_role(organization_id, array['owner','admin']::public.studio_role[]));

insert into storage.buckets (id, name, public, file_size_limit)
values ('property-evidence', 'property-evidence', false, 2147483648)
on conflict (id) do update set public = false;

create policy evidence_objects_read on storage.objects for select
using (bucket_id = 'property-evidence' and public.is_org_member((storage.foldername(name))[1]::uuid));

create policy evidence_objects_insert on storage.objects for insert
with check (bucket_id = 'property-evidence' and public.has_org_role((storage.foldername(name))[1]::uuid, array['owner','admin','contributor']::public.studio_role[]));
