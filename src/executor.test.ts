import { describe, expect, test } from "bun:test";
import { decodeFunctionData, getAddress, type Address, type Hex } from "viem";
import { aavePoolAbi } from "./abi";
import { AAVE, TOKENS } from "./constants";
import { attributionSuffix } from "./attribution";
import { buildRebalance, sendExecute, type BuiltExecute } from "./executor";

const OWNER = getAddress("0x1111111111111111111111111111111111111111");
const AUSDC = getAddress("0x2222222222222222222222222222222222222222");
const EXECUTOR = getAddress("0x3333333333333333333333333333333333333333");
const ATTACKER = getAddress("0xbadBAD0000000000000000000000000000000000");

const USDC = getAddress(TOKENS.celo.USDC!.address);
const POOL = getAddress(AAVE.celo!.pool);
const AMOUNT = 100_000_000n; // 100 USDC (6 decimals)

const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

describe("buildRebalance — supply", () => {
  const built = buildRebalance({ kind: "supply", amount: AMOUNT, owner: OWNER, network: "celo" });

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
  const built = buildRebalance({
    kind: "withdraw",
    amount: AMOUNT,
    owner: OWNER,
    network: "celo",
    aToken: AUSDC,
  });

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

  test("withdraw without aToken throws", () => {
    expect(() => buildRebalance({ kind: "withdraw", amount: AMOUNT, owner: OWNER, network: "celo" })).toThrow();
  });
});

describe("buildRebalance — recipient is always the owner", () => {
  test("a caller-supplied recipient cannot override the owner", () => {
    // Even if a rogue caller smuggles a `recipient` field, the builder only ever
    // encodes `owner` as the Aave recipient word.
    const built = buildRebalance({
      kind: "supply",
      amount: AMOUNT,
      owner: OWNER,
      network: "celo",
      // @ts-expect-error — recipient is not part of RebalanceParams; must be ignored.
      recipient: ATTACKER,
    });
    const { args } = decodeFunctionData({ abi: aavePoolAbi, data: built.calls[0]!.data });
    expect(eq(args[2] as string, OWNER)).toBe(true);
    expect(eq(args[2] as string, ATTACKER)).toBe(false);
  });
});

describe("sendExecute — attribution suffix", () => {
  test("sent calldata ends with the ERC-8021 attribution suffix", async () => {
    const built: BuiltExecute = buildRebalance({ kind: "supply", amount: AMOUNT, owner: OWNER, network: "celo" });

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
