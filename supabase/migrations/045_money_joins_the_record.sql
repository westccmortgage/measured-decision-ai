-- 045 · Money joins the record.
--
-- Two kinds of human decision were being kept in a browser. Costs entered
-- against a trade, and a person's ruling that an observation belongs to a
-- different trade than the dictionary guessed — both written to
-- localStorage under a per-property key, and nowhere else.
--
-- That is a hole in the doctrine, not a missing feature. The product
-- promises provenance on every value and a record that outlives the
-- session; a figure a person entered against the work was visible to
-- nobody else, absent from the project record export, outside every audit,
-- and gone the moment a cache was cleared. The manifest claimed
-- "provenance on every value" while the money values were not in the
-- record at all.
--
-- Money is also the one thing on this project that must not be visible to
-- everybody who can see the building. A field contributor records what
-- they saw; they have no business seeing what it cost. An external owner
-- viewer sees an approved release, not the ledger. So both tables are
-- readable only by the four roles that run the project, enforced in the
-- policy rather than in the screen.
--
-- The AI writes nothing here, and cannot: every row names the person who
-- entered it. That was already the rule in the code; now it is the rule in
-- the database.

create table if not exists public.project_costs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  property_id uuid not null references public.properties(id) on delete cascade,
  -- The trade this money was recorded against, in the vocabulary the
  -- Studio already speaks: 'electrical', 'framing', and the rest.
  trade text not null,
  amount numeric,
  currency text not null default 'USD',
  invoice_ref text,
  -- The document this figure came off, when there is one. Deleting the
  -- evidence must never silently delete the money.
  document_evidence_id uuid references public.evidence_items(id) on delete set null,
  note text,
  recorded_by uuid not null references auth.users(id),
  recorded_at timestamptz not null default now(),
  state text not null default 'active' check (state in ('active', 'superseded')),
  created_at timestamptz not null default now()
);

create index if not exists project_costs_lookup
  on public.project_costs(property_id, state, trade);

-- A person overruling the trade dictionary for one observation. The code
-- already said this correction "outranks it forever after"; forever is
-- longer than a browser cache.
create table if not exists public.project_trade_corrections (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  property_id uuid not null references public.properties(id) on delete cascade,
  observation_key text not null,
  trade text not null,
  corrected_by uuid not null references auth.users(id),
  corrected_at timestamptz not null default now(),
  state text not null default 'active' check (state in ('active', 'superseded')),
  created_at timestamptz not null default now()
);

create unique index if not exists project_trade_corrections_one_live
  on public.project_trade_corrections(property_id, observation_key)
  where state = 'active';

alter table public.project_costs enable row level security;
alter table public.project_trade_corrections enable row level security;

-- Reading money is not the same as reading the building.
drop policy if exists project_costs_read on public.project_costs;
create policy project_costs_read on public.project_costs for select
using (public.property_role(property_id) in ('owner', 'admin', 'reviewer', 'project_manager'));

drop policy if exists project_trade_corrections_read on public.project_trade_corrections;
create policy project_trade_corrections_read on public.project_trade_corrections for select
using (public.property_role(property_id) in ('owner', 'admin', 'reviewer', 'project_manager'));

