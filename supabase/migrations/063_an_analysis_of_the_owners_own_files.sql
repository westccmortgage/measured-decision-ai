-- ═══════════════════════════════════════════════════════════════════════════
-- AN ANALYSIS OF FILES SOMEBODY ACTUALLY UPLOADED.
--
-- Everything Core V2 has read so far it invented from a seed. That is what
-- made the engine testable and it is not a product. These four tables are what
-- an owner's own PDF and video look like on the way in, and they are
-- deliberately SEPARATE from the engine's own record:
--
--   · analysis_runs      what the owner asked for, and what it cost
--   · analysis_files     one uploaded file, and where its bytes are
--   · analysis_parts     what was got OUT of those bytes — a page image, a
--                        page's text, a sampled frame — each with the hash of
--                        its own bytes and the place it came from
--   · analysis_events    what happened, in the owner's words, so a screen can
--                        be rebuilt from the record rather than from memory
--
-- WHY THE PARTS ARE A TABLE AND NOT A FOLDER.
--
-- The engine resolves material by the hash of its bytes and by nothing else.
-- A page image that is not filed under its own hash cannot be handed to a
-- reader, and a reading that cannot name the hash it read is not evidence. So
-- every derived piece is recorded with its hash, its storage path, and its
-- locator — page number and box, or seconds into the video. That row is what
-- turns a result back into a place in the original file.
--
-- WHAT MAKES A SET OF SOURCES FIXED.
--
-- An analysis is started over the files it holds AT THAT MOMENT, and the
-- workflow it creates names their hashes. Adding or replacing a file
-- afterwards cannot change what a finished reading was based on: the workflow
-- carries the fingerprint of the set it was started over, and a different set
-- is a different analysis.
--
-- WHAT THE PAID GATE IS.
--
-- `run_requested_at` is the owner pressing the button, written down. Nothing
-- may reach a provider for this analysis until it is set, and the amount it
-- may spend is `authorized_usd` — one number, per analysis, decided before
-- anything is sent. The runner asks this table; there is no ambient
-- "everything may spend" switch for owner analyses.
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists public.analysis_runs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  created_by uuid,
  title text not null,
  question_kind text not null default 'specific_question'
    check (question_kind in ('plan_consistency', 'video_against_plans', 'specific_question')),
  question text not null default '',
  state text not null default 'collecting'
    check (state in ('collecting', 'preparing', 'ready', 'running', 'finished', 'cancelled', 'failed')),
  workflow_id uuid references public.intelligence_workflows(id),
  estimate jsonb not null default '{}'::jsonb,
  authorized_usd numeric(12, 6),
  run_requested_at timestamptz,
  run_requested_by uuid,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint analysis_runs_paid_gate_is_whole check (
    (run_requested_at is null) = (authorized_usd is null))
);

create index if not exists analysis_runs_by_org on public.analysis_runs (organization_id, created_at desc);
create unique index if not exists analysis_runs_one_workflow on public.analysis_runs (workflow_id) where workflow_id is not null;

