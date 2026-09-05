-- Repair question retrieval without re-running or changing project analysis.
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
  -- A question is not an exact phrase: retrieve records matching its terms.
  v_query := replace(plainto_tsquery('english', v_terms)::text, ' & ', ' | ')::tsquery;
  if numnode(v_query) = 0 then return; end if;

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
          coalesce(c.component_key,'') || ' ' || coalesce(c.narrative,'') || ' required delivered installed coverage ' || coalesce(c.verdict,'')), v_query)
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
          coalesce(o.component_key,'') || ' ' || coalesce(o.note,'') || ' ' || o.kind), v_query)
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
        null, -- revision labels are not sheet references
        null, null, null,
        coalesce(d.issued_at::timestamptz, d.created_at),
        d.id, null, d.id,
        concat_ws('|', d.id::text, coalesce(d.revision_label,''), d.updated_at::text),
        ts_rank(to_tsvector('english',
          coalesce(d.original_filename,'') || ' ' || coalesce(d.document_type,'')), v_query)
        + case when d.original_filename ilike '%' || v_terms || '%' then 0.25 else 0 end
      from public.project_documents d
      where d.property_id = p_property_id and d.status <> 'superseded'

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
        ts_rank(to_tsvector('english', coalesce(s.name,'') || ' room captures'), v_query)
        + case when coalesce(s.name,'') ilike '%' || v_terms || '%' then 0.4 else 0 end
      from public.spaces s
      where s.property_id = p_property_id
    )
    select * from matches
    where hit_rank > 0
    order by hit_rank desc, happened_at desc nulls last, source_id
    limit v_cap * 2
  loop
    exit when v_taken >= v_cap or v_spent >= v_budget;
    -- The budget is a cap, not a target. One very long record must not be
    -- allowed to breach it "because it was first" — it is clipped to what is
    -- left. Its title and its id are intact, so it can still be cited; only
    -- the detail is shortened.
    v_row.title := left(coalesce(v_row.title, ''), least(240, v_budget - v_spent));
    v_body := left(coalesce(v_row.body, ''), least(v_per_row, greatest(0, v_budget - v_spent - char_length(v_row.title))));
    continue when char_length(v_body) = 0 and v_taken > 0;
    v_taken := v_taken + 1;
    v_spent := v_spent + char_length(v_body) + char_length(v_row.title);
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


-- Repeated refusals return the same safe refusal, never an endless retrieval message.
create or replace function public.project_search_answer_for(p_property_id uuid, p_input_fingerprint text)
returns table (id uuid, answer text, citations jsonb, limitations text, confidence text, created_at timestamptz)
language sql stable security definer set search_path = public as $$
 select a.id,
   case when a.refused then 'I could not find enough evidence in this project to answer reliably.' else a.answer end,
   case when a.refused then '[]'::jsonb else a.citations end,
   a.limitations, case when a.refused then 'low' else a.confidence end, a.created_at
 from public.project_search_answers a join public.properties p on p.id = a.property_id
 where a.property_id = p_property_id and a.input_fingerprint = p_input_fingerprint
   and public.is_org_member(p.organization_id)
 order by a.created_at desc, a.id limit 1;
$$;
