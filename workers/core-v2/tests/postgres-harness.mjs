/* A THROWAWAY POSTGRESQL FOR THE ADAPTER'S CONTRACT TESTS.
 *
 * The same recipe as supabase/tests/run.sh — initdb as an unprivileged user
 * when we are root, trust authentication, unix socket only, an empty
 * listen_addresses so nothing outside this machine can reach it — with its
 * own data directory and port so it never collides with another cluster.
 * Every call to `withThrowawayDatabase` gets a fresh database with every
 * migration applied in filename order, one organisation and one member, and
 * drops it afterwards. A cluster this process started is stopped when the
 * process exits.
 *
 * No connection string carries a credential, because there is none.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WireClient } from "../postgres/wire.ts";
import { entityId } from "../kernel/ids.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const PGBIN = process.env.PGBIN ?? "/usr/lib/postgresql/16/bin";
const WORK = "/var/tmp/mdai-pgadapter";
const DATA = join(WORK, "data");
const PORT = 5434;
const USER = "mdai";
const RUNAS = process.getuid && process.getuid() === 0 ? "pgtest" : null;

let startedHere = false;
let hookInstalled = false;
let counter = 0;

function sh(command, { check = true } = {}) {
  const result = RUNAS
    ? spawnSync("su", ["-s", "/bin/bash", RUNAS, "-c", command], { encoding: "utf8" })
    : spawnSync("bash", ["-c", command], { encoding: "utf8" });
  if (check && result.status !== 0) {
    throw new Error(`postgres harness: \`${command}\` failed (${result.status}): ${(result.stderr || result.stdout || "").trim().slice(0, 400)}`);
  }
  return result;
}

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function stopCluster() {
  if (!startedHere) return;
  startedHere = false;
  sh(`${PGBIN}/pg_ctl -D ${DATA} stop -m immediate`, { check: false });
}

function installExitHook() {
  if (hookInstalled) return;
  hookInstalled = true;
  process.on("exit", stopCluster);
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, () => { stopCluster(); process.exit(1); });
}

/* The cluster: created once, started if not running, stopped at exit when
   this process was the one that started it. */
export async function ensureCluster() {
  if (!existsSync(`${PGBIN}/initdb`)) throw new Error(`postgres harness: PostgreSQL 16 not found at ${PGBIN}; set PGBIN`);
  if (RUNAS) {
    if (spawnSync("id", [RUNAS]).status !== 0) {
      const made = spawnSync("useradd", ["-m", RUNAS], { encoding: "utf8" });
      if (made.status !== 0) throw new Error(`postgres harness: could not create user ${RUNAS}: ${made.stderr}`);
    }
  }
  if (!existsSync(WORK)) mkdirSync(WORK, { recursive: true });
  if (RUNAS) spawnSync("chown", ["-R", RUNAS, WORK]);
  if (!existsSync(join(DATA, "PG_VERSION"))) {
    sh(`rm -rf ${DATA} && ${PGBIN}/initdb -D ${DATA} -U ${USER} --auth=trust >/dev/null`);
  }
  const status = sh(`${PGBIN}/pg_ctl -D ${DATA} status`, { check: false });
  if (status.status !== 0) {
    /* Unix socket only: this cluster must not be reachable from anywhere. */
    sh(`${PGBIN}/pg_ctl -D ${DATA} -o '-k ${WORK} -p ${PORT} -c listen_addresses=' -l ${WORK}/pg.log start >/dev/null`);
    startedHere = true;
    installExitHook();
  }
  for (let i = 0; i < 100; i++) {
    if (sh(`${PGBIN}/pg_isready -h ${WORK} -p ${PORT} -q`, { check: false }).status === 0) return { socketPath: join(WORK, `.s.PGSQL.${PORT}`), work: WORK, port: PORT };
    await sleep(100);
  }
  throw new Error(`postgres harness: the cluster did not come up; see ${WORK}/pg.log`);
}

async function connect(database) {
  const { socketPath } = await ensureCluster();
  return WireClient.connect({ socketPath, user: USER, database, applicationName: "core-v2-contract" });
}

/* The part of Supabase the migrations reference — the same stub run.sh uses,
   and no more. */
const SUPABASE_STUB = `
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
`;

export function migrationFiles() {
  const dir = join(ROOT, "supabase", "migrations");
  return readdirSync(dir).filter((f) => f.endsWith(".sql")).sort().map((f) => join(dir, f));
}

async function createDatabase(name) {
  const admin = await connect("postgres");
  try {
    await admin.query(`drop database if exists ${name} with (force)`);
    await admin.query(`create database ${name}`);
  } finally { await admin.end(); }
}

async function dropDatabase(name) {
  const admin = await connect("postgres");
  try { await admin.query(`drop database if exists ${name} with (force)`); }
  finally { await admin.end(); }
}

/* A fresh database with every migration applied in filename order, one
   organisation and one owner. `fn` receives the connected client and the
   organisation id; the database is dropped afterwards whatever happens. */
export async function withThrowawayDatabase(fn) {
  const name = `core_v2_contract_${process.pid}_${++counter}`;
  await createDatabase(name);
  let client = null;
  try {
    client = await connect(name);
    await client.simple(SUPABASE_STUB);
    for (const file of migrationFiles()) {
      try { await client.simple(readFileSync(file, "utf8")); }
      catch (error) { throw new Error(`postgres harness: migration ${file.split("/").pop()} failed: ${error.message}`); }
    }
    const organizationId = entityId("organization", "contract-tests", name);
    const userId = entityId("user", "contract-tests", name);
    await client.query("insert into auth.users(id, email) values ($1, null)", [userId]);
    await client.query("insert into public.organizations(id, name) values ($1, $2)", [organizationId, "synthetic organisation"]);
    await client.query("insert into public.organization_members(organization_id, user_id, role) values ($1, $2, 'owner')", [organizationId, userId]);
    return await fn({ client, organizationId, userId, databaseName: name });
  } finally {
    if (client) await client.end().catch(() => {});
    await dropDatabase(name).catch(() => {});
  }
}

export const HARNESS_LOCATION = { work: WORK, port: PORT, user: USER };
