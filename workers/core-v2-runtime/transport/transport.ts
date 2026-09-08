/* THE ONE DOOR OUT, AND IT IS SHUT.
 *
 * Every request the runtime could ever make goes through a transport, and the
 * transport is injected. Nothing below this file knows how to open a socket:
 * an adapter builds a request and hands it over, and what happens next is
 * whoever was injected. The default is a transport that refuses, so a runtime
 * assembled carelessly cannot reach anything — the network is opt-in by
 * construction, not by remembering to pass a flag.
 *
 * A request carries an authorization header like any other; nothing here ever
 * writes one to a log, and `redacted()` is what the event stream sees.
 */

export type HttpMethod = "POST" | "GET";

export type HttpRequest = {
  method: HttpMethod;
  url: string;
  headers: Record<string, string>;
  /* Already serialised. An adapter that wants JSON serialises it, so what is
     hashed, logged and replayed is exactly what would go on the wire. */
  body: string;
  timeoutMs: number;
  signal?: AbortSignal;
};

export type HttpResponse = {
  status: number;
  headers: Record<string, string>;
  body: string;
};

export interface HttpTransport {
  readonly name: string;
  send(request: HttpRequest): Promise<HttpResponse>;
}

/* A door that was never opened. Distinguished from every other failure
   because it is not a failure of the thing on the other side. */
export class NetworkNotAuthorized extends Error {
  readonly refusals: string[];
  constructor(message: string, refusals: string[] = []) {
    super(message);
    this.refusals = refusals;
  }
}

/* Anything that looks like a credential, and the names of the headers that
   normally carry one. Matched on the header name, so a provider that invents
   a new one still has to be added here deliberately. */
const CREDENTIAL_HEADERS = new Set([
  "authorization", "x-api-key", "api-key", "proxy-authorization", "cookie", "set-cookie",
]);

/* What the event stream may see of a request. The value of a credential is
   replaced by its length, which is enough to tell "the key is missing" from
   "the key is wrong" without ever writing the key down. */
export function redacted(request: HttpRequest): { method: HttpMethod; url: string; headers: Record<string, string>; bodyBytes: number } {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(request.headers)) {
    headers[name] = CREDENTIAL_HEADERS.has(name.toLowerCase()) ? `«redacted ${value.length} characters»` : value;
  }
  return { method: request.method, url: redactedUrl(request.url), headers, bodyBytes: Buffer.byteLength(request.body, "utf8") };
}

/* A key in a query string is still a key. */
export function redactedUrl(url: string): string {
  return url.replace(/([?&](?:key|api_key|access_token|token)=)[^&]*/gi, "$1«redacted»");
}

/* THE DEFAULT. Refuses everything, and says what would have had to be true.
   Every test and every ordinary command runs against this or against a local
   fixture transport; nothing else exists in this package that can reach out. */
export class SealedTransport implements HttpTransport {
  readonly name = "sealed";
  readonly attempts: { url: string; method: HttpMethod }[] = [];

  async send(request: HttpRequest): Promise<HttpResponse> {
    this.attempts.push({ url: redactedUrl(request.url), method: request.method });
    throw new NetworkNotAuthorized(
      `core-v2-runtime: the network is sealed — nothing was sent to ${redactedUrl(request.url)}`,
      ["no transport authorised to reach a provider was supplied"],
    );
  }
}
