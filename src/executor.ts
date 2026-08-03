// KaneExecutor interaction (v2.1, non-custodial). Resolve a user's executor, read the
// per-token policy, dry-run a pull against the on-chain gate, build an Aave V3
// supply/withdraw rebalance as a pure execute() payload, and send it — attribution-tagged
// and signed by the agent key. Replaces the removed custodial vault.ts.
//
// "The model advises; your policy decides." Every builder is pure and testable off-chain;
// the recipient is ALWAYS the owner (never caller-supplied), matching the executor's
// on-chain recipient binding (Aave supply.onBehalfOf / withdraw.to at word index 2).

import { encodeFunctionData, formatUnits, parseUnits, zeroAddress, type Address, type Hex } from "viem";
import { chain, getWalletClient, publicClient } from "./chain";
import { config, type Network } from "./config";
import { AAVE, TOKENS, UBESWAP } from "./constants";
import {
  aaveDataProviderAbi,
  erc20Abi,
  kaneExecutorAbi,
  kaneExecutorFactoryAbi,
  ubeswapFactoryAbi,
  ubeswapPairAbi,
  ubeswapRouterAbi,
} from "./abi";
import { tagCalldata } from "./attribution";
import { quoteMento, mentoReason, buildMentoSwap } from "./mento";
import { quoteUniswap, buildUniswapSwap } from "./univ3";
import {
  buildSupplyCall,
  buildWithdrawCall,
  type LendingVenueName,
  type ResolvedLending,
} from "./lending";

// ---- types -----------------------------------------------------------------

/** Per-token policy struct (KanePolicy.TokenPolicy). All amounts are token base units. */
export interface TokenPolicy {
  perTxCap: bigint;
  budget: bigint;
  spent: bigint;
  windowCap: bigint;
  windowSpent: bigint;
  windowDuration: bigint;
  windowStart: bigint;
}

/** An encoded `execute(pulls, approvals, calls, version)` payload (version added at send). */
export interface BuiltExecute {
  pulls: { token: Address; amount: bigint }[];
  approvals: { token: Address; spender: Address; amount: bigint }[];
  calls: { target: Address; value: bigint; data: Hex }[];
}


/** Minimal wallet surface used by {@link sendExecute} (injectable for tests). */
export interface WalletLike {
  sendTransaction(args: { to: Address; data: Hex; chain: typeof chain }): Promise<Hex>;
}

// ---- reads -----------------------------------------------------------------

/** Resolve a user's executor via the factory. Throws a clear error when unconfigured/unresolved. */
export async function resolveExecutor(owner: Address): Promise<Address> {
  const factory = config.factoryAddress;
  if (!factory) {
    throw new Error("factory address not configured (deploy pending) — set FACTORY_ADDRESS or DEPLOYMENTS");
  }
  const executor = await publicClient.readContract({
    address: factory,
    abi: kaneExecutorFactoryAbi,
    functionName: "executorOf",
    args: [owner],
  });
  if (executor === zeroAddress) {
    throw new Error(`no executor for owner ${owner} — run createExecutor first`);
  }
  return executor;
}

/** Read the executor's per-token policy struct. */
export async function readTokenPolicy(executor: Address, token: Address): Promise<TokenPolicy> {
  const p = await publicClient.readContract({
    address: executor,
    abi: kaneExecutorAbi,
    functionName: "tokenPolicy",
    args: [token],
  });
  return {
    perTxCap: p.perTxCap,
    budget: p.budget,
    spent: p.spent,
    windowCap: p.windowCap,
    windowSpent: p.windowSpent,
    windowDuration: p.windowDuration,
    windowStart: p.windowStart,
  };
}

/** Off-chain dry-run: would pulling `amount` of `token` be allowed right now? */
export async function wouldAllowPull(
  executor: Address,
  token: Address,
  amount: bigint,
): Promise<{ ok: boolean; reason: string }> {
  const [ok, reason] = await publicClient.readContract({
    address: executor,
    abi: kaneExecutorAbi,
    functionName: "wouldAllowPull",
    args: [token, amount],
  });
  return { ok, reason };
}

/** Read the executor's current version guard (passed as expectedVersion on execute). */
export async function readVersion(executor: Address): Promise<number> {
  return publicClient.readContract({
    address: executor,
    abi: kaneExecutorAbi,
    functionName: "version",
  });
}

/** Resolve aUSDC (the aToken) for USDC via the Aave ProtocolDataProvider (on-demand). */
export async function resolveAToken(network: Network): Promise<Address> {
  const aave = AAVE[network];
  if (!aave) throw new Error(`Aave not configured for network ${network}`);
  const usdc = TOKENS[network]?.USDC;
  if (!usdc) throw new Error(`USDC not configured for network ${network}`);
  const [aToken] = await publicClient.readContract({
    address: aave.dataProvider,
    abi: aaveDataProviderAbi,
    functionName: "getReserveTokensAddresses",
    args: [usdc.address],
  });
  return aToken;
}

