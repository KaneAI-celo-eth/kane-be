// Central config, read from the environment (Bun auto-loads .env).

export type Network = "celo" | "celo_sepolia";

/** KaneAI's registered attribution tag. Must be present in every agent tx. */
export const ATTRIBUTION_TAG = process.env.ATTRIBUTION_TAG ?? "celo_ac1c160afeb3";

export const NETWORK: Network =
  process.env.NETWORK === "celo" ? "celo" : "celo_sepolia";

export const config = {
  network: NETWORK,
  rpcUrl: process.env.RPC_URL || undefined,
  agentPrivateKey: process.env.AGENT_PRIVATE_KEY as `0x${string}` | undefined,
  factoryAddress: process.env.FACTORY_ADDRESS as `0x${string}` | undefined,
  vaultAddress: process.env.VAULT_ADDRESS as `0x${string}` | undefined,
  llm: {
    // OpenAI-compatible endpoint (default: dgrid.ai). Key env var is AI_AUTH_TOKEN.
    apiKey: process.env.AI_AUTH_TOKEN || undefined,
    baseUrl: process.env.LLM_BASE_URL ?? "https://api.dgrid.ai/v1",
    model: process.env.LLM_MODEL ?? "anthropic/claude-haiku-4.5",
  },
  x402: {
    // Seller: facilitator credits key (from https://x402.celo.org dashboard).
    apiKey: process.env.X402_API_KEY || undefined,
    network: (process.env.X402_NETWORK === "mainnet" ? "mainnet" : "testnet") as "mainnet" | "testnet",
    // Seller's own receiving wallet (gets the USDC). Track-2 settlements are counted for this address.
    payTo: process.env.X402_PAY_TO as `0x${string}` | undefined,
    // Price per paid request, in USDC base units (6 decimals). "10000" = $0.01.
    price: process.env.X402_PRICE ?? "10000",
  },
  port: Number(process.env.PORT ?? 8787),
} as const;
