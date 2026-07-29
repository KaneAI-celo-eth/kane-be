// KaneExecutor interaction (v2.1, non-custodial). Resolve a user's executor, read the
// per-token policy, dry-run a pull against the on-chain gate, build an Aave V3
// supply/withdraw rebalance as a pure execute() payload, and send it — attribution-tagged
// and signed by the agent key. Replaces the removed custodial vault.ts.
//
// "The model advises; the chain decides." Every builder is pure and testable off-chain;
// the recipient is ALWAYS the owner (never caller-supplied), matching the executor's
// on-chain recipient binding (Aave supply.onBehalfOf / withdraw.to at word index 2).

import { encodeFunctionData, formatUnits, parseUnits, zeroAddress, type Address, type Hex } from "viem";
import { chain, getWalletClient, publicClient } from "./chain";
import { config, type Network } from "./config";
import { AAVE, TOKENS, UBESWAP } from "./constants";
import {
  aaveDataProviderAbi,
  aavePoolAbi,
  erc20Abi,
  kaneExecutorAbi,
  kaneExecutorFactoryAbi,
  ubeswapFactoryAbi,
  ubeswapPairAbi,
  ubeswapRouterAbi,
} from "./abi";
import { tagCalldata } from "./attribution";

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

export interface RebalanceParams {
  kind: "supply" | "withdraw";
  amount: bigint;
  owner: Address;
  network: Network;
  /** aToken (aUSDC) — REQUIRED for withdraw. Resolve via {@link resolveAToken}. */
  aToken?: Address;
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
export function buildRebalance(params: RebalanceParams): BuiltExecute {
  const { kind, amount, owner, network } = params;
  const aave = AAVE[network];
  if (!aave) throw new Error(`Aave not configured for network ${network}`);
  const usdc = TOKENS[network]?.USDC;
  if (!usdc) throw new Error(`USDC not configured for network ${network}`);
  const pool = aave.pool;

  if (kind === "supply") {
    const data = encodeFunctionData({
      abi: aavePoolAbi,
      functionName: "supply",
      args: [usdc.address, amount, owner, 0],
    });
    return {
      pulls: [{ token: usdc.address, amount }],
      approvals: [{ token: usdc.address, spender: pool, amount }],
      calls: [{ target: pool, value: 0n, data }],
    };
  }

  // withdraw
  if (!params.aToken) {
    throw new Error("withdraw requires aToken (aUSDC) — resolve via resolveAToken(network)");
  }
  const data = encodeFunctionData({
    abi: aavePoolAbi,
    functionName: "withdraw",
    args: [usdc.address, amount, owner],
  });
  return {
    pulls: [{ token: params.aToken, amount }],
    approvals: [],
    calls: [{ target: pool, value: 0n, data }],
  };
}

// ---- swap (Ubeswap V2) -----------------------------------------------------

const SWAP_SLIPPAGE_BPS = 100n; // 1% max slippage → amountOutMin
const MAX_PRICE_IMPACT_BPS = 1000n; // guard: reject if amountIn > 10% of the input-token pool reserve

export interface SwapQuote {
  fromSymbol: string;
  toSymbol: string;
  path: Address[];
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
 * Quote a swap on Ubeswap V2 (real on-chain `getAmountsOut`) with a **pool-depth guard**: Celo
 * pool depth varies wildly, and `amountOutMin` alone can't catch a shallow pool, so we reject
 * a swap whose input is a large fraction of the pair reserve (excessive price impact). Tries a
 * direct pair first, then routes via CELO. `amount` is a human decimal string of the from-token.
 */
export async function quoteSwap(
  fromSymbol: string,
  toSymbol: string,
  amount: string,
  network: Network = config.network,
): Promise<SwapQuote> {
  const ube = UBESWAP[network];
  if (!ube) throw new Error(`Ubeswap not configured for network ${network}`);
  const from = resolveToken(network, fromSymbol);
  const to = resolveToken(network, toSymbol);
  if (from.address.toLowerCase() === to.address.toLowerCase()) throw new Error("from and to are the same token");

  const amountIn = parseUnits(amount, from.decimals);
  if (amountIn <= 0n) throw new Error("amount must be positive");

  // Candidate paths: direct first, then via CELO (weth). Pick the first path where EVERY hop is
  // deep enough (the swap input at that hop isn't an outsized fraction of the pool reserve). A
  // shallow FINAL hop is exactly the Celo failure mode that `amountOutMin` alone can't catch.
  const isWeth = (a: Address) => a.toLowerCase() === ube.weth.toLowerCase();
  const candidates: Address[][] = [[from.address, to.address]];
  if (!isWeth(from.address) && !isWeth(to.address)) candidates.push([from.address, ube.weth, to.address]);

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
    throw new Error(
      shallow
        ? `swap too large for the available ${fromSymbol}→${toSymbol} pool depth on Ubeswap V2 — reduce the amount (or this pair's liquidity is on another venue)`
        : `no Ubeswap V2 pool for ${fromSymbol}→${toSymbol}`,
    );
  }
  const amountOut = amounts[amounts.length - 1];
  if (amountOut === undefined || amountOut <= 0n) throw new Error("zero output — no liquidity");
  const amountOutMin = (amountOut * (10000n - SWAP_SLIPPAGE_BPS)) / 10000n;

  return {
    fromSymbol: from.symbol, // canonical (e.g. "USDm")
    toSymbol: to.symbol,
    path,
    amountIn,
    amountOut,
    amountOutMin,
    amountOutHuman: formatUnits(amountOut, to.decimals),
  };
}

/**
 * Build an `execute` payload for a Ubeswap V2 swap: pull the input from the owner, approve the
 * router, and call `swapExactTokensForTokens` with `to = owner` (recipient-bound at word 3) and
 * an `amountOutMin` from {@link quoteSwap}. Output goes straight to the owner (no sweepTokens).
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
  const ube = UBESWAP[network];
  if (!ube) throw new Error(`Ubeswap not configured for network ${network}`);
  const quote = await quoteSwap(params.fromSymbol, params.toSymbol, params.amount, network);
  const deadline = BigInt(Math.floor(Date.now() / 1000) + (params.deadlineSeconds ?? 1200));

  const data = encodeFunctionData({
    abi: ubeswapRouterAbi,
    functionName: "swapExactTokensForTokens",
    args: [quote.amountIn, quote.amountOutMin, quote.path, params.owner, deadline],
  });
  const tokenIn = quote.path[0];
  if (!tokenIn) throw new Error("empty swap path");
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
