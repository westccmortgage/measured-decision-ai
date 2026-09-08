/* A TRANSPORT THAT ANSWERS FROM A FILE, SO A TEST NEVER NEEDS A PROVIDER.
 *
 * Routes are matched in the order they were given, on method and on a
 * substring of the url, and every request is kept so a test can assert what
 * would have gone on the wire — the shape of the body, the headers, the
 * absence of anything that should not be there. A request that matches no
 * route is an error rather than a default answer: a test that thinks it
 * stubbed something and did not should fail loudly.
 */
import type { HttpMethod, HttpRequest, HttpResponse, HttpTransport } from "./transport.ts";
import { TransportFault, redacted } from "./transport.ts";

export type FixtureRoute = {
  /* A substring of the url. Adapters build their own urls, so this is what
     tells one provider's route from another's without restating them. */
  urlContains: string;
  method?: HttpMethod;
  /* One canned answer, or a sequence: the nth matching request gets the nth
     answer, and the last one repeats. A sequence is how a rate limit followed
     by a success is written. */
  responses: HttpResponse[];
  /* Or a fault instead of an answer — a timeout, a socket that died. */
  fails?: (Error | null)[];
};

export class FixtureTransport implements HttpTransport {
  readonly name = "fixture";
  readonly sent: HttpRequest[] = [];
  private routes: FixtureRoute[];
  private hits = new Map<FixtureRoute, number>();

  constructor(routes: FixtureRoute[]) {
    this.routes = routes;
  }

  /* What a test asserts against: every request, with credentials redacted, in
     the order they were made. */
  get seen(): ReturnType<typeof redacted>[] {
    return this.sent.map(redacted);
  }

  bodies(): unknown[] {
    return this.sent.map((r) => { try { return JSON.parse(r.body); } catch { return r.body; } });
  }

  async send(request: HttpRequest): Promise<HttpResponse> {
    this.sent.push(request);
    if (request.signal?.aborted) throw new TransportFault("core-v2-runtime: the request was aborted before it was sent", true);
    const route = this.routes.find((r) => request.url.includes(r.urlContains) && (!r.method || r.method === request.method));
    if (!route) {
      throw new Error(`core-v2-runtime: no fixture answers ${request.method} ${request.url} — a test that stubs nothing must say so`);
    }
    const n = this.hits.get(route) ?? 0;
    this.hits.set(route, n + 1);
    const fault = route.fails?.[Math.min(n, (route.fails?.length ?? 1) - 1)];
    if (fault) throw fault;
    const response = route.responses[Math.min(n, route.responses.length - 1)];
    if (!response) throw new Error(`core-v2-runtime: fixture route ${route.urlContains} ran out of answers`);
    return response;
  }
}

export function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): HttpResponse {
  return { status, headers: { "content-type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) };
}
