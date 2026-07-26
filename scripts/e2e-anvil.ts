// End-to-end routing test against an anvil fork of Celo mainnet.
//
// Proves the kane-be execution routing is correct: the owner authorizes a separate agent key,
// and the agent drives a real Aave V3 supply→withdraw rebalance via the executor using the
// production buildRebalance() + sendExecute() (attribution-tagged), with recipient binding + caps
// + residual all enforced on-chain. No mocks — it talks to the deployed contracts on the fork.
//
// Prereqs: anvil forking Celo mainnet on :8545, contracts deployed, and this run started with:
//   NETWORK=celo RPC_URL=http://localhost:8545 AGENT_PRIVATE_KEY=<acct1> FACTORY_ADDRESS=<factory> \
//     bun run scripts/e2e-anvil.ts
// (env must be set BEFORE import so config picks up the anvil endpoint + agent key.)

import {
  createPublicClient,
  createTestClient,
  createWalletClient,
  encodeAbiParameters,
  http,
  keccak256,
  maxUint256,
  pad,
  parseEther,
  toFunctionSelector,
  toHex,
  formatUnits,
  zeroAddress,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { celo } from "viem/chains";
import { kaneExecutorAbi, kaneExecutorFactoryAbi, erc20Abi } from "../src/abi";

declare const process: { env: Record<string, string | undefined>; exit(code: number): never };
import {
  buildRebalance,
  resolveAToken,
  resolveExecutor,
  readVersion,
  sendExecute,
  wouldAllowPull,
} from "../src/executor";
import { AAVE, TOKENS } from "../src/constants";
import { tagCalldata } from "../src/attribution";

const RPC = process.env.RPC_URL ?? "http://localhost:8545";
const FACTORY = process.env.FACTORY_ADDRESS as Address;
// anvil default accounts: acct0 = owner (user), acct1 = agent (the kane-be signer).
const OWNER_PK = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const;
const AGENT = privateKeyToAccount(
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
).address;

const USDC = TOKENS.celo.USDC.address;
const POOL = AAVE.celo!.pool;
const SUPPLY_SEL = toFunctionSelector("supply(address,uint256,address,uint16)");
const WITHDRAW_SEL = toFunctionSelector("withdraw(address,uint256,address)");
const CAP = 1_000_000_000n; // 1000 USDC
const AMOUNT = 100_000_000n; // 100 USDC

// The kane-sc standard `calls` denylist (mirrors SetupExecutor.s.sol standardForbiddenSelectors()).
const FORBIDDEN: Hex[] = [
  "transfer(address,uint256)",
  "transferFrom(address,address,uint256)",
  "approve(address,uint256)",
  "increaseAllowance(address,uint256)",
  "decreaseAllowance(address,uint256)",
  "permit(address,address,uint256,uint256,uint8,bytes32,bytes32)",
  "transferWithAuthorization(address,address,uint256,uint256,uint256,bytes32,uint8,bytes32,bytes32)",
  "receiveWithAuthorization(address,address,uint256,uint256,uint256,bytes32,uint8,bytes32,bytes32)",
  "setApprovalForAll(address,bool)",
  "send(address,uint256,bytes)",
  "transferAndCall(address,uint256)",
  "transferAndCall(address,uint256,bytes)",
  "transferFromAndCall(address,address,uint256)",
  "approveAndCall(address,uint256)",
  "approveAndCall(address,uint256,bytes)",
].map((s) => toFunctionSelector(s));

const owner = privateKeyToAccount(OWNER_PK);
const transport = http(RPC);
const pub = createPublicClient({ chain: celo, transport });
const test = createTestClient({ chain: celo, mode: "anvil", transport });
const ownerWallet = createWalletClient({ account: owner, chain: celo, transport });

const ok = (b: boolean, msg: string) => {
  if (!b) throw new Error(`ASSERT FAILED: ${msg}`);
  console.log(`  ✓ ${msg}`);
};
const usdc = (v: bigint) => formatUnits(v, 6);

async function ownerWrite(address: Address, abi: unknown, functionName: string, args: unknown[]) {
  const hash = await ownerWallet.writeContract({ address, abi: abi as never, functionName, args, chain: celo } as never);
  await pub.waitForTransactionReceipt({ hash });
  return hash;
}

/** Fund `account` with `amount` USDC by finding + writing the ERC-20 balance storage slot. */
async function fundUsdc(account: Address, amount: bigint) {
  for (let slot = 0n; slot < 40n; slot++) {
    const key = keccak256(
      encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [account, slot]),
    );
    await test.setStorageAt({ address: USDC, index: key, value: pad(toHex(amount), { size: 32 }) });
    const bal = (await pub.readContract({ address: USDC, abi: erc20Abi, functionName: "balanceOf", args: [account] })) as bigint;
    if (bal === amount) return slot;
  }
  throw new Error("could not locate USDC balance slot");
}

