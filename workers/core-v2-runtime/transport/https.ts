/* THE DOOR THAT CAN ACTUALLY BE OPENED — AND EVERY LOCK ON IT.
 *
 * Everything else in this package refuses to send. This is the one file that
 * can, and it exists so that "authorised" and "possible" are the same thing
 * exactly once: a runtime whose four gates are open has, until now, had no
 * way to reach anybody at all, which made the gates a statement about
 * nothing.
 *
 * It cannot be constructed unless every gate is open. Not "it refuses when it
 * is called" — the factory throws, so a process that is not authorised never
 * holds an object that could send. And after that it is still narrow:
 *
 *   · https only, never http, never a scheme with a socket path in it;
 *   · the host must be one an operator configured — the allowlist is built
 *     from the configured provider addresses, not from an argument;
 *   · a url carrying a credential (user:pass@) is refused before anything is
 *     resolved: a credential in a url is a credential in every log that ever
 *     writes a url;
 *   · the address it would connect to must be public. Loopback, private
 *     ranges, link-local, unique-local and carrier-grade NAT are refused,
 *     for the literal address and for every address a name resolves to, so a
 *     configured host that happens to point inside cannot be used to reach a
 *     metadata service or a neighbour;
 *   · redirects are NOT followed. A 3xx is handed back exactly as it
 *     arrived, and the caller treats it as the provider declining to take the
 *     request. Following one is how a request ends up somewhere nobody
 *     allowlisted;
 *   · a request larger than the configured ceiling never leaves, and a
 *     response larger than the ceiling stops being read;
 *   · the deadline is the request's own, and cancellation is honoured;
 *   · nothing is logged. There is no logger here at all: what a caller learns
 *     is the response, or an error whose message names a host and a code and
 *     never a header, a body or a piece of material.
 *
 * And the rule everything downstream depends on: WHETHER ANYTHING WAS SENT.
 * This transport says "nothing left" only when it can prove it — the request
 * was refused before it was built, the name did not resolve, the connection
 * was refused, the handshake failed, or the caller cancelled before a byte
 * was written. Every other failure is reported as possibly submitted, which
 * is what makes the attempt an unknown outcome rather than a free retry.
 */
import dns from "node:dns";
import https from "node:https";
import type { HttpRequest, HttpResponse, HttpTransport } from "./transport.ts";
import { NetworkNotAuthorized, TransportFault } from "./transport.ts";
import type { RuntimeConfig } from "../runtime-config.ts";
import { paidCallRefusals } from "../runtime-config.ts";

/* The node-level seam. Declared structurally rather than imported as a type
   so that this file compiles with no dependency on node's own typings, and so
   that a test can hand it a double at exactly the boundary where the socket
   would be. */
export type NodeRequestOptions = {
  method: string;
  protocol: string;
  hostname: string;
  port: number;
  path: string;
  headers: Record<string, string>;
  timeout: number;
};

export type NodeResponse = {
  statusCode?: number;
  headers: Record<string, string | string[] | undefined>;
  setEncoding(encoding: string): void;
  on(event: string, listener: (...args: unknown[]) => void): NodeResponse;
  destroy(error?: Error): void;
};

export type NodeRequest = {
  on(event: string, listener: (...args: unknown[]) => void): NodeRequest;
  write(chunk: string, encoding: string, callback?: (error?: Error | null) => void): boolean;
  end(callback?: () => void): void;
  destroy(error?: Error): void;
  setTimeout(ms: number, listener?: () => void): NodeRequest;
};

export type OpenRequest = (options: NodeRequestOptions, onResponse: (response: NodeResponse) => void) => NodeRequest;

export type Lookup = (hostname: string) => Promise<string[]>;

export type HttpsTransportOptions = {
  config: RuntimeConfig;
  /* Defaults are deliberately small. An operator who needs more says so. */
  maximumRequestBytes?: number;
  maximumResponseBytes?: number;
  /* The seams. Both default to node's own; a test replaces them and no
     socket is ever opened. */
  openRequest?: OpenRequest;
  lookup?: Lookup;
};

const DEFAULT_MAXIMUM_REQUEST_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAXIMUM_RESPONSE_BYTES = 8 * 1024 * 1024;

/* Addresses nothing outside may be reached at. */
const PRIVATE_V4 = [
  /^0\./, /^10\./, /^127\./, /^169\.254\./, /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./, /^192\.0\.0\./, /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./,
  /^198\.(1[89])\./, /^255\.255\.255\.255$/,
];

