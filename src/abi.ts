import { parseAbi } from "viem";

export const kaneVaultAbi = parseAbi([
  // agent bounded exits
  "function agentTransfer(address to, uint256 amount, uint32 expectedVersion, string memo)",
  "function agentSpendCapped(address protocol, uint256 amount, bytes callData, uint32 expectedVersion, string memo)",
  // views
  "function wouldAllow(address caller, uint256 amount, uint32 expectedVersion) view returns (bool ok, string reason)",
  "function balance() view returns (uint256)",
  "function remainingBudget() view returns (uint256)",
  "function owner() view returns (address)",
  "function token() view returns (address)",
  "function allowedRecipient(address recipient) view returns (bool)",
  "function allowedProtocol(address protocol) view returns (bool)",
  "function policy() view returns (address agent, uint128 budget, uint128 spent, uint128 perTxCap, uint128 windowCap, uint128 windowSpent, uint64 windowDuration, uint64 windowStart, uint64 expiry, uint32 version, bool revoked)",
]);

export const kaneVaultFactoryAbi = parseAbi([
  "function createVault(address token) returns (address vault)",
  "function vaultOf(address owner, address token) view returns (address)",
  "function vaultCount() view returns (uint256)",
]);

// Minimal ERC-20 for balances / decimals.
export const erc20Abi = parseAbi([
  "function balanceOf(address account) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
]);
