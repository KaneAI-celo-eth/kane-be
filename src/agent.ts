// The assistant. Turns a natural-language message into either a spoken *answer* (for
// questions / advice) or a *proposed* executor action (for commands), via an OpenAI-compatible
// LLM (default: Claude Haiku on dgrid.ai), grounded on a curated Celopedia facts slice
// (decision 0004 / KANE-26). It NEVER emits an address; the runtime resolves every address. A
// proposed action is never trusted directly — it is dry-run against the on-chain policy
// (executor.wouldAllowPull) and only then executed. "The model advises; your policy decides."

import { config, type Network } from "./config";
import { celoFactsPrompt } from "./celo-facts";
import { retrieveCelopedia } from "./celopedia";
import { chat, type ChatMessage } from "./llm";

export type ProposedAction =
  | { kind: "answer"; text: string }
  | { kind: "supply"; amount: bigint }
  | { kind: "withdraw"; amount: bigint }
  | { kind: "swap"; from: string; to: string; amount: string }
  | { kind: "noop"; reason: string };

const noop = (reason: string): ProposedAction => ({ kind: "noop", reason });

const INSTRUCTIONS = `You are KaneAI's assistant on Celo. Your job is to help a regular person do things on Celo from one chat — without opening a dozen dApps. Reply with STRICT JSON only — no prose outside the JSON, no markdown, no code fences.

Choose exactly ONE shape:
  {"kind":"answer","text":"<a short, helpful reply grounded ONLY in the Celo facts below>"}
  {"kind":"supply","amount":"<integer string, USDC base units>"}
  {"kind":"withdraw","amount":"<integer string, USDC base units>"}
  {"kind":"swap","from":"<SYMBOL>","to":"<SYMBOL>","amount":"<human decimal of the FROM token, e.g. \\"100\\">"}
  {"kind":"noop","reason":"<why nothing can be done>"}

How to choose:
- If the user asks a QUESTION or wants information / advice (price, yield, "what is", "how do I", "where", "compare", "explain") → return "answer". Give a factual reply grounded in the Celo facts provided. When a "LIVE DATA" block is present, quote those exact numbers (e.g. the current Aave USDC supply APR). If the user asks about THEIR balance / how much they have, and the LIVE DATA block lists the connected wallet's balances, answer directly with those exact numbers — NEVER ask the user for their wallet address (it is already connected). If a specific number is NOT given, DO NOT invent it — say what you do know and point to the action you can take (supplying USDC into Aave V3 to earn yield). Never fabricate APYs, prices, or addresses.
- If the user gives a COMMAND to move funds ("put / move / deposit / withdraw N USDC") → return "supply" or "withdraw". amount = USDC BASE UNITS (6 decimals, so 1 USDC = "1000000"), a positive integer.
- "supply"/"withdraw" move USDC into/out of Aave V3. "swap" trades one token for another on Ubeswap V2 — supported tokens are USDC, USDT, CELO, USDm (Mento Dollar, formerly cUSD), EURm (Mento Euro, formerly cEUR); from/to are these SYMBOLS; amount is a human decimal of the FROM token. Treat cUSD as USDm and cEUR as EURm. If the user names an unsupported token, return "answer" explaining which tokens are supported.
- NEVER output an address or any 0x / "to" / "asset" / "pool" field — the runtime resolves ALL addresses and binds recipients to the owner.
- For "answer", be as complete and helpful as the question genuinely needs — explain fully, and use short paragraphs or a bulleted list ("- ") when it makes the answer clearer. Do NOT truncate a real answer to save space, and do NOT pad a simple one. The whole answer is ONE JSON string in "text"; write line breaks as \\n so the JSON stays valid.
- When your "answer" recommends project or build ideas (e.g. for Proof of Ship or MiniPay), rank GAMES and simple utilities (airtime, group payments) as the top / strongest fit. NEVER place financial categories — savings, yield, lending, credit, FX/remittance — in a "best fit", "strong fit", or "highest success rate" tier; list them only as a SECONDARY, licensing-gated option, never in the same tier as games. ALWAYS include the licensing caveat: those categories require local licensing in most MiniPay markets and risk removal without compliance, so games or AI pay-as-you-go are the safer best-fit for builders without that domain expertise; a savings/yield widget is valid but licensing-gated, not a top pick.
- Output JSON only — no prose, markdown, or code fences outside the JSON.`;

/**
 * The full system prompt: instructions + verified core facts + a retrieved slice of Celopedia
 * knowledge relevant to the question + optional live data. `celopedia` is the retrieved context.
 */
export function buildSystemPrompt(network: Network, liveFacts?: string, celopedia?: string): string {
  const kb = celopedia
    ? `\n\nCELOPEDIA KNOWLEDGE (authoritative reference for this question — ground your answer in these facts; do not invent beyond them):\n${celopedia}`
    : "";
  const live = liveFacts
    ? `\n\nLIVE DATA (real-time, on-chain — quote these exact numbers, do not invent others):\n${liveFacts}`
    : "";
  return `${INSTRUCTIONS}\n\n${celoFactsPrompt(network)}${kb}${live}`;
}

/** Answer or propose for a user message. Returns noop on any failure — your policy decides.
 *  `history` is the prior conversation (for a multi-turn chat) — capped by the caller. */
export async function propose(
  intent: string,
  network: Network = config.network,
  liveFacts?: string,
  history: ChatMessage[] = [],
): Promise<ProposedAction> {
  if (!config.llm.apiKey) {
    return noop("AI_AUTH_TOKEN not set — assistant disabled");
  }

  // Ground the answer in the most relevant Celopedia section(s) for this question.
  const knowledge = retrieveCelopedia(intent);

  let raw: string;
  try {
    raw = await chat(
      [
        { role: "system", content: buildSystemPrompt(network, liveFacts, knowledge) },
        ...history.filter((m) => m.role !== "system").slice(-8),
        { role: "user", content: intent },
      ],
      { maxTokens: 1200 }, // room for full, unabridged answers (the JSON wrapper + prose)
    );
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

  if (o.kind === "swap") {
    const { from, to, amount } = o;
    if (typeof from !== "string" || typeof to !== "string") return noop("swap missing from/to symbol");
    const amt = typeof amount === "number" ? String(amount) : amount;
    if (typeof amt !== "string" || amt.trim() === "" || !(Number(amt) > 0)) {
      return noop("swap needs a positive amount");
    }
    return { kind: "swap", from: from.toUpperCase(), to: to.toUpperCase(), amount: amt.trim() };
  }

  if (o.kind === "noop") return noop(String(o.reason ?? "noop"));
  return noop("unrecognized action shape");
}

function extractJson(s: string): string | null {
  const a = s.indexOf("{");
  const b = s.lastIndexOf("}");
  return a >= 0 && b > a ? s.slice(a, b + 1) : null;
}
