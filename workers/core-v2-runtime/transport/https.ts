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
 *   · the endpoint must belong to a provider this run is AUTHORISED for, not
 *     merely one an operator configured. Configured and authorised are two
 *     different sets, and treating the larger one as the smaller is how a run
 *     that paid for one provider reaches another. The allowlist is a list of
 *     normalised origins — scheme, host and effective port — because a host
 *     is not an endpoint;
 *   · a url carrying a credential (user:pass@) is refused before anything is
 *     resolved: a credential in a url is a credential in every log that ever
 *     writes a url;
 *   · the address it would connect to must be public, decided by PARSING the
 *     address rather than by looking at the front of a string. Loopback,
 *     this-network, private ranges, carrier-grade NAT, link-local,
 *     unique-local, benchmarking, multicast, reserved and the broadcast
 *     address are refused — for IPv4, for IPv6 (including a bracketed url
 *     hostname such as [::1], which a prefix check silently lets through),
 *     and for every IPv4 address wearing an IPv6 costume;
 *   · and the addresses that passed those checks are the addresses the socket
 *     connects to. The lookup handed to node answers only from that set, so a
 *     name that resolved outside once cannot resolve inside a moment later:
 *     there is no second lookup to poison. There is no connection pool
 *     either, because a pooled socket is handed back without any lookup at
 *     all and would carry a request over a connection a different request
 *     validated. The hostname is still what the certificate is verified
 *     against and what the handshake asks for;
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
import { authorizedProviders, networkAuthorizationProblems } from "../runtime-config.ts";

/* The node-level seam. Declared structurally rather than imported as a type
   so that this file compiles with no dependency on node's own typings, and so
   that a test can hand it a double at exactly the boundary where the socket
   would be. */
export type NodeLookupOptions = { family?: number; all?: boolean; hints?: number; verbatim?: boolean };
export type NodeLookupCallback = (error: Error | null, address?: string | { address: string; family: number }[], family?: number) => void;
export type NodeLookup = (hostname: string, options: NodeLookupOptions | NodeLookupCallback, callback?: NodeLookupCallback) => void;

export type NodeRequestOptions = {
  method: string;
  protocol: string;
  hostname: string;
  /* What the handshake asks for and the certificate is checked against.
     Absent for an address literal, which has no name to ask for. */
  servername?: string;
  port: number;
  path: string;
  headers: Record<string, string>;
  timeout: number;
  /* The addresses this request may connect to, and no others. */
  lookup: NodeLookup;
  /* Deliberately false: no connection pool, so no request is ever carried by
     a socket some earlier request opened. */
  agent: false;
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

/* ──────────────────────────────────────────── addresses, parsed as addresses

   The rule "do not reach inside this network" is only as good as the parsing
   underneath it, and string prefixes are not parsing: "fd00::1" starts with
   "fd" and so does "fdoo.example" — and, the other way, a url's hostname for
   an IPv6 literal arrives WRAPPED IN BRACKETS, so "[::1]" matches neither
   "::1" nor any prefix, and a check written on prefixes lets loopback
   straight through. Everything below therefore parses to bytes first and
   decides on the bytes. */

export type ParsedAddress = { family: 4 | 6; bytes: number[]; text: string };

/* A url hostname, an answer from a resolver, or an operator's literal. Null
   means "this is not an address", which for a hostname means it is a name and
   will be resolved, and for a resolver's answer means the answer is refused. */
export function parseAddress(value: string): ParsedAddress | null {
  const raw = value.trim().toLowerCase();
  if (raw.length === 0) return null;
  /* A url gives an IPv6 hostname bracketed; a resolver does not. */
  const bare = raw.startsWith("[") && raw.endsWith("]") ? raw.slice(1, -1) : raw;
  /* A zone index ("fe80::1%eth0") names an interface on this machine. */
  const withoutZone = bare.includes("%") ? bare.slice(0, bare.indexOf("%")) : bare;
  if (withoutZone.includes(":")) {
    const bytes = parseIpv6(withoutZone);
    return bytes ? { family: 6, bytes, text: withoutZone } : null;
  }
  const bytes = parseIpv4(withoutZone);
  return bytes ? { family: 4, bytes, text: withoutZone } : null;
}

function parseIpv4(value: string): number[] | null {
  const parts = value.split(".");
  if (parts.length !== 4) return null;
  const bytes: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const byte = Number(part);
    if (byte > 255) return null;
    bytes.push(byte);
  }
  return bytes;
}

