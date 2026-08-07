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
import {
  buildRebalance,
  buildSwap,
  quoteSwap,
  readBalances,
  readSupplyApr,
  readTokenPolicy,
  readVersion,
  resolveExecutor,
  sendExecute,
  wouldAllowPull,
  type BuiltExecute,
} from "./executor";
import { resolveLending } from "./lending";
import { buildStake, CELO_TOKEN } from "./stcelo";
import { propose, type ProposedAction } from "./agent";
import { buildPaymentMiddleware, facilitatorReachable, PAID_ROUTE, x402Enabled } from "./x402/seller";

// Backstop: a flaky x402 facilitator (or any late async error) must never take the agent down.
// Log unhandled rejections and keep serving /intent, /build, /health instead of crash-looping.
process.on("unhandledRejection", (reason) => {
  console.error("[kane-be] unhandledRejection — continuing:", reason);
});

const app = new Hono();

// Allow the local console (Vite dev) to call the gateway from the browser.
// x402 request/response headers the browser buyer must be allowed to send + read cross-origin.
const X402_REQ_HEADERS = ["Content-Type", "X-PAYMENT", "PAYMENT-SIGNATURE"];
const X402_RES_HEADERS = [
  "PAYMENT-REQUIRED",
  "PAYMENT-RESPONSE",
  "X-PAYMENT-RESPONSE",
  "PAYMENT-VERIFIED",
  "PAYMENT-ERROR",
];

// Allowed browser origins: localhost (dev), any *.vercel.app (the deployed console + previews),
// and anything in ALLOWED_ORIGINS (comma-separated, e.g. a custom domain). The production FE lives
// on Vercel, so it must be permitted to call this gateway cross-origin.
const EXTRA_ORIGINS = (process.env.ALLOWED_ORIGINS ?? "").split(",").map((o) => o.trim()).filter(Boolean);
function allowOrigin(origin: string | undefined): string {
  if (!origin) return EXTRA_ORIGINS[0] ?? "http://localhost:5173";
  if (/^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin)) return origin;
  if (/^https:\/\/([a-z0-9-]+\.)*vercel\.app$/.test(origin)) return origin;
  if (EXTRA_ORIGINS.includes(origin)) return origin;
  return EXTRA_ORIGINS[0] ?? "http://localhost:5173";
}

app.use(
  "*",
  cors({
    origin: (origin) => allowOrigin(origin ?? undefined),
    allowMethods: ["GET", "POST", "OPTIONS"],
    allowHeaders: X402_REQ_HEADERS,
    exposeHeaders: X402_RES_HEADERS, // so wrapFetchWithPayment can read the 402 requirements + settlement
  }),
);

app.get("/health", (c) =>
  c.json({
    ok: true,
    service: "kane-be",
    network: config.network,
    chainId: chain.id,
    // KaneAI's dedicated agent signer — the address the console authorizes (never the user's wallet).
    agent: agentAddress() ?? null,
    attributionTag: ATTRIBUTION_TAG,
    x402: x402Enabled(),
  }),
);

