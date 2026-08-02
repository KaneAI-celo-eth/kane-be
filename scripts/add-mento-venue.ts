// Migration: add the Mento V3 swap venue to an ALREADY-REGISTERED executor. New executors get
// this at creation (kane-fe buildPolicy); existing ones need the owner (MANAGER_ROLE) to run
// the setters once. This batches them into a single owner-signed `multicall`:
//   - setAllowedTarget(MENTO_ROUTER, true)
//   - setAllowedSelector(MENTO_ROUTER, 0x3375aa2a, true, bindRecipient=true, word 3)
//   - provisionToken(<each Mento local stable>, cap)
//
// Usage:
//   OWNER=0x... bun scripts/add-mento-venue.ts            # print the tagged multicall to sign
//   OWNER=0x... OWNER_PRIVATE_KEY=0x... bun scripts/add-mento-venue.ts --send   # sign + send
//
// The owner must sign (only MANAGER_ROLE may re-scope policy; the deployer cannot).

import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  http,
  getAddress,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { CHAINS, TOKENS, type Network } from "../src/constants";
import { config } from "../src/config";
import { MENTO_ROUTER, MENTO_SWAP_SELECTOR, MENTO_RECIPIENT_WORD_INDEX } from "../src/mento";
import { tagCalldata } from "../src/attribution";

const network: Network = config.network;
const rpc = config.rpcUrl || CHAINS[network].rpc;
const CAP_18 = 1_000_000_000_000_000_000_000n; // 1000e18 — mirrors kane-fe buildPolicy

// Mento local-currency stables to provision as pull tokens (18d, swap on Mento V3).
const MENTO_SYMBOLS = ["BRLm", "XOFm", "KESm", "NGNm", "COPm", "GBPm", "CHFm", "JPYm", "AUDm", "CADm", "GHSm", "PHPm", "ZARm"];

const execAbi = [
  { type: "function", name: "executorOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "address" }] },
  { type: "function", name: "setAllowedTarget", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "bool" }], outputs: [] },
  { type: "function", name: "setAllowedSelector", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "bytes4" }, { type: "bool" }, { type: "bool" }, { type: "uint16" }], outputs: [] },
  { type: "function", name: "provisionToken", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint128" }, { type: "uint128" }, { type: "uint128" }, { type: "uint64" }], outputs: [] },
  { type: "function", name: "multicall", stateMutability: "nonpayable", inputs: [{ type: "bytes[]" }], outputs: [{ type: "bytes[]" }] },
] as const;

const owner = process.env.OWNER as Address | undefined;
if (!owner) throw new Error("set OWNER=0x... (the executor owner)");
if (!config.factoryAddress) throw new Error("factory address not configured");

const pc = createPublicClient({ transport: http(rpc) });
const executor = (await pc.readContract({
  address: config.factoryAddress,
  abi: execAbi,
  functionName: "executorOf",
  args: [getAddress(owner)],
})) as Address;
if (executor === "0x0000000000000000000000000000000000000000") {
  throw new Error(`no executor for ${owner} — register first`);
}

const tokens = TOKENS[network];
const inner: Hex[] = [
  encodeFunctionData({ abi: execAbi, functionName: "setAllowedTarget", args: [MENTO_ROUTER, true] }),
  encodeFunctionData({
    abi: execAbi,
    functionName: "setAllowedSelector",
    args: [MENTO_ROUTER, MENTO_SWAP_SELECTOR, true, true, MENTO_RECIPIENT_WORD_INDEX],
  }),
  ...MENTO_SYMBOLS.filter((s) => tokens[s]).map((s) =>
    encodeFunctionData({
      abi: execAbi,
      functionName: "provisionToken",
      args: [tokens[s]!.address, CAP_18, CAP_18, 0n, 0n],
    }),
  ),
];

const data = tagCalldata(encodeFunctionData({ abi: execAbi, functionName: "multicall", args: [inner] }));

console.log("executor:", executor);
console.log("calls in multicall:", inner.length, `(1 target + 1 selector + ${inner.length - 2} tokens)`);
console.log("to:", executor);
console.log("data:", data);

if (process.argv.includes("--send")) {
  const pk = process.env.OWNER_PRIVATE_KEY as Hex | undefined;
  if (!pk) throw new Error("--send needs OWNER_PRIVATE_KEY (the owner's key — only MANAGER_ROLE may re-scope)");
  const account = privateKeyToAccount(pk);
  if (getAddress(account.address) !== getAddress(owner)) {
    throw new Error(`OWNER_PRIVATE_KEY (${account.address}) != OWNER (${owner}) — the owner must sign`);
  }
  const chain = { id: CHAINS[network].id, name: network, nativeCurrency: { name: "CELO", symbol: "CELO", decimals: 18 }, rpcUrls: { default: { http: [rpc] } } } as const;
  const wc = createWalletClient({ account, transport: http(rpc), chain });
  const hash = await wc.sendTransaction({ to: executor, data, chain });
  console.log("sent:", hash);
  await pc.waitForTransactionReceipt({ hash });
  console.log("confirmed ✓ Mento venue added to", executor);
} else {
  console.log("\n(dry-run) re-run with --send + OWNER_PRIVATE_KEY, or sign this {to,data} from the owner wallet.");
}
