// Minimal CLI for the KaneAI agent (executor model). Commands: info, executor, policy.

import { type Address, isAddress } from "viem";
import { ATTRIBUTION_TAG, config } from "./config";
import { chain } from "./chain";
import { TOKENS } from "./constants";
import { readTokenPolicy, resolveExecutor } from "./executor";

const [cmd, arg, arg2] = process.argv.slice(2);

async function main() {
  switch (cmd) {
    case "info":
      console.log("KaneAI agent runtime");
      console.log("  network:", config.network, `(chainId ${chain.id})`);
      console.log("  attribution tag:", ATTRIBUTION_TAG);
      console.log("  factory:", config.factoryAddress ?? "(not set — deploy pending)");
      break;

    case "executor": {
      if (!arg || !isAddress(arg)) {
        console.error("usage: bun run src/cli.ts executor <ownerAddress>");
        process.exit(1);
      }
      const executor = await resolveExecutor(arg as Address);
      console.log("executor:", executor);
      break;
    }

    case "policy": {
      if (!arg || !isAddress(arg)) {
        console.error("usage: bun run src/cli.ts policy <executorAddress> [token]");
        process.exit(1);
      }
      const token = arg2 && isAddress(arg2) ? (arg2 as Address) : defaultToken();
      const p = await readTokenPolicy(arg as Address, token);
      console.log("token:", token);
      console.log(JSON.stringify(p, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2));
      break;
    }

    default:
      console.log("usage: bun run src/cli.ts <info | executor <owner> | policy <executor> [token]>");
  }
}

function defaultToken(): Address {
  const usdc = TOKENS[config.network]?.USDC;
  if (!usdc) throw new Error(`USDC not configured for network ${config.network}`);
  return usdc.address;
}

main();
