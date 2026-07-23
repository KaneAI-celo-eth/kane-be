// Buyer flow — a fetch that transparently pays x402-protected endpoints from the
// agent wallet. Each settlement is also counted for Track 2. No facilitator key and
// no native gas needed (the facilitator sponsors settlement gas).

import { wrapFetchWithPaymentFromConfig } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";
import { config } from "../config";
import { X402_NETWORK } from "./facilitator";

/** A `fetch` that auto-pays on HTTP 402. Throws if the agent wallet key is unset. */
export function makePayFetch(): typeof fetch {
  if (!config.agentPrivateKey) {
    throw new Error("AGENT_PRIVATE_KEY not set — buyer fetch unavailable");
  }
  const account = privateKeyToAccount(config.agentPrivateKey);
  return wrapFetchWithPaymentFromConfig(fetch, {
    schemes: [{ network: X402_NETWORK, client: new ExactEvmScheme(account) }],
  }) as typeof fetch;
}
