-- ASK THIS PROJECT — deep search with exact citations.
--
-- A person opens their project and asks an ordinary question. The answer comes
-- only from that project's own record, and every factual sentence carries a
-- source they can click.
--
-- The shape is deliberate and narrow: DETERMINISTIC RETRIEVAL here, in SQL,
-- then exactly one model call, then server-side verification that every
-- citation the model returned was actually in what it was given. The model
-- never chooses what to read and never invents a reference — it only writes
-- prose over records the database picked and echoes their ids back.
--
-- What this is NOT: a chat, an agent, an embedding index, a second provider,
-- or anything that writes. It reads and it answers.

-- ─────────────────────────────────────────────── the ledger admits one more
-- Project Search spends money, so it goes through the guard that already
-- exists rather than around it.
alter table public.ai_runs drop constraint if exists ai_runs_process_key_check;
alter table public.ai_runs add constraint ai_runs_process_key_check
  check (process_key in (
    'plan-analyze', 'spatial-analyze', 'document-classify',
    'document-evidence', 'field-quality-check', 'project-search'));

-- ─────────────────────────────────────────────── where an answer lives
-- Deliberately NOT a column on ai_runs. That table is a spend journal — one
-- row per paid call, read by whoever needs to reconcile an invoice — and an
-- answer's prose, its citations and its limitations are a different thing
-- with a different lifetime. They are joined by ai_run_id and nothing else.
create table if not exists public.project_search_answers (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  property_id uuid not null references public.properties(id) on delete cascade,
  ai_run_id uuid references public.ai_runs(id) on delete set null,
  -- The question as asked, and as normalised for the fingerprint. Both,
  -- because the person should see their own words back.
  question text not null,
  question_normalized text not null,
  input_fingerprint text not null,
  answer text not null,
  -- Only citations that survived verification. A citation the model invented
  -- never reaches this table.
  citations jsonb not null default '[]'::jsonb,
  limitations text,
  confidence text,
  -- What retrieval actually handed the model, so a stale answer can be
  -- explained rather than guessed at.
  source_ids text[] not null default '{}',
  records_considered integer not null default 0,
  characters_sent integer not null default 0,
  -- True when verification left nothing standing. The prose is kept for
  -- diagnosis and NEVER shown: an answer with no surviving source is exactly
  -- the unverifiable claim this product exists to refuse.
  refused boolean not null default false,
  refusal_reason text,
  asked_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

comment on table public.project_search_answers is
  'One answer per paid project-search call, joined to its spend row by ai_run_id. An answer whose citations did not survive verification is stored refused and never shown.';

create index if not exists project_search_answers_lookup
  on public.project_search_answers(property_id, input_fingerprint, created_at desc);

alter table public.project_search_answers enable row level security;
drop policy if exists project_search_answers_read on public.project_search_answers;
create policy project_search_answers_read on public.project_search_answers for select
using (public.is_org_member(organization_id));
revoke all on public.project_search_answers from public, anon, authenticated;
grant select on public.project_search_answers to authenticated;

-- ─────────────────────────────────────────────── retrieval
-- Everything the project knows that could bear on the question, ranked, and
-- cut twice: by a record count AND by a character budget.
--
-- The count alone is not a limit. Forty short rows and forty long readings
-- are the same number and wildly different money, and the second one is what
-- a real project produces. So rows are taken in rank order until either cap
-- is reached, and each row's body is clipped before it is counted.
--
-- Every row carries a STABLE source_id — kind:uuid — because that is the only
-- thing the model is allowed to echo back. The fields a citation is built
-- from never go to the model at all: it cannot fabricate a sheet number it
-- was never shown.
create or replace function public.project_search_context(
  p_property_id uuid,
  p_question text,
  p_limit integer default 40,
  p_char_budget integer default 24000
)
returns table (
  source_id text,
  kind text,
  title text,
  body text,
  -- what a citation is built from, server side only
  filename text,
  sheet_ref text,
  page_number integer,
  room_id uuid,
  room_name text,
  happened_at timestamptz,
  document_id uuid,
  evidence_id uuid,
  record_id uuid,
  -- a change here is a different answer, so it rides in the fingerprint
  version text,
  rank real
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_org uuid;
  v_terms text;
  v_query tsquery;
  v_row record;
  v_spent integer := 0;
  v_taken integer := 0;
  v_body text;
  v_cap integer := greatest(1, least(coalesce(p_limit, 40), 60));
  -- A floor low enough that the parameter is honoured across any sane range:
  -- a caller asking for a small context must get a small context, not the
  -- floor. The ceiling is what stops one question costing a fortune.
  v_budget integer := greatest(400, least(coalesce(p_char_budget, 24000), 60000));
  -- One row may never eat the whole budget.
  v_per_row integer := 1200;
begin
  select organization_id into v_org from public.properties where id = p_property_id;
  if v_org is null or not public.is_org_member(v_org) then return; end if;

  v_terms := nullif(trim(coalesce(p_question, '')), '');
  if v_terms is null or char_length(v_terms) < 2 then return; end if;
  v_query := plainto_tsquery('english', v_terms);

  for v_row in
    with matches as (
      -- Requirements: what the plans say is required, with the sheet refs
      -- the reading cited.
      select
        'requirement:' || r.id::text as source_id,
        'requirement' as kind,
        coalesce(r.component_key, 'Requirement') as title,
        concat_ws(' · ', r.description,
          nullif(r.quantity::text, ''), r.unit, 'method ' || r.method) as body,
        null::text as filename,
        nullif(array_to_string(
          array(select jsonb_array_elements_text(coalesce(r.source_refs, '[]'::jsonb))), ', '), '') as sheet_ref,
        null::integer as page_number,
        null::uuid as room_id, null::text as room_name,
        r.created_at as happened_at,
        null::uuid as document_id, null::uuid as evidence_id, r.id as record_id,
        concat_ws('|', r.id::text, r.state, r.quantity::text) as version,
        ts_rank(to_tsvector('english',
          coalesce(r.component_key,'') || ' ' || coalesce(r.description,'')), v_query) as hit_rank
      from public.project_requirements r
      where r.property_id = p_property_id and r.state = 'active'

      union all
      -- What the reconciliation concluded. Derived, so its own body names the
      -- quantities it was derived FROM; the evidence behind it is retrieved
      -- as its own rows alongside.
      select
        'reconciliation:' || c.id::text,
        'reconciliation',
        coalesce(c.component_key, 'Reconciliation'),
        concat_ws(' · ', c.narrative,
          'required ' || coalesce(c.required_quantity::text, '—'),
          'delivered ' || coalesce(c.delivered_quantity::text, '—'),
          'visually evidenced ' || coalesce(c.evidenced_quantity::text, '—'),
          'coverage ' || coalesce(c.coverage, 'unknown'),
          'verdict ' || coalesce(c.verdict, 'open')),
        null, null, null, null, null,
        c.computed_at,
        null, null, c.id,
        concat_ws('|', c.id::text, c.verdict, c.computed_at::text),
        ts_rank(to_tsvector('english',
          coalesce(c.component_key,'') || ' ' || coalesce(c.narrative,'')), v_query)
      from public.project_reconciliations c
      where c.property_id = p_property_id and c.state = 'active'

      union all
      -- What paperwork or a capture actually observed.
      select
        'observation:' || o.id::text,
        'observation',
        coalesce(o.component_key, 'Observation'),
        concat_ws(' · ', o.note, o.kind,
          'quantity ' || coalesce(o.quantity::text, '—'),
          'coverage ' || coalesce(o.coverage, 'unknown'),
          'channel ' || coalesce(o.channel, 'unknown'),
          'method ' || coalesce(o.method, 'unknown')),
        null, null, null,
        o.space_id, sp.name,
        o.observed_at,
        null, (coalesce(o.evidence_ids, '{}'::uuid[]))[1], o.id,
        concat_ws('|', o.id::text, o.state, o.quantity::text),
        ts_rank(to_tsvector('english',
          coalesce(o.component_key,'') || ' ' || coalesce(o.note,'')), v_query)
      from public.project_observations o
      left join public.spaces sp on sp.id = o.space_id
      where o.property_id = p_property_id and o.state = 'active'

      union all
      -- Where the reading could not read. These are what turn "missing" into
      -- "not yet evidenced".
      select
        'gap:' || g.id::text,
        'gap',
        coalesce(g.component_key, g.kind),
        concat_ws(' · ', g.question, 'status ' || g.status,
          case when g.blocks_activation then 'blocks activation' else null end,
          'severity ' || coalesce(g.severity, 'unknown')),
        null,
        nullif(array_to_string(
          array(select jsonb_array_elements_text(coalesce(g.source_refs, '[]'::jsonb))), ', '), ''),
        null, null, null,
        g.last_seen_at,
        null, null, g.id,
        concat_ws('|', g.id::text, g.status, g.last_seen_at::text),
        ts_rank(to_tsvector('english',
          coalesce(g.question,'') || ' ' || coalesce(g.component_key,'')), v_query)
      from public.plan_reading_gaps g
      where g.property_id = p_property_id

      union all
      -- The documents themselves: plans, specifications, paperwork.
      select
        'document:' || d.id::text,
        'document',
        d.original_filename,
        concat_ws(' · ', d.document_type,
          nullif('revision ' || d.revision_label, 'revision '),
          nullif('issued ' || d.issued_at::text, 'issued '),
          'status ' || coalesce(d.status, 'unknown')),
        d.original_filename,
        d.revision_label,
        null, null, null,
        coalesce(d.issued_at::timestamptz, d.created_at),
        d.id, null, d.id,
        concat_ws('|', d.id::text, coalesce(d.revision_label,''), d.updated_at::text),
        ts_rank(to_tsvector('english',
          coalesce(d.original_filename,'') || ' ' || coalesce(d.document_type,'')), v_query)
        + case when d.original_filename ilike '%' || v_terms || '%' then 0.25 else 0 end
      from public.project_documents d
      where d.property_id = p_property_id

      union all
      -- Captures: the photographs and 360 rooms an answer points at.
      select
        'capture:' || e.id::text,
        'capture',
        coalesce(sp2.name, 'Capture') || ' · ' || coalesce(e.original_filename, ''),
        concat_ws(' · ', e.media_type,
          nullif('subject ' || (e.source_metadata->>'subject'), 'subject '),
          nullif('captured ' || e.captured_at::text, 'captured ')),
        e.original_filename, null, null,
        e.space_id, sp2.name,
        e.captured_at,
        null, e.id, e.id,
        concat_ws('|', e.id::text, e.captured_at::text),
        ts_rank(to_tsvector('english',
          coalesce(sp2.name,'') || ' ' || coalesce(e.original_filename,'') || ' '
          || coalesce(e.source_metadata->>'subject','')), v_query)
        + case when coalesce(sp2.name,'') ilike '%' || v_terms || '%' then 0.3 else 0 end
      from public.evidence_items e
      left join public.spaces sp2 on sp2.id = e.space_id
      where e.property_id = p_property_id and e.deleted_at is null

      union all
      -- Rooms, so "which rooms have not been analyzed" has rows to stand on.
      select
        'room:' || s.id::text,
        'room',
        s.name,
        concat_ws(' · ', 'room',
          (select count(*)::text || ' captures' from public.evidence_items ev
            where ev.space_id = s.id and ev.deleted_at is null)),
        null, null, null,
        s.id, s.name,
        s.created_at,
        null, null, s.id,
        concat_ws('|', s.id::text, s.created_at::text),
        ts_rank(to_tsvector('english', coalesce(s.name,'')), v_query)
        + case when coalesce(s.name,'') ilike '%' || v_terms || '%' then 0.4 else 0 end
      from public.spaces s
      where s.property_id = p_property_id
    )
    select * from matches
    where hit_rank > 0
    order by hit_rank desc, happened_at desc nulls last
    limit v_cap * 2
  loop
    exit when v_taken >= v_cap or v_spent >= v_budget;
    -- The budget is a cap, not a target. One very long record must not be
    -- allowed to breach it "because it was first" — it is clipped to what is
    -- left. Its title and its id are intact, so it can still be cited; only
    -- the detail is shortened.
    v_body := left(coalesce(v_row.body, ''), least(v_per_row, v_budget - v_spent));
    continue when char_length(v_body) = 0 and v_taken > 0;
    v_taken := v_taken + 1;
    v_spent := v_spent + char_length(v_body);
    source_id := v_row.source_id; kind := v_row.kind; title := v_row.title;
    body := v_body; filename := v_row.filename; sheet_ref := v_row.sheet_ref;
    page_number := v_row.page_number; room_id := v_row.room_id;
    room_name := v_row.room_name; happened_at := v_row.happened_at;
    document_id := v_row.document_id; evidence_id := v_row.evidence_id;
    record_id := v_row.record_id; version := v_row.version; rank := v_row.hit_rank;
    return next;
  end loop;
end;
$$;

-- ─────────────────────────────────────────────── writing an answer down
create or replace function public.record_project_search_answer(
  p_organization_id uuid,
  p_property_id uuid,
  p_ai_run_id uuid,
  p_question text,
  p_question_normalized text,
  p_input_fingerprint text,
  p_answer text,
  p_citations jsonb,
  p_limitations text,
  p_confidence text,
  p_source_ids text[],
  p_records_considered integer,
  p_characters_sent integer,
  p_refused boolean,
  p_refusal_reason text,
  p_asked_by uuid
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare new_id uuid;
begin
  insert into public.project_search_answers (
    organization_id, property_id, ai_run_id, question, question_normalized,
    input_fingerprint, answer, citations, limitations, confidence, source_ids,
    records_considered, characters_sent, refused, refusal_reason, asked_by
  ) values (
    p_organization_id, p_property_id, p_ai_run_id, p_question, p_question_normalized,
    p_input_fingerprint, p_answer, coalesce(p_citations, '[]'::jsonb), p_limitations,
    p_confidence, coalesce(p_source_ids, '{}'), coalesce(p_records_considered, 0),
    coalesce(p_characters_sent, 0), coalesce(p_refused, false), p_refusal_reason, p_asked_by
  ) returning id into new_id;
  return new_id;
end;
$$;

-- The saved answer for a fingerprint, so a repeated question costs nothing.
-- A refused answer is never handed back as a result: the question is asked
-- again rather than the refusal being cached as if it were knowledge.
create or replace function public.project_search_answer_for(
  p_property_id uuid,
  p_input_fingerprint text
)
returns table (
  id uuid, answer text, citations jsonb, limitations text,
  confidence text, created_at timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select a.id, a.answer, a.citations, a.limitations, a.confidence, a.created_at
    from public.project_search_answers a
    join public.properties p on p.id = a.property_id
   where a.property_id = p_property_id
     and a.input_fingerprint = p_input_fingerprint
     and not a.refused
     and public.is_org_member(p.organization_id)
   order by a.created_at desc
   limit 1;
$$;

revoke all on function public.record_project_search_answer(uuid, uuid, uuid, text, text, text, text, jsonb, text, text, text[], integer, integer, boolean, text, uuid) from public, anon, authenticated;
grant execute on function public.project_search_context(uuid, text, integer, integer) to authenticated;
grant execute on function public.project_search_answer_for(uuid, text) to authenticated;
