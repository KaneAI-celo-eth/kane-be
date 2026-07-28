// The assistant. Turns a natural-language message into either a spoken *answer* (for
// questions / advice) or a *proposed* executor action (for commands), via an OpenAI-compatible
// LLM (default: Claude Haiku on dgrid.ai), grounded on a curated Celopedia facts slice
// (decision 0004 / KANE-26). It NEVER emits an address; the runtime resolves every address. A
// proposed action is never trusted directly — it is dry-run against the on-chain policy
// (executor.wouldAllowPull) and only then executed. "The model advises; the chain decides."

import { config, type Network } from "./config";
import { celoFactsPrompt } from "./celo-facts";
import { chat } from "./llm";

export type ProposedAction =
  | { kind: "answer"; text: string }
  | { kind: "supply"; amount: bigint }
  | { kind: "withdraw"; amount: bigint }
  | { kind: "noop"; reason: string };

const noop = (reason: string): ProposedAction => ({ kind: "noop", reason });

const INSTRUCTIONS = `You are KaneAI's assistant on Celo. Your job is to help a regular person do things on Celo from one chat — without opening a dozen dApps. Reply with STRICT JSON only — no prose outside the JSON, no markdown, no code fences.

Choose exactly ONE shape:
  {"kind":"answer","text":"<a short, helpful reply grounded ONLY in the Celo facts below>"}
  {"kind":"supply","amount":"<integer string, USDC base units>"}
  {"kind":"withdraw","amount":"<integer string, USDC base units>"}
  {"kind":"noop","reason":"<why nothing can be done>"}

How to choose:
- If the user asks a QUESTION or wants information / advice (price, yield, "what is", "how do I", "where", "compare", "explain") → return "answer". Give a concise, factual reply grounded in the Celo facts provided. When a "LIVE DATA" block is present, quote those exact numbers (e.g. the current Aave USDC supply APR). If a specific number is NOT given, DO NOT invent it — say what you do know and point to the action you can take (supplying USDC into Aave V3 to earn yield). Never fabricate APYs, prices, or addresses.
- If the user gives a COMMAND to move funds ("put / move / deposit / withdraw N USDC") → return "supply" or "withdraw". amount = USDC BASE UNITS (6 decimals, so 1 USDC = "1000000"), a positive integer.
- Only "supply"/"withdraw" execute on-chain right now (USDC on Aave V3). Swaps and other venues are NOT executable yet — if the user asks to swap or trade, return "answer" that explains this and offers the supported action.
- NEVER output an address or any 0x / "to" / "asset" / "pool" field — the runtime resolves ALL addresses and binds recipients to the owner.
- Keep "text" under ~60 words. Output JSON only.`;

/** The full system prompt — instructions + the Celopedia facts slice + optional live data. */
export function buildSystemPrompt(network: Network, liveFacts?: string): string {
  const live = liveFacts
    ? `\n\nLIVE DATA (real-time, on-chain — quote these exact numbers, do not invent others):\n${liveFacts}`
    : "";
  return `${INSTRUCTIONS}\n\n${celoFactsPrompt(network)}${live}`;
}

/** Answer or propose for a user message. Returns noop on any failure — the chain decides. */
export async function propose(
  intent: string,
  network: Network = config.network,
  liveFacts?: string,
): Promise<ProposedAction> {
  if (!config.llm.apiKey) {
    return noop("AI_AUTH_TOKEN not set — assistant disabled");
  }

  let raw: string;
  try {
    raw = await chat([
      { role: "system", content: buildSystemPrompt(network, liveFacts) },
      { role: "user", content: intent },
    ]);
  } catch (e) {
    return noop(`LLM error: ${(e as Error).message}`);
  }

  return parseAction(raw);
}

/**
 * Parse the LLM's JSON into a validated ProposedAction. Action shapes carry NO address, so any
 * smuggled `to`/address field is structurally ignored. Invalid/malformed → noop.
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

  if (o.kind === "answer") {
    const text = o.text;
    if (typeof text !== "string" || text.trim() === "") return noop("empty answer from LLM");
    return { kind: "answer", text: text.trim() };
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
