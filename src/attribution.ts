// ERC-8021 attribution tagging. Every agent transaction carries KaneAI's tag so
// its on-chain volume and x402 payments are credited on the hackathon leaderboard.

import { toDataSuffix } from "@celo/attribution-tags";
import { concat, type Hex } from "viem";
import { ATTRIBUTION_TAG } from "./config";

/** The encoded ERC-8021 suffix for KaneAI's registered tag. */
export const attributionSuffix = toDataSuffix(ATTRIBUTION_TAG) as Hex;

/** Append the KaneAI attribution suffix after a call's calldata. */
export function tagCalldata(calldata: Hex): Hex {
  return concat([calldata, attributionSuffix]);
}
