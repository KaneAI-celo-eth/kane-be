// Seller flow — charge per request via the hosted Celo x402 facilitator.
// Settlements to `config.x402.payTo` are counted for Track 2 (Most x402 Payments).
//
// TODO(tuning): the paid route below ("/x402/advice") is a placeholder product —
// swap it for the real thing KaneAI sells per call (agent advice, a signed action
// proposal, a data endpoint, …). Keep the price object shape.

import { paymentMiddleware, x402ResourceServer } from "@x402/hono";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { getAddress } from "viem";
import { config } from "../config";
import { facilitator, X402_NETWORK, X402_USDC } from "./facilitator";

/** True when the seller side is configured (API key + receiving wallet). */
export function x402Enabled(): boolean {
  return Boolean(config.x402.apiKey && config.x402.payTo);
}

/** The path the paid handler is mounted at. */
export const PAID_ROUTE = "/x402/advice";

/** Build the Hono payment middleware for the paid route(s). Call only when x402Enabled(). */
export function buildPaymentMiddleware() {
  const server = new x402ResourceServer(facilitator);
  server.register("eip155:*", new ExactEvmScheme());

  // Inlined so the object literal is contextually typed against RoutesConfig.
  return paymentMiddleware(
    {
      "GET /x402/advice": {
        accepts: [
          {
            scheme: "exact",
            network: X402_NETWORK,
            payTo: getAddress(config.x402.payTo!),
            price: {
              amount: config.x402.price,
              asset: getAddress(X402_USDC),
              extra: { name: "USDC", version: "2" }, // EIP-712 domain for EIP-3009
            },
          },
        ],
        description: "KaneAI agent advice (pay-per-call)",
      },
    },
    server,
  );
}
