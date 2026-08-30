-- 044 · The period pass.
--
-- The record could answer "how does this project stand" but never "what
-- happened between these two dates". Every number it held was cumulative,
-- so the question an owner actually asks every week — what arrived, what
-- went in, what is sitting on site that nobody has installed — had no
-- answer in the system at all.
--
-- Four things this returns, and not one of them is invented:
--
--   arrived        delivery documents read in the window, by component
--   installed      what the capture could confirm went in, in the window
--   on_site        delivered across all time minus installed across all
--                  time: material bought and not yet in the building
--   awaiting       requirements with no installed evidence, ever
--
-- Plus the plan's own phase order with what each phase says must be
-- captured before it is concealed. That is the honest forward look: the
-- drawings' own sequence, not a forecast this system is in no position to
-- make. There is deliberately no budget here and no projection of spend —
-- the record holds no budget, and inventing one would be the exact failure
-- this product exists to refuse.
--
-- on_site is the number post-audit conversations kept circling: "bought is
-- not installed" stops being a slogan the moment the difference is a row.

create or replace function public.reconcile_period(
  p_property_id uuid,
  p_since timestamptz default now() - interval '7 days',
  p_until timestamptz default now()
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  property_record public.properties%rowtype;
  actor_role public.studio_role;
  arrived jsonb;
  installed jsonb;
  on_site jsonb;
  awaiting jsonb;
  phase_order jsonb;
  latest_baseline uuid;
begin
  select * into property_record from public.properties where id = p_property_id;
  if property_record.id is null then
    raise exception 'That project is not in the record';
  end if;
  actor_role := public.property_role(p_property_id);
  if actor_role is null or actor_role not in ('owner', 'admin', 'reviewer', 'project_manager') then
    raise exception 'The period pass is for the people who run the project';
  end if;
  if p_until < p_since then
    raise exception 'A period ends after it begins';
  end if;

  -- What the delivery documents said arrived inside the window.
  select coalesce(jsonb_agg(row_to_json(entry) order by entry.component_key), '[]'::jsonb)
    into arrived
  from (
    select component_key,
           sum(coalesce(quantity, 0)) as quantity,
           count(*) as documents,
           min(confidence) as weakest_confidence
      from public.project_observations
     where property_id = p_property_id
       and state = 'active'
       and kind = 'delivered_documented'
       and observed_at >= p_since and observed_at <= p_until
     group by component_key
  ) entry;

  -- What the capture could confirm went in, inside the window. Absence here
  -- is not absence on site: a component nobody could identify in a frame is
  -- simply not counted, which is why it never becomes a zero.
  select coalesce(jsonb_agg(row_to_json(entry) order by entry.component_key), '[]'::jsonb)
    into installed
  from (
    select component_key,
           sum(coalesce(quantity, 0)) as quantity,
           count(*) as observations,
           min(confidence) as weakest_confidence
      from public.project_observations
     where property_id = p_property_id
       and state = 'active'
       and kind = 'installed_seen'
       and observed_at >= p_since and observed_at <= p_until
     group by component_key
  ) entry;

  -- Bought and not yet in the building. Cumulative on purpose: material
  -- delivered in March and still stacked in June is exactly the thing this
  -- number exists to make impossible to miss.
  select coalesce(jsonb_agg(row_to_json(entry) order by entry.component_key), '[]'::jsonb)
    into on_site
  from (
    select component_key,
           delivered_total,
           installed_total,
           delivered_total - installed_total as difference
      from (
        select component_key,
               sum(case when kind = 'delivered_documented' then coalesce(quantity, 0) else 0 end) as delivered_total,
               sum(case when kind = 'installed_seen' then coalesce(quantity, 0) else 0 end) as installed_total
          from public.project_observations
         where property_id = p_property_id
           and state = 'active'
           and kind in ('delivered_documented', 'installed_seen')
           and observed_at <= p_until
         group by component_key
      ) totals
     where delivered_total - installed_total > 0
  ) entry;

  -- Required by the documents, and never once seen installed.
  select coalesce(jsonb_agg(row_to_json(entry) order by entry.component_key), '[]'::jsonb)
    into awaiting
  from (
    select r.component_key,
           r.description,
           r.quantity as required_quantity,
           r.unit,
           r.method
      from public.project_requirements r
     where r.property_id = p_property_id
       and r.state = 'active'
       and not exists (
         select 1 from public.project_observations o
          where o.property_id = r.property_id
            and o.state = 'active'
            and o.kind = 'installed_seen'
            and o.component_key = r.component_key
            and o.observed_at <= p_until
       )
  ) entry;

  -- The plan's own order, and what each phase says must be captured before
  -- it is hidden. This is a forward look the drawings authorise; it is not
  -- a forecast, and it never claims a date.
  select id into latest_baseline
    from public.document_baselines
   where property_id = p_property_id
   order by version desc
   limit 1;

  select coalesce(jsonb_agg(row_to_json(entry) order by entry.sequence), '[]'::jsonb)
    into phase_order
  from (
    select p.sequence,
           p.code,
           p.name,
           p.starts_when,
           p.ends_when,
           p.concealment_risk,
           (select count(*) from public.capture_requirements c
             where c.phase_id = p.id) as capture_requirements,
           (select count(*) from public.capture_requirements c
             where c.phase_id = p.id and c.priority in ('critical', 'high')) as before_concealment
      from public.construction_phases p
     where p.baseline_id = latest_baseline
  ) entry;

  return jsonb_build_object(
    'property_id', p_property_id,
    'since', p_since,
    'until', p_until,
    'arrived', arrived,
    'installed', installed,
    'on_site_not_installed', on_site,
    'awaiting_evidence', awaiting,
    'plan_sequence', phase_order,
    'doctrine', 'Counted from the record. A delivery document is never proof of installation, '
      || 'and a component the capture could not identify is not counted rather than counted as zero. '
      || 'This pass holds no budget and makes no forecast.'
  );
end;
$$;

comment on function public.reconcile_period(uuid, timestamptz, timestamptz) is
  'What happened between two dates: what arrived, what went in, what is on site and not installed, what is still awaiting evidence, and the plan''s own phase order. No budget, no forecast — the record holds neither.';

revoke all on function public.reconcile_period(uuid, timestamptz, timestamptz) from public, anon;
grant execute on function public.reconcile_period(uuid, timestamptz, timestamptz) to authenticated;
