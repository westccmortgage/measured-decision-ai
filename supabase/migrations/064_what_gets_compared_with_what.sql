-- ═══════════════════════════════════════════════════════════════════════════
-- 064 · WHAT GETS COMPARED WITH WHAT
--
-- A reader handed one page can say what is on it. It cannot say whether a set
-- AGREES WITH ITSELF, and a reader handed one frame cannot say whether what
-- the camera saw is what the sheet called for. Those are questions about two
-- pieces of material, and the pair has to be decided before the reading — once,
-- the same for both blind readers, and written down.
--
-- Most pairs are read out of the material: a sheet carries its own number and
-- names the sheets it refers to. Some cannot be: nothing in a video frame says
-- which sheet it belongs to. This column is where the owner's own answer to
-- that lives, and it is the only place a correspondence is ever taken from
-- besides the file itself.
--
-- WHY IT IS SETTLED WITH THE MATERIAL. The pairs a run was started over are
-- written into the workflow's requested scope, which 058 already freezes. This
-- column is the INPUT to that decision, so it is closed at the same moment the
-- files are: changing what should be compared, after a comparison has been
-- made, would leave a result standing on a question nobody asked.
-- ═══════════════════════════════════════════════════════════════════════════

alter table public.analysis_runs
  add column if not exists pairing jsonb not null default '{}'::jsonb;

comment on column public.analysis_runs.pairing is
  'The owner''s own answer to "what should be compared with what": pagePairs, and momentPages naming the sheets a clip is read against. Empty means the material''s own cross-references decide, and where they cannot the place is reported as needing a check rather than paired by guesswork.';

-- ─────────────────────────────────────────── the guard learns one more column
--
-- 063's trigger closes the FILES of a started analysis. This closes the
-- question those files were read to answer. Both are the same rule: a result
-- may not be left standing on inputs that moved underneath it.

create or replace function public.analysis_run_is_settled()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if old.run_requested_at is not null
     and new.pairing is distinct from old.pairing then
    raise exception 'analysis % has already been run; what it compares is settled', old.id
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists analysis_runs_pairing_is_settled on public.analysis_runs;
create trigger analysis_runs_pairing_is_settled before update on public.analysis_runs
  for each row execute function public.analysis_run_is_settled();
