// End-to-end x402 BUYER test — pays a real 0.01 USDC to KaneAI's live seller and gets the proposal.
// Proves the Track-2 flow works on mainnet + seeds the settlement count.
//
// Usage:  bun run scripts/x402-buy-test.ts
//
// Requires: BUYER_PRIVATE_KEY (a mainnet wallet holding ≥0.02 USDC; defaults to AGENT_PRIVATE_KEY)
//           and the seller's facilitator (x402.celo.org) must have prepaid credits.
// The seller is the deployed backend; override with SELLER_URL.

import { x402Client, wrapFetchWithPayment } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";

const SELLER = process.env.SELLER_URL ?? "https://kane-api.157.10.160.167.nip.io";
const pk = (process.env.BUYER_PRIVATE_KEY ?? process.env.AGENT_PRIVATE_KEY) as `0x${string}` | undefined;
if (!pk) {
  console.error("set BUYER_PRIVATE_KEY (or AGENT_PRIVATE_KEY) — a mainnet wallet with USDC");
  process.exit(1);
}

const account = privateKeyToAccount(pk);
console.log("buyer:", account.address, "→ seller:", SELLER);

// The connected account IS the ClientEvmSigner (viem LocalAccount has address + signTypedData).
const client = new x402Client().register("eip155:42220", new ExactEvmScheme(account));
const payFetch = wrapFetchWithPayment(fetch, client);

const res = await payFetch(`${SELLER}/intent`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ intent: "What's the best USDC yield on Celo right now?" }),
});

console.log("HTTP", res.status);
const settle = res.headers.get("PAYMENT-RESPONSE") ?? res.headers.get("X-PAYMENT-RESPONSE");
if (settle) {
  try {
    console.log("settlement:", JSON.parse(Buffer.from(settle, "base64").toString()));
  } catch {
    console.log("settlement header:", settle);
  }
}
const body = await res.json().catch(() => ({}));
console.log("agent replied:", JSON.stringify(body).slice(0, 400));
console.log(res.ok ? "\n✅ paid 0.01 USDC + got the proposal — x402 works end-to-end on mainnet" : "\n⚠️ not settled (check USDC balance + facilitator credits)");
