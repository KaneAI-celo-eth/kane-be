// The advisor. Turns a natural-language intent into a *proposed* action via an
// OpenAI-compatible LLM (default: Claude Haiku on dgrid.ai). The proposal is never
// trusted directly — it is dry-run against the on-chain policy (vault.dryRun) and
// only then executed. "The model advises; the chain decides."

import { isAddress, type Address } from "viem";
import { config } from "./config";
import { chat } from "./llm";

export type ProposedAction =
  | { kind: "transfer"; to: Address; amount: bigint; memo: string }
  | { kind: "spend"; protocol: Address; amount: bigint; callData: `0x${string}`; memo: string }
  | { kind: "noop"; reason: string };

const SYSTEM_PROMPT = `You are KaneAI's planner on Celo. Convert the user's intent into exactly ONE action, as strict JSON — no prose, no markdown, no code fences.

Choose one shape:
  {"kind":"transfer","to":"0x<40-hex address>","amount":"<integer string, token base units>","memo":"<short note>"}
  {"kind":"noop","reason":"<why no safe action>"}

Rules:
- Amounts are stablecoin BASE UNITS as a decimal integer string (USDC/USDT have 6 decimals, so 1 USDC = "1000000"; cUSD has 18).
- Only propose a transfer when the intent names a concrete recipient address and amount.
- If the intent is vague, unsafe, or missing a recipient/amount, return noop.
- Output JSON only.`;

/** Propose an action for a user intent. Returns noop on any failure — the chain decides. */
export async function propose(intent: string): Promise<ProposedAction> {
  if (!config.llm.apiKey) {
    return { kind: "noop", reason: "AI_AUTH_TOKEN not set — proposer disabled" };
  }

  let raw: string;
  try {
    raw = await chat([
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: intent },
    ]);
  } catch (e) {
    return { kind: "noop", reason: `LLM error: ${(e as Error).message}` };
  }

  return parseAction(raw);
}

/** Parse the LLM's JSON into a validated ProposedAction (transfer or noop). */
export function parseAction(raw: string): ProposedAction {
  const json = extractJson(raw);
  if (!json) return { kind: "noop", reason: "no JSON in LLM output" };

  let o: Record<string, unknown>;
  try {
    o = JSON.parse(json) as Record<string, unknown>;
  } catch {
    return { kind: "noop", reason: "invalid JSON from LLM" };
  }

  if (o.kind === "transfer" && typeof o.to === "string" && isAddress(o.to) && typeof o.amount === "string") {
    try {
      return { kind: "transfer", to: o.to, amount: BigInt(o.amount), memo: String(o.memo ?? "") };
    } catch {
      return { kind: "noop", reason: "non-integer amount from LLM" };
    }
  }
  if (o.kind === "noop") return { kind: "noop", reason: String(o.reason ?? "noop") };
  return { kind: "noop", reason: "unrecognized action shape" };
}

function extractJson(s: string): string | null {
  const a = s.indexOf("{");
  const b = s.lastIndexOf("}");
  return a >= 0 && b > a ? s.slice(a, b + 1) : null;
}
