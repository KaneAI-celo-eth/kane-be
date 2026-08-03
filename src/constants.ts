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
    // Local/regional Mento stables (all 18d) swap on MENTO V3 (see mento.ts); most have NO
    // Ubeswap pool. ⚠️ FX/regional pairs are gated by Mento FX-market hours + oracle circuit
    // breakers, so a quote can be temporarily unavailable — handled gracefully by the router.
    USDm: { address: "0x765DE816845861e75A25fCA122bb6898B8B1282a", decimals: 18 },
    EURm: { address: "0xD8763CBa276a3738E6DE85b4b3bF5FDed6D6cA73", decimals: 18 },
    BRLm: { address: "0xe8537a3d056DA446677B9E9d6c5dB704EaAb4787", decimals: 18 },
    XOFm: { address: "0x73F93dcc49cB8A239e2032663e9475dd5ef29A08", decimals: 18 },
    KESm: { address: "0x456a3D042C0DbD3db53D5489e98dFb038553B0d0", decimals: 18 },
    NGNm: { address: "0xE2702Bd97ee33c88c8f6f92DA3B733608aa76F71", decimals: 18 },
    COPm: { address: "0x8A567e2aE79CA692Bd748aB832081C45de4041eA", decimals: 18 },
    GBPm: { address: "0xCCF663b1fF11028f0b19058d0f7B674004a40746", decimals: 18 },
    CHFm: { address: "0xb55a79F398E759E43C95b979163f30eC87Ee131D", decimals: 18 },
    JPYm: { address: "0xc45eCF20f3CD864B32D9794d6f76814aE8892e20", decimals: 18 },
    AUDm: { address: "0x7175504C455076F15c04A2F90a8e352281F492F9", decimals: 18 },
    CADm: { address: "0xff4Ab19391af240c311c54200a492233052B6325", decimals: 18 },
    GHSm: { address: "0xfAeA5F3404bbA20D3cc2f8C4B0A888F55a3c7313", decimals: 18 },
    PHPm: { address: "0x105d4A9306D2E55a71d2Eb95B81553AE1dC20d7B", decimals: 18 },
    ZARm: { address: "0x4c35853A3B4e647fD266f4de678dCc8fEC410BF6", decimals: 18 },
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
  // Upgraded in place 2026-07-30 to add ONE-TX registration (createExecutorWithPolicy) + OWNER-can-
  // execute (manual actions owner-signed; agent path reserved for the scheduler). Factory & beacon
  // proxy addresses unchanged; only the impls behind them changed — executor impl
  // 0x1d67929fc0cb885be25B4056AA051dD4630d987c, factory impl 0x9ac0521b0ccb1e20c6f4aaa4460197ca8bb6209a.
  // (Prior: central-agent build executor impl 0x1c3caFa…, before that sweepTokens+Multicall 0x0eAd…6693.)
  // Central agent = 0x08633C082736dE642C1A787FF7B07a2AA415A1D7.
  [CHAINS.celo.id]: {
    factory: "0x1CB84F7597A97A6c6BEE5CcE3AF4E1fBF02E0981",
    beacon: "0x409240F0e64907f4644106914d6aFf78E97DE7aA",
    implementation: "0x1d67929fc0cb885be25B4056AA051dD4630d987c",
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
 * Moola Market — a 2nd lending venue (Aave **V2** fork). Lends CELO/USDm/EURm/BRLm (NOT USDC/USDT/
 * WETH — so it complements Aave rather than overlapping on USDC). `deposit`/`withdraw` bind the
 * recipient (`onBehalfOf`/`to`) to the owner at head word 2, same as Aave — no contract change.
 * Verified on-chain 2026-08-03: LendingPool below, reserves CELO/USDm/EURm/BRLm. ⚠️ V2's
 * `getReserveData` struct differs from V3 (see lending.ts).
 */
export const MOOLA: Partial<Record<Network, Address>> = {
  celo: "0x970b12522CA9b4054807a2c5B736149a5BE6f670",
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
/** KaneAI's registered ERC-8004 agentId (mainnet, owner = agent wallet 0x0863…A1D7). */
export const ERC8004_AGENT_ID = 9749n;

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
