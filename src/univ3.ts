// Uniswap V3 swap venue (single-hop `exactInputSingle`) — the DEEPEST DEX on Celo and always-on
// (no oracle / FX-market gating, unlike Mento). We quote across the fee tiers via QuoterV2, pick
// the best output, then build an `exactInputSingle` call on SwapRouter02 with the recipient bound
// to the owner (static head word index 3 — the same safety model as Ubeswap V2 / Mento V3).
//
// ⚠️ Only SINGLE-HOP `exactInputSingle` is used. Multi-hop `exactInput` (dynamic `path` bytes) and
// the UniversalRouter put the recipient inside DYNAMIC calldata, which the executor's
// recipient-binding cannot protect (KaneExecutor SelectorRule scope; flagged in the audit). So
// only the single-hop selector is ever allowlisted — output can never leave the owner.

import { encodeFunctionData, type Address, type Hex } from "viem";
import { publicClient } from "./chain";
import { type Network } from "./constants";

export const UNISWAP_V3: Partial<Record<Network, { router: Address; quoter: Address }>> = {
  celo: {
    router: "0x5615CDAb10dc425a742d643d949a7F474C01abc4", // SwapRouter02
    quoter: "0x82825d0554fA07f7FC52Ab63c961F330fdEFa8E8", // QuoterV2
  },
};
/** `exactInputSingle(...)` on SwapRouter02; the recipient is the static head word at index 3. */
export const UNISWAP_SWAP_SELECTOR: Hex = "0x04e45aaf";
export const UNISWAP_RECIPIENT_WORD_INDEX = 3;

const FEE_TIERS = [100, 500, 3000, 10000] as const; // 0.01% / 0.05% / 0.3% / 1%

const quoterAbi = [
  {
    type: "function",
    name: "quoteExactInputSingle",
    stateMutability: "nonpayable", // reverts to return data; call via simulate/staticcall
    inputs: [
      {
        type: "tuple",
        components: [
          { name: "tokenIn", type: "address" },
          { name: "tokenOut", type: "address" },
          { name: "amountIn", type: "uint256" },
          { name: "fee", type: "uint24" },
          { name: "sqrtPriceLimitX96", type: "uint160" },
        ],
      },
    ],
    outputs: [
      { name: "amountOut", type: "uint256" },
      { name: "sqrtPriceX96After", type: "uint160" },
      { name: "initializedTicksCrossed", type: "uint32" },
      { name: "gasEstimate", type: "uint256" },
    ],
  },
] as const;

const routerAbi = [
  {
    type: "function",
    name: "exactInputSingle",
    stateMutability: "payable",
    inputs: [
      {
        type: "tuple",
        components: [
          { name: "tokenIn", type: "address" },
          { name: "tokenOut", type: "address" },
          { name: "fee", type: "uint24" },
          { name: "recipient", type: "address" },
          { name: "amountIn", type: "uint256" },
          { name: "amountOutMinimum", type: "uint256" },
          { name: "sqrtPriceLimitX96", type: "uint160" },
        ],
      },
    ],
    outputs: [{ name: "amountOut", type: "uint256" }],
  },
] as const;

export interface UniswapQuote {
  amountOut: bigint;
  /** The winning fee tier (needed verbatim by {@link buildUniswapSwap}). */
  fee: number;
}

/** Best-fee-tier quote for a single-hop Uniswap V3 swap. Throws if no tier has a pool. The V3
 *  quote already reflects real price impact, so the deepest tier wins naturally. */
export async function quoteUniswap(
  fromAddress: Address,
  toAddress: Address,
  amountIn: bigint,
  network: Network,
): Promise<UniswapQuote> {
  const cfg = UNISWAP_V3[network];
  if (!cfg) throw new Error(`Uniswap V3 not configured for ${network}`);
  let best: UniswapQuote | undefined;
  for (const fee of FEE_TIERS) {
    try {
      const r = await publicClient.simulateContract({
        address: cfg.quoter,
        abi: quoterAbi,
        functionName: "quoteExactInputSingle",
        args: [{ tokenIn: fromAddress, tokenOut: toAddress, amountIn, fee, sqrtPriceLimitX96: 0n }],
      });
      const out = r.result[0] as bigint;
      if (out > 0n && (!best || out > best.amountOut)) best = { amountOut: out, fee };
    } catch {
      // no pool at this fee tier — try the next
    }
  }
  if (!best) throw new Error("no Uniswap V3 pool");
  return best;
}

/** Build the `exactInputSingle` call for the executor (recipient bound to the owner). */
export function buildUniswapSwap(params: {
  fromAddress: Address;
  toAddress: Address;
  amountIn: bigint;
  amountOutMin: bigint;
  fee: number;
  owner: Address;
  network: Network;
}): { router: Address; data: Hex } {
  const cfg = UNISWAP_V3[params.network];
  if (!cfg) throw new Error(`Uniswap V3 not configured for ${params.network}`);
  const data = encodeFunctionData({
    abi: routerAbi,
    functionName: "exactInputSingle",
    args: [
      {
        tokenIn: params.fromAddress,
        tokenOut: params.toAddress,
        fee: params.fee,
        recipient: params.owner, // recipient-bound (head word 3) → output goes to the owner
        amountIn: params.amountIn,
        amountOutMinimum: params.amountOutMin,
        sqrtPriceLimitX96: 0n,
      },
    ],
  });
  return { router: cfg.router, data };
}
