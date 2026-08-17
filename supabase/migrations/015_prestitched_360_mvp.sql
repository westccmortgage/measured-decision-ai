-- MVP path: a full 2:1 equirectangular MP4 exported in Insta360 Studio is
-- already a VR master. Register it against the protected INSV capture group
-- without requiring the licensed GPU stitching worker.

create or replace function public.reconcile_prestitched_360(p_evidence_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_evidence public.evidence_items%rowtype;
  v_filename text;
  v_capture_key text;
  v_group_id uuid;
  v_source_ids uuid[];
  v_width integer;
  v_height integer;
begin
  select * into v_evidence from public.evidence_items where id = p_evidence_id;
  if not found then raise exception 'Evidence source not found'; end if;

  v_filename := lower(v_evidence.original_filename);
  v_width := nullif(v_evidence.source_metadata->>'width', '')::integer;
  v_height := nullif(v_evidence.source_metadata->>'height', '')::integer;

  if v_filename !~ '\.(mp4|mov|m4v)$'
     or coalesce(v_evidence.source_metadata->>'projection', '') <> 'equirectangular'
     or v_width is null or v_height is null
     or (v_width::numeric / greatest(v_height, 1)) not between 1.9 and 2.1 then
    return null;
  end if;

  -- Insta360 Studio normally keeps the camera filename. Normalizing an
  -- optional _00_/_10_ lens marker reconnects the export to its INSV pair.
  v_capture_key := regexp_replace(v_filename, '\.(mp4|mov|m4v)$', '');
  v_capture_key := regexp_replace(v_capture_key, '_(00|10)_([0-9]+)$', '_\2');

  select id, source_evidence_ids into v_group_id, v_source_ids
  from public.capture_360_groups
  where property_id = v_evidence.property_id and capture_key = v_capture_key
  for update;

  if v_group_id is null then
    insert into public.capture_360_groups (
      organization_id, property_id, space_id, project_intake_access_id,
      capture_key, camera_format, expected_source_count, source_evidence_ids,
      state, processing_profile
    ) values (
      v_evidence.organization_id, v_evidence.property_id, v_evidence.space_id,
      v_evidence.project_intake_access_id, v_capture_key, 'prestitched-equirectangular',
      1, array[p_evidence_id], 'vr_ready',
      jsonb_build_object(
        'projection', 'equirectangular', 'aspect_ratio', '2:1',
        'video_codec', 'source', 'stabilization', 'exported-in-insta360-studio',
        'vr_target', 'apple-projected-media', 'processing_mode', 'serverless-mvp'
      )
    ) returning id into v_group_id;
  else
    update public.capture_360_groups
    set source_evidence_ids = case
          when p_evidence_id = any(source_evidence_ids) then source_evidence_ids
          else array_append(source_evidence_ids, p_evidence_id)
        end,
        state = 'vr_ready',
        processing_profile = processing_profile || jsonb_build_object(
          'processing_mode', 'serverless-mvp',
          'stabilization', 'exported-in-insta360-studio'
        ),
        updated_at = now()
    where id = v_group_id;
  end if;

  insert into public.capture_360_jobs (
    organization_id, property_id, capture_group_id, state, progress, stage,
    output_manifest, error_code
  ) values (
    v_evidence.organization_id, v_evidence.property_id, v_group_id,
    'completed', 100, 'VR master received',
    jsonb_build_object(
      'vr_master', jsonb_build_object(
        'evidence_id', v_evidence.id,
        'bucket', v_evidence.storage_bucket,
        'object_key', v_evidence.storage_path,
        'projection', 'equirectangular',
        'width', v_width,
        'height', v_height,
        'codec', coalesce(v_evidence.source_metadata->>'codec', 'source')
      ),
      'processing_mode', 'serverless-mvp',
      'source_originals_preserved', true
    ),
    null
  )
  on conflict (capture_group_id) do update
  set state = 'completed', progress = 100, stage = 'VR master received',
      output_manifest = excluded.output_manifest, error_code = null,
      updated_at = now();

  return v_group_id;
end;
$$;

revoke all on function public.reconcile_prestitched_360(uuid) from public, anon, authenticated;
grant execute on function public.reconcile_prestitched_360(uuid) to service_role;
