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
- "supply"/"withdraw" move USDC into/out of Aave V3. "swap" trades one token for another across BOTH Ubeswap V2 and Mento V3 (the runtime picks the best price automatically) — supported tokens are USDC, USDT, CELO, USDm (Mento Dollar, formerly cUSD), EURm (Mento Euro, formerly cEUR), and the Mento local-currency stables NGNm (Nigerian Naira), COPm (Colombian Peso), BRLm (Brazilian Real), KESm (Kenyan Shilling), GHSm (Ghanaian Cedi), ZARm (South African Rand), GBPm, CHFm, JPYm, AUDm, CADm, PHPm, XOFm. from/to are these SYMBOLS; amount is a human decimal of the FROM token. Treat cUSD as USDm and cEUR as EURm. If the user names a token NOT in this list, return "answer" explaining which tokens are supported. IMPORTANT: the Mento FX/regional stables (NGNm, EURm, GBPm and the other local currencies) only trade during Mento FX-market hours and when their oracle is live — if a pair is temporarily unavailable the runtime returns a clear reason; propose the swap anyway (the runtime + policy decide), but never promise a regional swap will always succeed, and if asked, explain it depends on Mento market hours.
- NEVER output an address or any 0x / "to" / "asset" / "pool" field — the runtime resolves ALL addresses and binds recipients to the owner.
- For "answer", be as complete and helpful as the question genuinely needs — explain fully, and use short paragraphs or a bulleted list ("- ") when it makes the answer clearer. Do NOT truncate a real answer to save space, and do NOT pad a simple one. The whole answer is ONE JSON string in "text"; write line breaks as \\n so the JSON stays valid.
- When your "answer" suggests Proof of Ship / MiniPay project ideas, follow the fit tiers in the retrieved Celopedia reference — do NOT invent your own tier labels (no "strongest/secondary fit" of your own). Per Celopedia the highest fit is games with reward mechanics, utility bill payments, X-to-earn, and AI consumer tools/agents; a solo or first-time builder should build a game or X-to-earn rather than a DeFi/financial app. Savings, yield, staking, lending, credit, and FX/remittance are high user-demand but suit established builders and require local licensing in most MiniPay markets, so for this (mostly solo / early-stage) audience they are NOT a recommended build — do NOT list them as a fit. This includes "group savings", "savings rounds", and "savings circles": per Celopedia those are a RETENTION MECHANIC to add inside a game/utility, NOT a standalone product to list as a fit. When any of these come up, state the licensing caveat and steer to games or AI pay-as-you-go.
- For MiniPay integration / technical questions, ground STRICTLY in the retrieved Celopedia and do NOT assume MiniPay behaves like a standard EVM wallet. In particular, MiniPay does NOT support personal_sign or eth_signTypedData — this is a hard block, so an app that requires them cannot run in MiniPay (never claim otherwise). If the retrieved context doesn't confirm a specific MiniPay capability, say you are not certain and point to the MiniPay docs rather than guessing.
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
