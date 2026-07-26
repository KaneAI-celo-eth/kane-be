#!/usr/bin/env bash
# One-shot local routing test: start an anvil fork of Celo mainnet (if not already up),
# deploy the KaneExecutor factory, then run the kane-be routing e2e against it.
#
#   bun run e2e:anvil        # (from kaneai-be)  — or:  ./scripts/e2e-anvil.sh
#
# Requires foundry (anvil/forge/cast) + bun. Assumes the sibling repo layout KaneAI/{kaneai-be,kaneai-sc}.
set -euo pipefail

PORT=8545
RPC="http://localhost:${PORT}"
HERE="$(cd "$(dirname "$0")" && pwd)"
SC="$(cd "${HERE}/../../kaneai-sc" && pwd)"
# anvil default accounts: [0] = owner/deployer, [1] = the delegated agent kane-be signs with.
DEPLOYER_PK="0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
AGENT_PK="0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"

if ! cast block-number --rpc-url "${RPC}" >/dev/null 2>&1; then
  echo "▸ starting anvil (fork of Celo mainnet) on :${PORT} …"
  anvil --fork-url https://forno.celo.org --chain-id 42220 --port "${PORT}" --silent &
  for _ in $(seq 1 30); do cast block-number --rpc-url "${RPC}" >/dev/null 2>&1 && break; sleep 1; done
fi
echo "▸ anvil block $(cast block-number --rpc-url "${RPC}")"

echo "▸ deploying KaneExecutor + factory …"
FACTORY="$(cd "${SC}" && PRIVATE_KEY="${DEPLOYER_PK}" forge script script/DeployExecutor.s.sol \
  --rpc-url "${RPC}" --broadcast 2>&1 | grep 'KaneExecutorFactory:' | grep -oE '0x[0-9a-fA-F]{40}' | head -1)"
echo "▸ factory ${FACTORY}"

NETWORK=celo RPC_URL="${RPC}" AGENT_PRIVATE_KEY="${AGENT_PK}" FACTORY_ADDRESS="${FACTORY}" \
  bun run "${HERE}/e2e-anvil.ts"
