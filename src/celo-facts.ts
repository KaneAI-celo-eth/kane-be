// Celopedia-grounded facts slice for the LLM proposer (decision 0004 / KANE-26).
//
// Celopedia lives at the workspace root (.agents/skills/celopedia-skill/references/),
// OUTSIDE the deployed kane-be — so the verified Celo facts are curated here and injected
// into the system prompt instead of read from disk at runtime. The model chooses only an
// action + amount; kane-be resolves every address from constants. "Inject the reference
// slice; never let the model guess addresses."
//
// Sources (do not invent addresses — keep in sync with Celopedia):
//   - references/network-info.md  → Celo Mainnet / Sepolia chain params
//   - references/contracts.md     → USDC (External Stablecoins), Aave V3 (Pool + ProtocolDataProvider)

import { AAVE, ATTRIBUTION_TAG, CHAINS, TOKENS, type Network } from "./constants";

/**
 * The verified-facts string injected into the proposer's system prompt for `network`.
 * Aave V3 is Celo-mainnet-only, so the Aave/USDC facts are the mainnet demo venue even
 * when the active runtime chain is Sepolia; the active chain id is stated for context.
 */
export function celoFactsPrompt(network: Network): string {
  const chain = CHAINS[network];
  // Aave (and the aUSDC position) only exist on Celo mainnet — the rebalance venue.
  const aave = AAVE.celo!;
  const mainnetUsdc = TOKENS.celo.USDC;
  if (!mainnetUsdc) throw new Error("USDC (celo) not configured");
  const usdc = TOKENS[network]?.USDC ?? mainnetUsdc;

  return [
    "VERIFIED CELO FACTS (authoritative — source: Celopedia references):",
    `- Active chain: ${network} (chainId ${chain.id}, RPC ${chain.rpc}, ~1s blocks, ~$0.0005 gas).`,
    `- USDC token (6 decimals): ${mainnetUsdc.address} — 1 USDC = 1000000 base units.`,
    `- Active-chain USDC: ${usdc.address}.`,
    `- Demo venue: Aave V3 on Celo mainnet (chainId ${CHAINS.celo.id}).`,
    `  Aave V3 Pool: ${aave.pool}`,
    `  Aave V3 ProtocolDataProvider: ${aave.dataProvider}`,
    "- Call shapes (encoded by the runtime, NOT by you):",
    "  supply(asset=USDC, amount, onBehalfOf=OWNER, referralCode=0) — deposits USDC, mints aUSDC to the owner.",
    "  withdraw(asset=USDC, amount, to=OWNER) — burns the owner's aUSDC, returns USDC to the owner.",
    "- Recipients are ALWAYS the vault owner; the on-chain executor rejects any other recipient.",
    `- Every executed transaction carries KaneAI's ERC-8021 attribution tag (${ATTRIBUTION_TAG}), appended by the runtime.`,
  ].join("\n");
}
