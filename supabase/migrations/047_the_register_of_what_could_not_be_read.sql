-- 047 · The register of what could not be read.
--
-- The plan reader already admits what it cannot do. Every run raises its
-- questions, marks the counts nobody could make as OPEN_RFI, and states a
-- confidence on the ones it did make. All of that lives inside one run:
-- open the baseline, see this run's gaps; open the next baseline, see that
-- run's gaps. Nothing accumulates, so nobody can answer the question that
-- actually matters — WHERE DOES THE READER KEEP FAILING?
--
-- A per-run list is not knowledge of your own machine. A register is: the
-- same question raised by four consecutive readings of the same set, the
-- schedule that has been unreadable since March, the mark whose count has
-- never once come back with confidence. That is operational knowledge about
-- the product's own weak spots, and today it exists nowhere.
--
-- One rule governs this table, and it is the reason the register can be
-- trusted at all: A READER FALLING SILENT IS NOT AN ANSWER. When a later
-- reading stops raising a gap, the register says exactly that —
-- 'not_raised_again' — and never 'answered'. Only a person answers, with
-- their name and the date on the row. A machine that quietly drops its own
-- open questions between versions would launder failure into progress, and
-- that is the one failure this product exists to refuse.
--
-- Three kinds, kept apart because they are different failures:
--   unanswered_question  the reading raised a question and nobody answered
--   no_count             a component came back with no number at all
--   weak_count           a number came back the reader would not stand behind

create table if not exists public.plan_reading_gaps (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  property_id uuid not null references public.properties(id) on delete cascade,
  kind text not null check (kind in ('unanswered_question', 'no_count', 'weak_count')),
  -- Stable identity inside (property, kind): the normalised question text,
  -- or the component key. Same failure, same row, however often it recurs.
  gap_key text not null,
  question text not null,
  component_key text,
  severity text not null default 'important'
    check (severity in ('critical', 'important', 'informational')),
  blocks_activation boolean not null default false,
  source_refs jsonb not null default '[]'::jsonb,
  first_seen_at timestamptz not null default now(),
  first_seen_baseline uuid references public.document_baselines(id) on delete set null,
  last_seen_at timestamptz not null default now(),
  last_seen_baseline uuid references public.document_baselines(id) on delete set null,
  -- How many distinct readings raised it. Two is a pattern; five is a
  -- weak spot with a date on it.
  readings_seen integer not null default 1,
  status text not null default 'open'
    check (status in ('open', 'answered', 'not_raised_again', 'withdrawn')),
  answer text,
  answered_by uuid references auth.users(id),
  answered_at timestamptz,
  created_at timestamptz not null default now()
);

create unique index if not exists plan_reading_gaps_identity
  on public.plan_reading_gaps(property_id, kind, gap_key);
create index if not exists plan_reading_gaps_lookup
  on public.plan_reading_gaps(property_id, status, kind);

comment on table public.plan_reading_gaps is
  'Cumulative register of where the plan reader could not read, across every reading of a project. A gap a later reading stopped raising is marked not_raised_again, never answered: only a person answers, and their name is on the row.';

alter table public.plan_reading_gaps enable row level security;

-- Readable by the people who run the project. There are no write policies
-- on purpose: rows arrive through the fold below, and a person's answer
-- goes through the RPC that records who they are.
drop policy if exists plan_reading_gaps_read on public.plan_reading_gaps;
create policy plan_reading_gaps_read on public.plan_reading_gaps for select
using (public.property_role(property_id) in ('owner', 'admin', 'reviewer', 'project_manager'));

-- ─────────────────────────────────────────────────────────── small helpers

create or replace function public.plan_reading_gap_key(p_text text)
returns text
language sql
immutable
set search_path = public
as $$
  select left(
    regexp_replace(
      regexp_replace(lower(trim(coalesce(p_text, ''))), '\s+', ' ', 'g'),
      '[.?!,;:]+$', ''),
    400)
$$;

-- Every sheet that ever raised the gap stays in its provenance.
create or replace function public.plan_reading_refs_union(p_left jsonb, p_right jsonb)
returns jsonb
language sql
immutable
set search_path = public
as $$
  select coalesce((
    select jsonb_agg(ref order by ref)
      from (
        select jsonb_array_elements(coalesce(p_left, '[]'::jsonb)) as ref
        union
        select jsonb_array_elements(coalesce(p_right, '[]'::jsonb))
      ) refs
  ), '[]'::jsonb)
