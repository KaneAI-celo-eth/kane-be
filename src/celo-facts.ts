// Verified CORE facts for the LLM assistant — the exact addresses/venues the runtime acts on,
// DERIVED from this repo's Celopedia-verified registry (constants.ts) so the prompt can never
// drift from what the code uses. Broad Celo knowledge (protocols, yields, ecosystem) is retrieved
// separately from the live Celopedia references (see celopedia.ts). Decision 0004 / KANE-26.
//
// Keep constants.ts in sync with the bundled Celopedia refs (`celopedia-refs/`, re-vendored via
// `bun run sync-celopedia`) — the CLAUDE.md "always check Celopedia" rule.

import { AAVE, ATTRIBUTION_TAG, CHAINS, TOKENS, UBESWAP, type Network } from "./constants";

/** The verified core-facts string injected into the assistant's system prompt for `network`. */
export function celoFactsPrompt(network: Network): string {
  const chain = CHAINS[network];
  const aave = AAVE.celo!; // Aave V3 is Celo-mainnet-only — the yield venue
  const ube = UBESWAP.celo; // Ubeswap V2 — the swap venue
  const tokens = TOKENS[network] && Object.keys(TOKENS[network]).length ? TOKENS[network] : TOKENS.celo;
  const tokenLines = Object.entries(tokens).map(([sym, t]) => `    ${sym}: ${t.address} (${t.decimals} decimals)`);

  return [
    "VERIFIED CELO FACTS (authoritative — from the Celopedia-verified registry):",
    `- Active chain: ${network} (chainId ${chain.id}, RPC ${chain.rpc}, ~1s blocks, ~$0.0005 gas).`,
    "- Supported tokens (you use SYMBOLS only; the runtime resolves every address):",
    ...tokenLines,
    '    NOTE: USDm = Mento Dollar (formerly cUSD); EURm = Mento Euro (formerly cEUR) — same tokens, new names. "USDM" (capital M) is a DIFFERENT token (Mountain Protocol) and is NOT supported.',
    `- Yield venue: Aave V3 on Celo mainnet (chainId ${CHAINS.celo.id}) — Pool ${aave.pool}, ProtocolDataProvider ${aave.dataProvider}. supply/withdraw USDC; a deposit mints aUSDC to the owner. The live USDC supply APR is provided under LIVE DATA when available.`,
    ube
      ? `- Swap venue: Ubeswap V2 (Uniswap-V2 fork) — Router ${ube.router}. Deep pools: CELO/USDm, USDm/EURm, CELO/EURm; USDC/USDT pairs are thin (their liquidity is on Mento). Swaps route here with the output bound to the owner.`
      : "",
    "- Call shapes are encoded by the runtime, NOT by you. Recipients/outputs are ALWAYS the vault owner; the on-chain executor rejects any other recipient.",
    `- Every executed transaction carries KaneAI's ERC-8021 attribution tag (${ATTRIBUTION_TAG}), appended by the runtime.`,
  ]
    .filter(Boolean)
    .join("\n");
}
