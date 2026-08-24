-- One question, one answer, with the thing itself attached.
--
-- The record already holds everything: the captures, the plan set, what the AI
-- read in each room, what a person confirmed, what is still owed. Getting at
-- any of it meant remembering which screen it lived on and clicking down to it.
-- "The 360 of the master bedroom from last time" is a five-second question and
-- was a two-minute hunt.
--
-- What this is not: it does not answer questions, it finds things. Asked about
-- framing it returns the framing invoice, the room, the capture and the AI's
-- unconfirmed note about framing — it never says whether the framing is done.
-- That distinction is the product. An interpretation carries `confirmed` so the
-- screen showing it can keep saying, in the search results as everywhere else,
-- that a suggestion is not a fact until a person says so.
--
-- Matching is deliberately two-headed, because the record holds two kinds of
-- text. Filenames and room names want substring matching — somebody typing
-- "205A" or "bath" means exactly that. The AI's prose wants stemming, so
-- "framing" finds "framed". Neither alone is enough, so a row matches if either
-- does, and full-text hits rank above substring hits.

create or replace function public.search_project_record(
  p_property_id uuid,
  p_query text,
  p_limit integer default 40
)
returns table (
  kind text,
  id uuid,
  title text,
  detail text,
  room_id uuid,
  room_name text,
  happened_at timestamptz,
  -- Only ever true for something a person confirmed. An AI reading is false
  -- here until somebody signs it, and null where the idea does not apply.
  confirmed boolean,
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
begin
  v_terms := nullif(trim(p_query), '');
  if v_terms is null or char_length(v_terms) < 2 then
    return;
  end if;

  select organization_id into v_org from public.properties
   where properties.id = p_property_id and deleted_at is null;
  if v_org is null then
    return;
  end if;
  -- The definer bypasses row-level security, so membership is checked here or
  -- it is not checked at all.
  if not public.is_org_member(v_org) then
    raise exception 'Not authorized for this project';
  end if;

  v_query := websearch_to_tsquery('english', v_terms);

  return query
  with hits as (
    -- Evidence: the files themselves.
    select
      'evidence'::text as kind,
      e.id,
      e.original_filename as title,
      e.media_type as detail,
      e.space_id as room_id,
      s.name as room_name,
      coalesce(e.captured_at, e.created_at) as happened_at,
      null::boolean as confirmed,
      ts_rank(to_tsvector('english',
        coalesce(e.original_filename, '') || ' ' || coalesce(e.media_type, '') || ' ' || coalesce(s.name, '')
      ), v_query) as rank,
      (coalesce(e.original_filename, '') || ' ' || coalesce(e.media_type, '') || ' ' || coalesce(s.name, '')) as haystack
    from public.evidence_items e
    left join public.spaces s on s.id = e.space_id
    where e.property_id = p_property_id and e.deleted_at is null

    union all

    -- Rooms: so "bath" lands on the room, not only on files inside it.
    select
      'room', s.id, s.name,
      concat_ws(' · ', s.building, s.level), s.id, s.name,
      s.created_at, (s.review_state = 'confirmed'),
      ts_rank(to_tsvector('english',
        coalesce(s.name, '') || ' ' || coalesce(s.building, '') || ' ' || coalesce(s.level, '')
      ), v_query),
      concat_ws(' ', s.name, s.building, s.level)
    from public.spaces s
    where s.property_id = p_property_id

    union all

    -- The plan set and anything else filed as a document.
    select
      'document', d.id, d.original_filename,
      concat_ws(' · ', d.document_type, d.revision_label), null::uuid, null::text,
      d.created_at, null::boolean,
      ts_rank(to_tsvector('english',
        coalesce(d.original_filename, '') || ' ' || coalesce(d.document_type, '') || ' ' || coalesce(d.revision_label, '')
      ), v_query),
      concat_ws(' ', d.original_filename, d.document_type, d.revision_label)
    from public.project_documents d
    where d.property_id = p_property_id

    union all

    -- What the AI read in a room, and whether anybody has confirmed it.
    -- The summary is the title; the observations and open questions are
    -- searchable behind it, because "was the window replaced" lives there.
    select
      'finding', a.id,
      coalesce(a.body->>'summary', 'AI interpretation'),
      concat_ws(' ', s.name),
      a.space_id, s.name, a.created_at,
      coalesce(r.state = 'confirmed', false),
      ts_rank(to_tsvector('english',
        coalesce(a.body->>'summary', '') || ' ' ||
        coalesce((select string_agg(value, ' ') from jsonb_array_elements_text(coalesce(a.body->'observations', '[]'::jsonb))), '') || ' ' ||
        coalesce((select string_agg(value, ' ') from jsonb_array_elements_text(coalesce(a.body->'questions', '[]'::jsonb))), '')
      ), v_query),
      coalesce(a.body->>'summary', '') || ' ' ||
        coalesce((select string_agg(value, ' ') from jsonb_array_elements_text(coalesce(a.body->'observations', '[]'::jsonb))), '') || ' ' ||
        coalesce((select string_agg(value, ' ') from jsonb_array_elements_text(coalesce(a.body->'questions', '[]'::jsonb))), '')
    from public.ai_suggestions a
    left join public.spaces s on s.id = a.space_id
    left join public.suggestion_reviews r on r.suggestion_id = a.id
    where a.property_id = p_property_id

    union all

    -- What the plan set says still has to be captured, and what somebody
    -- accepted as never coming. Both are answers to "what is missing".
    select
      'capture', t.id, req.title,
      case when t.status = 'waived'
        then concat('Accepted as missing — ', coalesce(t.waiver_reason, 'no reason recorded'))
        else concat_ws(' · ', req.capture_type, t.status) end,
      t.space_id, s.name, t.created_at,
      (t.status = 'verified'),
      ts_rank(to_tsvector('english',
        coalesce(req.title, '') || ' ' || coalesce(req.rationale, '') || ' ' || coalesce(req.system, '')
      ), v_query),
      concat_ws(' ', req.title, req.rationale, req.system, s.name)
    from public.capture_tasks t
    join public.capture_requirements req on req.id = t.requirement_id
    left join public.spaces s on s.id = t.space_id
    where t.property_id = p_property_id
  )
  select
    hits.kind, hits.id, hits.title, hits.detail, hits.room_id, hits.room_name,
    hits.happened_at, hits.confirmed, hits.rank
  from hits
  where hits.rank > 0 or hits.haystack ilike '%' || v_terms || '%'
  -- Full-text hits first, then the most recent: somebody asking about a room
  -- usually means the last thing that happened in it.
  order by hits.rank desc, hits.happened_at desc nulls last
  limit greatest(1, least(coalesce(p_limit, 40), 100));
end;
$$;

revoke all on function public.search_project_record(uuid, text, integer) from public, anon;
grant execute on function public.search_project_record(uuid, text, integer) to authenticated;

comment on function public.search_project_record(uuid, text, integer) is
  'Finds things in one project''s record and returns them with what they are. It does not answer questions and never states an AI reading as fact — every interpretation carries whether a person confirmed it.';