async function main() {
  console.log(`\nkane-be routing e2e — anvil fork of Celo mainnet\n  factory ${FACTORY}\n  owner   ${owner.address}\n  agent   ${AGENT}\n`);
  const balOf = (t: Address, a: Address) =>
    pub.readContract({ address: t, abi: erc20Abi, functionName: "balanceOf", args: [a] }) as Promise<bigint>;

  // 0) fund native gas + USDC
  await test.setBalance({ address: owner.address, value: parseEther("100") });
  await test.setBalance({ address: AGENT, value: parseEther("100") });
  const slot = await fundUsdc(owner.address, CAP);
  const usdc0 = await balOf(USDC, owner.address);
  ok(usdc0 === CAP, `funded owner ${usdc(CAP)} USDC (slot ${slot})`);

  // 1) owner authorize flow (owner-signed) — what kane-fe does in prod
  console.log("\n[authorize] owner-signed:");
  // reuse-or-create so the script is rerunnable against a dirty anvil (provisionToken resets caps).
  const existing = (await pub.readContract({ address: FACTORY, abi: kaneExecutorFactoryAbi, functionName: "executorOf", args: [owner.address] })) as Address;
  if (existing === zeroAddress) await ownerWrite(FACTORY, kaneExecutorFactoryAbi, "createExecutor", []);
  const executor = await resolveExecutor(owner.address);
  ok(/^0x[0-9a-fA-F]{40}$/.test(executor) && executor !== owner.address, `${existing === zeroAddress ? "createExecutor" : "reuse executor"} → ${executor}`);
  const aUsdc = await resolveAToken("celo");
  ok(aUsdc.length === 42, `resolved aUSDC ${aUsdc}`);

  await ownerWrite(executor, kaneExecutorAbi, "setAgent", [AGENT]);
  await ownerWrite(executor, kaneExecutorAbi, "provisionToken", [USDC, CAP, CAP, 0n, 0n]);
  await ownerWrite(executor, kaneExecutorAbi, "provisionToken", [aUsdc, CAP, CAP, 0n, 0n]);
  await ownerWrite(executor, kaneExecutorAbi, "setAllowedTarget", [POOL, true]);
  await ownerWrite(executor, kaneExecutorAbi, "setAllowedSelector", [POOL, SUPPLY_SEL, true, true, 2]);
  await ownerWrite(executor, kaneExecutorAbi, "setAllowedSelector", [POOL, WITHDRAW_SEL, true, true, 2]);
  await ownerWrite(executor, kaneExecutorAbi, "setForbiddenSelectors", [FORBIDDEN, true]);
  await ownerWrite(USDC, erc20Abi, "approve", [executor, maxUint256]);
  await ownerWrite(aUsdc, erc20Abi, "approve", [executor, maxUint256]);
  ok(await pub.readContract({ address: executor, abi: kaneExecutorAbi, functionName: "agent" }) === AGENT, "agent set");
  ok(await pub.readContract({ address: executor, abi: kaneExecutorAbi, functionName: "forbiddenSelector", args: [FORBIDDEN[0]] }) === true, "denylist seeded");

  // 2) agent supply — production buildRebalance() + sendExecute() (agent-signed, attribution-tagged)
  console.log("\n[agent] supply 100 USDC → Aave (recipient bound to owner):");
  const version = await readVersion(executor);
  const dry = await wouldAllowPull(executor, USDC, AMOUNT);
  ok(dry.ok, `dry-run wouldAllowPull ok (${dry.reason || "—"})`);
  const supplyBuilt = buildRebalance({ kind: "supply", amount: AMOUNT, owner: owner.address, network: "celo" });
  ok(supplyBuilt.calls[0].data.slice(0, 10) === SUPPLY_SEL, "built calls[0] = Aave supply");
  const h1 = await sendExecute(executor, supplyBuilt, version);
  await pub.waitForTransactionReceipt({ hash: h1 });
  const aBal = await balOf(aUsdc, owner.address);
  const usdc1 = await balOf(USDC, owner.address);
  ok(aBal >= AMOUNT - 2n, `owner holds ~${usdc(aBal)} aUSDC`);
  ok(usdc1 === usdc0 - AMOUNT, `owner USDC ${usdc(usdc0)} → ${usdc(usdc1)} (100 pulled)`);
  ok((await balOf(USDC, executor)) === 0n, "executor holds no residual USDC");

  // attribution: the sent execute tx carries the ERC-8021 suffix
  const suffix = tagCalldata("0x").slice(2);
  const tx1 = await pub.getTransaction({ hash: h1 });
  ok(tx1.input.endsWith(suffix), `execute tx carries attribution suffix (…${suffix.slice(-12)})`);

  // 3) agent withdraw — pull the aUSDC, withdraw USDC back to owner
  console.log("\n[agent] withdraw → USDC back to owner:");
  const version2 = await readVersion(executor);
  const wBuilt = buildRebalance({ kind: "withdraw", amount: aBal, owner: owner.address, network: "celo", aToken: aUsdc });
  ok(wBuilt.calls[0].data.slice(0, 10) === WITHDRAW_SEL, "built calls[0] = Aave withdraw");
  const h2 = await sendExecute(executor, wBuilt, version2);
  await pub.waitForTransactionReceipt({ hash: h2 });
  const usdc2 = await balOf(USDC, owner.address);
  ok(usdc2 >= usdc0 - 2n, `owner USDC restored → ${usdc(usdc2)}`);
  ok((await balOf(aUsdc, executor)) === 0n, "executor holds no residual aUSDC");

  // 4) recipient binding regression — a redirected withdraw MUST revert on-chain
  console.log("\n[security] redirected withdraw must revert (recipient binding):");
  const attacker = "0x000000000000000000000000000000000000dEaD" as Address;
  const attackerBefore = await balOf(USDC, attacker); // 0xdEaD holds pre-existing USDC on the fork
  await fundUsdc(owner.address, AMOUNT);
  await sendExecute(executor, buildRebalance({ kind: "supply", amount: AMOUNT, owner: owner.address, network: "celo" }), await readVersion(executor)).then((h) => pub.waitForTransactionReceipt({ hash: h }));
  const aBal2 = await balOf(aUsdc, owner.address);
  // hand-craft a malicious withdraw with to=attacker (bypassing buildRebalance)
  const evil = { ...buildRebalance({ kind: "withdraw", amount: aBal2, owner: owner.address, network: "celo", aToken: aUsdc }) };
  const { encodeFunctionData } = await import("viem");
  const aavePoolAbi = (await import("../src/abi")).aavePoolAbi;
  evil.calls = [{ target: POOL, value: 0n, data: encodeFunctionData({ abi: aavePoolAbi, functionName: "withdraw", args: [USDC, aBal2, attacker] }) }];
  let reverted = false;
  try {
    await sendExecute(executor, evil, await readVersion(executor)).then((h) => pub.waitForTransactionReceipt({ hash: h }));
  } catch {
    reverted = true;
  }
  ok(reverted, "withdraw(to=attacker) reverted (RecipientNotBound)");
  ok((await balOf(USDC, attacker)) === attackerBefore, "attacker balance unchanged — no funds redirected");

  console.log("\n✅ ROUTING E2E PASSED — kane-be drives the executor correctly end-to-end.\n");
}

main().catch((e) => {
  console.error("\n❌ E2E FAILED:", e.message ?? e);
  process.exit(1);
});