// Seller flow (Track 2): every `POST /intent` (one user prompt) requires a 0.01 USDC payment.
// We enable the paywall only if the facilitator is reachable — but a facilitator outage must
// neither crash the agent NOR give the paid product away for free. So on an outage we FAIL CLOSED:
// /intent returns 503 while the free routes (/health, /build, /policy, /dry-run) stay up. The
// paywall re-enables on the next restart once the facilitator recovers.
if (x402Enabled()) {
  if (await facilitatorReachable()) {
    app.use(buildPaymentMiddleware());
    console.log("[x402] facilitator reachable — paywall enabled on POST /intent");
  } else {
    app.use(PAID_ROUTE, async (c) =>
      c.json(
        { error: "Payment temporarily unavailable — the x402 facilitator is unreachable. Please try again shortly." },
        503,
      ),
    );
    console.warn(`[x402] facilitator unreachable at boot — ${PAID_ROUTE} returns 503 (fail-closed); other routes up`);
  }
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
  const body = await c.req.json<{
    intent?: string;
    owner?: string;
    history?: { role: "user" | "assistant"; content: string }[];
  }>();
  if (!body?.intent) return c.json({ error: "intent required" }, 400);

  // Real-time facts for grounded answers (e.g. the live Aave USDC supply APR).
  const apr = await readSupplyApr(config.network);
  let liveFacts = apr !== null ? `Aave V3 USDC supply APR right now: ${apr}% per year.` : "";

  // Ground balance questions in the CONNECTED wallet — the console already knows it, so the agent
  // must never ask the user for an address.
  if (body.owner && isAddress(body.owner)) {
    try {
      const bals = await readBalances(body.owner as Address, config.network);
      if (bals.length) {
        const line = bals.map((b) => `${b.symbol} ${b.human}`).join(", ");
        liveFacts += `\nThe connected wallet is ${body.owner}. Its CURRENT token balances: ${line}. When the user asks to check their balance / how much they have, answer directly with these exact numbers — do NOT ask them for an address.`;
      }
    } catch {
      /* balance read failed — fall back to APR-only facts */
    }
  }

  const action = await propose(body.intent, config.network, liveFacts || undefined, body.history ?? []);
  const res: Record<string, unknown> = { action: serializeAction(action) };

  // Supply/withdraw dry-run against the gate; answers/noops don't touch the chain.
  if (
    (action.kind === "supply" || action.kind === "withdraw" || action.kind === "stake") &&
    body.owner &&
    isAddress(body.owner)
  ) {
    try {
      const executor = await resolveExecutor(body.owner as Address);
      const token = action.kind === "stake" ? CELO_TOKEN : await pullToken(action.kind, action.asset);
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
        venue: q.venue,
        amountIn: q.amountIn.toString(),
        amountOut: q.amountOut.toString(),
        amountOutHuman: q.amountOutHuman,
        amountOutMin: q.amountOutMin.toString(),
        hops: q.path ? q.path.length - 1 : 1,
      };
      if (body.owner && isAddress(body.owner)) {
        const executor = await resolveExecutor(body.owner as Address);
        res.executor = executor;
        res.dryRun = await wouldAllowPull(executor, q.fromAddress, q.amountIn);
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

  const body = await c.req.json<{
    intent?: string;
    owner?: string;
    action?: { kind?: string; amount?: string; from?: string; to?: string; asset?: string };
  }>();
  if (!body?.owner || !isAddress(body.owner)) return c.json({ error: "invalid or missing owner" }, 400);
  const owner = body.owner as Address;

  // Prefer an explicit action (execute EXACTLY what the console proposed — deterministic, no
  // re-propose); fall back to proposing from `intent`. Either way it is dry-run before sending.
  let action: ProposedAction;
  if (body.action?.kind) {
    const a = deserializeAction(body.action);
    if (!a) return c.json({ error: "invalid action" }, 400);
    action = a;
  } else if (body.intent) {
    action = await propose(body.intent);
  } else {
    return c.json({ error: "intent or action required" }, 400);
  }
  // Only fund-moving actions execute; answers and noops never touch the chain.
  if (action.kind !== "supply" && action.kind !== "withdraw" && action.kind !== "swap" && action.kind !== "stake") {
    return c.json({ action: serializeAction(action), executed: false });
  }

  try {
    const executor = await resolveExecutor(owner);
    const network = config.network;

    let built: BuiltExecute;
    let token: Address;
    let pullAmount: bigint;
    if (action.kind === "supply" || action.kind === "withdraw") {
      const r = await resolveLending(action.asset ?? "USDC", network);
      built = buildRebalance(r, action.kind, action.amount, owner);
      token = built.pulls[0]!.token; // asset for supply, a/mToken for withdraw — venue-resolved
      pullAmount = action.amount;
    } else if (action.kind === "stake") {
      built = buildStake(action.amount);
      token = built.pulls[0]!.token; // CELO
      pullAmount = action.amount;
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

// Build the execute() payload for an action so the OWNER can sign it themselves (manual actions are
// owner-signed; the agent path is for the scheduler). Returns the pulls/approvals/calls + the input
// token/amount to approve + the executor's current version — everything the console needs to send
// approve(inputToken, inputAmount) then execute(...) from the user's wallet. Does NOT send anything.
app.post("/build", async (c) => {
  const body = await c.req.json<{
    owner?: string;
    action?: { kind?: string; amount?: string; from?: string; to?: string; asset?: string };
  }>();
  if (!body?.owner || !isAddress(body.owner)) return c.json({ error: "invalid or missing owner" }, 400);
  const action = body.action?.kind ? deserializeAction(body.action) : null;
  if (!action) return c.json({ error: "invalid action" }, 400);
  const owner = body.owner as Address;
  const network = config.network;

  try {
    const executor = await resolveExecutor(owner);
    let built: BuiltExecute;
    let inputToken: Address;
    let inputAmount: bigint;
    let quote: Awaited<ReturnType<typeof buildSwap>>["quote"] | undefined;

    if (action.kind === "supply" || action.kind === "withdraw") {
      const r = await resolveLending(action.asset ?? "USDC", network);
      built = buildRebalance(r, action.kind, action.amount, owner);
      inputToken = built.pulls[0]!.token; // asset for supply, a/mToken for withdraw — venue-resolved
      inputAmount = action.amount;
    } else if (action.kind === "stake") {
      built = buildStake(action.amount);
      inputToken = built.pulls[0]!.token; // CELO
      inputAmount = action.amount;
    } else if (action.kind === "swap") {
      const s = await buildSwap({ fromSymbol: action.from, toSymbol: action.to, amount: action.amount, owner, network });
      built = s;
      quote = s.quote;
      inputToken = s.pulls[0]!.token;
      inputAmount = s.pulls[0]!.amount;
    } else {
      return c.json({ error: "action is not executable" }, 400);
    }

    const version = await readVersion(executor);
    const dryRun = await wouldAllowPull(executor, inputToken, inputAmount);
    return c.json({
      executor,
      version,
      inputToken,
      inputAmount: inputAmount.toString(),
      dryRun,
      // execute() args, JSON-safe (bigints → strings). The console casts back to bigint to sign.
      pulls: built.pulls.map((p) => ({ token: p.token, amount: p.amount.toString() })),
      approvals: built.approvals.map((a) => ({ token: a.token, spender: a.spender, amount: a.amount.toString() })),
      calls: built.calls.map((cl) => ({ target: cl.target, value: cl.value.toString(), data: cl.data })),
      ...(built.sweepTokens?.length ? { sweepTokens: built.sweepTokens } : {}),
      ...(quote
        ? { quote: { from: quote.fromSymbol, to: quote.toSymbol, venue: quote.venue, amountOutHuman: quote.amountOutHuman, hops: quote.path ? quote.path.length - 1 : 1 } }
        : {}),
    });
  } catch (e) {
    return c.json({ error: (e as Error).message }, 502);
  }
});

/** The token pulled for a given action kind: USDC for supply, aUSDC for withdraw. */
async function pullToken(kind: "supply" | "withdraw", asset?: string): Promise<Address> {
  const r = await resolveLending(asset ?? "USDC", config.network);
  return kind === "supply" ? r.assetAddress : r.aToken;
}

function serializeAction(a: ProposedAction) {
  if (a.kind === "noop") return { kind: a.kind, reason: a.reason };
  if (a.kind === "answer") return { kind: a.kind, text: a.text };
  if (a.kind === "swap") return { kind: a.kind, from: a.from, to: a.to, amount: a.amount };
  return { kind: a.kind, amount: a.amount.toString(), ...("asset" in a && a.asset ? { asset: a.asset } : {}) };
}

/** Wire → ProposedAction for the console's Execute button. Only fund-moving kinds are executable;
 *  anything else (or malformed) returns null so the caller rejects it. The action is still dry-run
 *  against the on-chain gate before sending — your policy decides. */
function deserializeAction(a: {
  kind?: string;
  amount?: string;
  from?: string;
  to?: string;
  asset?: string;
}): ProposedAction | null {
  if (a.kind === "supply" || a.kind === "withdraw") {
    if (!a.amount) return null;
    try {
      const amount = BigInt(a.amount);
      if (amount <= 0n) return null;
      const asset = typeof a.asset === "string" && a.asset.trim() ? a.asset.trim() : undefined;
      return { kind: a.kind, amount, ...(asset ? { asset } : {}) };
    } catch {
      return null;
    }
  }
  if (a.kind === "stake") {
    if (!a.amount) return null;
    try {
      const amount = BigInt(a.amount);
      if (amount <= 0n) return null;
      return { kind: "stake", amount };
    } catch {
      return null;
    }
  }
  if (a.kind === "swap") {
    if (!a.from || !a.to || !a.amount || !(Number(a.amount) > 0)) return null;
    return { kind: "swap", from: a.from, to: a.to, amount: a.amount };
  }
  return null;
}

/**
 * TLS terminates at nginx, so this process receives plain http and Hono's `c.req.url` says
 * `http://…`. The x402 payment middleware copies that URL straight into the 402's
 * `resource.url`, which meant every payment-requirements header advertised
 * `http://kane-api…/intent` for a service only reachable over https. A buyer that matches on
 * the resource URL, or any tooling that follows it, is pointed at a scheme that does not answer.
 *
 * Rewriting the Request here rather than in a Hono middleware is deliberate: the payment
 * middleware reads the URL before any route handler runs, so the correction has to land before
 * Hono sees the request at all.
 *
 * `x-forwarded-proto` is trusted only to upgrade http→https, never to downgrade, so a spoofed
 * header cannot make the paywall advertise a plaintext resource. `PUBLIC_ORIGIN` is the escape
 * hatch for a proxy that does not set the header — set it to the public origin and every request
 * is rewritten to that host and scheme.
 */
const PUBLIC_ORIGIN = (process.env.PUBLIC_ORIGIN ?? "").trim();

export function publicUrlFor(req: Request): string {
  if (PUBLIC_ORIGIN) {
    const url = new URL(req.url);
    const pub = new URL(PUBLIC_ORIGIN);
    url.protocol = pub.protocol;
    url.host = pub.host;
    return url.toString();
  }
  if (req.headers.get("x-forwarded-proto") === "https" && req.url.startsWith("http://")) {
    const url = new URL(req.url);
    url.protocol = "https:";
    return url.toString();
  }
  return req.url;
}

const fetchBehindProxy = (req: Request, ...rest: unknown[]) => {
  const corrected = publicUrlFor(req);
  const forwarded = corrected === req.url ? req : new Request(corrected, req);
  return (app.fetch as (r: Request, ...a: unknown[]) => Response | Promise<Response>)(forwarded, ...rest);
};

export default { port: config.port, fetch: fetchBehindProxy };
