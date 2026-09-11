"""Connect the owner's analysis UI to the existing project. Never start work."""
import hashlib
import json
import os
from pathlib import Path
import sys
import time
import urllib.error
import urllib.request

PROJECT = "hbqlhplgqwuesrovbiye"
ROOT = "https://api.supabase.com/v1/projects/" + PROJECT
FUNCTIONS = {"core-v2-analysis", "core-v2-runner", "core-v2-runner-tick"}
KEYS = {"ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY"}
FLAG = "CORE_V2_RUNNER_ALLOW_PROVIDER_NETWORK"
TICK = f"https://{PROJECT}.supabase.co/functions/v1/core-v2-runner-tick"
BEFORE = Path(os.environ["RUNNER_TEMP"]) / "mdai-existing-before.json"


def api(path, payload=None, method=None):
    req = urllib.request.Request(
        ROOT + path, data=None if payload is None else json.dumps(payload).encode(),
        headers={"Authorization": "Bearer " + os.environ["SUPABASE_ACCESS_TOKEN"],
                 "Content-Type": "application/json"}, method=method)
    try:
        with urllib.request.urlopen(req, timeout=90) as response:
            body = response.read()
            return json.loads(body) if body else None
    except urllib.error.HTTPError as error:
        # No credentials, database content or provider responses in the log.
        raise SystemExit(f"Existing project {path}: HTTP {error.code}") from None


def query(sql, write=False):
    return api("/database/query", {"query": sql, "read_only": not write})


def snapshot():
    return query("""select
      (select count(*) from public.intelligence_workflows
       where state not in ('completed','partial','failed','cancelled')) as unfinished,
      (select count(*) from public.workflow_continuations where state in ('due','held')) as queued,
      (select count(*) from public.agent_attempts) as attempts,
      (select count(*) from public.analysis_runs) as analyses,
      (select count(*) from public.attempt_cost_reservations) as reservations""")[0]


def idle():
    state = snapshot()
    if int(state["unfinished"]) or int(state["queued"]):
        raise SystemExit("Existing work is unfinished; do not change execution underneath it.")
    return state


def secret_digests():
    return {item["name"]: item.get("value", item.get("digest")) for item in api("/secrets")}


def other_functions():
    return {f["slug"]: f.get("ezbr_sha256") for f in api("/functions") if f["slug"] not in FUNCTIONS}


def literal(text):
    return "'" + text.replace("'", "''") + "'"


def prepare():
    before = idle()
    secrets = secret_digests()
    if not KEYS.issubset(secrets):
        raise SystemExit("Existing project is missing provider keys: " + ", ".join(sorted(KEYS - secrets.keys())))
    BEFORE.write_text(json.dumps({"record": before, "keys": {k: secrets[k] for k in KEYS},
                                  "functions": other_functions()}))
    versions = {row["version"] for row in query("select version from supabase_migrations.schema_migrations")}
    if "063" not in versions:
        raise SystemExit("Expected the existing analysis schema through 063; no migration applied.")
    # Apply only the three reviewed additions, retaining their repository
    # versions. Each migration and its history entry commit together.
    for version in ("064", "065", "066"):
        if version in versions:
            print("Already applied:", version)
            continue
        paths = list(Path("supabase/migrations").glob(version + "_*.sql"))
        if len(paths) != 1:
            raise SystemExit("Expected exactly one migration " + version)
        sql = paths[0].read_text()
        name = paths[0].stem.split("_", 1)[1]
        query("begin; set local lock_timeout = '5s';\n" + sql +
              "\ninsert into supabase_migrations.schema_migrations(version,name,statements) values (" +
              literal(version) + "," + literal(name) + ",array[" + literal(sql) + "]); commit;", write=True)
        print("Applied:", version)

    poolers = api("/config/database/pooler")
    primary = [p for p in poolers if p.get("database_type") == "PRIMARY"]
    candidates = [p for p in primary if p.get("pool_mode") == "session"] or primary
    if not candidates:
        raise SystemExit("No primary Supavisor route returned.")
    pooler = candidates[0]
    if not all(pooler.get(k) for k in ("db_host", "db_user", "db_name")):
        raise SystemExit("Incomplete primary Supavisor route.")
    # Supavisor session mode uses 5432 (as proved by the existing canary).
    # Only routing facts are set. The password remains SUPABASE_DB_URL's.
    settings = {
        "CORE_V2_RUNNER_DB_HOST": str(pooler["db_host"]),
        "CORE_V2_RUNNER_DB_PORT": "5432",
        "CORE_V2_RUNNER_DB_USER": str(pooler["db_user"]),
        "CORE_V2_RUNNER_DB_NAME": str(pooler["db_name"]),
        "CORE_V2_RUNNER_TICK_URL": TICK,
    }
    api("/secrets", [{"name": k, "value": v} for k, v in settings.items()])
    auth = api("/config/auth")
    redirects = [s.strip() for s in (auth.get("uri_allow_list") or "").split(",") if s.strip()]
    for url in ("https://measureddecision.ai/studio/**",
                "https://deploy-preview-223--measureddecisionai.netlify.app/studio/**"):
        if url not in redirects:
            redirects.append(url)
    api("/config/auth", {"uri_allow_list": ",".join(redirects)}, method="PATCH")
    print("Existing project prepared; provider keys retained; no analysis started.")


