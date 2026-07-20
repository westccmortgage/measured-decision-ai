-- Enables authorized Studio users to correct evidence metadata and room assignment.
-- Apply after 001_spatial_studio.sql.

create policy evidence_update on public.evidence_items
for update
using (
  public.has_org_role(
    organization_id,
    array['owner','admin','reviewer','contributor']::public.studio_role[]
  )
)
with check (
  public.has_org_role(
    organization_id,
    array['owner','admin','reviewer','contributor']::public.studio_role[]
  )
);