function parseIpv6(value: string): number[] | null {
  const halves = value.split("::");
  if (halves.length > 2) return null;
  const readGroups = (text: string): number[] | null => {
    if (text.length === 0) return [];
    const out: number[] = [];
    const groups = text.split(":");
    for (let i = 0; i < groups.length; i += 1) {
      const group = groups[i];
      /* A trailing dotted quad, as in ::ffff:127.0.0.1. */
      if (group.includes(".")) {
        if (i !== groups.length - 1) return null;
        const quad = parseIpv4(group);
        if (!quad) return null;
        out.push(...quad);
        continue;
      }
      if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
      const word = Number.parseInt(group, 16);
      out.push((word >> 8) & 0xff, word & 0xff);
    }
    return out;
  };
  const head = readGroups(halves[0] ?? "");
  const tail = halves.length === 2 ? readGroups(halves[1] ?? "") : [];
  if (head === null || tail === null) return null;
  if (halves.length === 1) return head.length === 16 ? head : null;
  const missing = 16 - head.length - tail.length;
  if (missing < 0) return null;
  return [...head, ...new Array<number>(missing).fill(0), ...tail];
}

/* Everything nothing outside may be reached at, decided on the bytes:
   loopback, this-network, private, carrier-grade NAT, link-local,
   unique-local, benchmarking, multicast, reserved and the broadcast address —
   for IPv4, and for every IPv4 address wearing an IPv6 costume. */
function publicV4(b: number[]): boolean {
  const [a, second, third] = b;
  if (a === 0) return false;                                   /* 0.0.0.0/8, and the unspecified address */
  if (a === 10) return false;                                  /* 10/8 */
  if (a === 127) return false;                                 /* loopback */
  if (a === 100 && second >= 64 && second <= 127) return false; /* 100.64/10, carrier-grade NAT */
  if (a === 169 && second === 254) return false;               /* link-local, and the metadata address */
  if (a === 172 && second >= 16 && second <= 31) return false; /* 172.16/12 */
  if (a === 192 && second === 0 && third === 0) return false;  /* 192.0.0/24 */
  if (a === 192 && second === 168) return false;               /* 192.168/16 */
  if (a === 198 && (second === 18 || second === 19)) return false; /* benchmarking */
  if (a >= 224) return false;                                  /* multicast, reserved, broadcast */
  return true;
}

function publicV6(b: number[]): boolean {
  const zeros = (upto: number) => b.slice(0, upto).every((byte) => byte === 0);
  if (b.every((byte) => byte === 0)) return false;             /* :: */
  if (zeros(15) && b[15] === 1) return false;                  /* ::1 */
  if (zeros(10) && b[10] === 0xff && b[11] === 0xff) return publicV4(b.slice(12)); /* ::ffff:a.b.c.d */
  if (zeros(12)) return publicV4(b.slice(12));                 /* ::a.b.c.d, deprecated but still routed */
  if (b[0] === 0xfe && (b[1] & 0xc0) === 0x80) return false;   /* fe80::/10 link-local */
  if ((b[0] & 0xfe) === 0xfc) return false;                    /* fc00::/7 unique local */
  if (b[0] === 0xff) return false;                             /* ff00::/8 multicast */
  return true;
}

/* True only for an address that is genuinely outside. Anything that is not an
   address at all is NOT called public here: a caller asks this about a
   literal it has already parsed, or about an answer a resolver gave, and both
   of those are addresses or nothing. */
export function isPublicAddress(value: string): boolean {
  const parsed = parseAddress(value);
  if (!parsed) return false;
  return parsed.family === 4 ? publicV4(parsed.bytes) : publicV6(parsed.bytes);
}

/* https, host, effective port. Two urls that reach the same socket normalise
   to the same string, and two that do not, do not — which is the whole point:
   an allowlist of hosts lets a second provider on a second port through, and
   an allowlist of origins does not. */
export function httpsOrigin(url: URL): string {
  return `https://${url.hostname.toLowerCase()}:${url.port === "" ? "443" : url.port}`;
}

