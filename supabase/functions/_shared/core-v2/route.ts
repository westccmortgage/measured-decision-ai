/* HOW AN EDGE FUNCTION REACHES THE RECORD, AND WHAT IT MAY SAY ABOUT IT.
 *
 * Two facts this repository paid to learn:
 *
 *   1. the address is Supavisor's, not the database's own. The direct address
 *      is not reachable from the Edge Runtime, and the first canary spent a
 *      run finding that out. It is read from the Management API and set as a
 *      secret; nothing here guesses a host, a port or a region.
 *   2. the PASSWORD is never a secret of ours. Supabase gives every function
 *      `SUPABASE_DB_URL` with the platform's own credentials in it, and the
 *      route below takes the password from there rather than asking anybody
 *      to copy one into a second place. A secret in two places is a secret
 *      that gets rotated in one of them.
 *
 * `describe` is host, port and database. The url itself is never returned in
 * anything that is logged, reported or put in a response body.
 */

export type Route = { url: string; describe: string; passwordFrom: string };
export type RouteProblem = { problem: string };

export type RouteVariables = {
  /* A complete connection url, if the operator prefers to set one. */
  complete: string;
  host: string;
  port: string;
  user: string;
  name: string;
};

export function routeVariables(prefix: string): RouteVariables {
  return {
    complete: `${prefix}_DB_URL`,
    host: `${prefix}_DB_HOST`,
    port: `${prefix}_DB_PORT`,
    user: `${prefix}_DB_USER`,
    name: `${prefix}_DB_NAME`,
  };
}

/* A ROUTE THIS PROJECT ALREADY HAS.
 *
 * The pooler's host and user were read from the Management API once and set as
 * secrets for the canary. They are facts about this database, not about that
 * function, and asking an operator to write the same two values under a second
 * prefix would be asking them to keep one fact in two places.
 *
 * So the search is: this function's own prefix, then any prefix a sibling
 * already established, then the platform's own url. The first that answers
 * wins, and the answer says which one it was. */
export function routeToRecord(
  prefix: string,
  env: (name: string) => string | undefined,
  alsoTry: string[] = ["CORE_V2_CANARY"],
): Route | RouteProblem {
  const first = routeUnderPrefix(prefix, env);
  if (!isRouteProblem(first)) return first;
  for (const other of alsoTry) {
    const found = routeUnderPrefix(other, env);
    if (!isRouteProblem(found)) return found;
  }
  /* Last: the platform's own url, complete. It is the direct address rather
     than the pooler's, which does not always answer from the Edge Runtime —
     so it is tried last and its failure is a connection error rather than a
     silent wrong answer. */
  const platform = env("SUPABASE_DB_URL");
  if (platform) {
    try {
      const parsed = new URL(platform);
      if (parsed.password) {
        return {
          url: platform,
          describe: `${parsed.hostname}:${parsed.port || "5432"}${parsed.pathname}`,
          passwordFrom: "SUPABASE_DB_URL (the platform's own)",
        };
      }
    } catch { /* fall through to the first problem, which names what to set */ }
  }
  return first;
}

function routeUnderPrefix(prefix: string, env: (name: string) => string | undefined): Route | RouteProblem {
  const names = routeVariables(prefix);

  const complete = env(names.complete);
  if (complete) {
    try {
      const parsed = new URL(complete);
      if (!parsed.password) return { problem: `${names.complete} carries no password` };
      return {
        url: complete,
        describe: `${parsed.hostname}:${parsed.port || "5432"}${parsed.pathname}`,
        passwordFrom: names.complete,
      };
    } catch {
      return { problem: `${names.complete} is not a url` };
    }
  }

  const host = env(names.host);
  const user = env(names.user);
  if (!host || !user) {
    return { problem: `neither ${names.complete} nor ${names.host}/${names.user} is set; there is no record to write to` };
  }
  const port = env(names.port) || "5432";
  const name = env(names.name) || "postgres";

  const platform = env("SUPABASE_DB_URL");
  if (!platform) return { problem: "SUPABASE_DB_URL is not set, so there is no password to reach the pooler with" };
  let password = "";
  try { password = new URL(platform).password; }
  catch { return { problem: "SUPABASE_DB_URL is not a url" }; }
  if (!password) return { problem: "SUPABASE_DB_URL carries no password" };

  return {
    url: `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(decodeURIComponent(password))}@${host}:${port}/${name}`,
    describe: `${host}:${port}/${name}`,
    passwordFrom: "SUPABASE_DB_URL (the platform's own, never copied out)",
  };
}

export function isRouteProblem(route: Route | RouteProblem): route is RouteProblem {
  return (route as RouteProblem).problem !== undefined;
}
