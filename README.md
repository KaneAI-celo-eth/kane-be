# KaneAI — Agent Runtime (`kane-be`)

The runtime behind KaneAI on **Celo**. It proposes actions from natural language,
**dry-runs them against the on-chain policy gate**, and executes only what the policy
allows — every transaction carrying KaneAI's attribution tag.

> **The model advises; your policy decides.**

## Modules

| File | Role |
| --- | --- |
| `src/config.ts` | Env-driven config (network, keys, RPC, LLM, x402, CORS). |
| `src/constants.ts` | Verified Celo registry (tokens, Aave V3 + Ubeswap venues, factory, attribution tag) — the public source of truth the prompt derives from. |
| `src/chain.ts` | viem chain defs (Celo mainnet + Sepolia) + public / wallet clients. |
| `src/attribution.ts` | ERC-8021 tagging — appends KaneAI's tag to every tx (Track 1 & 2 credit). |
| `src/abi.ts` | Executor / factory / ERC-20 / Aave / Ubeswap ABIs. |
| `src/executor.ts` | Per-user executor interaction: resolve the owner's executor, read its policy, dry-run a pull (`wouldAllowPull`), and build the `execute()` payload (owner-signed) or agent-sign it. Recipient is ALWAYS the owner. |
| `src/llm.ts` | OpenAI-compatible chat client (default: Claude Haiku via dgrid.ai). |
| `src/celo-facts.ts` | Curated core facts (addresses / venues) injected into every prompt, derived from `constants.ts` so the prompt can't drift from the code. |
| `src/celopedia.ts` | Celopedia retrieval — injects the most relevant reference slice per query so answers stay grounded. |
| `src/agent.ts` | The advisor: intent → validated `ProposedAction` (`answer` / `supply` / `withdraw` / `swap` / `noop`) via the LLM. |
| `src/x402/*` | x402 pay-per-prompt (Track 2): `seller` (gates `/intent`), `buyer` (auto-pay `fetch`), `facilitator` (hosted Celo facilitator client). |
| `src/server.ts` | Hono HTTP gateway: `/health`, `/policy`, `/dry-run`, `/intent`, `/build`, `/execute`. |
| `src/cli.ts` | CLI (`info`, `executor`, `policy`). |

## Run

```bash
bun install
cp .env.example .env   # AGENT_PRIVATE_KEY, AI_AUTH_TOKEN, X402_API_KEY, X402_PAY_TO

bun run cli info                    # show config + attribution tag
bun run cli policy <executorAddr>   # read an executor's on-chain policy
bun run dev                         # start the gateway (default :8787)
```

## Flow

```
intent ─► agent.propose() ─► executor.wouldAllowPull() ─► /build (owner signs approve + execute)
            (advisor,             (on-chain policy gate)      or /execute (agent-signed)
             Celopedia-grounded)                                      └─► tx (+ attribution tag)
```

Nothing the proposer returns is trusted directly: it is validated by the on-chain
policy before any funds move, and the executor binds every recipient to the owner.

## Config

Secrets live only in `.env`; public config (addresses, venues, tag, `MAINNET` toggle)
is in `src/constants.ts`. `NETWORK=celo` selects mainnet (chainId 42220). `CELOPEDIA_PATH`
points at the Celopedia references the retrieval reads. The attribution tag defaults to
KaneAI's registered value; every agent transaction includes it so on-chain volume and
x402 payments are credited.

## Deploy

The Celiq VPS is not a git checkout (no git there), so deployment is an rsync of the
source + Celopedia grounding, then a `pm2 restart`:

```bash
bun run deploy        # rsync src/ + grounding → VPS, restart pm2, health-check
```

`deploy.sh` targets host `celiq-vps` (override with `KANE_VPS=<host>`). Run `bun install`
on the VPS afterward only if `package.json` dependencies changed.

---

Part of **KaneAI** · Celo Agentic Payments & DeFAI Hackathon · MIT.
