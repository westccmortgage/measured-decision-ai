export type OpenAITransport = {
  provider: "openai";
  transport: "cloudflare_ai_gateway" | "openai_direct";
  baseUrl: string;
  headers: Record<string, string>;
};

type TransportOptions = {
  zeroDataRetention?: boolean;
};

function env(name: string) {
  return (Deno.env.get(name) || "").trim();
}

/**
 * Prefer Cloudflare AI Gateway when its server-only credentials are configured.
 *
 * The provider-native OpenAI route deliberately keeps the OpenAI Responses API
 * wire format unchanged. That matters to plan-analyze, which creates a native
 * background response and later retrieves that same response by id.
 *
 * In Cloudflare mode we do NOT send an OpenAI Authorization header. With no
 * default OpenAI BYOK key stored on this gateway, Cloudflare therefore falls
 * through to Unified Billing instead of charging the direct OpenAI account.
 * OPENAI_API_KEY remains a safe fallback until the gateway secrets are present.
 */
export function openAITransport(options: TransportOptions = {}): OpenAITransport {
  const accountId = env("CLOUDFLARE_ACCOUNT_ID");
  const gatewayId = env("CLOUDFLARE_AI_GATEWAY_ID");
  const gatewayToken = env("CLOUDFLARE_AI_GATEWAY_TOKEN") || env("CLOUDFLARE_API_TOKEN");
  const hasGatewayConfig = Boolean(accountId || gatewayId || gatewayToken);

  if (hasGatewayConfig) {
    if (!accountId || !gatewayToken) {
      throw new Error("Cloudflare AI Gateway configuration is incomplete");
    }

    const headers: Record<string, string> = {
      "cf-aig-authorization": `Bearer ${gatewayToken}`,
      "cf-aig-collect-log-payload": "false",
      "Content-Type": "application/json",
    };
    if (options.zeroDataRetention) headers["cf-aig-zdr"] = "true";

    return {
      provider: "openai",
      transport: "cloudflare_ai_gateway",
      baseUrl: `https://gateway.ai.cloudflare.com/v1/${encodeURIComponent(accountId)}/${encodeURIComponent(gatewayId || "default")}/openai`,
      headers,
    };
  }

  const openAIKey = env("OPENAI_API_KEY");
  if (!openAIKey) throw new Error("OpenAI provider configuration is incomplete");

  return {
    provider: "openai",
    transport: "openai_direct",
    baseUrl: "https://api.openai.com/v1",
    headers: {
      Authorization: `Bearer ${openAIKey}`,
      "Content-Type": "application/json",
    },
  };
}
