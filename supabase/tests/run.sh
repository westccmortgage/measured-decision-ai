#!/usr/bin/env bash
# Apply every migration to a throwaway PostgreSQL and assert the security
# invariants against it. No network, no Supabase account.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PGBIN="${PGBIN:-/usr/lib/postgresql/16/bin}"
WORK="${WORK:-/var/tmp/mdai-pgtest}"
PORT="${PORT:-5433}"

[ -x "$PGBIN/initdb" ] || { echo "PostgreSQL 16 not found at $PGBIN. Set PGBIN."; exit 1; }

# initdb refuses to run as root, which is how this often runs in a container.
RUNAS=""
if [ "$(id -u)" = "0" ]; then
  id pgtest >/dev/null 2>&1 || useradd -m pgtest
  RUNAS="pgtest"
fi

cleanup() {
  ${RUNAS:+su -s /bin/bash "$RUNAS" -c} "$PGBIN/pg_ctl -D $WORK/data stop -m immediate" >/dev/null 2>&1 || true
}
trap cleanup EXIT

rm -rf "$WORK"; mkdir -p "$WORK"
[ -n "$RUNAS" ] && chown -R "$RUNAS" "$WORK"
run() { if [ -n "$RUNAS" ]; then su -s /bin/bash "$RUNAS" -c "$1"; else bash -c "$1"; fi; }

run "$PGBIN/initdb -D $WORK/data -U mdai --auth=trust" >/dev/null
# Unix socket only: this cluster must not be reachable from anywhere.
run "$PGBIN/pg_ctl -D $WORK/data -o '-k $WORK -p $PORT -c listen_addresses=' -l $WORK/pg.log start" >/dev/null
sleep 2

psql() { command psql -h "$WORK" -p "$PORT" -U mdai -d postgres "$@"; }

# The part of Supabase the migrations reference. Deliberately minimal: anything
# more would be testing a fake instead of the schema.
psql -q -v ON_ERROR_STOP=1 <<'SQL'
do $$begin
  if not exists(select 1 from pg_roles where rolname='anon') then create role anon nologin; end if;
  if not exists(select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
  if not exists(select 1 from pg_roles where rolname='service_role') then create role service_role nologin; end if;
end$$;
create schema if not exists auth; create schema if not exists storage; create schema if not exists extensions;
create extension if not exists pgcrypto;
create table auth.users(id uuid primary key default gen_random_uuid(), email text);
create or replace function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('test.uid', true),'')::uuid $$;
create or replace function auth.role() returns text language sql stable as $$
  select coalesce(nullif(current_setting('test.role', true),''),'authenticated') $$;
create table storage.buckets(id text primary key, name text, public boolean default false,
  file_size_limit bigint, allowed_mime_types text[], owner uuid);
create table storage.objects(id uuid primary key default gen_random_uuid(), bucket_id text, name text, owner uuid);
alter table storage.objects enable row level security;
create or replace function storage.foldername(name text) returns text[] language sql immutable as $$
  select string_to_array(name,'/') $$;
SQL

echo "--- migrations ---"
for file in "$ROOT"/supabase/migrations/*.sql; do
  if psql -q -v ON_ERROR_STOP=1 --single-transaction -f "$file" >/dev/null 2>"$WORK/err"; then
    echo "  ok  $(basename "$file")"
  else
    echo "  FAILED $(basename "$file")"; grep -i error "$WORK/err" | head -5; exit 1
  fi
done

echo "--- invariants ---"
output="$(psql -f "$ROOT/supabase/tests/security_invariants.sql" 2>&1)"
echo "$output" | grep -E "PASS|FAIL" | sed 's/^psql[^ ]* //;s/^NOTICE:  //;s/^/  /'
if echo "$output" | grep -q "FAIL"; then echo; echo "FAILED"; exit 1; fi
echo
echo "$(echo "$output" | grep -c PASS) invariants hold."
