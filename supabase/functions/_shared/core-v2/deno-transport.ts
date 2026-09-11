/* THE DOOR OUT, FOR ONE RUN, ON A RUNTIME THAT HAS NO SOCKETS.
 *
 * workers/core-v2-runtime/transport/https.ts is the authorised transport and
 * is not touched by this file. It reaches a provider by opening its own
 * socket through a lookup pinned to an address set it validated first, with
 * no connection pool — which is how it closes the rebinding gap.
 *
 * Deno's fetch does not expose that seam. There is no hook that says "use
 * THIS address for this request", so the pin cannot be reproduced here. A
 * node:https implementation running under Deno's compatibility layer would
 * ACCEPT the `lookup` option and, as far as this canary can establish
 * without spending money to find out, quietly not honour it — and a pin that
 * is silently ignored is worse than one that was never claimed. So this file
 * claims what it enforces and no more.
 *
 * WHAT IT ENFORCES, the same rules and mostly the same code:
 *
 *   · it refuses to exist unless every authorization is in place, from
 *     networkAuthorizationProblems — the same function, not a copy;
 *   · one normalised https origin per AUTHORISED provider, from httpsOrigin —
 *     scheme, host and effective port, not a host;
 *   · https only, and no credential written into an address;
 *   · an address literal must be outside this network, by isPublicAddress;
 *   · a name is resolved first where the runtime allows it, and one answer
 *     inside this network refuses the whole set;
 *   · redirects are answers, handed back unfollowed;
 *   · a request over the size limit is not sent; an answer over the size
 *     limit is cut off and reported as an outcome nobody knows;
 *   · a deadline, from the caller;
 *   · credentials are redacted by the shared redacted(), never logged here.
 *
 * WHAT IT CANNOT ENFORCE, stated rather than implied: the connection is not
 * pinned to the addresses that were checked, because fetch will not say
 * where it went. TLS certificate validation against the hostname still
 * stands, and is what carries that weight here.
 *
 * WHAT IT ASSUMES ABOUT FAILURE, deliberately in the expensive direction: a
 * failure this file did not itself raise before calling fetch is reported as
 * an outcome nobody knows, not as "nothing was sent". An unknown outcome
 * costs the full reservation and stops the canary — which is the safe way to
 * be wrong.
 */
import type { RuntimeConfig } from "../../../../workers/core-v2-runtime/runtime-config.ts";
import { authorizedProviders, networkAuthorizationProblems } from "../../../../workers/core-v2-runtime/runtime-config.ts";
import type { HttpRequest, HttpResponse, HttpTransport } from "../../../../workers/core-v2-runtime/transport/transport.ts";
import { NetworkNotAuthorized, TransportFault } from "../../../../workers/core-v2-runtime/transport/transport.ts";
import { httpsOrigin, isPublicAddress, parseAddress } from "../../../../workers/core-v2-runtime/transport/https.ts";

const DEFAULT_MAXIMUM_REQUEST_BYTES = 1024 * 1024;
const DEFAULT_MAXIMUM_RESPONSE_BYTES = 4 * 1024 * 1024;

export type DenoTransportOptions = {
  config: RuntimeConfig;
  maximumRequestBytes?: number;
  maximumResponseBytes?: number;
  /* Replaced by a test; the real one is Deno's own resolver. Returning null
     means "this runtime would not let me ask", which is recorded rather than
     treated as an answer. */
  resolve?: (hostname: string) => Promise<string[] | null>;
  fetch?: typeof fetch;
};

async function denoResolve(hostname: string): Promise<string[] | null> {
  const runtime = (globalThis as { Deno?: { resolveDns?: (h: string, t: string) => Promise<string[]> } }).Deno;
  if (!runtime?.resolveDns) return null;
  const answers: string[] = [];
  for (const record of ["A", "AAAA"] as const) {
    try {
      answers.push(...await runtime.resolveDns(hostname, record));
    } catch (error) {
      /* NotFound for one family is ordinary; a runtime that refuses to
         resolve at all is reported as "not checked", not as "no answers". */
      const name = (error as { name?: string }).name ?? "";
      if (name === "NotCapable" || name === "NotSupported" || name === "PermissionDenied") return null;
    }
  }
  return answers;
}

