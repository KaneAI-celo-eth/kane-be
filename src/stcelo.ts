// stCELO liquid staking — the "stake" action. The stCELO Manager's `deposit()` is payable + mints
// stCELO to msg.sender. The executor's ERC20-pull model funds the native `msg.value` via CELO's
// DUAL NATURE (native balance == GoldToken ERC20 balance): pulling CELO as an ERC20 (transferFrom)
// raises the executor's native balance, which funds `deposit{value}`; the minted stCELO (to the
// executor) is delta-swept to the owner.
//
// ⚠️ The "CELO transferFrom moves native balance" mechanic CANNOT be Foundry/anvil-fork-tested —
// Celo's native-transfer precompile is stubbed on forks (verified: an ERC20 CELO transfer is a
// no-op on a fork). What IS fork-verified: `deposit()` succeeds + mints stCELO to msg.sender, and
// dual-nature `balanceOf == native`. So the FIRST mainnet stake should be a DUST amount. Atomicity
// makes a wrong assumption harmless: if the pull didn't fund native, `deposit{value}` reverts →
// the whole `execute` reverts → the owner's CELO is untouched.

import type { Address, Hex } from "viem";
import type { BuiltExecute } from "./executor";

export const STCELO_MANAGER: Address = "0x0239b96D10a434a56CC9E09383077A0490cF9398";
export const STCELO_TOKEN: Address = "0xC668583dcbDc9ae6FA3CE46462758188adfdfC24";
export const CELO_TOKEN: Address = "0x471EcE3750Da237f93B8E339c536989b8978a438";
/** `deposit()` on the stCELO Manager (payable, no args → mints stCELO to msg.sender). */
export const STCELO_DEPOSIT_SELECTOR: Hex = "0xd0e30db0";

/** Build the "stake N CELO" execute payload: pull CELO (→ the executor's native balance), call
 *  `deposit{value: N}()` (mints stCELO to the executor), and sweep the minted stCELO to the owner.
 *  `amount` is CELO base units (18 decimals). */
export function buildStake(amount: bigint): BuiltExecute {
  return {
    pulls: [{ token: CELO_TOKEN, amount }],
    approvals: [],
    calls: [{ target: STCELO_MANAGER, value: amount, data: STCELO_DEPOSIT_SELECTOR }],
    sweepTokens: [STCELO_TOKEN],
  };
}