/* What a name resolves to, asked of the system resolver. Only used for a
   host that is not already a literal address. */
const systemLookup: Lookup = async (hostname: string): Promise<string[]> => {
  const resolver = (dns as unknown as { promises: { lookup(host: string, options: { all: true; verbatim: true }): Promise<{ address: string }[]> } }).promises;
  const found = await resolver.lookup(hostname, { all: true, verbatim: true });
  return found.map((entry) => entry.address);
};

export class HttpsTransport implements HttpTransport {
  readonly name = "https";
  /* Where this transport may go: one normalised https origin per authorised
     provider. Not a list of hosts — a host is not an endpoint. */
  readonly allowedOrigins: string[];
  private openRequest: OpenRequest;
  private lookup: Lookup;
  private maximumRequestBytes: number;
  private maximumResponseBytes: number;

  constructor(options: HttpsTransportOptions) {
    /* THE GATES, AT CONSTRUCTION — and the whole of the authorization, not
       the four booleans on their own. A process that is not authorised never
       holds one of these, and a process that is authorised for one provider
       never holds one that can reach a different one. */
    const refusals = networkAuthorizationProblems(options.config);
    if (refusals.length > 0) {
      throw new NetworkNotAuthorized(
        "core-v2-runtime: a transport that can reach a provider may not be built until every authorization is in place",
        refusals,
      );
    }
    /* One origin per AUTHORISED provider — scheme, host and effective port.
       A provider that is merely configured contributes nothing: it is not
       what this run was authorised to spend money on, so it is not somewhere
       this transport may go. */
    const origins = new Set<string>();
    const byId = new Map(options.config.providers.map((p) => [p.providerId, p]));
    for (const authorized of authorizedProviders(options.config)) {
      const provider = byId.get(authorized.providerId)!;
      let url: URL;
      try {
        url = new URL(provider.baseUrl);
      } catch {
        throw new NetworkNotAuthorized(`core-v2-runtime: ${provider.providerId} is authorised and has an address that is not a url`);
      }
      if (url.protocol !== "https:") {
        throw new NetworkNotAuthorized(`core-v2-runtime: ${provider.providerId} is configured at ${url.protocol}//, and this transport speaks https only`);
      }
      if (url.username || url.password) {
        throw new NetworkNotAuthorized(`core-v2-runtime: ${provider.providerId} has a credential written into its address`);
      }
      origins.add(httpsOrigin(url));
    }
    /* networkAuthorizationProblems has already refused an authorisation that
       covers nothing, so this cannot be reached by an ordinary path; it is
       here because a transport with nowhere to go must never exist. */
    if (origins.size === 0) throw new NetworkNotAuthorized("core-v2-runtime: this authorisation names no address, so there is nowhere this transport may go");
    this.allowedOrigins = [...origins].sort();
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
    const origin = httpsOrigin(url);
    if (!this.allowedOrigins.includes(origin)) {
      throw new TransportFault(`core-v2-runtime: ${origin} is not an endpoint this run is authorised to reach, so nothing was sent`, true);
    }
    const hostname = url.hostname.toLowerCase();
    const size = Buffer.byteLength(request.body ?? "", "utf8");
    if (size > this.maximumRequestBytes) {
      throw new TransportFault(`core-v2-runtime: the request is ${size} bytes and at most ${this.maximumRequestBytes} may be sent, so nothing was sent`, true);
    }
    if (request.signal?.aborted) {
      throw new TransportFault("core-v2-runtime: the request was cancelled before it was sent", true);
    }

    /* THE ADDRESS SET, DECIDED ONCE AND THEN USED. An operator's literal is
       checked as itself; a name is resolved here, and the answers this check
       passed are the answers the connection is pinned to below. A second
       lookup at connection time is the whole of the rebinding attack, and
       there is no second lookup. */
    const literal = parseAddress(hostname);
    let addresses: string[];
    if (literal) {
      if (!isPublicAddress(hostname)) {
        throw new TransportFault(`core-v2-runtime: ${hostname} is an address inside this network, and this transport does not go there — nothing was sent`, true);
      }
      addresses = [literal.text];
    } else {
      const answered = await this.resolveOrRefuse(hostname);
      if (answered.length === 0) {
        throw new TransportFault(`core-v2-runtime: ${hostname} resolves to nothing, so nothing was sent`, true);
      }
      /* An answer that is not an address is not an answer, and ONE bad
         address in a set of good ones refuses the whole set. A resolver that
         returns both a public address and a private one is the ordinary shape
         of a rebinding attempt, not a partial success. */
      for (const address of answered) {
        if (!parseAddress(address)) {
          throw new TransportFault(`core-v2-runtime: ${hostname} resolved to something that is not an address, so nothing was sent`, true);
        }
      }
      const inside = answered.filter((address) => !isPublicAddress(address));
      if (inside.length > 0) {
        throw new TransportFault(`core-v2-runtime: ${hostname} resolves to an address inside this network, and this transport does not go there — nothing was sent`, true);
      }
      addresses = answered.map((address) => parseAddress(address)!.text);
    }

    return await this.exchange(request, url, addresses);
  }