/* Settles when the signal aborts, and never rejects: it is one half of a
   race, not an error path of its own. */
function until(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
}

const byteLength = (text: string): number => new TextEncoder().encode(text).length;

export class DenoFetchTransport implements HttpTransport {
  readonly name = "https-deno-fetch";
  readonly allowedOrigins: string[];
  /* Set when a hostname's addresses could not be checked, so the run can say
     so rather than imply a check that did not happen. */
  readonly unresolvedHosts: string[] = [];
  private maximumRequestBytes: number;
  private maximumResponseBytes: number;
  private resolve: (hostname: string) => Promise<string[] | null>;
  private send_: typeof fetch;

  constructor(options: DenoTransportOptions) {
    const refusals = networkAuthorizationProblems(options.config);
    if (refusals.length > 0) {
      throw new NetworkNotAuthorized(
        "core-v2-canary: a transport that can reach a provider may not be built until every authorization is in place",
        refusals,
      );
    }
    const origins = new Set<string>();
    const byId = new Map(options.config.providers.map((p) => [p.providerId, p]));
    for (const authorized of authorizedProviders(options.config)) {
      const provider = byId.get(authorized.providerId)!;
      let url: URL;
      try {
        url = new URL(provider.baseUrl);
      } catch {
        throw new NetworkNotAuthorized(`core-v2-canary: ${provider.providerId} is authorised and has an address that is not a url`);
      }
      if (url.protocol !== "https:") throw new NetworkNotAuthorized(`core-v2-canary: ${provider.providerId} is configured at ${url.protocol}//, and this transport speaks https only`);
      if (url.username || url.password) throw new NetworkNotAuthorized(`core-v2-canary: ${provider.providerId} has a credential written into its address`);
      origins.add(httpsOrigin(url));
    }
    if (origins.size === 0) throw new NetworkNotAuthorized("core-v2-canary: no authorised provider has an address, so there is nowhere this transport may go");
    this.allowedOrigins = [...origins].sort();
    this.maximumRequestBytes = options.maximumRequestBytes ?? DEFAULT_MAXIMUM_REQUEST_BYTES;
    this.maximumResponseBytes = options.maximumResponseBytes ?? DEFAULT_MAXIMUM_RESPONSE_BYTES;
    this.resolve = options.resolve ?? denoResolve;
    this.send_ = options.fetch ?? fetch;
  }

  async send(request: HttpRequest): Promise<HttpResponse> {
    /* ── everything provable before a byte could leave ── */
    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      throw new TransportFault("core-v2-canary: the url is not a url, so nothing was sent", true);
    }
    if (url.protocol !== "https:") throw new TransportFault(`core-v2-canary: ${url.protocol}// is not https, so nothing was sent`, true);
    if (url.username || url.password) throw new TransportFault("core-v2-canary: the url carries a credential, so nothing was sent", true);
    const origin = httpsOrigin(url);
    if (!this.allowedOrigins.includes(origin)) {
      throw new TransportFault(`core-v2-canary: ${origin} is not an endpoint this run is authorised to reach, so nothing was sent`, true);
    }
    const size = byteLength(request.body ?? "");
    if (size > this.maximumRequestBytes) {
      throw new TransportFault(`core-v2-canary: the request is ${size} bytes and at most ${this.maximumRequestBytes} may be sent, so nothing was sent`, true);
    }
    if (request.signal?.aborted) throw new TransportFault("core-v2-canary: the request was cancelled before it was sent", true);

