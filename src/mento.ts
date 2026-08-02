// Mento V3 swap venue (FPMM via the Mento Router) — the SECOND swap venue alongside
// Ubeswap V2 (see executor.ts). Many Mento local stablecoins (NGNm, COPm, BRLm, EURm,
// GBPm, KESm, …) have NO Ubeswap pool — their liquidity lives on Mento. The Mento SDK
// (viem-native) resolves the route, quotes against the live oracle, and builds the swap
// calldata; we wrap that into the executor's allowlisted-call model: the Router is an
// allowlisted target and the swap selector's recipient (static head word index 3) is
// bound to the owner — exactly like the Ubeswap `to` binding, so output goes to the owner.
//
// ⚠️ Mento gates FX/regional stablecoins by FX-market hours + per-pool oracle circuit
// breakers (Celopedia security-patterns.md). A quote can revert with "FX market is
// currently closed" or "no valid median". We surface those as a friendly, non-fatal
// reason so the agent tells the user to try later instead of failing hard.

import { Mento, ChainId } from "@mento-protocol/mento-sdk";
import type { Address, Hex } from "viem";
import { CHAINS, type Network } from "./constants";
import { config } from "./config";

/** Mento V3 Router (Celo mainnet) — the swap venue target the executor allowlists. */
export const MENTO_ROUTER: Address = "0x4861840C2EfB2b98312B0aE34d86fD73E8f9B6f6";
/** `swap(...)` selector on the Mento Router. The recipient is the STATIC head word at
 *  index 3 (0-based, after the selector) — recipient-bindable exactly like Ubeswap's `to`. */
export const MENTO_SWAP_SELECTOR: Hex = "0x3375aa2a";
export const MENTO_RECIPIENT_WORD_INDEX = 3;

function chainIdFor(network: Network): number {
  return network === "celo" ? ChainId.CELO : ChainId.CELO_SEPOLIA;
}

const _clients = new Map<Network, Promise<Mento>>();
function client(network: Network): Promise<Mento> {
  let c = _clients.get(network);
  if (!c) {
    const rpc = config.rpcUrl || CHAINS[network].rpc;
    c = Mento.create(chainIdFor(network), rpc);
    _clients.set(network, c);
  }
  return c;
}

export interface MentoQuote {
  amountOut: bigint;
  /** Opaque Mento SDK route, carried to the build step to avoid re-resolving. */
  route: unknown;
}

/** Map a Mento revert to a short, human reason (breaker / FX-hours / no-route). */
export function mentoReason(message: string): string {
  const m = message.toLowerCase();
  if (m.includes("fx market"))
    return "the Mento FX market is currently closed — FX-pegged stables trade during market hours; try again then";
  if (m.includes("no valid median") || m.includes("circuit") || m.includes("breaker"))
    return "this Mento pair is temporarily paused by its oracle circuit breaker — try again shortly";
  if (m.includes("no route") || m.includes("not have a tradable"))
    return "no Mento pool for this pair";
  return message.split("\n")[0] ?? message;
}

/** Quote a swap on Mento. Throws with the raw SDK message on breaker/closed/no-route
 *  (callers wrap it with {@link mentoReason}). */
export async function quoteMento(
  fromAddress: Address,
  toAddress: Address,
  amountIn: bigint,
  network: Network = config.network,
): Promise<MentoQuote> {
  const m = await client(network);
  const route = await m.routes.findRoute(fromAddress, toAddress);
  const out = await m.quotes.getAmountOut(fromAddress, toAddress, amountIn, route as never);
  return { amountOut: BigInt(out.toString()), route };
}

/** Build the Mento swap call for the executor: the Router target + swap calldata with the
 *  recipient bound to `owner` (output goes straight to the owner, like the Ubeswap path).
 *  The SDK bakes its own `amountOutMin` (from `slippageBps`) into the calldata. */
export async function buildMentoSwap(params: {
  fromAddress: Address;
  toAddress: Address;
  amountIn: bigint;
  owner: Address;
  slippageBps?: bigint;
  deadlineSeconds?: number;
  route?: unknown;
  network?: Network;
}): Promise<{ router: Address; data: Hex; amountOut: bigint }> {
  const network = params.network ?? config.network;
  const m = await client(network);
  const route = params.route ?? (await m.routes.findRoute(params.fromAddress, params.toAddress));
  const slippageTolerance = Number(params.slippageBps ?? 100n) / 100; // bps → percent (100 bps = 1%)
  const deadline = BigInt(Math.floor(Date.now() / 1000) + (params.deadlineSeconds ?? 1200));
  const out = await m.quotes.getAmountOut(params.fromAddress, params.toAddress, params.amountIn, route as never);
  const tx = await m.swap.buildSwapTransaction(
    params.fromAddress,
    params.toAddress,
    params.amountIn,
    params.owner, // recipient — output tokens go to the owner (recipient-bound at word 3)
    params.owner, // owner context for the SDK's allowance handling
    { slippageTolerance, deadline },
    route as never,
  );
  const swap = (tx as { swap?: { params?: { to?: string; data?: string } } }).swap?.params;
  if (!swap?.to || !swap?.data) throw new Error("Mento SDK returned no swap calldata");
  return { router: swap.to as Address, data: swap.data as Hex, amountOut: BigInt(out.toString()) };
}
