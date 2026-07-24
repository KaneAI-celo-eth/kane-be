import { describe, expect, test } from "bun:test";
import { AAVE, TOKENS } from "./constants";
import { buildSystemPrompt, parseAction } from "./agent";

describe("parseAction — valid intents", () => {
  test("supply intent parses to {kind:'supply', amount}", () => {
    const a = parseAction('{"kind":"supply","amount":"1000000"}');
    expect(a).toEqual({ kind: "supply", amount: 1_000_000n });
  });

  test("withdraw intent parses to {kind:'withdraw', amount}", () => {
    const a = parseAction('{"kind":"withdraw","amount":"250000"}');
    expect(a).toEqual({ kind: "withdraw", amount: 250_000n });
  });

  test("numeric amount is accepted", () => {
    const a = parseAction('{"kind":"supply","amount":500000}');
    expect(a).toEqual({ kind: "supply", amount: 500_000n });
  });
});

describe("parseAction — addresses are ignored, failures are noop", () => {
  test("a smuggled address field is ignored (action carries no address)", () => {
    const a = parseAction('{"kind":"supply","amount":"1000000","to":"0x000000000000000000000000000000000000dEaD"}');
    expect(a).toEqual({ kind: "supply", amount: 1_000_000n });
    expect(a).not.toHaveProperty("to");
  });

  test("malformed JSON → noop", () => {
    expect(parseAction("not json at all").kind).toBe("noop");
  });

  test("missing amount → noop", () => {
    expect(parseAction('{"kind":"supply"}').kind).toBe("noop");
  });

  test("non-integer amount → noop", () => {
    expect(parseAction('{"kind":"supply","amount":"1.5"}').kind).toBe("noop");
  });

  test("non-positive amount → noop", () => {
    expect(parseAction('{"kind":"supply","amount":"0"}').kind).toBe("noop");
  });

  test("explicit noop is preserved with reason", () => {
    const a = parseAction('{"kind":"noop","reason":"vague"}');
    expect(a).toEqual({ kind: "noop", reason: "vague" });
  });
});

describe("buildSystemPrompt — Celopedia grounding", () => {
  const prompt = buildSystemPrompt("celo");

  test("carries the verified Aave pool + USDC addresses", () => {
    expect(prompt).toContain(AAVE.celo!.pool);
    expect(prompt).toContain(TOKENS.celo.USDC!.address);
  });

  test("instructs the model to never emit an address", () => {
    expect(prompt).toContain("NEVER output an address");
  });
});