    /* ── the deadline, started here rather than at the fetch ──
       Everything from this line on can block: a resolver that never answers
       blocks exactly as completely as a provider that never answers, and it
       blocks BEFORE any byte has left, where the caller's own abort signal is
       not yet listened to. A deadline that only covers the fetch leaves that
       stretch unbounded, and an unbounded stretch inside a request-scoped
       runtime is not a slow call — it is an attempt the operator is killed in
       the middle of, recorded forever as an outcome nobody knows. One clock,
       from the first thing that can wait to the last. */
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(new Error("timeout")), request.timeoutMs);
    const onCancel = () => deadline.abort(new Error("cancelled"));
    request.signal?.addEventListener("abort", onCancel, { once: true });
    const givenUp = () => deadline.signal.aborted;
    const release = () => {
      clearTimeout(timer);
      request.signal?.removeEventListener("abort", onCancel);
    };

    const hostname = url.hostname.toLowerCase();
    const literal = parseAddress(hostname);
    if (literal) {
      if (!isPublicAddress(hostname)) {
        release();
        throw new TransportFault(`core-v2-canary: ${hostname} is an address inside this network, and this transport does not go there — nothing was sent`, true);
      }
    } else {
      /* The resolver gets the deadline too. Whichever settles first wins, and
         a resolver still running when the clock stops is left behind rather
         than waited on. */
      const answered = await Promise.race([
        this.resolve(hostname).catch(() => null),
        until(deadline.signal).then(() => null as string[] | null),
      ]);
      if (givenUp()) {
        release();
        throw new TransportFault(`core-v2-canary: ${hostname} was not resolved within ${request.timeoutMs}ms, so nothing was sent`, true);
      }
      if (answered === null) {
        if (!this.unresolvedHosts.includes(hostname)) this.unresolvedHosts.push(hostname);
      } else {
        if (answered.length === 0) { release(); throw new TransportFault(`core-v2-canary: ${hostname} resolves to nothing, so nothing was sent`, true); }
        for (const address of answered) {
          if (!parseAddress(address)) { release(); throw new TransportFault(`core-v2-canary: ${hostname} resolved to something that is not an address, so nothing was sent`, true); }
        }
        if (answered.some((address) => !isPublicAddress(address))) {
          release();
          throw new TransportFault(`core-v2-canary: ${hostname} resolves to an address inside this network, and this transport does not go there — nothing was sent`, true);
        }
      }
    }

    /* ── the exchange, after which nothing is provably unsent ── */
    let response: Response;
    try {
      response = await this.send_(request.url, {
        method: request.method,
        headers: { ...request.headers, "content-length": String(size) },
        body: request.method === "GET" ? undefined : (request.body ?? ""),
        /* A redirect is an answer, and it is handed back unfollowed. */
        redirect: "manual",
        signal: deadline.signal,
      });
    } catch (error) {
      release();
      const why = deadline.signal.aborted ? `no answer within ${request.timeoutMs}ms` : describe(error);
      /* Deliberately not "nothing was sent": fetch does not say, and the
         expensive assumption is the safe one. */
      throw new TransportFault(`core-v2-canary: the exchange failed (${why}); whether the work was done is not known`, false, error);
    }

    try {
      const headers: Record<string, string> = {};
      response.headers.forEach((value, name) => { headers[name.toLowerCase()] = value; });
      const body = await this.readCapped(response);
      return { status: response.status, headers, body };
    } finally {
      release();
    }
  }

  /* Reads the answer, and stops reading at the cap rather than after it. */
  private async readCapped(response: Response): Promise<string> {
    if (!response.body) return "";
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let text = "";
    let bytes = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > this.maximumResponseBytes) {
        await reader.cancel().catch(() => {});
        throw new TransportFault(
          `core-v2-canary: the answer went past ${this.maximumResponseBytes} bytes and was cut off; whether the work was done is not known`, false);
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  }
}

function describe(error: unknown): string {
  if (error && typeof error === "object") {
    const named = error as { name?: string; message?: string };
    if (typeof named.message === "string" && named.message) return named.message.slice(0, 60);
    if (typeof named.name === "string" && named.name) return named.name;
  }
  return "unknown";
}
