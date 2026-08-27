-- The anonymous door closes.
--
-- The security audit found every action RPC executable by the `anon` role.
-- Each one already refuses a signed-out caller internally — auth.uid() is
-- null, the role lookup fails, the function raises, and 208 invariants
-- prove it — but defense in depth does not lean on one door: a caller with
-- no identity has no business reaching an action function at all, so the
-- EXECUTE grant goes away and the refusal happens at the gate instead of
-- in the hallway.
--
-- Deliberately kept executable by anon: is_org_member, has_org_role and
-- is_studio_member. They are pure membership predicates over auth.uid()
-- (false/empty for a signed-out caller, leaking nothing) and they run
-- inside RLS policies — revoking them would turn every signed-out SELECT
-- into a permission error instead of an honest empty result.
--
-- consume_project_intake_create_slot is called only by the project-intake
-- worker through the service role; no browser role needs it at all.

revoke all on function public.add_space_link(uuid, uuid, text) from public, anon;
grant execute on function public.add_space_link(uuid, uuid, text) to authenticated;

revoke all on function public.approve_document_baseline(uuid) from public, anon;
grant execute on function public.approve_document_baseline(uuid) to authenticated;

revoke all on function public.approve_material_takeoff(uuid, text, jsonb, jsonb, jsonb, integer, text, text, jsonb) from public, anon;
grant execute on function public.approve_material_takeoff(uuid, text, jsonb, jsonb, jsonb, integer, text, text, jsonb) to authenticated;

revoke all on function public.attest_and_approve_document_baseline(uuid, text) from public, anon;
grant execute on function public.attest_and_approve_document_baseline(uuid, text) to authenticated;

revoke all on function public.bootstrap_personal_organization(text) from public, anon;
grant execute on function public.bootstrap_personal_organization(text) to authenticated;

revoke all on function public.consume_project_intake_create_slot(text, integer) from public, anon, authenticated;
grant execute on function public.consume_project_intake_create_slot(text, integer) to service_role;

revoke all on function public.derive_capture_coverage(uuid) from public, anon;
grant execute on function public.derive_capture_coverage(uuid) to authenticated;

revoke all on function public.extract_project_requirements(uuid) from public, anon;
grant execute on function public.extract_project_requirements(uuid) to authenticated;

revoke all on function public.lift_capture_waiver(uuid, text) from public, anon;
grant execute on function public.lift_capture_waiver(uuid, text) to authenticated;

revoke all on function public.link_evidence_to_capture_task(uuid, uuid[]) from public, anon;
grant execute on function public.link_evidence_to_capture_task(uuid, uuid[]) to authenticated;

revoke all on function public.move_evidence_to_room(uuid, uuid, text) from public, anon;
grant execute on function public.move_evidence_to_room(uuid, uuid, text) to authenticated;

revoke all on function public.owner_report_data(uuid, timestamptz) from public, anon;
grant execute on function public.owner_report_data(uuid, timestamptz) to authenticated;

revoke all on function public.project_files(uuid) from public, anon;
grant execute on function public.project_files(uuid) to authenticated;

revoke all on function public.project_space_links(uuid) from public, anon;
grant execute on function public.project_space_links(uuid) to authenticated;

revoke all on function public.reconcile_project(uuid) from public, anon;
grant execute on function public.reconcile_project(uuid) to authenticated;

revoke all on function public.record_observation(uuid, text, text, numeric, uuid, uuid[], text, text, text, text) from public, anon;
grant execute on function public.record_observation(uuid, text, text, numeric, uuid, uuid[], text, text, text, text) to authenticated;

revoke all on function public.record_vision_counts(uuid, uuid, uuid[], jsonb) from public, anon;
grant execute on function public.record_vision_counts(uuid, uuid, uuid[], jsonb) to authenticated;

revoke all on function public.review_space_link(uuid, text, text) from public, anon;
grant execute on function public.review_space_link(uuid, text, text) to authenticated;

revoke all on function public.review_takeoff_line(uuid, text, text, text, text) from public, anon;
grant execute on function public.review_takeoff_line(uuid, text, text, text, text) to authenticated;

revoke all on function public.waive_capture_phase(uuid, uuid, text, text) from public, anon;
grant execute on function public.waive_capture_phase(uuid, uuid, text, text) to authenticated;

revoke all on function public.waive_capture_task(uuid, text, text) from public, anon;
grant execute on function public.waive_capture_task(uuid, text, text) to authenticated;
