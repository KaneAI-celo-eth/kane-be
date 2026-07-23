// Hosted Celo x402 facilitator client. Attaches the metering API key on every
// facilitator request (verify / settle / supported). The key never leaves the server.

import { HTTPFacilitatorClient } from "@x402/core/server";
import { config } from "../config";

export const FACILITATOR_URL =
  config.x402.network === "mainnet"
    ? "https://api.x402.celo.org"
    : "https://api.x402.sepolia.celo.org";

/** CAIP-2 network id for the active x402 network. */
export const X402_NETWORK: `eip155:${string}` =
  config.x402.network === "mainnet" ? "eip155:42220" : "eip155:11142220";

/** Canonical USDC (6 decimals, EIP-3009) for the active network. */
export const X402_USDC =
  config.x402.network === "mainnet"
    ? "0xcebA9300f2b948710d2653dD7B07f33A8B32118C"
    : "0x01C5C0122039549AD1493B8220cABEdD739BC44E";

export const facilitator = new HTTPFacilitatorClient({
  url: FACILITATOR_URL,
  createAuthHeaders: async () => {
    const h = { "X-API-Key": config.x402.apiKey ?? "" };
    return { verify: h, settle: h, supported: h };
  },
});
