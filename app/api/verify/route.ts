import { getWalletAnalytics } from "@/lib/analytics-data";
import { getTrackedWallet } from "@/lib/snapshot";
import { runChecks } from "@/lib/verify";

/** The same consistency checks as `npm run verify`, for a hosted instance. Plain text. */
export async function GET(): Promise<Response> {
  const wallet = getTrackedWallet();
  if (!wallet) return new Response("TRACKED_WALLET is not set.", { status: 400 });
  try {
    const report = runChecks(await getWalletAnalytics(wallet));
    return new Response(report.lines.join("\n") + "\n", { status: report.failures ? 500 : 200, headers: { "content-type": "text/plain; charset=utf-8" } });
  } catch (err) {
    console.error("Verify failed:", err);
    return new Response("Couldn't run checks.\n", { status: 500 });
  }
}
