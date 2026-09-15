import { PublicKey } from "@solana/web3.js";
import { getWalletAnalytics } from "@/lib/analytics-data";
import { getTrackedWallet } from "@/lib/snapshot";

/** Analytics computed from stored snapshots. Defaults to the tracked wallet. */
export async function GET(request: Request): Promise<Response> {
  const raw = new URL(request.url).searchParams.get("wallet")?.trim() || getTrackedWallet() || "";
  let wallet: string;
  try {
    wallet = new PublicKey(raw).toBase58();
  } catch {
    return Response.json({ error: "That doesn't look like a valid Solana address." }, { status: 400 });
  }
  try {
    return Response.json(await getWalletAnalytics(wallet));
  } catch (err) {
    console.error("Failed to compute analytics:", err);
    return Response.json({ error: "Couldn't read tracking data." }, { status: 500 });
  }
}
