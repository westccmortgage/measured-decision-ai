/* Starting the 360 machine from Studio.
 *
 * Uploading a capture already asks for the machine on its own. This is the same
 * request made deliberately: somebody looking at a room that is waiting, who
 * would otherwise be opening the AWS console. It exists so that screen has a
 * button instead of an instruction.
 *
 * It answers with what actually happened, including every refusal, because
 * "nothing is queued" and "it is already running" are useful answers and
 * "Starting…" over either of them would be a lie.
 */
import { safeError } from "../_shared/safe-error.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { wake360Machine } from "../_shared/wake-360-machine.ts";

const allowedOrigins = new Set([
  "https://measureddecision.com",
  "https://www.measureddecision.com",
  "http://localhost:8080",
  "http://127.0.0.1:8080",
]);

function corsHeaders(request: Request) {
  const origin = request.headers.get("origin") || "";
  return {
    "Access-Control-Allow-Origin": allowedOrigins.has(origin) ? origin : "https://measureddecision.com",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}

function json(request: Request, body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(request), "Content-Type": "application/json" },
  });
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders(request) });
  try {
    if (request.method !== "POST") return json(request, { error: "Unsupported method" }, 405);

    const authorization = request.headers.get("Authorization") || "";
    if (!authorization) return json(request, { error: "Sign in to start the 360 machine" }, 401);

    const url = Deno.env.get("SUPABASE_URL")!;
    const userClient = createClient(url, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: authorization } },
    });
    const { data: userData, error: userError } = await userClient.auth.getUser();
    if (userError || !userData?.user) {
      return json(request, { error: "Sign in to start the 360 machine" }, 401);
    }

    /* The machine is shared infrastructure rather than one organisation's
       property, so belonging to any organisation is the bar — the same bar the
       record of its runs uses. Somebody with no organisation at all has no
       captures to stitch and no business spending the money. */
    const { count, error: memberError } = await userClient
      .from("organization_members")
      .select("organization_id", { count: "exact", head: true })
      .eq("user_id", userData.user.id);
    if (memberError || !count) {
      return json(request, { error: "Only a Studio member can start the 360 machine" }, 403);
    }

    const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const result = await wake360Machine(admin, "person", userData.user.id);
    return json(request, result);
  } catch (error) {
    const safe = safeError(error, "The 360 machine could not be reached.");
    return json(request, safe.body, safe.status);
  }
});
