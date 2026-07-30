// Register KaneAI as an ERC-8004 agent (Identity Registry) on Celo.
//
// The agent metadata is embedded as a `data:` URI (fully on-chain, content-addressed — no IPFS
// pinning needed, and the validator accepts it). Follows the CURRENT EIP-8004 registration-v1
// spec (see Celopedia ai-agents.md: `type` = the #registration-v1 URI, `services` with `endpoint`).
//
// Usage:
//   bun run scripts/register-8004.ts            # simulate only (prints agentId, no tx)
//   BROADCAST=1 bun run scripts/register-8004.ts # actually register (agent wallet signs)
//
// Signs with AGENT_PRIVATE_KEY (the agent wallet becomes the identity owner). Do NOT set
// RPC_URL to a local node — this registers on Celo mainnet.

import { getAddress, type Hex } from "viem";
import { publicClient, getWalletClient } from "../src/chain";
import { config } from "../src/config";
import { ERC8004_IDENTITY } from "../src/constants";

const IDENTITY = getAddress(ERC8004_IDENTITY[config.network]);

// Minimal ABI for register + reads.
const registryAbi = [
  { type: "function", name: "register", stateMutability: "nonpayable", inputs: [{ name: "agentURI", type: "string" }], outputs: [{ name: "agentId", type: "uint256" }] },
  { type: "function", name: "tokenURI", stateMutability: "view", inputs: [{ name: "agentId", type: "uint256" }], outputs: [{ type: "string" }] },
  { type: "function", name: "ownerOf", stateMutability: "view", inputs: [{ name: "agentId", type: "uint256" }], outputs: [{ type: "address" }] },
] as const;

// Spec-compliant metadata (registration-v1).
const metadata = {
  type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
  name: "KaneAI",
  description:
    "Autonomous, non-custodial stablecoin finance agent on Celo. The model advises; your on-chain policy decides. Funds stay in a user-owned executor bounded by a deterministic Solidity policy gate (per-token caps, an Aave V3 venue allowlist, and recipient-binding to the owner); the agent proposes supply/withdraw within it, settles per prompt via x402 (0.01 USDC), and tags every transaction (ERC-8021).",
  services: [{ name: "web", endpoint: "https://github.com/KaneAI-celo-eth", version: "1.0" }],
  supportedTrust: ["reputation", "validation"],
};

const json = JSON.stringify(metadata);
const agentURI = `data:application/json;base64,${Buffer.from(json).toString("base64")}`;

async function main() {
  const wallet = getWalletClient();
  const account = wallet.account!; // full LocalAccount → writeContract signs locally (raw tx)
  console.log("network:      ", config.network);
  console.log("registry:     ", IDENTITY);
  console.log("agent (owner):", account.address);
  console.log("agentURI len: ", agentURI.length, "chars (data: URI, on-chain)");

  // Simulate first — surfaces the agentId and any revert without spending gas.
  const { result: agentId, request } = await publicClient.simulateContract({
    address: IDENTITY,
    abi: registryAbi,
    functionName: "register",
    args: [agentURI],
    account,
  });
  console.log("SIMULATED agentId =", agentId.toString());

  if (process.env.BROADCAST !== "1") {
    console.log("\n(simulate only — set BROADCAST=1 to register for real)");
    return;
  }

  const hash = await wallet.writeContract(request);
  console.log("register tx:", hash);
  await publicClient.waitForTransactionReceipt({ hash: hash as Hex });
  const owner = await publicClient.readContract({ address: IDENTITY, abi: registryAbi, functionName: "ownerOf", args: [agentId] });
  const uri = await publicClient.readContract({ address: IDENTITY, abi: registryAbi, functionName: "tokenURI", args: [agentId] });
  console.log("REGISTERED ✓ agentId =", agentId.toString(), "| owner =", owner);
  console.log("tokenURI matches:", uri === agentURI);
}

main().catch((e) => {
  console.error("register-8004 failed:", e.shortMessage ?? e.message ?? e);
  process.exit(1);
});
