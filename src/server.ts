// HTTP gateway for the KaneAI agent (Hono). One of several interfaces
// (gateway / CLI / Telegram) that share the same agent + executor mapping.
//
// Executor model (v2.1, non-custodial): /policy reads a per-token policy, /dry-run asks
// the gate whether a pull is allowed, /intent proposes + dry-runs (no send), and the
// guarded /execute proposes → dry-runs → sends an attribution-tagged execute() as the agent.

import { Hono } from "hono";
import { cors } from "hono/cors";
import { type Address, isAddress } from "viem";
import { ATTRIBUTION_TAG, config } from "./config";
import { agentAddress, chain } from "./chain";
import { TOKENS } from "./constants";
import {
  buildRebalance,
  buildSwap,
  quoteSwap,
  readSupplyApr,
  readTokenPolicy,
  readVersion,
  resolveAToken,
  resolveExecutor,
  sendExecute,
  wouldAllowPull,
  type BuiltExecute,
} from "./executor";
import { propose, type ProposedAction } from "./agent";
import { buildPaymentMiddleware, PAID_ROUTE, x402Enabled } from "./x402/seller";

const app = new Hono();

// Allow the local console (Vite dev) to call the gateway from the browser.
app.use(
  "*",
  cors({
    origin: (origin) =>
      origin && /^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin) ? origin : "http://localhost:5173",
    allowMethods: ["GET", "POST", "OPTIONS"],
  }),
);

app.get("/health", (c) =>
  c.json({
    ok: true,
    service: "kane-be",
    network: config.network,
    chainId: chain.id,
    attributionTag: ATTRIBUTION_TAG,
    x402: x402Enabled(),
  }),
);

// Seller flow (Track 2): mount the paid route only when configured (API key + payTo).
if (x402Enabled()) {
  app.use(buildPaymentMiddleware());
  app.get(PAID_ROUTE, (c) =>
    c.json({
      advice: "KaneAI: define your paid product here.",
      attributionTag: ATTRIBUTION_TAG,
    }),
  );
}

// Read the on-chain per-token policy: /policy?executor=0x..&token=0x..
app.get("/policy", async (c) => {
  const executor = c.req.query("executor");
  const token = c.req.query("token");
  if (!executor || !isAddress(executor)) return c.json({ error: "invalid or missing executor address" }, 400);
  if (!token || !isAddress(token)) return c.json({ error: "invalid or missing token address" }, 400);

  try {
    const p = await readTokenPolicy(executor as Address, token as Address);
    return c.json({
      executor,
      token,
      perTxCap: p.perTxCap.toString(),
      budget: p.budget.toString(),
      spent: p.spent.toString(),
      windowCap: p.windowCap.toString(),
      windowSpent: p.windowSpent.toString(),
      windowDuration: p.windowDuration.toString(),
      windowStart: p.windowStart.toString(),
    });
  } catch (e) {
    return c.json({ error: (e as Error).message }, 502);
  }
});

// Dry-run a pull against the gate (no transaction sent).
app.post("/dry-run", async (c) => {
  const body = await c.req.json<{ executor?: string; token?: string; amount?: string }>();
  if (!body?.executor || !isAddress(body.executor)) return c.json({ error: "invalid or missing executor" }, 400);
  if (!body?.token || !isAddress(body.token)) return c.json({ error: "invalid or missing token" }, 400);
  if (!body?.amount) return c.json({ error: "amount required" }, 400);

  try {
    const result = await wouldAllowPull(body.executor as Address, body.token as Address, BigInt(body.amount));
    return c.json(result);
  } catch (e) {
    return c.json({ error: (e as Error).message }, 502);
  }
});

