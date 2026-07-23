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
    apiKey: process.env.LLM_API_KEY || undefined,
    baseUrl: process.env.LLM_BASE_URL ?? "https://api.openai.com/v1",
    model: process.env.LLM_MODEL ?? "gpt-4o-mini",
  },
  port: Number(process.env.PORT ?? 8787),
} as const;
