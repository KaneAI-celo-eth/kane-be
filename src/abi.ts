import { parseAbi } from "viem";

// KaneExecutor v2.1 — non-custodial per-user executor. The agent drives an atomic
// execute(pulls, approvals, calls, version); the owner configures per-token caps +
// recipient-bound allowlists + a seeded denylist. Mirrors kane-sc src/KaneExecutor.sol.
export const kaneExecutorAbi = parseAbi([
  // agent action: atomic pull → bounded-approve → allowlisted calls → reset → sweep-back
  "function execute((address token, uint256 amount)[] pulls, (address token, address spender, uint256 amount)[] approvals, (address target, uint256 value, bytes data)[] calls, uint32 expectedVersion)",
  // per-token policy struct (KanePolicy.TokenPolicy)
  "function tokenPolicy(address token) view returns ((uint128 perTxCap, uint128 budget, uint128 spent, uint128 windowCap, uint128 windowSpent, uint64 windowDuration, uint64 windowStart))",
  // off-chain dry-run
  "function wouldAllowPull(address token, uint256 amount) view returns (bool ok, string reason)",
  // status views
  "function owner() view returns (address)",
  "function deployer() view returns (address)",
  "function agent() view returns (address)",
  "function version() view returns (uint32)",
  "function revoked() view returns (bool)",
  "function allowedTarget(address target) view returns (bool)",
  "function allowedSelector(address target, bytes4 selector) view returns (bool)",
  "function forbiddenSelector(bytes4 selector) view returns (bool)",
  // owner (MANAGER_ROLE) config
  "function setAgent(address agent)",
  "function setExpiry(uint64 expiry)",
  "function provisionToken(address token, uint128 perTxCap, uint128 budget, uint128 windowCap, uint64 windowDuration)",
  "function setAllowedTarget(address target, bool allowed)",
  "function setAllowedSelector(address target, bytes4 selector, bool allowed, bool bindRecipient, uint16 recipientWordIndex)",
  "function setForbiddenSelector(bytes4 selector, bool forbidden)",
  "function setForbiddenSelectors(bytes4[] selectors, bool forbidden)",
  "function rescue(address token, address to)",
  "function rescueNative(address to)",
  // kill switch
  "function revoke()",
  "function unrevoke()",
  // roles (AccessControl)
  "function MANAGER_ROLE() view returns (bytes32)",
  "function ADMIN_ROLE() view returns (bytes32)",
  "function hasRole(bytes32 role, address account) view returns (bool)",
]);

// KaneExecutorFactory — one executor per user behind a shared beacon.
export const kaneExecutorFactoryAbi = parseAbi([
  "function createExecutor() returns (address executor)",
  "function executorOf(address owner) view returns (address)",
  "function beacon() view returns (address)",
  "function admin() view returns (address)",
  "function executorCount() view returns (uint256)",
]);

// KaneBeacon — shared upgrade beacon (AccessControl UPGRADER_ROLE).
export const kaneBeaconAbi = parseAbi([
  "function implementation() view returns (address)",
  "function UPGRADER_ROLE() view returns (bytes32)",
]);

// Minimal ERC-20 — balances/metadata + the allowance the owner grants the executor
// (the executor pulls via transferFrom(owner), so the owner must approve it first).
export const erc20Abi = parseAbi([
  "function balanceOf(address account) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
]);

// Aave V3 Pool — the demo rebalance target (supply/withdraw). onBehalfOf / to are the
// 3rd arg (word index 2), recipient-bound to the owner by the executor.
export const aavePoolAbi = parseAbi([
  "function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode)",
  "function withdraw(address asset, uint256 amount, address to) returns (uint256)",
]);

// Aave V3 ProtocolDataProvider — resolves the aToken (aUSDC) for the withdraw pull.
export const aaveDataProviderAbi = parseAbi([
  "function getReserveTokensAddresses(address asset) view returns (address aTokenAddress, address stableDebtTokenAddress, address variableDebtTokenAddress)",
]);