$$;

-- ────────────────────────────────────────────────────────────────── the fold
-- Folds one reading into the register. Called by the triggers below, so it
-- takes no role of its own: whoever wrote the reading was already allowed
-- to write it.

create or replace function public.fold_plan_reading_gaps(
  p_baseline_id uuid,
  p_include_requirements boolean default true
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  baseline_record public.document_baselines%rowtype;
  kinds text[] := array['unanswered_question'];
  folded integer := 0;
  touched integer := 0;
  newest uuid;
begin
  select * into baseline_record from public.document_baselines where id = p_baseline_id;
  if baseline_record.id is null then
    return 0;
  end if;
  if p_include_requirements then
    kinds := kinds || array['no_count', 'weak_count'];
  end if;

  -- The questions the reading itself raised.
  insert into public.plan_reading_gaps (
    organization_id, property_id, kind, gap_key, question, component_key,
    severity, blocks_activation, source_refs,
    first_seen_baseline, last_seen_baseline, readings_seen
  )
  select
    baseline_record.organization_id, baseline_record.property_id, 'unanswered_question',
    public.plan_reading_gap_key(g->>'question'),
    trim(g->>'question'),
    null,
    case when coalesce(g->>'severity', '') in ('critical', 'important', 'informational')
         then g->>'severity' else 'important' end,
    coalesce((g->>'blocks_activation')::boolean, false),
    coalesce(g->'source_refs', '[]'::jsonb),
    p_baseline_id, p_baseline_id, 1
  from jsonb_array_elements(coalesce(baseline_record.gaps, '[]'::jsonb)) g
  where public.plan_reading_gap_key(g->>'question') <> ''
  on conflict (property_id, kind, gap_key) do update set
    question = excluded.question,
    severity = excluded.severity,
    blocks_activation = excluded.blocks_activation,
    source_refs = public.plan_reading_refs_union(public.plan_reading_gaps.source_refs, excluded.source_refs),
    last_seen_at = now(),
    last_seen_baseline = excluded.last_seen_baseline,
    readings_seen = public.plan_reading_gaps.readings_seen
      + case when public.plan_reading_gaps.last_seen_baseline is distinct from excluded.last_seen_baseline
             then 1 else 0 end,
    /* A new reading raising it again reopens it — including one a person
       already answered, because an answer that did not reach the drawings
       is a gap that is still there. A person's withdrawal stands. */
    status = case
      when public.plan_reading_gaps.last_seen_baseline is distinct from excluded.last_seen_baseline
       and public.plan_reading_gaps.status in ('answered', 'not_raised_again') then 'open'
      when public.plan_reading_gaps.status = 'not_raised_again' then 'open'
      else public.plan_reading_gaps.status end;
  get diagnostics touched = row_count;
  folded := folded + touched;

  -- What the distiller could not turn into a number, and what it would not
  -- stand behind. Both come off the requirements this baseline produced.
  if p_include_requirements then
    insert into public.plan_reading_gaps (
      organization_id, property_id, kind, gap_key, question, component_key,
      severity, blocks_activation, source_refs,
      first_seen_baseline, last_seen_baseline, readings_seen
    )
    select
      r.organization_id, r.property_id,
      case when r.method = 'OPEN_RFI' then 'no_count' else 'weak_count' end,
      public.plan_reading_gap_key(r.component_key),
      case when r.method = 'OPEN_RFI'
           then 'No count could be read for ' || r.component_key
                || case when coalesce(trim(r.description), '') <> ''
                        then ' (' || trim(r.description) || ')' else '' end
           else 'The count for ' || r.component_key || ' came back at '
                || r.confidence || ' confidence' end,
      r.component_key,
      case when r.method = 'OPEN_RFI' then 'important' else 'informational' end,
      false,
      r.source_refs,
      p_baseline_id, p_baseline_id, 1
    from public.project_requirements r
    where r.baseline_id = p_baseline_id
      and r.state = 'active'
      and (r.method = 'OPEN_RFI' or r.confidence in ('low', 'none'))
      and public.plan_reading_gap_key(r.component_key) <> ''
    on conflict (property_id, kind, gap_key) do update set
      question = excluded.question,
      component_key = excluded.component_key,
      source_refs = public.plan_reading_refs_union(public.plan_reading_gaps.source_refs, excluded.source_refs),
      last_seen_at = now(),
      last_seen_baseline = excluded.last_seen_baseline,
      readings_seen = public.plan_reading_gaps.readings_seen
        + case when public.plan_reading_gaps.last_seen_baseline is distinct from excluded.last_seen_baseline
               then 1 else 0 end,
      status = case
        when public.plan_reading_gaps.last_seen_baseline is distinct from excluded.last_seen_baseline
         and public.plan_reading_gaps.status in ('answered', 'not_raised_again') then 'open'
        when public.plan_reading_gaps.status = 'not_raised_again' then 'open'
        else public.plan_reading_gaps.status end;
    get diagnostics touched = row_count;
    folded := folded + touched;
  end if;

  /* Only the newest reading of a project may say what it did not raise.
     Re-folding an older baseline must never silence the current one. */
  select id into newest
    from public.document_baselines
   where property_id = baseline_record.property_id
   order by version desc, created_at desc
   limit 1;

  if newest = p_baseline_id then
    /* Marked for what happened, not for what it means: the latest reading
       did not raise this. That is not an answer, and the register will
       never call it one. */
    update public.plan_reading_gaps
       set status = 'not_raised_again'
     where property_id = baseline_record.property_id
       and kind = any(kinds)
       and status = 'open'
       and last_seen_baseline is distinct from p_baseline_id;
  end if;

  return folded;
end;
$$;

comment on function public.fold_plan_reading_gaps(uuid, boolean) is
  'Folds one plan reading into the cumulative register: its questions, the counts it could not make, and the counts it would not stand behind. Gaps the newest reading stopped raising become not_raised_again — never answered.';

-- ──────────────────────────────────────────────────────────────── the wiring
-- The register fills itself. A reading lands, its questions are on the
-- record; the distiller finishes, its unreadable counts join them.

create or replace function public.note_baseline_reading_gaps()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.fold_plan_reading_gaps(new.id, false);
  return new;
end;
$$;

drop trigger if exists baselines_note_reading_gaps on public.document_baselines;
create trigger baselines_note_reading_gaps
  after insert on public.document_baselines
  for each row execute function public.note_baseline_reading_gaps();

create or replace function public.note_extraction_reading_gaps()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.channel = 'technical'
     and new.source_kind = 'baseline'
     and new.state in ('complete', 'complete_with_rfis')
     and (tg_op = 'INSERT' or old.state is distinct from new.state)
     and coalesce(new.source_id, '') ~*
         '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  then
    perform public.fold_plan_reading_gaps(new.source_id::uuid, true);
  end if;
  return new;
end;
$$;

drop trigger if exists intelligence_jobs_note_reading_gaps on public.intelligence_jobs;
create trigger intelligence_jobs_note_reading_gaps
  after insert or update on public.intelligence_jobs
  for each row execute function public.note_extraction_reading_gaps();

-- ────────────────────────────────────────────────────────────── the answer
-- The only door that changes a gap's standing, and it records a person.

create or replace function public.answer_plan_reading_gap(
  p_gap_id uuid,
  p_verdict text,
  p_answer text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  gap_record public.plan_reading_gaps%rowtype;
  actor_role public.studio_role;
begin
  if p_verdict not in ('answered', 'withdrawn') then
    raise exception 'A gap is answered or withdrawn';
  end if;
  if coalesce(trim(p_answer), '') = '' then
    raise exception 'Answering a gap says what the answer is';
  end if;

  select * into gap_record from public.plan_reading_gaps where id = p_gap_id;
  if gap_record.id is null then
    raise exception 'That gap is not in the register';
  end if;
  actor_role := public.property_role(gap_record.property_id);
  if actor_role is null or actor_role not in ('owner', 'admin', 'reviewer', 'project_manager') then
    raise exception 'Answering what the reader could not read is for the people who run the project';
  end if;

  update public.plan_reading_gaps
     set status = p_verdict,
         answer = trim(p_answer),
         answered_by = auth.uid(),
         answered_at = now()
   where id = p_gap_id;
  return p_gap_id;
end;
$$;

comment on function public.answer_plan_reading_gap(uuid, text, text) is
  'A person answers a gap the reader raised, or withdraws it as no longer applicable. Their name and the date go on the row; nothing else can set a gap to answered.';

-- ──────────────────────────────────────────────────────────── the register
-- One project: what is open, what somebody answered, what the newest
-- reading stopped raising, and what recurs.

create or replace function public.plan_reading_register(p_property_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  property_record public.properties%rowtype;
  actor_role public.studio_role;
  open_gaps jsonb;
  answered_gaps jsonb;
  quiet_gaps jsonb;
  withdrawn_gaps jsonb;
  totals jsonb;
begin
  select * into property_record from public.properties where id = p_property_id;
  if property_record.id is null then
    raise exception 'That project is not in the record';
  end if;
  actor_role := public.property_role(p_property_id);
  if actor_role is null or actor_role not in ('owner', 'admin', 'reviewer', 'project_manager') then
    raise exception 'The reading register is for the people who run the project';
  end if;

  select coalesce(jsonb_agg(row_to_json(entry) order by entry.blocks_activation desc,
                            entry.severity_rank, entry.readings_seen desc, entry.first_seen_at), '[]'::jsonb)
    into open_gaps
  from (
    select id, kind, question, component_key, severity, blocks_activation, source_refs,
           readings_seen, first_seen_at, last_seen_at, answer, answered_at,
           case severity when 'critical' then 1 when 'important' then 2 else 3 end as severity_rank
      from public.plan_reading_gaps
     where property_id = p_property_id and status = 'open'
  ) entry;

  select coalesce(jsonb_agg(row_to_json(entry) order by entry.answered_at desc), '[]'::jsonb)
    into answered_gaps
  from (
    select id, kind, question, component_key, readings_seen, answer, answered_by, answered_at
      from public.plan_reading_gaps
     where property_id = p_property_id and status = 'answered'
  ) entry;

  select coalesce(jsonb_agg(row_to_json(entry) order by entry.last_seen_at desc), '[]'::jsonb)
    into quiet_gaps
  from (
    select id, kind, question, component_key, readings_seen, first_seen_at, last_seen_at
      from public.plan_reading_gaps
     where property_id = p_property_id and status = 'not_raised_again'
  ) entry;

  select coalesce(jsonb_agg(row_to_json(entry) order by entry.answered_at desc), '[]'::jsonb)
    into withdrawn_gaps
  from (
    select id, kind, question, component_key, readings_seen, answer, answered_by, answered_at
      from public.plan_reading_gaps
     where property_id = p_property_id and status = 'withdrawn'
  ) entry;

  select jsonb_build_object(
    'open', count(*) filter (where status = 'open'),
    'blocking', count(*) filter (where status = 'open' and blocks_activation),
    'recurring', count(*) filter (where status = 'open' and readings_seen > 1),
    'answered_by_a_person', count(*) filter (where status = 'answered'),
    'not_raised_again', count(*) filter (where status = 'not_raised_again'),
    'withdrawn', count(*) filter (where status = 'withdrawn'),
    'oldest_open_days', coalesce(max(
      case when status = 'open'
           then floor(extract(epoch from (now() - first_seen_at)) / 86400) end), 0),
    'readings', (select count(*) from public.document_baselines where property_id = p_property_id)
  ) into totals
  from public.plan_reading_gaps where property_id = p_property_id;

  return jsonb_build_object(
    'property_id', p_property_id,
    'open', open_gaps,
    'answered', answered_gaps,
    'not_raised_again', quiet_gaps,
    'withdrawn', withdrawn_gaps,
    'summary', totals,
    'doctrine',
      'A gap the newest reading stopped raising is recorded as not_raised_again, never as answered: '
      || 'a reader falling silent is not an answer. Only a person answers, and their name is on the row.'
  );
end;
$$;

comment on function public.plan_reading_register(uuid) is
  'The cumulative register for one project: open gaps ranked by what blocks activation and what keeps recurring, what a person answered, and what the newest reading stopped raising.';

-- ────────────────────────────────────────────────────────────── weak spots
-- Across a builder's projects: not "what is open on this job" but "where
-- does this reader keep failing".

create or replace function public.plan_reading_weak_spots(p_organization_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  by_kind jsonb;
  recurring jsonb;
  by_sheet jsonb;
begin
  if not public.has_org_role(p_organization_id,
      array['owner', 'admin', 'reviewer', 'project_manager']::public.studio_role[]) then
    raise exception 'The weak-spot map is for the people who run the projects';
  end if;

  select coalesce(jsonb_agg(row_to_json(entry) order by entry.open_now desc, entry.kind), '[]'::jsonb)
    into by_kind
  from (
    select kind,
           count(*) as gaps,
           count(*) filter (where status = 'open') as open_now,
           count(*) filter (where status = 'answered') as answered_by_a_person,
           count(distinct property_id) as projects
      from public.plan_reading_gaps
     where organization_id = p_organization_id
     group by kind
  ) entry;

  -- The same failure on more than one reading, and how many projects it
  -- turns up on. Two projects raising the same question is the reader's
  -- weakness, not the project's.
  select coalesce(jsonb_agg(row_to_json(entry) order by entry.projects desc, entry.readings desc), '[]'::jsonb)
    into recurring
  from (
    select gap_key, kind,
           max(question) as question,
           count(distinct property_id) as projects,
           sum(readings_seen) as readings,
           count(*) filter (where status = 'open') as still_open
      from public.plan_reading_gaps
     where organization_id = p_organization_id
     group by gap_key, kind
    having sum(readings_seen) > 1 or count(distinct property_id) > 1
     limit 50
  ) entry;

  -- Which sheets the reader keeps stumbling on, by the reference it cited.
  select coalesce(jsonb_agg(row_to_json(entry) order by entry.gaps desc, entry.sheet), '[]'::jsonb)
    into by_sheet
  from (
    select ref.value #>> '{}' as sheet,
           count(*) as gaps,
           count(distinct g.property_id) as projects
      from public.plan_reading_gaps g
      cross join lateral jsonb_array_elements(coalesce(g.source_refs, '[]'::jsonb)) as ref
     where g.organization_id = p_organization_id
       and coalesce(ref.value #>> '{}', '') <> ''
     group by 1
     order by 2 desc
     limit 25
  ) entry;

  return jsonb_build_object(
    'organization_id', p_organization_id,
    'by_kind', by_kind,
    'recurring', recurring,
    'by_sheet', by_sheet,
    'doctrine',
      'Counts of where the plan reader could not read. It is a map of this system''s own weak spots, '
      || 'not a judgement of any drawing set and not a measure of the work on site.'
  );
end;
$$;

comment on function public.plan_reading_weak_spots(uuid) is
  'Across one organisation: where the plan reader keeps failing — by kind of failure, by the gap that recurs, and by the sheet reference it keeps citing.';

-- The triggers keep firing without EXECUTE: revoking it only removes the
-- REST endpoint, which is the point.
revoke all on function public.note_baseline_reading_gaps() from public, anon, authenticated;
revoke all on function public.note_extraction_reading_gaps() from public, anon, authenticated;
revoke all on function public.plan_reading_gap_key(text) from public, anon;
revoke all on function public.plan_reading_refs_union(jsonb, jsonb) from public, anon;
revoke all on function public.fold_plan_reading_gaps(uuid, boolean) from public, anon, authenticated;
revoke all on function public.answer_plan_reading_gap(uuid, text, text) from public, anon;
revoke all on function public.plan_reading_register(uuid) from public, anon;
revoke all on function public.plan_reading_weak_spots(uuid) from public, anon;
grant execute on function public.answer_plan_reading_gap(uuid, text, text) to authenticated;
grant execute on function public.plan_reading_register(uuid) to authenticated;
grant execute on function public.plan_reading_weak_spots(uuid) to authenticated;

-- ─────────────────────────────────────────────────────────────── the past
-- The register starts with the history the database already holds: every
-- reading ever made, in the order it was made, so a gap that has been open
-- since the first pass says so from the first day this ships.

do $$
declare
  baseline_row record;
begin
  for baseline_row in
    select id from public.document_baselines order by property_id, version, created_at
  loop
    perform public.fold_plan_reading_gaps(baseline_row.id, true);
  end loop;
end;
$$;
