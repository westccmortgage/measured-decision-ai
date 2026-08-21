-- Findings from Supabase's own database linter, on functions this project added.
--
-- Every function in `public` is published as a REST endpoint. That is fine for
-- the ones meant to be called and pointless for the ones that are not: a trigger
-- function has no business being reachable at /rest/v1/rpc/, and the fewer
-- things answer at all, the less there is to probe.
--
-- Verified first, because getting this wrong would break every write: PostgreSQL
-- does not check EXECUTE privilege when a trigger fires. Revoking it removes the
-- REST endpoint and leaves the trigger working. supabase/tests asserts both.

-- A function without an explicit search_path resolves names using whatever the
-- caller's search_path happens to be. This one references nothing at all, so the
-- empty path is both the safest and the most honest setting.
create or replace function public.audit_events_are_append_only()
returns trigger language plpgsql set search_path = '' as $$
begin
  raise exception 'audit_events is append-only: an entry cannot be edited or removed, and this includes cascades. Retire an organization by other means rather than erasing its history.';
end; $$;

revoke all on function public.audit_events_are_append_only() from public, anon, authenticated;
revoke all on function public.guard_evidence_deletion() from public, anon, authenticated;
revoke all on function public.guard_property_deletion() from public, anon, authenticated;
revoke all on function public.guard_space_deletion() from public, anon, authenticated;
revoke all on function public.audit_decision_change() from public, anon, authenticated;
revoke all on function public.audit_analysis_state() from public, anon, authenticated;
revoke all on function public.audit_release_state() from public, anon, authenticated;
revoke all on function public.audit_membership_change() from public, anon, authenticated;

-- Nothing signed out has any use for these; they answer questions about
-- auth.uid(), which for a signed-out caller is nobody.
revoke all on function public.can_access_property(uuid) from public, anon;
revoke all on function public.property_role(uuid) from public, anon;
grant execute on function public.can_access_property(uuid) to authenticated;
grant execute on function public.property_role(uuid) to authenticated;

-- is_org_member, has_org_role and is_studio_member are deliberately left alone.
-- They are evaluated inside row-level security policies, and a policy expression
-- runs with the privileges of whoever is querying — revoking EXECUTE would make
-- every read fail rather than return nothing. They disclose nothing on their
-- own: each answers only about the caller's own identity.

-- These two tables have row-level security on and no policies, which the linter
-- reports and which is the intended configuration: deny everything to every
-- client, and let only the service role — which bypasses RLS — near them. Said
-- out loud here so the next person does not "fix" it by adding a policy.
comment on table public.project_intake_settings is
  'Deny-all by design: RLS on, no policies. Only the project-intake Edge Function, which holds the service key, may read this.';
comment on table public.project_intake_rate_limits is
  'Deny-all by design: RLS on, no policies. A client that could read this could see how close it is to a limit, which is exactly what a client guessing project codes would want to know.';
