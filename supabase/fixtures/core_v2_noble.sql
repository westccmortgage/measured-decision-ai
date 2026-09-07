-- Noble, as Core V2 will hold it — with nothing of Noble in it.
--
-- The acceptance project is three structural sheets: S-2, S-3 and S-4. This
-- fixture builds their V2 shape — page identities and the semantic regions a
-- cartographer would find on them — out of invented geometry and invented
-- hashes. No client drawing, no rendered page, and no provider response is in
-- this file or is reachable from it. What it gives a test is the thing under
-- test: a source an anchor can point at.
--
-- Load it into a session and call it:
--
--     \ir supabase/fixtures/core_v2_noble.sql
--     select pg_temp.core_v2_noble_fixture(
--       'organisation uuid', 'property uuid', 'document uuid');
--
-- It lives in pg_temp on purpose: a fixture that survives the session it was
-- loaded in would eventually be mistaken for data.

create or replace function pg_temp.core_v2_noble_fixture(
  p_organization_id uuid, p_property_id uuid, p_document_id uuid
) returns void language plpgsql as $$
begin
  -- Three pages of one document revision. The page index is physical; the
  -- printed sheet number is what a person reads in the title block, and the
  -- two are not the same fact — S-2 is the 24th page of the submittal set it
  -- came from.
  insert into public.source_pages(
    id, organization_id, property_id, document_id, page_index,
    printed_sheet_number, printed_sheet_title, discipline,
    page_width, page_height, render_path, content_hash, metadata)
  values
    ('0a0e0002-0000-0000-0000-000000000000', p_organization_id, p_property_id, p_document_id, 0,
     'S-2', 'FOUNDATION PLAN', 'structural', 1726, 2591,
     'fixture/noble/s-2.jpg', 'fixture-page-hash-s2',
     jsonb_build_object('fixture', true, 'rotate', 270, 'page_in_submittal_set', 24)),
    ('0a0e0003-0000-0000-0000-000000000000', p_organization_id, p_property_id, p_document_id, 1,
     'S-3', 'FLOOR FRAMING PLAN', 'structural', 1726, 2591,
     'fixture/noble/s-3.jpg', 'fixture-page-hash-s3',
     jsonb_build_object('fixture', true, 'rotate', 270, 'page_in_submittal_set', 25)),
    ('0a0e0004-0000-0000-0000-000000000000', p_organization_id, p_property_id, p_document_id, 2,
     'S-4', 'ROOF FRAMING PLAN', 'structural', 1726, 2591,
     'fixture/noble/s-4.jpg', 'fixture-page-hash-s4',
     jsonb_build_object('fixture', true, 'rotate', 270, 'page_in_submittal_set', 26));

  -- The regions a sheet cartographer would return: where the schedule is,
  -- where the plan is, where the legend and the general notes are. Boxes are
  -- normalised, so they mean the same thing at any rendering resolution.
  insert into public.page_regions(
    id, organization_id, property_id, page_id, region_kind, label, bbox, rotation,
    crop_path, region_hash, identified_by, status)
  values
    ('0b0e0002-0000-0000-0000-000000000001', p_organization_id, p_property_id,
     '0a0e0002-0000-0000-0000-000000000000', 'schedule', 'FOOTING SCHEDULE',
     '[0.62,0.06,0.97,0.34]'::jsonb, 0, 'fixture/noble/s-2-schedule.jpg',
     'fixture-region-s2-schedule', 'deterministic', 'accepted'),
    ('0b0e0002-0000-0000-0000-000000000002', p_organization_id, p_property_id,
     '0a0e0002-0000-0000-0000-000000000000', 'plan_view', 'FOUNDATION PLAN',
     '[0.04,0.08,0.60,0.92]'::jsonb, 0, 'fixture/noble/s-2-plan.jpg',
     'fixture-region-s2-plan', 'deterministic', 'accepted'),
    ('0b0e0002-0000-0000-0000-000000000003', p_organization_id, p_property_id,
     '0a0e0002-0000-0000-0000-000000000000', 'title_block', null,
     '[0.86,0.80,0.99,0.99]'::jsonb, 0, 'fixture/noble/s-2-title.jpg',
     'fixture-region-s2-title', 'deterministic', 'accepted'),
    ('0b0e0003-0000-0000-0000-000000000001', p_organization_id, p_property_id,
     '0a0e0003-0000-0000-0000-000000000000', 'schedule', 'HEADER SCHEDULE',
     '[0.63,0.05,0.98,0.30]'::jsonb, 0, 'fixture/noble/s-3-schedule.jpg',
     'fixture-region-s3-schedule', 'deterministic', 'accepted'),
    ('0b0e0003-0000-0000-0000-000000000002', p_organization_id, p_property_id,
     '0a0e0003-0000-0000-0000-000000000000', 'plan_view', 'FLOOR FRAMING PLAN',
     '[0.04,0.08,0.60,0.92]'::jsonb, 0, 'fixture/noble/s-3-plan.jpg',
     'fixture-region-s3-plan', 'deterministic', 'accepted'),
    ('0b0e0003-0000-0000-0000-000000000003', p_organization_id, p_property_id,
     '0a0e0003-0000-0000-0000-000000000000', 'legend', 'FRAMING LEGEND',
     '[0.63,0.32,0.98,0.52]'::jsonb, 0, 'fixture/noble/s-3-legend.jpg',
     'fixture-region-s3-legend', 'deterministic', 'accepted'),
    ('0b0e0004-0000-0000-0000-000000000001', p_organization_id, p_property_id,
     '0a0e0004-0000-0000-0000-000000000000', 'plan_view', 'ROOF FRAMING PLAN',
     '[0.04,0.08,0.60,0.92]'::jsonb, 0, 'fixture/noble/s-4-plan.jpg',
     'fixture-region-s4-plan', 'deterministic', 'accepted'),
    ('0b0e0004-0000-0000-0000-000000000002', p_organization_id, p_property_id,
     '0a0e0004-0000-0000-0000-000000000000', 'general_notes', 'GENERAL FRAMING NOTES',
     '[0.63,0.05,0.98,0.45]'::jsonb, 0, 'fixture/noble/s-4-notes.jpg',
     'fixture-region-s4-notes', 'deterministic', 'accepted');
end $$;
