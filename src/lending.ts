// Multi-venue lending: Aave V3 + Moola Market (Aave V2 fork). For a given asset the runtime picks
// the venue with the best SUPPLY APR among those that support it, then builds a supply/withdraw
// call with the recipient (onBehalfOf / to) bound to the owner at head word 2 — the same safety
// model the executor already enforces for Aave, so NO contract change.
//
//   Aave V3  supports: USDC, USDT, USDm, EURm, CELO   (supply selector; V3 ProtocolDataProvider)
//   Moola V2 supports: CELO, USDm, EURm, BRLm         (deposit selector; V2 pool.getReserveData)
//
// ⚠️ Moola is Aave **V2**: its `getReserveData` struct order differs from V3 — currentLiquidityRate
// is field index 3 (after variableBorrowIndex), aTokenAddress is index 7. Getting this wrong reads
// an accumulating index as the rate (spurious ~120% APR). Verified on-chain 2026-08-03.

import { encodeFunctionData, type Address, type Hex } from "viem";
import { publicClient } from "./chain";
import { AAVE, MOOLA, TOKENS, type Network } from "./constants";
import { aavePoolAbi, aaveDataProviderAbi } from "./abi";

const RAY = 10n ** 27n;

/** Moola (Aave V2) LendingPool surface: deposit/withdraw + the V2 `getReserveData` layout. */
const moolaPoolAbi = [
  { type: "function", name: "deposit", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }, { type: "address" }, { type: "uint16" }], outputs: [] },
  { type: "function", name: "withdraw", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }, { type: "address" }], outputs: [{ type: "uint256" }] },
  {
    type: "function",
    name: "getReserveData",
    stateMutability: "view",
    inputs: [{ type: "address" }],
    outputs: [
      {
        type: "tuple",
        components: [
          { name: "configuration", type: "tuple", components: [{ name: "data", type: "uint256" }] },
          { name: "liquidityIndex", type: "uint128" },
          { name: "variableBorrowIndex", type: "uint128" },
          { name: "currentLiquidityRate", type: "uint128" }, // supply APR (ray)
          { name: "currentVariableBorrowRate", type: "uint128" },
          { name: "currentStableBorrowRate", type: "uint128" },
          { name: "lastUpdateTimestamp", type: "uint40" },
          { name: "aTokenAddress", type: "address" },
          { name: "stableDebtTokenAddress", type: "address" },
          { name: "variableDebtTokenAddress", type: "address" },
          { name: "interestRateStrategyAddress", type: "address" },
          { name: "id", type: "uint8" },
        ],
      },
    ],
  },
] as const;

export type LendingVenueName = "aave" | "moola";

interface VenueDef {
  name: LendingVenueName;
  supports: readonly string[]; // asset symbols this venue lends
}

function venueDefs(network: Network): VenueDef[] {
  const out: VenueDef[] = [];
  if (AAVE[network]) out.push({ name: "aave", supports: ["USDC", "USDT", "USDm", "EURm", "CELO"] });
  if (MOOLA[network]) out.push({ name: "moola", supports: ["CELO", "USDm", "EURm", "BRLm"] });
  return out;
}

export interface ResolvedLending {
  venue: LendingVenueName;
  pool: Address;
  assetSymbol: string;
  assetAddress: Address;
  /** aToken / mToken — the interest-bearing token (pulled on withdraw). */
  aToken: Address;
  /** Live supply APR (% per year); null if the read failed. */
  aprPct: number | null;
}

/** Read a venue's reserve for an asset → the a/mToken + supply APR. Version-aware. */
async function readReserve(
  venue: LendingVenueName,
  assetAddress: Address,
  network: Network,
): Promise<{ pool: Address; aToken: Address; aprPct: number | null }> {
  if (venue === "aave") {
    const aave = AAVE[network]!;
    const [aToken] = await publicClient.readContract({
      address: aave.dataProvider,
      abi: aaveDataProviderAbi,
      functionName: "getReserveTokensAddresses",
      args: [assetAddress],
    });
    let aprPct: number | null = null;
    try {
      const d = await publicClient.readContract({
        address: aave.dataProvider,
        abi: aaveDataProviderAbi,
        functionName: "getReserveData",
        args: [assetAddress],
      });
      aprPct = Number((d[5] * 10000n) / RAY) / 100; // liquidityRate (ray)
    } catch {
      /* leave null */
    }
    return { pool: aave.pool, aToken, aprPct };
  }
  // moola (Aave V2)
  const pool = MOOLA[network]!;
  const d = await publicClient.readContract({
    address: pool,
    abi: moolaPoolAbi,
    functionName: "getReserveData",
    args: [assetAddress],
  });
  const aprPct = Number((d.currentLiquidityRate * 10000n) / RAY) / 100;
  return { pool, aToken: d.aTokenAddress, aprPct };
}

/** Resolve the best lending venue for a supply of `assetSymbol` — highest supply APR among the
 *  venues that support it. Throws if no venue lends the asset. */
export async function resolveLending(assetSymbol: string, network: Network): Promise<ResolvedLending> {
  const tokens = TOKENS[network] ?? {};
  const key = Object.keys(tokens).find((k) => k.toLowerCase() === assetSymbol.toLowerCase());
  const token = key ? tokens[key] : undefined;
  if (!token || !key) throw new Error(`asset ${assetSymbol} not supported`);

  const candidates = venueDefs(network).filter((v) =>
    v.supports.some((s) => s.toLowerCase() === key.toLowerCase()),
  );
  if (candidates.length === 0) {
    throw new Error(`${key} is not lendable — supported: USDC, USDT, USDm, EURm, CELO, BRLm`);
  }

  const reads = await Promise.all(candidates.map((v) => readReserve(v.name, token.address, network)));
  let bestIdx = 0;
  for (let i = 1; i < reads.length; i++) {
    if ((reads[i]!.aprPct ?? -1) > (reads[bestIdx]!.aprPct ?? -1)) bestIdx = i;
  }
  const venue = candidates[bestIdx]!.name;
  const r = reads[bestIdx]!;
  return { venue, pool: r.pool, assetSymbol: key, assetAddress: token.address, aToken: r.aToken, aprPct: r.aprPct };
}

/** Build the supply call for a resolved venue (Aave `supply` / Moola `deposit`), recipient=owner. */
export function buildSupplyCall(r: ResolvedLending, amount: bigint, owner: Address): { pool: Address; data: Hex } {
  const data =
    r.venue === "aave"
      ? encodeFunctionData({ abi: aavePoolAbi, functionName: "supply", args: [r.assetAddress, amount, owner, 0] })
      : encodeFunctionData({ abi: moolaPoolAbi, functionName: "deposit", args: [r.assetAddress, amount, owner, 0] });
  return { pool: r.pool, data };
}

/** Build the withdraw call for a resolved venue (both are `withdraw(asset,amount,to)`), to=owner. */
export function buildWithdrawCall(r: ResolvedLending, amount: bigint, owner: Address): { pool: Address; data: Hex } {
  const data =
    r.venue === "aave"
      ? encodeFunctionData({ abi: aavePoolAbi, functionName: "withdraw", args: [r.assetAddress, amount, owner] })
      : encodeFunctionData({ abi: moolaPoolAbi, functionName: "withdraw", args: [r.assetAddress, amount, owner] });
  return { pool: r.pool, data };
}
