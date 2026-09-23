import { resetHistory } from "@/lib/reset";
import { getTrackedWallet, takeSnapshot } from "@/lib/snapshot";

/** Erase all tracked history, then take a fresh first snapshot. */
export async function POST(): Promise<Response> {
  try {
    await resetHistory();
    const wallet = getTrackedWallet();
    const snapshot = wallet ? await takeSnapshot(wallet).catch((err) => { console.error("Snapshot after reset failed:", err); return null; }) : null;
    return Response.json({ ok: true, positionsFound: snapshot?.positionsFound ?? 0 });
  } catch (err) {
    console.error("Reset failed:", err);
    return Response.json({ error: "Couldn't reset the history." }, { status: 500 });
  }
}