const RAY = 10n ** 27n;

/**
 * Live Aave V3 USDC supply APR (%, per year) from the ProtocolDataProvider's `liquidityRate`
 * (a ray). Returns null if Aave isn't configured or the read fails — the agent then answers
 * without a number rather than inventing one.
 */
export async function readSupplyApr(network: Network): Promise<number | null> {
  const aave = AAVE[network];
  const usdc = TOKENS[network]?.USDC;
  if (!aave || !usdc) return null;
  try {
    const data = await publicClient.readContract({
      address: aave.dataProvider,
      abi: aaveDataProviderAbi,
      functionName: "getReserveData",
      args: [usdc.address],
    });
    const liquidityRate = data[5]; // ray APR (1e27)
    return Number((liquidityRate * 10000n) / RAY) / 100; // % with 2 decimals
  } catch {
    return null;
  }
}

/** Read `owner`'s balance of every configured token (for grounding the assistant when the user
 *  asks about their wallet). Returns human-readable amounts keyed by symbol. */
export async function readBalances(
  owner: Address,
  network: Network,
): Promise<{ symbol: string; human: string }[]> {
  const toks = TOKENS[network] ?? {};
  const entries = Object.entries(toks);
  const results = await Promise.all(
    entries.map(async ([symbol, t]) => {
      try {
        const bal = (await publicClient.readContract({
          address: t.address,
          abi: erc20Abi,
          functionName: "balanceOf",
          args: [owner],
        })) as bigint;
        return { symbol, human: formatUnits(bal, t.decimals) };
      } catch {
        return null;
      }
    }),
  );
  return results.filter((r): r is { symbol: string; human: string } => r !== null);
}

// ---- pure builder ----------------------------------------------------------

/**
 * Build the Aave V3 rebalance as an execute() payload (PURE — unit-testable off-chain).
 * The recipient is ALWAYS `params.owner`; there is no caller-supplied recipient path.
 *
 *   supply:   pulls [{USDC, amt}], approvals [{USDC, pool, amt}], calls [supply(USDC, amt, owner, 0)]
 *   withdraw: pulls [{aUSDC, amt}], approvals [],                 calls [withdraw(USDC, amt, owner)]
 */
export function buildRebalance(
  resolved: ResolvedLending,
  kind: "supply" | "withdraw",
  amount: bigint,
  owner: Address,
): BuiltExecute & { venue: LendingVenueName; assetSymbol: string } {
  const base = { venue: resolved.venue, assetSymbol: resolved.assetSymbol };
  if (kind === "supply") {
    const { pool, data } = buildSupplyCall(resolved, amount, owner);
    return {
      ...base,
      pulls: [{ token: resolved.assetAddress, amount }],
      approvals: [{ token: resolved.assetAddress, spender: pool, amount }],
      calls: [{ target: pool, value: 0n, data }],
    };
  }
  // withdraw — pull the a/mToken, call withdraw(asset, amount, owner)
  const { pool, data } = buildWithdrawCall(resolved, amount, owner);
  return {
    ...base,
    pulls: [{ token: resolved.aToken, amount }],
    approvals: [],
    calls: [{ target: pool, value: 0n, data }],
  };
}

// ---- swap (Ubeswap V2) -----------------------------------------------------

const SWAP_SLIPPAGE_BPS = 100n; // 1% max slippage → amountOutMin
const MAX_PRICE_IMPACT_BPS = 1000n; // guard: reject if amountIn > 10% of the input-token pool reserve

export type SwapVenue = "ubeswap" | "mento" | "uniswap";

export interface SwapQuote {
  /** Which venue won the best-output comparison. */
  venue: SwapVenue;
  fromSymbol: string;
  toSymbol: string;
  fromAddress: Address;
  toAddress: Address;
  /** Ubeswap route (present only when `venue === "ubeswap"`). */
  path?: Address[];
  /** Uniswap V3 fee tier that won (present only when `venue === "uniswap"`). */
  fee?: number;
  amountIn: bigint;
  amountOut: bigint;
  amountOutMin: bigint;
  /** Human-readable output (toToken decimals). */
  amountOutHuman: string;
}

/** Resolve a token symbol (case-insensitive) to its address, decimals + CANONICAL symbol (the
 *  registry key — e.g. "USDm", never "USDM" which is a different token). */
export function resolveToken(
  network: Network,
  symbol: string,
): { address: Address; decimals: number; symbol: string } {
  const tokens = TOKENS[network] ?? {};
  const key = Object.keys(tokens).find((k) => k.toLowerCase() === symbol.toLowerCase());
  const t = key ? tokens[key] : undefined;
  if (!t || !key) throw new Error(`token ${symbol} not supported on ${network}`);
  return { ...t, symbol: key };
}

