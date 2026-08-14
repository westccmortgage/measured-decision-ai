do $$
declare source_record record;
begin
  for source_record in
    select id from public.evidence_items
    where lower(original_filename) like '%.insv'
    order by created_at
  loop
    perform public.reconcile_insta360_capture(source_record.id);
  end loop;
end; $$;
