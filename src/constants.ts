// Public, non-confidential constants — safe to commit. Secrets (keys) live in .env,
// read only in config.ts. Everything here is on-chain or otherwise public.

import type { Address } from "viem";

export type Network = "celo" | "celo_sepolia";

/**
 * 🔀 MASTER SWITCH — flip to `true` to run KaneAI on Celo MAINNET (else Sepolia testnet).
 * Drives BOTH the chain and the x402 network at once. Env `NETWORK` / `X402_NETWORK`
 * still override this per-run when set.
 */
export const MAINNET = true;

export const DEFAULT_NETWORK: Network = MAINNET ? "celo" : "celo_sepolia";
export const DEFAULT_X402_NETWORK: "mainnet" | "testnet" = MAINNET ? "mainnet" : "testnet";

/** KaneAI's registered attribution tag (ERC-8021) — rides on every agent tx. */
export const ATTRIBUTION_TAG = "celo_ac1c160afeb3";

export const CHAINS = {
  celo: {
    id: 42220,
    rpc: "https://forno.celo.org",
    explorer: "https://celoscan.io",
  },
  celo_sepolia: {
    id: 11142220,
    rpc: "https://forno.celo-sepolia.celo-testnet.org",
    explorer: "https://celo-sepolia.blockscout.com",
  },
} as const;

export interface TokenInfo {
  address: Address;
  decimals: number;
}

/** Canonical stablecoins per network. */
export const TOKENS: Record<Network, Record<string, TokenInfo>> = {
  celo: {
    USDC: { address: "0xcebA9300f2b948710d2653dD7B07f33A8B32118C", decimals: 6 },
    USDT: { address: "0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e", decimals: 6 },
    // Mento stablecoins — rebranded cUSD→USDm, cEUR→EURm (SAME addresses; per Celopedia).
    USDm: { address: "0x765DE816845861e75A25fCA122bb6898B8B1282a", decimals: 18 },
    EURm: { address: "0xD8763CBa276a3738E6DE85b4b3bF5FDed6D6cA73", decimals: 18 },
    CELO: { address: "0x471EcE3750Da237f93B8E339c536989b8978a438", decimals: 18 },
  },
  celo_sepolia: {
    USDC: { address: "0x01C5C0122039549AD1493B8220cABEdD739BC44E", decimals: 6 },
  },
};

/**
 * Deployed KaneExecutor stack per chainId (public; filled in after each deploy).
 * `factory` = KaneExecutorFactory, `beacon` = KaneBeacon, `implementation` = KaneExecutor logic.
 * Empty until the mainnet deploy lands (migration ships address-driven, deploy-deferred).
 */
export const DEPLOYMENTS: Record<
  number,
  { factory?: Address; beacon?: Address; implementation?: Address }
> = {
  // Deployed to Celo mainnet 2026-07-28 (verified on Celoscan). Fully upgradeable stack:
  // factory = UUPS proxy, beacon = UUPS proxy, executor = beacon proxy (all AccessControl).
  // `implementation` upgraded in place to the sweepTokens + Multicall logic (beacon.upgradeTo).
  [CHAINS.celo.id]: {
    factory: "0x1CB84F7597A97A6c6BEE5CcE3AF4E1fBF02E0981",
    beacon: "0x409240F0e64907f4644106914d6aFf78E97DE7aA",
    implementation: "0x0eAd5cdBcFe85a02Ec9EEd93317A2F123AC36693",
  },
  [CHAINS.celo_sepolia.id]: {},
};

/**
 * Aave V3 addresses per network — the demo rebalance venue (supply/withdraw).
 * Aave V3 is live on Celo MAINNET only. Sourced from Celopedia
 * `references/contracts.md` → DeFi Protocol Contracts (Mainnet) → Aave V3
 * (Pool + ProtocolDataProvider). Do not invent addresses.
 */
export const AAVE: Partial<Record<Network, { pool: Address; dataProvider: Address }>> = {
  celo: {
    pool: "0x3E59A31363E2ad014dcbc521c4a0d5757d9f3402",
    dataProvider: "0x2e0f8D3B1631296cC7c56538D6Eb6032601E15ED",
  },
};

/**
 * Ubeswap V2 (Uniswap-V2 fork) on Celo mainnet — the swap venue. Sourced from Celopedia
 * `references/defi-protocols.md` → Ubeswap. The V2 router's `swapExactTokensForTokens(...,
 * address to, uint deadline)` puts `to` at a STATIC head word (index 3), so the executor can
 * bind the recipient to the owner. `WETH` = the wrapped-native intermediary (CELO GoldToken).
 */
export const UBESWAP: Partial<Record<Network, { router: Address; factory: Address; weth: Address }>> = {
  celo: {
    router: "0xE3D8bd6Aed4F159bc8000a9cD47CffDb95F96121",
    factory: "0x62d5b84bE28a183aBB507E125B384122D2C25fAE",
    weth: "0x471EcE3750Da237f93B8E339c536989b8978a438", // CELO
  },
};

/** ERC-8004 Identity Registry per network. */
export const ERC8004_IDENTITY: Record<Network, Address> = {
  celo: "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432",
  celo_sepolia: "0x8004A818BFB912233c491871b3d84c89A494BD9e",
};

/** Hosted Celo x402 facilitator (USDC/USDT via EIP-3009). */
export const X402 = {
  mainnet: {
    facilitator: "https://api.x402.celo.org",
    caip2: "eip155:42220",
    usdc: "0xcebA9300f2b948710d2653dD7B07f33A8B32118C" as Address,
  },
  testnet: {
    facilitator: "https://api.x402.sepolia.celo.org",
    caip2: "eip155:11142220",
    usdc: "0x01C5C0122039549AD1493B8220cABEdD739BC44E" as Address,
  },
} as const;

/** Default x402 price per request: $0.01 in USDC base units (6 decimals). */
export const X402_DEFAULT_PRICE = "10000";

/** LLM defaults (OpenAI-compatible; dgrid.ai / Claude Haiku). */
export const LLM_DEFAULTS = {
  baseUrl: "https://api.dgrid.ai/v1",
  model: "anthropic/claude-haiku-4.5",
} as const;
