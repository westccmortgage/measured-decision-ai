-- Measured Decision AI: private external object storage contract.
-- Supabase remains the system of record; large binary objects may live in AWS S3.

alter table public.project_documents
  add column if not exists storage_provider text not null default 'supabase',
  add column if not exists storage_bucket text,
  add column if not exists object_version_id text,
  add column if not exists object_etag text,
  add column if not exists sha256 text;

alter table public.evidence_items
  add column if not exists storage_provider text not null default 'supabase',
  add column if not exists storage_bucket text,
  add column if not exists object_version_id text,
  add column if not exists object_etag text;

update public.project_documents
set storage_bucket = 'project-documents'
where storage_provider = 'supabase' and storage_bucket is null;

update public.evidence_items
set storage_bucket = 'property-evidence'
where storage_provider = 'supabase' and storage_bucket is null;

alter table public.project_documents
  drop constraint if exists project_documents_storage_provider_check;
alter table public.project_documents
  add constraint project_documents_storage_provider_check
  check (storage_provider in ('supabase', 'aws-s3'));

alter table public.evidence_items
  drop constraint if exists evidence_items_storage_provider_check;
alter table public.evidence_items
  add constraint evidence_items_storage_provider_check
  check (storage_provider in ('supabase', 'aws-s3'));

create table if not exists public.object_uploads (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  property_id uuid not null references public.properties(id) on delete cascade,
  space_id uuid references public.spaces(id) on delete set null,
  entity_type text not null check (entity_type in ('project_document', 'evidence')),
  storage_provider text not null default 'aws-s3' check (storage_provider = 'aws-s3'),
  storage_bucket text not null,
  object_key text not null unique,
  multipart_upload_id text not null,
  original_filename text not null,
  mime_type text not null,
  byte_size bigint not null check (byte_size > 0),
  entity_metadata jsonb not null default '{}'::jsonb,
  status text not null default 'pending'
    check (status in ('pending', 'completed', 'aborted', 'failed')),
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  expires_at timestamptz not null default (now() + interval '7 days')
);

create index if not exists object_uploads_owner_status_idx
  on public.object_uploads(created_by, status, updated_at desc);
create index if not exists object_uploads_property_idx
  on public.object_uploads(organization_id, property_id, created_at desc);

alter table public.object_uploads enable row level security;

drop policy if exists object_uploads_read_own on public.object_uploads;
create policy object_uploads_read_own on public.object_uploads for select
using (
  created_by = auth.uid()
  and public.is_org_member(organization_id)
);

comment on table public.object_uploads is
  'Service-owned resumable S3 multipart upload sessions. Browser clients mutate these only through the object-storage Edge Function.';

comment on column public.project_documents.storage_path is
  'Provider-relative object key. Resolve with storage_provider and storage_bucket; never store a signed URL.';
comment on column public.evidence_items.storage_path is
  'Provider-relative object key. Resolve with storage_provider and storage_bucket; never store a signed URL.';
