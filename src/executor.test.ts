import { describe, expect, test } from "bun:test";
import { decodeFunctionData, getAddress, type Address, type Hex } from "viem";
import { aavePoolAbi } from "./abi";
import { AAVE, TOKENS } from "./constants";
import { attributionSuffix } from "./attribution";
import { buildRebalance, sendExecute, type BuiltExecute } from "./executor";
import type { ResolvedLending } from "./lending";

const OWNER = getAddress("0x1111111111111111111111111111111111111111");
const AUSDC = getAddress("0x2222222222222222222222222222222222222222");
const EXECUTOR = getAddress("0x3333333333333333333333333333333333333333");
const ATTACKER = getAddress("0xbadBAD0000000000000000000000000000000000");

const USDC = getAddress(TOKENS.celo.USDC!.address);
const POOL = getAddress(AAVE.celo!.pool);
const AMOUNT = 100_000_000n; // 100 USDC (6 decimals)

// A pre-resolved Aave/USDC venue (buildRebalance is pure — venue resolution is server-side).
const RESOLVED_USDC: ResolvedLending = {
  venue: "aave",
  pool: POOL,
  assetSymbol: "USDC",
  assetAddress: USDC,
  aToken: AUSDC,
  aprPct: null,
};

const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

describe("buildRebalance — supply", () => {
  const built = buildRebalance(RESOLVED_USDC, "supply", AMOUNT, OWNER);

  test("pulls USDC and approves the pool", () => {
    expect(built.pulls).toHaveLength(1);
    expect(eq(built.pulls[0]!.token, USDC)).toBe(true);
    expect(built.pulls[0]!.amount).toBe(AMOUNT);

    expect(built.approvals).toHaveLength(1);
    expect(eq(built.approvals[0]!.token, USDC)).toBe(true);
    expect(eq(built.approvals[0]!.spender, POOL)).toBe(true);
    expect(built.approvals[0]!.amount).toBe(AMOUNT);
  });

  test("call decodes to supply(USDC, amount, owner, 0) with onBehalfOf == owner", () => {
    expect(built.calls).toHaveLength(1);
    expect(eq(built.calls[0]!.target, POOL)).toBe(true);
    const { functionName, args } = decodeFunctionData({ abi: aavePoolAbi, data: built.calls[0]!.data });
    expect(functionName).toBe("supply");
    expect(eq(args[0] as string, USDC)).toBe(true); // asset
    expect(args[1]).toBe(AMOUNT); // amount
    expect(eq(args[2] as string, OWNER)).toBe(true); // onBehalfOf (word index 2)
    expect(args[3]).toBe(0); // referralCode
  });
});

describe("buildRebalance — withdraw", () => {
  const built = buildRebalance(RESOLVED_USDC, "withdraw", AMOUNT, OWNER);

  test("pulls aUSDC and needs no approval", () => {
    expect(built.pulls).toHaveLength(1);
    expect(eq(built.pulls[0]!.token, AUSDC)).toBe(true);
    expect(built.pulls[0]!.amount).toBe(AMOUNT);
    expect(built.approvals).toHaveLength(0);
  });

  test("call decodes to withdraw(USDC, amount, owner) with to == owner", () => {
    const { functionName, args } = decodeFunctionData({ abi: aavePoolAbi, data: built.calls[0]!.data });
    expect(functionName).toBe("withdraw");
    expect(eq(args[0] as string, USDC)).toBe(true); // asset
    expect(args[1]).toBe(AMOUNT); // amount
    expect(eq(args[2] as string, OWNER)).toBe(true); // to (word index 2)
  });

});

describe("buildRebalance — recipient is always the owner", () => {
  test("the recipient word is always the owner, never anyone else", () => {
    // buildRebalance only ever encodes the explicit `owner` as the Aave recipient word;
    // there is no caller-supplied recipient path.
    const built = buildRebalance(RESOLVED_USDC, "supply", AMOUNT, OWNER);
    const { args } = decodeFunctionData({ abi: aavePoolAbi, data: built.calls[0]!.data });
    expect(eq(args[2] as string, OWNER)).toBe(true);
    expect(eq(args[2] as string, ATTACKER)).toBe(false);
  });
});

describe("sendExecute — attribution suffix", () => {
  test("sent calldata ends with the ERC-8021 attribution suffix", async () => {
    const built: BuiltExecute = buildRebalance(RESOLVED_USDC, "supply", AMOUNT, OWNER);

    let captured: Hex | undefined;
    const mockWallet = {
      sendTransaction: async (params: { to: Address; data: Hex }): Promise<Hex> => {
        captured = params.data;
        return "0xabc" as Hex;
      },
    };

    await sendExecute(EXECUTOR, built, 1, mockWallet);

    expect(captured).toBeDefined();
    // suffix is a 0x-prefixed hex; the tagged calldata must end with its body.
    expect(captured!.endsWith(attributionSuffix.slice(2))).toBe(true);
  });
});