  /* The lookup handed to the socket. It answers ONLY from the addresses that
     passed the checks above, never asks anybody anything, and cannot be made
     to change its mind — so what the certificate is verified against is the
     hostname, and what the connection goes to is an address this run already
     decided was outside. */
  private pinnedLookup(hostname: string, addresses: string[]): NodeLookup {
    const answers = addresses.map((address) => ({ address, family: parseAddress(address)!.family }));
    return (asked: string, optionsOrCallback: NodeLookupOptions | NodeLookupCallback, maybeCallback?: NodeLookupCallback): void => {
      const callback = (typeof optionsOrCallback === "function" ? optionsOrCallback : maybeCallback)!;
      const wanted = typeof optionsOrCallback === "function" ? {} : (optionsOrCallback ?? {});
      const matching = wanted.family === 4 || wanted.family === 6
        ? answers.filter((answer) => answer.family === wanted.family)
        : answers;
      if (matching.length === 0) {
        callback(Object.assign(new Error(`core-v2-runtime: ${asked || hostname} has no address this run checked`), { code: "ENOTFOUND" }));
        return;
      }
      if (wanted.all) { callback(null, matching.map((answer) => ({ ...answer }))); return; }
      callback(null, matching[0].address, matching[0].family);
    };
  }

  private async resolveOrRefuse(hostname: string): Promise<string[]> {
    try {
      return await this.lookup(hostname);
    } catch (error) {
      throw new TransportFault(`core-v2-runtime: ${hostname} did not resolve (${codeOf(error)}), so nothing was sent`, true, error);
    }
  }

  private exchange(request: HttpRequest, url: URL, addresses: string[]): Promise<HttpResponse> {
    return new Promise<HttpResponse>((resolve, reject) => {
      /* Until a byte of the body has been handed to the socket, a failure is
         provably "nothing was sent". After that it is not, and this flag is
         the only thing that decides which. */
      let written = false;
      let settled = false;
      const finish = (fn: () => void) => { if (!settled) { settled = true; fn(); } };

      const hostname = url.hostname.toLowerCase();
      const literal = parseAddress(hostname);
      const options: NodeRequestOptions = {
        method: request.method,
        protocol: "https:",
        /* The NAME, so the certificate is verified against the name and the
           handshake asks for it — while the socket goes only where the
           pinned lookup says. An address literal gets no server name,
           because there is no name to put in one. */
        hostname: url.hostname,
        servername: literal ? undefined : hostname,
        port: url.port ? Number(url.port) : 443,
        path: `${url.pathname}${url.search}`,
        headers: { ...request.headers, "content-length": String(Buffer.byteLength(request.body ?? "", "utf8")) },
        timeout: request.timeoutMs,
        lookup: this.pinnedLookup(hostname, addresses),
        /* NO CONNECTION POOL. node's default agent keeps sockets alive and
           hands a pooled one straight back — WITHOUT calling lookup at all,
           because there is nothing left to resolve. A request carried that
           way travels over a connection some earlier request established,
           which is not the same thing as a connection established through
           the address set THIS request validated. The rule is that the
           addresses that were checked are the addresses connected to, so
           every request opens its own socket through its own pinned lookup
           and closes it again. A paid call per attempt is not a workload
           that needs a pool. */
        agent: false,
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
