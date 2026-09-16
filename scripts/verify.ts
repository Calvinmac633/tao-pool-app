/**
 * Consistency checks over the live tracker database. Run with `npm run verify`.
 * Exits non-zero if any check fails.
 */
import { readFileSync } from "node:fs";
import { getWalletAnalytics } from "../lib/analytics-data";
import { getTrackedWallet } from "../lib/snapshot";
import type { PositionAnalytics } from "../lib/types";

// Load .env.local the way Next does, without overriding real env vars.
try {
  for (const line of readFileSync(".env.local", "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
} catch {
  // no .env.local; rely on the environment
}

const f = (n: number) => n.toFixed(2);
let failures = 0;
function check(name: string, ok: boolean, detail: string) {
  if (!ok) failures++;
  console.log(`  ${ok ? "OK  " : "FAIL"} ${name}: ${detail}`);
}

function checkPosition(a: PositionAnalytics) {
  console.log(`${a.closedAt ? "closed" : "open  "} ${a.positionId.slice(0, 8)} ${a.poolName}  value ${f(a.lastUsdValue)}  price ${f(a.lastPrice)}`);

  // Everything that ever showed as uncollected is either still uncollected or was collected.
  const lhs = a.lastUncollectedUsd + a.collectedUsd;
  const rhs = a.baselineUncollectedUsd + a.lifetime.earnedUsd;
  check("fee reconciliation", Math.abs(lhs - rhs) < 0.05, `uncollected ${f(a.lastUncollectedUsd)} + collected ${f(a.collectedUsd)} = ${f(lhs)} vs baseline ${f(a.baselineUncollectedUsd)} + earned ${f(a.lifetime.earnedUsd)} = ${f(rhs)}`);

  // APR is earned over time-weighted capital, annualised over the covered time.
  const w = a.closedAt ? a.lifetime : a.windows["24h"];
  if (w && w.apr != null && w.avgCapitalUsd > 0 && w.coveredSeconds > 0) {
    const hand = (w.earnedUsd / w.avgCapitalUsd) * ((365 * 86400) / w.coveredSeconds);
    check("APR recomputed", Math.abs(hand - w.apr) < 1e-9, `${f(w.earnedUsd)} / ${f(w.avgCapitalUsd)} over ${(w.coveredSeconds / 3600).toFixed(1)}h -> ${(hand * 100).toFixed(1)}% (app ${(w.apr * 100).toFixed(1)}%)`);
  }

  // Impermanent loss can never favour the LP; allow a little API pricing noise.
  const tol = Math.max(1, a.lastUsdValue * 0.001);
  check("IL not positive", a.ilUsd <= tol, `IL ${f(a.ilUsd)} (${(a.ilPct * 100).toFixed(2)}%), entry ${a.entry.source}${a.entry.adjustments ? `, ${a.entry.adjustments} adjustment(s)` : ""}`);
  if (a.projections) {
    const { entry, lower, upper, current } = a.projections;
    check("bound projections not positive", lower.ilUsd <= tol && upper.ilUsd <= tol, `lower ${f(lower.ilUsd)}, upper ${f(upper.ilUsd)}`);
    check("headline IL matches projection", Math.abs(a.ilUsd - current.ilUsd) < 0.01, `headline ${f(a.ilUsd)}, now-row ${f(current.ilUsd)}`);
    if (entry && a.entry.history.length === 1) {
      check("IL is zero at the entry price", Math.abs(entry.ilUsd) < tol, `${f(entry.ilUsd)} at ${f(entry.price)}`);
    }
  }
  check("net = IL + fees", Math.abs(a.netUsd - (a.ilUsd + a.lifetime.earnedUsd)) < 0.01, `${f(a.netUsd)} = ${f(a.ilUsd)} + ${f(a.lifetime.earnedUsd)}`);
}

async function main() {
  const wallet = process.argv[2] ?? getTrackedWallet();
  if (!wallet) {
    console.error("Pass a wallet address or set TRACKED_WALLET.");
    process.exit(2);
  }
  const d = await getWalletAnalytics(wallet);
  console.log(`wallet ${wallet}, as of ${d.asOf}, ${d.open.length} open, ${d.closed.length} closed shown\n`);
  for (const a of [...d.open, ...d.closed]) checkPosition(a);

  console.log("portfolio");
  const sum24 = d.open.reduce((s, a) => s + (a.windows["24h"]?.earnedUsd ?? 0), 0);
  check("open positions' 24h fees <= portfolio 24h", sum24 <= d.portfolio.windows["24h"].earnedUsd + 0.01, `${f(sum24)} <= ${f(d.portfolio.windows["24h"].earnedUsd)} (closed positions account for the rest)`);
  const capital = d.open.reduce((s, a) => s + a.lastUsdValue, 0);
  check("current capital = sum of open values", Math.abs(capital - d.portfolio.currentCapitalUsd) < 0.01, `${f(capital)} vs ${f(d.portfolio.currentCapitalUsd)}`);

  console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
