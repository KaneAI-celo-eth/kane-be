// KaneExecutor interaction (v2.1, non-custodial). Resolve a user's executor, read the
// per-token policy, dry-run a pull against the on-chain gate, build an Aave V3
// supply/withdraw rebalance as a pure execute() payload, and send it — attribution-tagged
// and signed by the agent key. Replaces the removed custodial vault.ts.
//
// "The model advises; the chain decides." Every builder is pure and testable off-chain;
// the recipient is ALWAYS the owner (never caller-supplied), matching the executor's
// on-chain recipient binding (Aave supply.onBehalfOf / withdraw.to at word index 2).

import { encodeFunctionData, zeroAddress, type Address, type Hex } from "viem";
import { chain, getWalletClient, publicClient } from "./chain";
import { config, type Network } from "./config";
import { AAVE, TOKENS } from "./constants";
import { aaveDataProviderAbi, aavePoolAbi, kaneExecutorAbi, kaneExecutorFactoryAbi } from "./abi";
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