/** Read the input-token reserve of a Ubeswap pair for the pool-depth guard. */
async function inputReserve(factory: Address, tokenIn: Address, tokenOut: Address): Promise<bigint> {
  const pair = await publicClient.readContract({
    address: factory,
    abi: ubeswapFactoryAbi,
    functionName: "getPair",
    args: [tokenIn, tokenOut],
  });
  if (pair === zeroAddress) return 0n;
  const [r0, r1] = await publicClient.readContract({
    address: pair,
    abi: ubeswapPairAbi,
    functionName: "getReserves",
  });
  const token0 = await publicClient.readContract({ address: pair, abi: ubeswapPairAbi, functionName: "token0" });
  return token0.toLowerCase() === tokenIn.toLowerCase() ? r0 : r1;
}

/**
 * Quote a Ubeswap V2 swap (real on-chain `getAmountsOut`) with a **pool-depth guard**: Celo
 * pool depth varies wildly and `amountOutMin` alone can't catch a shallow pool, so we reject a
 * swap whose input is an outsized fraction of the pair reserve. Tries a direct pair, then routes
 * via CELO. Throws on no-pool / too-shallow / zero-output (the caller may still use Mento).
 */
async function quoteUbeswap(
  fromAddress: Address,
  toAddress: Address,
  amountIn: bigint,
  network: Network,
): Promise<{ path: Address[]; amountOut: bigint }> {
  const ube = UBESWAP[network];
  if (!ube) throw new Error(`Ubeswap not configured for network ${network}`);
  const isWeth = (a: Address) => a.toLowerCase() === ube.weth.toLowerCase();
  const candidates: Address[][] = [[fromAddress, toAddress]];
  if (!isWeth(fromAddress) && !isWeth(toAddress)) candidates.push([fromAddress, ube.weth, toAddress]);

  let path: Address[] | undefined;
  let amounts: readonly bigint[] | undefined;
  let shallow = false;
  for (const cand of candidates) {
    let cAmounts: readonly bigint[];
    try {
      cAmounts = await publicClient.readContract({
        address: ube.router,
        abi: ubeswapRouterAbi,
        functionName: "getAmountsOut",
        args: [amountIn, cand],
      });
    } catch {
      continue; // no pair for this path
    }
    let ok = true;
    for (let i = 0; i < cand.length - 1; i++) {
      const reserve = await inputReserve(ube.factory, cand[i]!, cand[i + 1]!);
      if (reserve === 0n || cAmounts[i]! * 10000n > reserve * MAX_PRICE_IMPACT_BPS) {
        ok = false;
        shallow = true;
        break;
      }
    }
    if (ok) {
      path = cand;
      amounts = cAmounts;
      break;
    }
  }
  if (!path || !amounts) {
    throw new Error(shallow ? "swap too large for the available pool depth" : "no Ubeswap V2 pool");
  }
  const amountOut = amounts[amounts.length - 1];
  if (amountOut === undefined || amountOut <= 0n) throw new Error("zero output — no liquidity");
  return { path, amountOut };
}

/**
 * Quote a swap across BOTH venues — Ubeswap V2 and Mento V3 — and return the best output. Many
 * Mento local stables (NGNm, COPm, BRLm, …) have NO Ubeswap pool, so Mento is what makes them
 * swappable; USD-pegged pairs may trade on either and win on price. `amount` is a human decimal
 * of the from-token. Throws a combined reason only when NEITHER venue can serve the pair (this
 * is where Mento's FX-hours / oracle-breaker reason surfaces to the user).
 */
