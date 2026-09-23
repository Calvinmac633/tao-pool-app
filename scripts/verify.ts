/**
 * Consistency checks over the live tracker database. Run with `npm run verify`.
 * Exits non-zero if any check fails.
 */
import { readFileSync } from "node:fs";
import { getWalletAnalytics } from "../lib/analytics-data";
import { getTrackedWallet } from "../lib/snapshot";
import { runChecks } from "../lib/verify";

// Load .env.local the way Next does, without overriding real env vars.
try {
  for (const line of readFileSync(".env.local", "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
} catch {
  // no .env.local; rely on the environment
}

async function main() {
  const wallet = process.argv[2] ?? getTrackedWallet();
  if (!wallet) {
    console.error("Pass a wallet address or set TRACKED_WALLET.");
    process.exit(2);
  }
  const report = runChecks(await getWalletAnalytics(wallet));
  console.log(report.lines.join("\n"));
  process.exit(report.failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
