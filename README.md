# KaneAI — Agent Runtime (`kane-be`)

The runtime behind KaneAI on **Celo**. It proposes actions from natural language,
**dry-runs them against the on-chain policy gate**, and executes only what the chain
allows — every transaction carrying KaneAI's attribution tag.

> **The model advises; the chain decides.**

## Modules

| File | Role |
| --- | --- |
| `src/config.ts` | Env-driven config (network, keys, addresses, attribution tag). |
| `src/chain.ts` | viem chain defs (Celo mainnet + Sepolia) and public / wallet clients. |
| `src/attribution.ts` | ERC-8021 tagging — appends KaneAI's tag to every tx (Track 1 & 2 credit). |
| `src/abi.ts` | Vault / factory / ERC-20 ABIs. |
| `src/vault.ts` | Read policy, dry-run (`wouldAllow`), execute bounded exits tagged. |
| `src/llm.ts` | OpenAI-compatible chat client (default: Claude Haiku on dgrid.ai). |
| `src/agent.ts` | The advisor: intent → validated `ProposedAction` (transfer or noop) via the LLM. |
| `src/x402/*` | x402 pay-per-request (Track 2): seller (paid route) + buyer (auto-pay `fetch`) via the hosted Celo facilitator. |
| `src/server.ts` | Hono HTTP gateway: `/health`, `/policy`, `/dry-run`, `/intent` (propose + dry-run); mounts the x402 paid route when configured. |
| `src/cli.ts` | CLI (`info`, `policy`). |

## Run

```bash
bun install
cp .env.example .env   # fill AGENT_PRIVATE_KEY, VAULT_ADDRESS, LLM_API_KEY

bun run cli info                 # show config + attribution tag
bun run cli policy <vaultAddr>   # read a vault's on-chain policy
bun run dev                      # start the gateway (default :8787)
```

## Flow

```
intent ──► agent.propose() ──► vault.dryRun() ──► vault.agentTransfer() ──► tx (+ attribution tag)
             (advisor)          (on-chain gate)     (bounded exit)
```

Nothing the proposer returns is trusted directly: it is validated by the on-chain
policy before any funds move.

## Config

Network is `celo_sepolia` by default (deploy/dev on testnet first). Set `NETWORK=celo`
for mainnet. The attribution tag defaults to KaneAI's registered value; every agent
transaction includes it so on-chain volume and x402 payments are credited.

---

Part of **KaneAI** · Celo Agentic Payments & DeFAI Hackathon · MIT.
