-- Human Confirmed means a human confirmed it.
--
-- The takeoff screen used to ask the owner to write in counts the AI could
-- not make — and then recorded whatever they typed as the signer's reading.
-- An owner copying an AI's numbers into that field would have produced a
-- "human confirmed" value that no human ever verified: provenance laundering,
-- the one failure this product exists to refuse.
--
-- The corrected model:
--   - The AI proposes everything it can, with confidence and what blocked
--     certainty. The owner reviews; they are never asked to measure plans.
--   - An owner's acceptance (approve_material_takeoff) records
--     OWNER_ACCEPTED_BASELINE — a working baseline, not a technical
--     confirmation. It never marks any line human-confirmed.
--   - HUMAN_CONFIRMED exists only here: a qualified reviewer confirms,
--     corrects, or keeps open ONE LINE AT A TIME, and the record keeps who,
--     in what role, what value, when, and the superseded history.

create table if not exists public.takeoff_line_reviews (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  property_id uuid not null references public.properties(id) on delete cascade,
  baseline_id uuid not null references public.document_baselines(id) on delete cascade,
  kind text not null default 'wood_framing' check (kind in ('wood_framing')),
  -- The line under review, by its stable key: the order line's item text or
  -- the RFI's question text, verbatim.
  line_key text not null,
  verdict text not null check (verdict in ('confirmed', 'corrected', 'kept_open')),
  -- The value the reviewer stands behind (required unless kept open), verbatim.
  value text,
  note text,
  reviewer_role public.studio_role not null,
  reviewed_by uuid not null references auth.users(id),
  reviewed_at timestamptz not null default now(),
  state text not null default 'active' check (state in ('active', 'superseded'))
);

create index if not exists takeoff_line_reviews_lookup
  on public.takeoff_line_reviews(baseline_id, kind, state);

comment on table public.takeoff_line_reviews is
  'Line-level expert review of the AI takeoff. HUMAN_CONFIRMED exists only through these rows; an owner-level acceptance never creates one.';

alter table public.takeoff_line_reviews enable row level security;

drop policy if exists takeoff_line_reviews_read on public.takeoff_line_reviews;
create policy takeoff_line_reviews_read on public.takeoff_line_reviews for select
using (public.is_org_member(organization_id));

-- Writes go through the RPC so the reviewer's qualification is checked and
-- the supersede history cannot be skipped.

create or replace function public.review_takeoff_line(
  p_baseline_id uuid,
  p_line_key text,
  p_verdict text,
  p_value text default null,
  p_note text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  baseline_record public.document_baselines%rowtype;
  actor_role public.studio_role;
  new_id uuid;
begin
  if p_verdict not in ('confirmed', 'corrected', 'kept_open') then
    raise exception 'A review confirms, corrects, or keeps the line open';
  end if;
  if nullif(trim(coalesce(p_line_key, '')), '') is null then
    raise exception 'A review names the line it reviews';
  end if;
  if p_verdict in ('confirmed', 'corrected') and nullif(trim(coalesce(p_value, '')), '') is null then
    raise exception 'A confirmation states the value the reviewer stands behind';
  end if;

  select * into baseline_record from public.document_baselines where id = p_baseline_id;
  if baseline_record.id is null then
    raise exception 'That plan baseline is not in the record';
  end if;

  actor_role := public.property_role(baseline_record.property_id);
  if actor_role is null or actor_role not in ('owner', 'admin', 'reviewer', 'project_manager') then
    raise exception 'Line review is for a qualified reviewer on this project';
  end if;

  -- One active review per line. History supersedes, never disappears.
  update public.takeoff_line_reviews
  set state = 'superseded'
  where baseline_id = p_baseline_id and kind = 'wood_framing'
    and line_key = trim(p_line_key) and state = 'active';

  insert into public.takeoff_line_reviews (
    organization_id, property_id, baseline_id, line_key,
    verdict, value, note, reviewer_role, reviewed_by
  ) values (
    baseline_record.organization_id, baseline_record.property_id, p_baseline_id, trim(p_line_key),
    p_verdict, nullif(trim(coalesce(p_value, '')), ''), nullif(trim(coalesce(p_note, '')), ''),
    actor_role, auth.uid()
  ) returning id into new_id;

  insert into public.audit_events (
    organization_id, actor_id, action, entity_type, entity_id, detail
  ) values (
    baseline_record.organization_id, auth.uid(), 'takeoff_line.reviewed',
    'takeoff_line_review', new_id::text,
    jsonb_build_object(
      'property_id', baseline_record.property_id,
      'baseline_id', p_baseline_id,
      'line_key', trim(p_line_key),
      'verdict', p_verdict,
      'reviewer_role', actor_role
    )
  );

  return new_id;
end;
$$;

comment on function public.review_takeoff_line(uuid, text, text, text, text) is
  'A qualified reviewer confirms, corrects, or keeps open one takeoff line. The only door to HUMAN_CONFIRMED.';

revoke all on function public.review_takeoff_line(uuid, text, text, text, text) from public;
grant execute on function public.review_takeoff_line(uuid, text, text, text, text) to authenticated;

-- Said in the record itself: an accepted takeoff is a working baseline.
comment on function public.approve_material_takeoff(uuid, text, jsonb, jsonb, jsonb, integer, text, text, jsonb) is
  'The owner accepts the AI takeoff as the project''s working baseline (OWNER_ACCEPTED_BASELINE). It never marks a value human-confirmed; that takes review_takeoff_line.';