def readiness():
    # Exercise the watchdog's real authentication path. The credential stays
    # inside Vault and is sent by pg_net directly to this project's own door.
    request_id = query("""select net.http_post(
      url := 'https://hbqlhplgqwuesrovbiye.supabase.co/functions/v1/core-v2-runner-tick?mode=readiness',
      headers := jsonb_build_object('Content-Type','application/json','x-core-v2-runner',
        (select decrypted_secret from vault.decrypted_secrets where name='core_v2_runner_secret' limit 1)),
      body := '{}'::jsonb, timeout_milliseconds := 20000) as id""", write=True)[0]["id"]
    response = None
    for _ in range(30):
        rows = query("select status_code, content, timed_out from net._http_response where id=" + str(int(request_id)))
        if rows:
            response = rows[0]
            break
        time.sleep(1)
    if response is None or response.get("timed_out"):
        raise SystemExit("The deployed readiness request did not return in its bounded window.")
    try:
        result = json.loads(response.get("content") or "{}")
    except ValueError:
        raise SystemExit("Readiness returned no JSON.")
    if response.get("status_code") != 200:
        raise SystemExit("Runner readiness: HTTP " + str(response.get("status_code")) +
                         ": " + str(result.get("refused", "unclassified"))[:180])
    if result.get("databaseConnected") is not True or result.get("providerKeysPresent") is not True:
        raise SystemExit("The deployed runner is not ready: " + json.dumps(result))
    if result.get("workflowClaimed") is not False:
        raise SystemExit("Readiness must not claim work.")
    return result


def activate():
    idle()
    # Install the existing watchdog, not a new orchestration mechanism.
    query("""begin;
      create extension if not exists pg_net;
      create extension if not exists pg_cron;
      do $$ begin
        if not exists(select 1 from vault.secrets where name='core_v2_runner_secret') then
          perform vault.create_secret(encode(extensions.gen_random_bytes(32),'hex'),
            'core_v2_runner_secret','Core V2 continuation authentication');
        end if;
      end $$;
      insert into public.core_v2_runner_settings(id,armed,endpoint,secret_name)
      values (true,true,'https://hbqlhplgqwuesrovbiye.supabase.co/functions/v1/core-v2-runner-tick','core_v2_runner_secret')
      on conflict(id) do update set armed=true,endpoint=excluded.endpoint,secret_name=excluded.secret_name;
      select cron.schedule('core-v2-runner-watchdog','* * * * *',
        'select public.core_v2_watchdog_tick(10)');
      commit;""", write=True)
    idle()
    print("DEPLOYED READINESS", json.dumps(readiness()))
    api("/secrets", [{"name": FLAG, "value": "true"}])
    after = secret_digests()
    if after.get(FLAG) not in ("true", hashlib.sha256(b"true").hexdigest()):
        raise SystemExit("Network setting readback failed.")
    before = json.loads(BEFORE.read_text())
    if any(after.get(k) != v for k, v in before["keys"].items()):
        raise SystemExit("Provider configuration changed during deployment.")
    if before["functions"] != other_functions():
        raise SystemExit("An unrelated function changed during deployment.")
    if before["record"] != snapshot():
        raise SystemExit("Work appeared during deployment; inspect before reporting no new attempts.")
    final = readiness()
    if final.get("providerNetworkEnabled") is not True:
        raise SystemExit("Runner has not received the enabled setting yet.")
    print("FINAL READINESS", json.dumps(final))
    print("WATCHDOG", json.dumps(query("select armed,endpoint from public.core_v2_runner_settings")))
    print("RECORD", json.dumps(snapshot()))
    with open(os.environ["GITHUB_STEP_SUMMARY"], "a") as out:
        out.write("Existing Measured Decision project connected. Three provider keys unchanged; "
                  "real runner connects to its database; network enabled; watchdog armed. "
                  "No analysis started and no provider called.\n")


if __name__ == "__main__":
    {"prepare": prepare, "activate": activate}[sys.argv[1]]()
