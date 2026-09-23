import { getDb } from "./db";

/** Erase every tracked record: positions, snapshots, runs, and the ledger. Cannot be undone. */
export async function resetHistory(): Promise<void> {
  const db = await getDb();
  await db.batch(
    ["DELETE FROM snapshots", "DELETE FROM positions", "DELETE FROM snapshot_runs", "DELETE FROM wallet_txs", "DELETE FROM ledger_state"],
    "write",
  );
}
