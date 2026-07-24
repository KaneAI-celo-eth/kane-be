// The advisor. Turns a natural-language intent into a *proposed* executor action via an
// OpenAI-compatible LLM (default: Claude Haiku on dgrid.ai). The model is grounded on a
// curated Celopedia facts slice (decision 0004 / KANE-26) and returns ONLY an action +
// amount — it NEVER emits an address; the runtime resolves every address. The proposal is
// never trusted directly: it is dry-run against the on-chain policy (executor.wouldAllowPull)
// and only then executed. "The model advises; the chain decides."

import { config, type Network } from "./config";
import { celoFactsPrompt } from "./celo-facts";
import { chat } from "./llm";

export type ProposedAction =
  | { kind: "supply"; amount: bigint }
  | { kind: "withdraw"; amount: bigint }
  | { kind: "noop"; reason: string };

const noop = (reason: string): ProposedAction => ({ kind: "noop", reason });

const INSTRUCTIONS = `You are KaneAI's planner on Celo. Convert the user's intent into exactly ONE action, as strict JSON — no prose, no markdown, no code fences.

Choose one shape:
  {"kind":"supply","amount":"<integer string, USDC base units>"}
  {"kind":"withdraw","amount":"<integer string, USDC base units>"}
  {"kind":"noop","reason":"<why no safe action>"}

Rules:
- "supply" deposits USDC into Aave V3; "withdraw" redeems USDC from Aave V3.
- amount is USDC BASE UNITS as a decimal integer string (6 decimals, so 1 USDC = "1000000"). It must be a positive integer.
- NEVER output an address. Do NOT include "to", "onBehalfOf", "asset", "token", "pool", or any 0x field — the runtime resolves ALL addresses, and recipients are always bound to the vault owner.
- If the intent is vague, unsafe, or names no amount, return noop.
- Output JSON only.`;

/** The full system prompt for `network` — instructions + the Celopedia-grounded facts slice. */
export function buildSystemPrompt(network: Network): string {
  return `${INSTRUCTIONS}\n\n${celoFactsPrompt(network)}`;
}

/** Propose an action for a user intent. Returns noop on any failure — the chain decides. */
export async function propose(
  intent: string,
  network: Network = config.network,
): Promise<ProposedAction> {
  if (!config.llm.apiKey) {
    return noop("AI_AUTH_TOKEN not set — proposer disabled");
  }

  let raw: string;
  try {
    raw = await chat([
      { role: "system", content: buildSystemPrompt(network) },
      { role: "user", content: intent },
    ]);
  } catch (e) {
    return noop(`LLM error: ${(e as Error).message}`);
  }

  return parseAction(raw);
}

/**
 * Parse the LLM's JSON into a validated ProposedAction. The action shape carries NO address,
 * so any smuggled `to`/address field is structurally ignored. Invalid/malformed → noop.
 */
export function parseAction(raw: string): ProposedAction {
  const json = extractJson(raw);
  if (!json) return noop("no JSON in LLM output");

  let o: Record<string, unknown>;
  try {
    o = JSON.parse(json) as Record<string, unknown>;
  } catch {
    return noop("invalid JSON from LLM");
  }

  if (o.kind === "supply" || o.kind === "withdraw") {
    const amt = o.amount;
    if (typeof amt !== "string" && typeof amt !== "number") {
      return noop("missing or non-scalar amount from LLM");
    }
    let amount: bigint;
    try {
      amount = BigInt(amt);
    } catch {
      return noop("non-integer amount from LLM");
    }
    if (amount <= 0n) return noop("amount must be a positive integer");
    return { kind: o.kind, amount };
  }

  if (o.kind === "noop") return noop(String(o.reason ?? "noop"));
  return noop("unrecognized action shape");
}

function extractJson(s: string): string | null {
  const a = s.indexOf("{");
  const b = s.lastIndexOf("}");
  return a >= 0 && b > a ? s.slice(a, b + 1) : null;
}
