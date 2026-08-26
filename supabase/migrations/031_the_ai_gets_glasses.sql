-- The AI gets glasses.
--
-- Three analysis runs in a row reported printed facts as "not printed": a
-- finish legend in 3/32" text, drawn pile marks, a joist schedule. The cause
-- was never the reading rules — the provider rasterises an E-size sheet at a
-- resolution where that text simply is not in the pixels.
--
-- The browser now renders every plan page at drawing-desk resolution before
-- analysis and stores the tiles as derived copies next to the documents —
-- originals untouched, under their own page-renders/ prefix. This table is
-- the record that a document's pages were rendered, by whom, and at what
-- resolution, so analysis can find the tiles and nobody renders twice.

-- Tiles are JPEGs in the same governed bucket the plans live in.
update storage.buckets
set allowed_mime_types = array['application/pdf', 'image/jpeg']
where id = 'project-documents';

create table if not exists public.plan_page_renders (
  document_id uuid primary key references public.project_documents(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  property_id uuid not null references public.properties(id) on delete cascade,
  pages integer not null check (pages > 0),
  target_dpi integer not null check (target_dpi between 72 and 600),
  rendered_by uuid not null default auth.uid() references auth.users(id),
  rendered_at timestamptz not null default now()
);

comment on table public.plan_page_renders is
  'High-resolution page tiles rendered from a plan PDF before AI analysis. Derived copies; the original document is never altered.';

alter table public.plan_page_renders enable row level security;

drop policy if exists plan_page_renders_read on public.plan_page_renders;
create policy plan_page_renders_read on public.plan_page_renders for select
using (public.is_org_member(organization_id));

-- The same people who may put a plan into the project may render its pages —
-- mirrored from the project-documents storage insert policy.
drop policy if exists plan_page_renders_insert on public.plan_page_renders;
create policy plan_page_renders_insert on public.plan_page_renders for insert
with check (
  exists (
    select 1 from public.organization_members m
    where m.organization_id = plan_page_renders.organization_id
      and m.user_id = auth.uid() and m.role in ('owner', 'admin', 'contributor')
  )
  and exists (
    select 1 from public.project_documents d
    where d.id = plan_page_renders.document_id
      and d.organization_id = plan_page_renders.organization_id
      and d.property_id = plan_page_renders.property_id
  )
);
