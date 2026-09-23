import { getIntervalMinutes, getTrackedWallet, takeSnapshot } from "./snapshot";

// Guard on globalThis so dev-mode reloads don't start a second timer.
const globalForTracker = globalThis as unknown as { __trackerTimer?: NodeJS.Timeout };

/**
 * Start the background snapshot loop for TRACKED_WALLET. Takes one snapshot
 * immediately, then one every SNAPSHOT_INTERVAL_MINUTES while the server runs.
 */
export function startTracker(): void {
  if (globalForTracker.__trackerTimer) return;

  const wallet = getTrackedWallet();
  if (!wallet) {
    console.log("[tracker] TRACKED_WALLET not set; snapshots disabled.");
    return;
  }
  const minutes = getIntervalMinutes();
  console.log(`[tracker] snapshotting ${wallet} every ${minutes} min`);

  const run = async () => {
    try {
      const s = await takeSnapshot(wallet);
      console.log(
        `[tracker] run #${s.runId}: ${s.positionsFound} open, ${s.positionsFailed} failed, ${s.positionsClosed} closed` +
          (s.historyLookups ? `, ${s.historyLookups} open tx found` : "") +
          (s.ledgerAdded ? `, ${s.ledgerAdded} ledger tx added` : ""),
      );
    } catch (err) {
      console.error("[tracker] snapshot failed:", err instanceof Error ? err.message : err);
    }
  };

  void run();
  const timer = setInterval(run, minutes * 60 * 1000);
  timer.unref(); // never keep the process alive on its own
  globalForTracker.__trackerTimer = timer;
}