export async function quoteSwap(
  fromSymbol: string,
  toSymbol: string,
  amount: string,
  network: Network = config.network,
): Promise<SwapQuote> {
  const from = resolveToken(network, fromSymbol);
  const to = resolveToken(network, toSymbol);
  if (from.address.toLowerCase() === to.address.toLowerCase()) throw new Error("from and to are the same token");
  const amountIn = parseUnits(amount, from.decimals);
  if (amountIn <= 0n) throw new Error("amount must be positive");

  const reasons: string[] = [];
  type Candidate = { venue: SwapVenue; amountOut: bigint; path?: Address[]; fee?: number };
  const candidates: Candidate[] = [];

  try {
    const q = await quoteUbeswap(from.address, to.address, amountIn, network);
    candidates.push({ venue: "ubeswap", amountOut: q.amountOut, path: q.path });
  } catch (e) {
    reasons.push(`Ubeswap: ${(e as Error).message}`);
  }
  try {
    const q = await quoteMento(from.address, to.address, amountIn, network);
    candidates.push({ venue: "mento", amountOut: q.amountOut });
  } catch (e) {
    reasons.push(`Mento: ${mentoReason((e as Error).message)}`);
  }
  try {
    const q = await quoteUniswap(from.address, to.address, amountIn, network);
    candidates.push({ venue: "uniswap", amountOut: q.amountOut, fee: q.fee });
  } catch (e) {
    reasons.push(`Uniswap V3: ${(e as Error).message}`);
  }

  if (candidates.length === 0) {
    throw new Error(`no swap route for ${fromSymbol}→${toSymbol} — ${reasons.join("; ")}`);
  }
  // Best output across all venues wins.
  const best = candidates.reduce((a, b) => (b.amountOut > a.amountOut ? b : a));

  const amountOutMin = (best.amountOut * (10000n - SWAP_SLIPPAGE_BPS)) / 10000n;
  return {
    venue: best.venue,
    fromSymbol: from.symbol, // canonical (e.g. "USDm")
    toSymbol: to.symbol,
    fromAddress: from.address,
    toAddress: to.address,
    path: best.path,
    fee: best.fee,
    amountIn,
    amountOut: best.amountOut,
    amountOutMin,
    amountOutHuman: formatUnits(best.amountOut, to.decimals),
  };
}

/**
 * Build an `execute` payload for a swap on the best venue ({@link quoteSwap}). Ubeswap V2:
 * `swapExactTokensForTokens` with `to = owner`. Mento V3: the SDK-built Router call, recipient
 * bound to the owner. Either way the input is pulled from the owner, the venue is approved
 * (bounded, reset in `execute`), and the output goes straight to the owner (recipient-bound at
 * head word index 3 on both routers), so no `sweepTokens` are needed.
 */
export async function buildSwap(params: {
  fromSymbol: string;
  toSymbol: string;
  amount: string;
  owner: Address;
  network?: Network;
  deadlineSeconds?: number;
}): Promise<BuiltExecute & { quote: SwapQuote }> {
  const network = params.network ?? config.network;
  const quote = await quoteSwap(params.fromSymbol, params.toSymbol, params.amount, network);
  const tokenIn = quote.fromAddress;

  if (quote.venue === "mento") {
    const { router, data } = await buildMentoSwap({
      fromAddress: quote.fromAddress,
      toAddress: quote.toAddress,
      amountIn: quote.amountIn,
      owner: params.owner,
      slippageBps: SWAP_SLIPPAGE_BPS,
      deadlineSeconds: params.deadlineSeconds,
      network,
    });
    return {
      quote,
      pulls: [{ token: tokenIn, amount: quote.amountIn }],
      approvals: [{ token: tokenIn, spender: router, amount: quote.amountIn }],
      calls: [{ target: router, value: 0n, data }],
    };
  }

  if (quote.venue === "uniswap") {
    if (quote.fee === undefined) throw new Error("missing Uniswap V3 fee tier");
    const { router, data } = buildUniswapSwap({
      fromAddress: quote.fromAddress,
      toAddress: quote.toAddress,
      amountIn: quote.amountIn,
      amountOutMin: quote.amountOutMin,
      fee: quote.fee,
      owner: params.owner,
      network,
    });
    return {
      quote,
      pulls: [{ token: tokenIn, amount: quote.amountIn }],
      approvals: [{ token: tokenIn, spender: router, amount: quote.amountIn }],
      calls: [{ target: router, value: 0n, data }],
    };
  }

  // Ubeswap V2
  const ube = UBESWAP[network];
  if (!ube || !quote.path) throw new Error(`Ubeswap not configured for network ${network}`);
  const deadline = BigInt(Math.floor(Date.now() / 1000) + (params.deadlineSeconds ?? 1200));
  const data = encodeFunctionData({
    abi: ubeswapRouterAbi,
    functionName: "swapExactTokensForTokens",
    args: [quote.amountIn, quote.amountOutMin, quote.path, params.owner, deadline],
  });
  return {
    quote,
    pulls: [{ token: tokenIn, amount: quote.amountIn }],
    approvals: [{ token: tokenIn, spender: ube.router, amount: quote.amountIn }],
    calls: [{ target: ube.router, value: 0n, data }],
  };
}

// ---- send ------------------------------------------------------------------

/**
 * Encode + attribution-tag + send an execute(). Signed by the agent wallet (agent key).
 * `wallet` is injectable for tests; defaults to the configured agent wallet.
 */
export async function sendExecute(
  executor: Address,
  built: BuiltExecute,
  version: number,
  wallet?: WalletLike,
): Promise<Hex> {
  const calldata = encodeFunctionData({
    abi: kaneExecutorAbi,
    functionName: "execute",
    args: [built.pulls, built.approvals, built.calls, version],
  });
  const w: WalletLike = wallet ?? getWalletClient();
  return w.sendTransaction({ to: executor, data: tagCalldata(calldata), chain });
}