// Propose an action from natural language, then dry-run it against the on-chain gate.
// Does NOT execute — execution stays a separate, explicit step (/execute).
app.post("/intent", async (c) => {
  const body = await c.req.json<{ intent?: string; owner?: string }>();
  if (!body?.intent) return c.json({ error: "intent required" }, 400);

  // Real-time facts for grounded answers (e.g. the live Aave USDC supply APR).
  const apr = await readSupplyApr(config.network);
  const liveFacts = apr !== null ? `Aave V3 USDC supply APR right now: ${apr}% per year.` : undefined;

  const action = await propose(body.intent, config.network, liveFacts);
  const res: Record<string, unknown> = { action: serializeAction(action) };

  // Supply/withdraw dry-run against the gate; answers/noops don't touch the chain.
  if ((action.kind === "supply" || action.kind === "withdraw") && body.owner && isAddress(body.owner)) {
    try {
      const executor = await resolveExecutor(body.owner as Address);
      const token = await pullToken(action.kind);
      res.executor = executor;
      res.dryRun = await wouldAllowPull(executor, token, action.amount);
    } catch (e) {
      res.error = (e as Error).message; // unresolved executor / config gap — clear error, no crash
    }
  }

  // Swap: get a real Ubeswap quote (with the pool-depth guard) + dry-run the input pull.
  if (action.kind === "swap") {
    try {
      const q = await quoteSwap(action.from, action.to, action.amount);
      res.quote = {
        from: q.fromSymbol,
        to: q.toSymbol,
        amountIn: q.amountIn.toString(),
        amountOut: q.amountOut.toString(),
        amountOutHuman: q.amountOutHuman,
        amountOutMin: q.amountOutMin.toString(),
        hops: q.path.length - 1,
      };
      if (body.owner && isAddress(body.owner)) {
        const executor = await resolveExecutor(body.owner as Address);
        res.executor = executor;
        res.dryRun = await wouldAllowPull(executor, q.path[0]!, q.amountIn);
      }
    } catch (e) {
      res.error = (e as Error).message; // unsupported token / no pool / pool-depth guard / unresolved executor
    }
  }
  return c.json(res);
});

// Guarded end-to-end: propose → dry-run → send the attribution-tagged execute() as the agent.
app.post("/execute", async (c) => {
  if (!agentAddress()) return c.json({ error: "agent key not configured (AGENT_PRIVATE_KEY)" }, 403);

  const body = await c.req.json<{ intent?: string; owner?: string }>();
  if (!body?.intent) return c.json({ error: "intent required" }, 400);
  if (!body?.owner || !isAddress(body.owner)) return c.json({ error: "invalid or missing owner" }, 400);
  const owner = body.owner as Address;

  const action = await propose(body.intent);
  // Only fund-moving actions execute; answers and noops never touch the chain.
  if (action.kind !== "supply" && action.kind !== "withdraw" && action.kind !== "swap") {
    return c.json({ action: serializeAction(action), executed: false });
  }

  try {
    const executor = await resolveExecutor(owner);
    const network = config.network;

    let built: BuiltExecute;
    let token: Address;
    let pullAmount: bigint;
    if (action.kind === "supply") {
      token = usdcAddress();
      pullAmount = action.amount;
      built = buildRebalance({ kind: "supply", amount: action.amount, owner, network });
    } else if (action.kind === "withdraw") {
      const aToken = await resolveAToken(network);
      token = aToken;
      pullAmount = action.amount;
      built = buildRebalance({ kind: "withdraw", amount: action.amount, owner, network, aToken });
    } else {
      const s = await buildSwap({ fromSymbol: action.from, toSymbol: action.to, amount: action.amount, owner, network });
      built = s;
      token = s.pulls[0]!.token;
      pullAmount = s.pulls[0]!.amount;
    }

    const dryRun = await wouldAllowPull(executor, token, pullAmount);
    if (!dryRun.ok) return c.json({ action: serializeAction(action), executed: false, dryRun });

    const version = await readVersion(executor);
    const txHash = await sendExecute(executor, built, version);
    return c.json({ action: serializeAction(action), executed: true, txHash, dryRun });
  } catch (e) {
    return c.json({ action: serializeAction(action), executed: false, error: (e as Error).message }, 502);
  }
});

/** The token pulled for a given action kind: USDC for supply, aUSDC for withdraw. */
async function pullToken(kind: "supply" | "withdraw"): Promise<Address> {
  return kind === "supply" ? usdcAddress() : resolveAToken(config.network);
}

function usdcAddress(): Address {
  const usdc = TOKENS[config.network]?.USDC;
  if (!usdc) throw new Error(`USDC not configured for network ${config.network}`);
  return usdc.address;
}

function serializeAction(a: ProposedAction) {
  if (a.kind === "noop") return { kind: a.kind, reason: a.reason };
  if (a.kind === "answer") return { kind: a.kind, text: a.text };
  if (a.kind === "swap") return { kind: a.kind, from: a.from, to: a.to, amount: a.amount };
  return { kind: a.kind, amount: a.amount.toString() };
}

export default { port: config.port, fetch: app.fetch };
