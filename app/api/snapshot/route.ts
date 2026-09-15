import { getTrackedWallet, getTrackingStatus, takeSnapshot } from "@/lib/snapshot";

/** Tracking status for the configured wallet. */
export async function GET(): Promise<Response> {
  try {
    return Response.json(await getTrackingStatus());
  } catch (err) {
    console.error("Failed to read tracking status:", err);
    return Response.json({ error: "Couldn't read tracking status." }, { status: 500 });
  }
}

/** Take a snapshot of the configured wallet right now. */
export async function POST(): Promise<Response> {
  const wallet = getTrackedWallet();
  if (!wallet) {
    return Response.json({ error: "TRACKED_WALLET is not set." }, { status: 400 });
  }
  try {
    return Response.json(await takeSnapshot(wallet));
  } catch (err) {
    console.error("Manual snapshot failed:", err);
    return Response.json({ error: "Couldn't reach the network. Try again." }, { status: 502 });
  }
}
