// viem chain definitions + public / wallet clients for Celo.

import { createPublicClient, createWalletClient, defineChain, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { celo } from "viem/chains";
import { config, type Network } from "./config";

/** Celo Sepolia testnet (chainId 11142220). */
export const celoSepolia = defineChain({
  id: 11142220,
  name: "Celo Sepolia",
  nativeCurrency: { name: "CELO", symbol: "CELO", decimals: 18 },
  rpcUrls: {
    default: { http: ["https://forno.celo-sepolia.celo-testnet.org"] },
  },
  blockExplorers: {
    default: {
      name: "Blockscout",
      url: "https://celo-sepolia.blockscout.com",
    },
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
