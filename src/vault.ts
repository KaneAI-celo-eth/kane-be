// Vault interaction: read policy, dry-run against the on-chain gate, and execute
// bounded exits as attribution-tagged transactions.

import { encodeFunctionData, type Address, type Hex } from "viem";
import { chain, getWalletClient, publicClient } from "./chain";
import { kaneVaultAbi } from "./abi";
import { tagCalldata } from "./attribution";

export interface Policy {
  agent: Address;
  budget: bigint;
  spent: bigint;
  perTxCap: bigint;
  windowCap: bigint;
  windowSpent: bigint;
  windowDuration: bigint;
  windowStart: bigint;
  expiry: bigint;
  version: number;
  revoked: boolean;
}

export async function readPolicy(vault: Address): Promise<Policy> {
  const p = await publicClient.readContract({
    address: vault,
    abi: kaneVaultAbi,
    functionName: "policy",
  });
  return {
    agent: p[0],
    budget: p[1],
    spent: p[2],
    perTxCap: p[3],
    windowCap: p[4],
    windowSpent: p[5],
    windowDuration: p[6],
    windowStart: p[7],
    expiry: p[8],
    version: p[9],
    revoked: p[10],
  };
}

/** Off-chain dry-run: ask the vault whether a spend would be authorized right now. */
export async function dryRun(
  vault: Address,
  caller: Address,
  amount: bigint,
  version: number,
): Promise<{ ok: boolean; reason: string }> {
  const [ok, reason] = await publicClient.readContract({
    address: vault,
    abi: kaneVaultAbi,
    functionName: "wouldAllow",
    args: [caller, amount, version],
  });
  return { ok, reason };
}

/** Recipient-checked transfer, tagged with the KaneAI attribution suffix. */
export async function agentTransfer(
  vault: Address,
  to: Address,
  amount: bigint,
  version: number,
  memo: string,
): Promise<Hex> {
  const wallet = getWalletClient();
  const calldata = encodeFunctionData({
    abi: kaneVaultAbi,
    functionName: "agentTransfer",
    args: [to, amount, version, memo],
  });
  return wallet.sendTransaction({ to: vault, data: tagCalldata(calldata), chain });
}

/** Window-capped spend into an allowlisted protocol, tagged with the attribution suffix. */
export async function agentSpendCapped(
  vault: Address,
  protocol: Address,
  amount: bigint,
  callData: Hex,
  version: number,
  memo: string,
): Promise<Hex> {
  const wallet = getWalletClient();
  const data = encodeFunctionData({
    abi: kaneVaultAbi,
    functionName: "agentSpendCapped",
    args: [protocol, amount, callData, version, memo],
  });
  return wallet.sendTransaction({ to: vault, data: tagCalldata(data), chain });
}
