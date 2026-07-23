// Runtime config. Reads ONLY secrets (keys) and deployment toggles/overrides from
// the environment (Bun auto-loads .env). All public constants live in constants.ts.

import {
  ATTRIBUTION_TAG,
  CHAINS,
  DEFAULT_NETWORK,
  DEFAULT_X402_NETWORK,
  DEPLOYMENTS,
  LLM_DEFAULTS,
  X402_DEFAULT_PRICE,
  type Network,
} from "./constants";

export { ATTRIBUTION_TAG };
export type { Network };

// Env wins if explicitly set, otherwise the MAINNET toggle in constants.ts decides.
export const NETWORK: Network =
  process.env.NETWORK === "celo"
    ? "celo"
    : process.env.NETWORK === "celo_sepolia"
      ? "celo_sepolia"
      : DEFAULT_NETWORK;

const chainId = CHAINS[NETWORK].id;

export const config = {
  network: NETWORK,
  rpcUrl: process.env.RPC_URL || undefined, // optional RPC override (public)

  // --- secrets (from .env) ---
  agentPrivateKey: process.env.AGENT_PRIVATE_KEY as `0x${string}` | undefined,

  // --- deployed addresses: env override, else the checked-in constant ---
  factoryAddress:
    (process.env.FACTORY_ADDRESS as `0x${string}` | undefined) || DEPLOYMENTS[chainId]?.factory,
  vaultAddress: process.env.VAULT_ADDRESS as `0x${string}` | undefined,

  llm: {
    apiKey: process.env.AI_AUTH_TOKEN || undefined, // secret
    baseUrl: process.env.LLM_BASE_URL ?? LLM_DEFAULTS.baseUrl,
    model: process.env.LLM_MODEL ?? LLM_DEFAULTS.model,
  },

  x402: {
    apiKey: process.env.X402_API_KEY || undefined, // secret
    network:
      process.env.X402_NETWORK === "mainnet"
        ? "mainnet"
        : process.env.X402_NETWORK === "testnet"
          ? "testnet"
          : DEFAULT_X402_NETWORK,
    payTo: process.env.X402_PAY_TO as `0x${string}` | undefined, // public receiving address
    price: process.env.X402_PRICE ?? X402_DEFAULT_PRICE,
  },

  port: Number(process.env.PORT ?? 8787),
} as const;
