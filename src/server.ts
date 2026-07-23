// HTTP gateway for the KaneAI agent (Hono). One of several interfaces
// (gateway / CLI / Telegram) that share the same agent + vault mapping.

import { Hono } from "hono";
import { type Address, isAddress } from "viem";
import { ATTRIBUTION_TAG, config } from "./config";
import { chain } from "./chain";
import { dryRun, readPolicy } from "./vault";

const app = new Hono();

app.get("/health", (c) =>
  c.json({
    ok: true,
    service: "kane-be",
    network: config.network,
    chainId: chain.id,
    attributionTag: ATTRIBUTION_TAG,
  }),
);

// Read the on-chain policy for a vault.
app.get("/policy/:vault", async (c) => {
  const vault = c.req.param("vault");
  if (!isAddress(vault)) return c.json({ error: "invalid vault address" }, 400);
  const p = await readPolicy(vault as Address);
  return c.json({
    agent: p.agent,
    version: p.version,
    revoked: p.revoked,
    budget: p.budget.toString(),
    spent: p.spent.toString(),
    perTxCap: p.perTxCap.toString(),
    windowCap: p.windowCap.toString(),
    expiry: p.expiry.toString(),
  });
});

// Dry-run a spend against the gate (no transaction sent).
app.post("/dry-run", async (c) => {
  const body = await c.req.json<{ vault: string; caller: string; amount: string; version: number }>();
  if (!isAddress(body.vault) || !isAddress(body.caller)) {
    return c.json({ error: "invalid address" }, 400);
  }
  const result = await dryRun(body.vault as Address, body.caller as Address, BigInt(body.amount), body.version);
  return c.json(result);
});

// TODO(tuning): POST /intent — propose (agent.ts) -> dry-run -> execute (vault.ts).

export default { port: config.port, fetch: app.fetch };
