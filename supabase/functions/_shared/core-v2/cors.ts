/* WHICH PAGES MAY TALK TO A CORE V2 DOOR, AND WHY A PREFLIGHT EXISTS AT ALL.
 *
 * A browser that sends `authorization` and `content-type: application/json`
 * asks permission first, with an OPTIONS request. A door that answers 405 to
 * that has not refused the caller — it has made itself unreachable from every
 * page, while still answering curl perfectly. That is exactly the failure this
 * file exists to prevent, and it was a real one: the analysis door shipped
 * without a preflight and could not be called from the Studio at all.
 *
 * WHICH ORIGINS. The product's own domains, a developer's own machine, and
 * this site's Netlify deploys — whose subdomain carries the branch or the pull
 * request number and therefore cannot be written down in advance. The pattern
 * is anchored at both ends and pinned to this site's Netlify name, so it
 * matches `deploy-preview-223--measureddecisionai.netlify.app` and nothing
 * that merely ends in something similar.
 *
 * An origin that is not allowed is answered with the prime domain, which is a
 * refusal a browser understands: the response arrives and the page may not
 * read it.
 */

const NAMED = new Set([
  "https://measureddecision.ai",
  "https://www.measureddecision.ai",
  "https://measureddecision.com",
  "https://www.measureddecision.com",
]);

const NETLIFY = /^https:\/\/[a-z0-9][a-z0-9-]*--measureddecisionai\.netlify\.app$/;
const LOCAL = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

export function allowedOrigin(origin: string): string {
  if (NAMED.has(origin) || NETLIFY.test(origin) || LOCAL.test(origin)) return origin;
  return "https://measureddecision.ai";
}

export function corsHeaders(request: Request): Record<string, string> {
  return {
    "access-control-allow-origin": allowedOrigin(request.headers.get("origin") || ""),
    "access-control-allow-headers": "authorization, x-client-info, apikey, content-type",
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-max-age": "3600",
    vary: "Origin",
  };
}

/* The preflight, answered with no body and nothing read. */
export function preflightResponse(request: Request): Response {
  return new Response(null, { status: 204, headers: corsHeaders(request) });
}
