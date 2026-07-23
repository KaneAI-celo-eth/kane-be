// The advisor. Turns a natural-language intent into a *proposed* action.
// The proposal is never trusted directly — it is dry-run against the on-chain
// policy (vault.dryRun) and only then executed. "The model advises; the chain decides."

import type { Address } from "viem";
import { config } from "./config";

export type ProposedAction =
  | { kind: "transfer"; to: Address; amount: bigint; memo: string }
  | { kind: "spend"; protocol: Address; amount: bigint; callData: `0x${string}`; memo: string }
  | { kind: "noop"; reason: string };

/**
 * Propose an action for a user intent.
 *
 * TODO(tuning): implement an OpenAI-compatible tool-calling call against
 * config.llm.baseUrl (/chat/completions) that returns a strict ProposedAction.
 * Keep the tool schema tight so the model can only emit shapes the vault accepts.
 */
export async function propose(intent: string): Promise<ProposedAction> {
  if (!config.llm.apiKey) {
    return { kind: "noop", reason: "LLM_API_KEY not set — proposer disabled" };
  }
  void intent;
  return { kind: "noop", reason: "LLM proposer not implemented yet" };
}
