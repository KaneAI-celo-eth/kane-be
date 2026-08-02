// Verification: the Mento V3 swap payload built by buildSwap is safe to allowlist —
// specifically that the swap output is RECIPIENT-BOUND to the owner (calldata head word
// index 3), matching the executor policy (bindRecipient=true, recipientWordIndex=3). If this
// drifts, a swap's output could land somewhere other than the owner. Runs against Celo
// mainnet (Mento SDK needs a live oracle) — swaps a USD-pegged pair that trades 24/7.
//
//   bun run mento-check
//
import { buildSwap } from "../src/executor";
import { MENTO_ROUTER, MENTO_RECIPIENT_WORD_INDEX } from "../src/mento";
import { slice, getAddress, type Address } from "viem";

const OWNER = "0x8Be7313124D009583b280b0047dB1ABE93342515" as Address;

function wordAddress(data: `0x${string}`, wordIndex: number): Address {
  // After the 4-byte selector, each arg is a 32-byte word; an address is its low 20 bytes.
  const word = slice(data, 4 + wordIndex * 32, 4 + wordIndex * 32 + 32);
  return getAddress(("0x" + word.slice(-40)) as Address);
}

let failed = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "✅" : "❌"} ${name}${detail ? " — " + detail : ""}`);
  if (!ok) failed++;
}

const built = await buildSwap({ fromSymbol: "USDC", toSymbol: "USDm", amount: "5", owner: OWNER });

check("venue is mento", built.quote.venue === "mento", `venue=${built.quote.venue}`);
check("exactly one call", built.calls.length === 1);
check(
  "call target is the Mento Router",
  getAddress(built.calls[0]!.target) === getAddress(MENTO_ROUTER),
  built.calls[0]!.target,
);
check(
  "approval spender is the Mento Router",
  getAddress(built.approvals[0]!.spender) === getAddress(MENTO_ROUTER),
);
check(
  "input pull == approval amount",
  built.pulls[0]!.amount === built.approvals[0]!.amount && built.pulls[0]!.amount === built.quote.amountIn,
);
const recipient = wordAddress(built.calls[0]!.data, MENTO_RECIPIENT_WORD_INDEX);
check(
  `recipient bound to owner at word ${MENTO_RECIPIENT_WORD_INDEX}`,
  recipient === getAddress(OWNER),
  `word3=${recipient}`,
);

if (failed > 0) throw new Error(`${failed} check(s) failed`);
console.log("\nALL CHECKS PASSED");