export function isPublicAddress(address: string): boolean {
  const value = address.trim().toLowerCase();
  if (value.length === 0) return false;
  /* IPv6, including the forms that carry a v4 address inside them. */
  if (value.includes(":")) {
    if (value === "::" || value === "::1") return false;
    if (value.startsWith("fe80") || value.startsWith("fc") || value.startsWith("fd")) return false;
    const mapped = value.match(/(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPublicAddress(mapped[1]);
    return true;
  }
  if (/^\d+\.\d+\.\d+\.\d+$/.test(value)) return !PRIVATE_V4.some((pattern) => pattern.test(value));
  /* Not an address at all: a name, which is resolved before this is asked. */
  return true;
}

const isLiteralAddress = (hostname: string): boolean => /^\d+\.\d+\.\d+\.\d+$/.test(hostname) || hostname.includes(":");

/* What a name resolves to, asked of the system resolver. Only used for a
   host that is not already a literal address. */
const systemLookup: Lookup = async (hostname: string): Promise<string[]> => {
  const resolver = (dns as unknown as { promises: { lookup(host: string, options: { all: true; verbatim: true }): Promise<{ address: string }[]> } }).promises;
  const found = await resolver.lookup(hostname, { all: true, verbatim: true });
  return found.map((entry) => entry.address);
};

export class HttpsTransport implements HttpTransport {
  readonly name = "https";
  readonly allowedHosts: string[];
  private openRequest: OpenRequest;
  private lookup: Lookup;
  private maximumRequestBytes: number;
  private maximumResponseBytes: number;

  constructor(options: HttpsTransportOptions) {
    /* The gates, at construction. A process that is not authorised never
       holds one of these. */
    const refusals = paidCallRefusals(options.config);
    if (refusals.length > 0) {
      throw new NetworkNotAuthorized(
        "core-v2-runtime: a transport that can reach a provider may not be built until every authorization is in place",
        refusals,
      );
    }
    const hosts = new Set<string>();
    for (const provider of options.config.providers) {
      let url: URL;
      try {
        url = new URL(provider.baseUrl);
      } catch {
        throw new NetworkNotAuthorized(`core-v2-runtime: ${provider.providerId} has an address that is not a url`);
      }
      if (url.protocol !== "https:") {
        throw new NetworkNotAuthorized(`core-v2-runtime: ${provider.providerId} is configured at ${url.protocol}//, and this transport speaks https only`);
      }
      if (url.username || url.password) {
        throw new NetworkNotAuthorized(`core-v2-runtime: ${provider.providerId} has a credential written into its address`);
      }
      hosts.add(url.hostname.toLowerCase());
    }
    if (hosts.size === 0) throw new NetworkNotAuthorized("core-v2-runtime: no provider address is configured, so there is nowhere this transport may go");
    this.allowedHosts = [...hosts].sort();
    this.openRequest = options.openRequest ?? (https as unknown as { request: OpenRequest }).request;
    this.lookup = options.lookup ?? systemLookup;
    this.maximumRequestBytes = options.maximumRequestBytes ?? DEFAULT_MAXIMUM_REQUEST_BYTES;
    this.maximumResponseBytes = options.maximumResponseBytes ?? DEFAULT_MAXIMUM_RESPONSE_BYTES;
  }

  async send(request: HttpRequest): Promise<HttpResponse> {
    /* Everything that can be decided without a socket is decided first, and
       every one of these is provably "nothing was sent". */
    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      throw new TransportFault("core-v2-runtime: that is not a url, so nothing was sent", true);
    }
    if (url.protocol !== "https:") {
      throw new TransportFault(`core-v2-runtime: ${url.protocol}// is not https, so nothing was sent`, true);
    }
    if (url.username || url.password) {
      throw new TransportFault("core-v2-runtime: the url carries a credential, so nothing was sent", true);
    }
    const hostname = url.hostname.toLowerCase();
    if (!this.allowedHosts.includes(hostname)) {
      throw new TransportFault(`core-v2-runtime: ${hostname} is not a host any configured provider uses, so nothing was sent`, true);
    }
    const size = Buffer.byteLength(request.body ?? "", "utf8");
    if (size > this.maximumRequestBytes) {
      throw new TransportFault(`core-v2-runtime: the request is ${size} bytes and at most ${this.maximumRequestBytes} may be sent, so nothing was sent`, true);
    }
    if (request.signal?.aborted) {
      throw new TransportFault("core-v2-runtime: the request was cancelled before it was sent", true);
    }

    const addresses = isLiteralAddress(hostname) ? [hostname] : await this.resolveOrRefuse(hostname);
    const inside = addresses.filter((address) => !isPublicAddress(address));
    if (addresses.length === 0) {
      throw new TransportFault(`core-v2-runtime: ${hostname} resolves to nothing, so nothing was sent`, true);
    }
    if (inside.length > 0) {
      throw new TransportFault(`core-v2-runtime: ${hostname} resolves to an address inside this network, and this transport does not go there — nothing was sent`, true);
    }

    return await this.exchange(request, url);
  }

  private async resolveOrRefuse(hostname: string): Promise<string[]> {
    try {
      return await this.lookup(hostname);
    } catch (error) {
      throw new TransportFault(`core-v2-runtime: ${hostname} did not resolve (${codeOf(error)}), so nothing was sent`, true, error);
    }
  }

  private exchange(request: HttpRequest, url: URL): Promise<HttpResponse> {
    return new Promise<HttpResponse>((resolve, reject) => {
      /* Until a byte of the body has been handed to the socket, a failure is
         provably "nothing was sent". After that it is not, and this flag is
         the only thing that decides which. */
      let written = false;
      let settled = false;
      const finish = (fn: () => void) => { if (!settled) { settled = true; fn(); } };

      const options: NodeRequestOptions = {
        method: request.method,
        protocol: "https:",
        hostname: url.hostname,
        port: url.port ? Number(url.port) : 443,
        path: `${url.pathname}${url.search}`,
        headers: { ...request.headers, "content-length": String(Buffer.byteLength(request.body ?? "", "utf8")) },
        timeout: request.timeoutMs,
      };

      let outgoing: NodeRequest;
      try {
        outgoing = this.openRequest(options, (response) => {
          const status = response.statusCode ?? 0;
          const headers: Record<string, string> = {};
          for (const [name, value] of Object.entries(response.headers ?? {})) {
            headers[name.toLowerCase()] = Array.isArray(value) ? value.join(", ") : String(value ?? "");
          }
          let body = "";
          let overrun = false;
          response.setEncoding("utf8");
          response.on("data", (chunk: unknown) => {
            if (overrun) return;
            body += String(chunk);
            if (Buffer.byteLength(body, "utf8") > this.maximumResponseBytes) {
              overrun = true;
              response.destroy();
              finish(() => reject(new TransportFault(
                `core-v2-runtime: the answer went past ${this.maximumResponseBytes} bytes and was cut off; whether the work was done is not known`, false)));
            }
          });
          response.on("end", () => {
            /* A redirect is an answer, and it is handed back unfollowed. */
            finish(() => resolve({ status, headers, body }));
          });
          response.on("error", (error: unknown) => {
            finish(() => reject(new TransportFault(`core-v2-runtime: the answer stopped early (${codeOf(error)})`, false, error)));
          });
        });
      } catch (error) {
        finish(() => reject(new TransportFault(`core-v2-runtime: the request could not be opened (${codeOf(error)}), so nothing was sent`, true, error)));
        return;
      }

      const abort = () => {
        outgoing.destroy(new Error("cancelled"));
        finish(() => reject(new TransportFault(
          written
            ? "core-v2-runtime: the request was cancelled after it had been sent; whether the work was done is not known"
            : "core-v2-runtime: the request was cancelled before it was sent",
          !written)));
      };
      request.signal?.addEventListener("abort", abort, { once: true });

      outgoing.setTimeout(request.timeoutMs, () => {
        outgoing.destroy(new Error("timeout"));
        finish(() => reject(new TransportFault(
          written
            ? `core-v2-runtime: no answer within ${request.timeoutMs}ms of sending; whether the work was done is not known`
            : `core-v2-runtime: could not send within ${request.timeoutMs}ms`,
          !written)));
      });

      outgoing.on("error", (error: unknown) => {
        const code = codeOf(error);
        /* The three failures that are provably before submission, plus
           anything that happened before a byte was written. */
        const nothingSent = !written || code === "ENOTFOUND" || code === "ECONNREFUSED" || code === "EAI_AGAIN";
        finish(() => reject(new TransportFault(
          nothingSent
            ? `core-v2-runtime: the connection failed (${code}), so nothing was sent`
            : `core-v2-runtime: the connection failed after the request was sent (${code}); whether the work was done is not known`,
          nothingSent, error)));
      });

      outgoing.write(request.body ?? "", "utf8", (error?: Error | null) => {
        if (error) return;
        written = true;
      });
      outgoing.end();
    });
  }
}

/* THE ONLY WAY TO GET ONE. A factory rather than a constructor call so that
   "who is allowed to build this" is one line in one place, and so that the
   refusal carries every reason at once. */
export function createHttpsTransport(options: HttpsTransportOptions): HttpsTransport {
  return new HttpsTransport(options);
}

function codeOf(error: unknown): string {
  if (error && typeof error === "object" && typeof (error as { code?: unknown }).code === "string") return (error as { code: string }).code;
  if (error instanceof Error && error.message) return error.message.slice(0, 40);
  return "unknown";
}
