-- A synthetic source set, as Core V2 holds one — with nothing real in it.
--
-- Two sources and six accepted segments, built from invented locators and
-- invented hashes. No client, no document of anybody's, and no executor
-- response is in this file or is reachable from it. What it gives a test is
-- the thing under test: a source an anchor can point at.
--
-- Load it into a session and call it on a workflow row that names no sources
-- yet — the two it adds become that workflow's source set:
--
--     \ir supabase/fixtures/core_v2_synthetic.sql
--     select pg_temp.core_v2_synthetic_fixture('organisation uuid', 'workflow uuid');
--
-- It lives in pg_temp on purpose: a fixture that survives the session it was
-- loaded in would eventually be mistaken for data.

create or replace function pg_temp.core_v2_synthetic_fixture(
  p_organization_id uuid, p_workflow_id uuid
) returns void language plpgsql as $$
begin
  -- One paged register and one timed recording: the two locator shapes the
  -- kernel compares, so a test can anchor into either.
  insert into public.workflow_sources(
    id, organization_id, workflow_id, ordinal, source_kind, label, uri,
    content_hash, hash_algorithm, byte_size, media)
  values
    ('0a0e0001-0000-0000-0000-000000000000', p_organization_id, p_workflow_id, 0,
     'document', 'synthetic register A', 'fixture://synthetic/register-a',
     'fixture-source-hash-register-a', 'sha-256', 20480,
     jsonb_build_object('fixture', true, 'page_count', 2)),
    ('0a0e0002-0000-0000-0000-000000000000', p_organization_id, p_workflow_id, 1,
     'recording', 'synthetic recording B', 'fixture://synthetic/recording-b',
     'fixture-source-hash-recording-b', 'sha-256', 655360,
     jsonb_build_object('fixture', true, 'duration_ms', 120000));

  -- The segments a discoverer would return: two pages of the register, a table
  -- and a note found on them, and two scenes of the recording. Boxes are
  -- normalised, so they mean the same thing at any rendering resolution.
  insert into public.source_segments(
    id, organization_id, workflow_id, source_id, parent_segment_id, segment_kind, label,
    ordinal, locator, content_hash, status, discovered_by)
  values
    ('0b0e0001-0000-0000-0000-000000000001', p_organization_id, p_workflow_id,
     '0a0e0001-0000-0000-0000-000000000000', null, 'page', 'page 1',
     0, '{"page": 0, "bbox": [0, 0, 1, 1]}'::jsonb,
     'fixture-segment-hash-a-page-1', 'accepted', 'deterministic'),
    ('0b0e0001-0000-0000-0000-000000000002', p_organization_id, p_workflow_id,
     '0a0e0001-0000-0000-0000-000000000000', '0b0e0001-0000-0000-0000-000000000001', 'table', 'table 1',
     0, '{"page": 0, "bbox": [0.55, 0.05, 0.97, 0.40]}'::jsonb,
     'fixture-segment-hash-a-table-1', 'accepted', 'deterministic'),
    ('0b0e0001-0000-0000-0000-000000000003', p_organization_id, p_workflow_id,
     '0a0e0001-0000-0000-0000-000000000000', null, 'page', 'page 2',
     1, '{"page": 1, "bbox": [0, 0, 1, 1]}'::jsonb,
     'fixture-segment-hash-a-page-2', 'accepted', 'deterministic'),
    ('0b0e0001-0000-0000-0000-000000000004', p_organization_id, p_workflow_id,
     '0a0e0001-0000-0000-0000-000000000000', '0b0e0001-0000-0000-0000-000000000003', 'note', 'note 1',
     0, '{"page": 1, "bbox": [0.60, 0.50, 0.98, 0.90]}'::jsonb,
     'fixture-segment-hash-a-note-1', 'accepted', 'deterministic'),
    ('0b0e0002-0000-0000-0000-000000000001', p_organization_id, p_workflow_id,
     '0a0e0002-0000-0000-0000-000000000000', null, 'scene', 'scene 1',
     0, '{"start_ms": 0, "end_ms": 45000}'::jsonb,
     'fixture-segment-hash-b-scene-1', 'accepted', 'deterministic'),
    ('0b0e0002-0000-0000-0000-000000000002', p_organization_id, p_workflow_id,
     '0a0e0002-0000-0000-0000-000000000000', null, 'scene', 'scene 2',
     1, '{"start_ms": 45000, "end_ms": 120000}'::jsonb,
     'fixture-segment-hash-b-scene-2', 'accepted', 'deterministic');
end $$;