create table if not exists public.analysis_files (
  id uuid primary key default gen_random_uuid(),
  analysis_id uuid not null references public.analysis_runs(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  ordinal integer not null check (ordinal >= 0),
  kind text not null check (kind in ('pdf', 'video', 'video360')),
  file_name text not null,
  media_type text not null,
  byte_size bigint not null check (byte_size > 0),
  storage_path text not null,
  -- The whole file's identity, computed in the browser as it uploads: the
  -- SHA-256 of the concatenated SHA-256 digests of its six-megabyte chunks,
  -- with the byte length. NOT the plain SHA-256 of the file — a browser has
  -- no incremental digest, and hashing two gigabytes twice to be able to say
  -- "sha256" would buy a word, not a fact. It is deterministic, it changes
  -- when any byte changes, and that is what it is used for.
  content_fingerprint text,
  upload_state text not null default 'uploading'
    check (upload_state in ('uploading', 'stored', 'failed')),
  -- What the file says about itself: pages, or duration and picture size.
  probe jsonb not null default '{}'::jsonb,
  preparation_state text not null default 'waiting'
    check (preparation_state in ('waiting', 'preparing', 'prepared', 'failed')),
  prepared_units integer not null default 0 check (prepared_units >= 0),
  total_units integer not null default 0 check (total_units >= 0),
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (analysis_id, ordinal)
);

create index if not exists analysis_files_by_analysis on public.analysis_files (analysis_id, ordinal);

create table if not exists public.analysis_parts (
  id uuid primary key default gen_random_uuid(),
  analysis_id uuid not null references public.analysis_runs(id) on delete cascade,
  file_id uuid not null references public.analysis_files(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  part_kind text not null check (part_kind in ('pdf_page_image', 'pdf_page_text', 'video_frame')),
  -- Page number from 1, or the index of the sampled frame from 0.
  ordinal integer not null check (ordinal >= 0),
  storage_path text,
  inline_text text,
  media_type text not null,
  byte_size integer not null default 0 check (byte_size >= 0),
  content_sha256 text not null,
  -- Where in the original this came from: {"page": 4} or {"seconds": 12.5}.
  locator jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (file_id, part_kind, ordinal),
  constraint analysis_parts_has_bytes_or_text check (
    (storage_path is not null) or (inline_text is not null))
);

create index if not exists analysis_parts_by_hash on public.analysis_parts (analysis_id, content_sha256);
create index if not exists analysis_parts_by_file on public.analysis_parts (file_id, part_kind, ordinal);

create table if not exists public.analysis_events (
  id bigserial primary key,
  analysis_id uuid not null references public.analysis_runs(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  at timestamptz not null default now(),
  kind text not null,
  detail jsonb not null default '{}'::jsonb
);

create index if not exists analysis_events_by_analysis on public.analysis_events (analysis_id, at desc);

-- ─────────────────────────────────────────────────────────────────── access
--
-- A member of the organisation may read their analyses; somebody who may add
-- evidence may create and prepare one. The service role — the runner — is not
-- restricted by these policies and reads what it needs to advance a workflow.

alter table public.analysis_runs enable row level security;
alter table public.analysis_files enable row level security;
alter table public.analysis_parts enable row level security;
alter table public.analysis_events enable row level security;

create policy analysis_runs_read on public.analysis_runs for select
  using (public.is_org_member(organization_id));
create policy analysis_runs_write on public.analysis_runs for all
  using (public.has_org_role(organization_id, array['owner','admin','contributor']::public.studio_role[]))
  with check (public.has_org_role(organization_id, array['owner','admin','contributor']::public.studio_role[]));

create policy analysis_files_read on public.analysis_files for select
  using (public.is_org_member(organization_id));
create policy analysis_files_write on public.analysis_files for all
  using (public.has_org_role(organization_id, array['owner','admin','contributor']::public.studio_role[]))
  with check (public.has_org_role(organization_id, array['owner','admin','contributor']::public.studio_role[]));

create policy analysis_parts_read on public.analysis_parts for select
  using (public.is_org_member(organization_id));
create policy analysis_parts_write on public.analysis_parts for all
  using (public.has_org_role(organization_id, array['owner','admin','contributor']::public.studio_role[]))
  with check (public.has_org_role(organization_id, array['owner','admin','contributor']::public.studio_role[]));

create policy analysis_events_read on public.analysis_events for select
  using (public.is_org_member(organization_id));
-- A browser preparing material writes its own line in this history, so that
-- what a person saw happen survives the tab that saw it.
create policy analysis_events_write on public.analysis_events for insert
  with check (public.has_org_role(organization_id, array['owner','admin','contributor']::public.studio_role[]));

grant select on table public.analysis_runs, public.analysis_files, public.analysis_parts, public.analysis_events to authenticated;
grant insert, update on table public.analysis_runs, public.analysis_files, public.analysis_parts to authenticated;
-- Removing a file, or a part that has to be made again, is part of collecting.
-- It is not part of running: the guard below refuses both once an analysis has
-- been started, because material under a finished reading may not move.
grant delete on table public.analysis_files, public.analysis_parts to authenticated;
grant insert on table public.analysis_events to authenticated;

-- ─────────────────────────────────────────── material cannot move under a run
--
-- The workflow names the hash of every source it was started over, so a
-- swapped file could never silently change a finished reading. This is the
-- second lock, in front of the first: once the button has been pressed, the
-- file list and the prepared pieces of THIS analysis are closed. A different
-- set of files is a different analysis, and saying so here costs one trigger
-- and removes a whole class of "but the evidence says something else now".

create or replace function public.analysis_material_is_settled()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_analysis uuid;
  v_state text;
  v_requested timestamptz;
begin
  v_analysis := coalesce(new.analysis_id, old.analysis_id);
  select state, run_requested_at into v_state, v_requested
    from public.analysis_runs where id = v_analysis;
  if v_requested is not null then
    raise exception 'analysis % has already been run; its material is settled', v_analysis
      using errcode = 'check_violation';
  end if;
  if v_state in ('running', 'finished', 'cancelled') then
    raise exception 'analysis % is %; its material is settled', v_analysis, v_state
      using errcode = 'check_violation';
  end if;
  return coalesce(new, old);
end;
$$;

drop trigger if exists analysis_files_are_settled on public.analysis_files;
create trigger analysis_files_are_settled before insert or update or delete on public.analysis_files
  for each row execute function public.analysis_material_is_settled();
drop trigger if exists analysis_parts_are_settled on public.analysis_parts;
create trigger analysis_parts_are_settled before insert or update or delete on public.analysis_parts
  for each row execute function public.analysis_material_is_settled();

drop trigger if exists analysis_runs_touch on public.analysis_runs;
create trigger analysis_runs_touch before update on public.analysis_runs
  for each row execute function public.core_v2_touch();
drop trigger if exists analysis_files_touch on public.analysis_files;
create trigger analysis_files_touch before update on public.analysis_files
  for each row execute function public.core_v2_touch();

-- ────────────────────────────────────────────── the paid gate, per analysis
--
-- One question, asked by the runner about one workflow: did a person press the
-- button for this analysis, and what did they authorise. It reads the record
-- and trusts nothing it was passed.

create or replace function public.core_v2_analysis_authority(p_workflow_id uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(
    (select jsonb_build_object(
       'analysis_id', a.id,
       'organization_id', a.organization_id,
       'authorized_usd', a.authorized_usd,
       'requested_at', a.run_requested_at,
       'paid_calls_allowed', (a.run_requested_at is not null and coalesce(a.authorized_usd, 0) > 0),
       'question', a.question,
       'question_kind', a.question_kind,
       'state', a.state)
       from public.analysis_runs a where a.workflow_id = p_workflow_id),
    jsonb_build_object('paid_calls_allowed', false));
$$;

comment on function public.core_v2_analysis_authority(uuid) is
  'What a person authorised for one analysis, read from the record. Nothing reaches a provider for an owner analysis unless run_requested_at is set and an amount was authorised.';

revoke all on function public.core_v2_analysis_authority(uuid) from public, anon, authenticated;
grant execute on function public.core_v2_analysis_authority(uuid) to service_role;

comment on table public.analysis_runs is
  'One analysis the owner asked for: the question, the spend they authorised, and the Core V2 workflow it became.';
comment on table public.analysis_files is
  'One file the owner uploaded, and where its bytes are. The bytes are never re-read to change a finished reading.';
comment on table public.analysis_parts is
  'What was got out of a file: a page image, a page''s text, a sampled frame — each under the hash of its own bytes and with the place in the original it came from.';
comment on table public.analysis_events is
  'What happened to an analysis, in order, so a screen can be rebuilt from the record rather than from what a browser remembered.';
