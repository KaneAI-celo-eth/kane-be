// Hosted Celo x402 facilitator client. Attaches the metering API key on every
// facilitator request (verify / settle / supported). The key never leaves the server.

import { HTTPFacilitatorClient } from "@x402/core/server";
import { config } from "../config";
import { X402 } from "../constants";

const net = config.x402.network; // "mainnet" | "testnet"

export const FACILITATOR_URL = X402[net].facilitator;

/** CAIP-2 network id for the active x402 network. */
export const X402_NETWORK: `eip155:${string}` = X402[net].caip2;

/** Canonical USDC (6 decimals, EIP-3009) for the active network. */
export const X402_USDC = X402[net].usdc;

export const facilitator = new HTTPFacilitatorClient({
  url: FACILITATOR_URL,
  createAuthHeaders: async () => {
    const h = { "X-API-Key": config.x402.apiKey ?? "" };
    return { verify: h, settle: h, supported: h };
  },
});
