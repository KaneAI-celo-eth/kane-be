// Minimal CLI for the KaneAI agent. Grows into: create-vault, provision, intent, status.

import { type Address, isAddress } from "viem";
import { ATTRIBUTION_TAG, config } from "./config";
import { chain } from "./chain";
import { readPolicy } from "./vault";

const [cmd, arg] = process.argv.slice(2);

async function main() {
  switch (cmd) {
    case "info":
      console.log("KaneAI agent runtime");
      console.log("  network:", config.network, `(chainId ${chain.id})`);
      console.log("  attribution tag:", ATTRIBUTION_TAG);
      console.log("  vault:", config.vaultAddress ?? "(not set)");
      break;

    case "policy": {
      const vault = arg ?? config.vaultAddress;
      if (!vault || !isAddress(vault)) {
        console.error("usage: bun run src/cli.ts policy <vaultAddress>");
        process.exit(1);
      }
      const p = await readPolicy(vault as Address);
      console.log(JSON.stringify(p, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2));
      break;
    }

    default:
      console.log("usage: bun run src/cli.ts <info|policy [vault]>");
  }
}

main();
