-- ═══════════════════════════════════════════════════════════════════════════
-- 065 · THE WATCHDOG AND THE DOOR SHARE ONE SECRET, AND NEITHER HOLDS IT
--
-- 060 built the watchdog to knock with the value of a Vault secret it names,
-- and deliberately stored only the NAME. It left one thing unfinished: the
-- door on the other side had no way to recognise that secret. It knew two
-- credentials — a secret set in the function's own environment, and the
-- platform's service-role key — and setting either of those is an act nobody
-- can perform from inside the database, which is where the watchdog lives.
--
-- So the door is given a third way to recognise a caller, and it is the one
-- that needs no environment at all: ASK THE RECORD. The door is already
-- connected to it. The secret stays in Vault, the answer that comes back is
-- true or false, and the value is never returned, logged or compared outside
-- the database.
--
-- WHAT THIS IS NOT. It is not a second credential to keep in step: it is the
-- SAME one, named once in `core_v2_runner_settings.secret_name`. Rotating it
-- is one write to Vault. And it is not a way in for anybody else — the
-- function below is the service role's alone, and a caller who cannot reach
-- the record cannot ask it anything.
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function public.core_v2_runner_secret_matches(p_offered text)
returns boolean language plpgsql stable security definer
-- `extensions` is on the path because that is where this platform keeps
-- pgcrypto, and `digest` below is its function.
set search_path = public, extensions, pg_temp as $$
declare
  settings public.core_v2_runner_settings;
  held text;
  ok boolean := false;
begin
  if p_offered is null or length(p_offered) < 16 then
    return false;
  end if;
  select * into settings from public.core_v2_runner_settings where id;
  if not found or settings.secret_name is null then
    return false;
  end if;
  if to_regclass('vault.decrypted_secrets') is null then
    return false;
  end if;
  execute format(
    'select decrypted_secret from vault.decrypted_secrets where name = %L limit 1', settings.secret_name
  ) into held;
  if held is null then
    return false;
  end if;
  -- Same length and same bytes, and the comparison is of digests so the value
  -- itself is never reconstructed from a timing difference in this function.
  ok := (length(held) = length(p_offered))
        and encode(digest(held, 'sha256'), 'hex') = encode(digest(p_offered, 'sha256'), 'hex');
  return ok;
end;
$$;

comment on function public.core_v2_runner_secret_matches(text) is
  'Whether a caller offered the runner secret the watchdog knocks with. Answers true or false and never returns the value. The secret lives in Vault under the name core_v2_runner_settings.secret_name; nothing outside the database ever holds a copy.';

revoke all on function public.core_v2_runner_secret_matches(text) from public, anon, authenticated;
grant execute on function public.core_v2_runner_secret_matches(text) to service_role;
