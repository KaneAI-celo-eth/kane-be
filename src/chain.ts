// viem chain definitions + public / wallet clients for Celo.

import { createPublicClient, createWalletClient, defineChain, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { celo } from "viem/chains";
import { config, type Network } from "./config";
import { CHAINS } from "./constants";

/** Celo Sepolia testnet (chainId 11142220). */
export const celoSepolia = defineChain({
  id: CHAINS.celo_sepolia.id,
  name: "Celo Sepolia",
  nativeCurrency: { name: "CELO", symbol: "CELO", decimals: 18 },
  rpcUrls: {
    default: { http: [CHAINS.celo_sepolia.rpc] },
  },
  blockExplorers: {
    default: { name: "Blockscout", url: CHAINS.celo_sepolia.explorer },
  },
  testnet: true,
});

export function chainFor(network: Network) {
  return network === "celo" ? celo : celoSepolia;
}

export const chain = chainFor(config.network);

const transport = http(config.rpcUrl);

export const publicClient = createPublicClient({ chain, transport });

/** Wallet client for the delegated agent. Throws if no agent key is configured. */
export function getWalletClient() {
  if (!config.agentPrivateKey) {
    throw new Error("AGENT_PRIVATE_KEY not set — cannot sign transactions");
  }
  const account = privateKeyToAccount(config.agentPrivateKey);
  return createWalletClient({ account, chain, transport });
}

/** The delegated agent's address, or undefined if no key is configured. */
export function agentAddress(): `0x${string}` | undefined {
  if (!config.agentPrivateKey) return undefined;
  return privateKeyToAccount(config.agentPrivateKey).address;
}
