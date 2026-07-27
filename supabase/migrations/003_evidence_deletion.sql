-- Enables permanent evidence deletion for organization owners and admins.
-- Apply after 002_evidence_management.sql.

drop policy if exists evidence_delete on public.evidence_items;

create policy evidence_delete on public.evidence_items
for delete
using (
  public.has_org_role(
    organization_id,
    array['owner','admin']::public.studio_role[]
  )
);

drop policy if exists evidence_objects_delete on storage.objects;

create policy evidence_objects_delete on storage.objects
for delete
using (
  bucket_id = 'property-evidence'
  and public.has_org_role(
    (storage.foldername(name))[1]::uuid,
    array['owner','admin']::public.studio_role[]
  )
);