create or replace function public.record_project_cost(
  p_property_id uuid,
  p_trade text,
  p_amount numeric default null,
  p_currency text default 'USD',
  p_invoice_ref text default null,
  p_document_evidence_id uuid default null,
  p_note text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  property_record public.properties%rowtype;
  actor_role public.studio_role;
  new_id uuid;
begin
  select * into property_record from public.properties where id = p_property_id;
  if property_record.id is null then
    raise exception 'That project is not in the record';
  end if;
  actor_role := public.property_role(p_property_id);
  if actor_role is null or actor_role not in ('owner', 'admin', 'reviewer', 'project_manager') then
    raise exception 'Money is recorded by the people who run the project';
  end if;
  if coalesce(trim(p_trade), '') = '' then
    raise exception 'A cost names the trade it was recorded against';
  end if;
  /* An entry that says nothing is not an entry. A figure, a reference or a
     document — at least one, or there is nothing to record. */
  if p_amount is null and coalesce(trim(p_invoice_ref), '') = '' and p_document_evidence_id is null then
    raise exception 'A cost entry carries an amount, an invoice reference, or a document';
  end if;
  if p_amount is not null and p_amount < 0 then
    raise exception 'A recorded cost is not negative';
  end if;

  insert into public.project_costs(organization_id, property_id, trade, amount, currency,
    invoice_ref, document_evidence_id, note, recorded_by)
  values (property_record.organization_id, p_property_id, trim(p_trade), p_amount,
    coalesce(nullif(trim(p_currency), ''), 'USD'), nullif(trim(p_invoice_ref), ''),
    p_document_evidence_id, nullif(trim(p_note), ''), auth.uid())
  returning id into new_id;
  return new_id;
end;
$$;

comment on function public.record_project_cost(uuid, text, numeric, text, text, uuid, text) is
  'Records one cost entry against a trade. Every row names the person who entered it; the AI never writes here.';

create or replace function public.supersede_project_cost(p_cost_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  cost_record public.project_costs%rowtype;
  actor_role public.studio_role;
begin
  select * into cost_record from public.project_costs where id = p_cost_id;
  if cost_record.id is null then
    raise exception 'That cost entry is not in the record';
  end if;
  actor_role := public.property_role(cost_record.property_id);
  if actor_role is null or actor_role not in ('owner', 'admin', 'project_manager') then
    raise exception 'Withdrawing a cost entry is for the people who run the project';
  end if;
  /* Superseded, never deleted: a figure that was once entered against this
     project is part of what happened, even after somebody corrected it. */
  update public.project_costs set state = 'superseded' where id = p_cost_id;
  return true;
end;
$$;

comment on function public.supersede_project_cost(uuid) is
  'Withdraws a cost entry by superseding it. Nothing is deleted — a figure once entered is part of what happened.';

create or replace function public.correct_observation_trade(
  p_property_id uuid,
  p_observation_key text,
  p_trade text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  property_record public.properties%rowtype;
  actor_role public.studio_role;
  new_id uuid;
begin
  select * into property_record from public.properties where id = p_property_id;
  if property_record.id is null then
    raise exception 'That project is not in the record';
  end if;
  actor_role := public.property_role(p_property_id);
  if actor_role is null or actor_role not in ('owner', 'admin', 'reviewer', 'project_manager') then
    raise exception 'Overruling the trade dictionary is for the people who run the project';
  end if;
  if coalesce(trim(p_observation_key), '') = '' or coalesce(trim(p_trade), '') = '' then
    raise exception 'A correction names the observation and the trade';
  end if;

  update public.project_trade_corrections
     set state = 'superseded'
   where property_id = p_property_id
     and observation_key = trim(p_observation_key)
     and state = 'active';

  insert into public.project_trade_corrections(organization_id, property_id, observation_key, trade, corrected_by)
  values (property_record.organization_id, p_property_id, trim(p_observation_key), trim(p_trade), auth.uid())
  returning id into new_id;
  return new_id;
end;
$$;

comment on function public.correct_observation_trade(uuid, text, text) is
  'A person overrules the trade dictionary for one observation. The previous correction is superseded, never erased.';

revoke all on function public.record_project_cost(uuid, text, numeric, text, text, uuid, text) from public, anon;
revoke all on function public.supersede_project_cost(uuid) from public, anon;
revoke all on function public.correct_observation_trade(uuid, text, text) from public, anon;
grant execute on function public.record_project_cost(uuid, text, numeric, text, text, uuid, text) to authenticated;
grant execute on function public.supersede_project_cost(uuid) to authenticated;
grant execute on function public.correct_observation_trade(uuid, text, text) to authenticated;
