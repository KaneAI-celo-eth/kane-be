// Seller flow — charge 0.01 USDC per prompt via the hosted Celo x402 facilitator.
// The PAID product is the agent itself: every `POST /intent` (one user prompt → one proposal)
// requires a 0.01 USDC payment. Settlements to `config.x402.payTo` are counted for Track 2
// (Most x402 Payments). Enabled only when an API key + receiving wallet are configured, so local
// (anvil) dev stays free; the real per-prompt charge runs against mainnet USDC.

import { paymentMiddleware, x402ResourceServer } from "@x402/hono";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { getAddress } from "viem";
import { config } from "../config";
import { facilitator, X402_NETWORK, X402_USDC } from "./facilitator";

/** True when the seller side is configured (API key + receiving wallet) AND we're not on a local
 *  fork. x402 settles REAL mainnet USDC via the hosted facilitator, so it's auto-disabled when
 *  RPC_URL points at a local anvil node — local/dev prompts stay free; the mainnet demo charges. */
export function x402Enabled(): boolean {
  const local = /localhost|127\.0\.0\.1/.test(config.rpcUrl ?? "");
  return Boolean(config.x402.apiKey && config.x402.payTo) && !local;
}

/** The paid route — one user prompt to the agent. */
export const PAID_ROUTE = "/intent";

/** Build the Hono payment middleware: `POST /intent` costs `config.x402.price` (default 0.01 USDC).
 *  Call only when x402Enabled(). Non-paid routes (/health, /policy, …) are untouched. */
export function buildPaymentMiddleware() {
  const server = new x402ResourceServer(facilitator);
  server.register("eip155:*", new ExactEvmScheme());

  // Inlined so the object literal is contextually typed against RoutesConfig.
  return paymentMiddleware(
    {
      "POST /intent": {
        accepts: [
          {
            scheme: "exact",
            network: X402_NETWORK,
            payTo: getAddress(config.x402.payTo!),
            price: {
              amount: config.x402.price, // "10000" = 0.01 USDC (6 decimals)
              asset: getAddress(X402_USDC),
              extra: { name: "USDC", version: "2" }, // EIP-712 domain for EIP-3009
            },
          },
        ],
        description: "KaneAI agent — one prompt (pay-per-call)",
      },
    },
    server,
  );
}
