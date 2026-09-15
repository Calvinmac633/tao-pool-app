import { PublicKey } from "@solana/web3.js";
import type { InStatement } from "@libsql/client";
import { getDb } from "./db";
import { fetchWalletPositions } from "./raydium";
import type { SnapshotSummary, TrackingStatus } from "./types";

export const DEFAULT_INTERVAL_MINUTES = 15;

export function getTrackedWallet(): string | null {
  const raw = process.env.TRACKED_WALLET?.trim();
  if (!raw) return null;
  // Normalise so comparisons against user input are exact.
  return new PublicKey(raw).toBase58();
}

export function getIntervalMinutes(): number {
  const n = Number(process.env.SNAPSHOT_INTERVAL_MINUTES);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_INTERVAL_MINUTES;
}

/**
 * Record one snapshot of every open position for a wallet.
 *
 * Writes a snapshot_runs row, one snapshots row per open position, upserts
 * the positions registry, and marks positions that are no longer open as
 * closed. A position whose Raydium request failed this run is left alone
 * rather than being marked closed.
 */
export async function takeSnapshot(walletAddress: string): Promise<SnapshotSummary> {
  const wallet = new PublicKey(walletAddress).toBase58();
  const db = await getDb();
  const startedAt = new Date().toISOString();

  const runInsert = await db.execute({
    sql: `INSERT INTO snapshot_runs (wallet, started_at, status) VALUES (?, ?, 'running')`,
    args: [wallet, startedAt],
  });
  const runId = Number(runInsert.lastInsertRowid);

  let result;
  try {
    result = await fetchWalletPositions(new PublicKey(wallet));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db.execute({
      sql: `UPDATE snapshot_runs SET finished_at = ?, status = 'failed', error = ? WHERE id = ?`,
      args: [new Date().toISOString(), message, runId],
    });
    throw err;
  }

  const takenAt = new Date().toISOString();
  const statements: InStatement[] = [];

  for (const { position: p, raw } of result.positions) {
    statements.push({
      sql: `INSERT INTO snapshots (
              run_id, taken_at, wallet, position_id, pool_id, price_a,
              amount_a, amount_b, usd_value, fee_amount_a, fee_amount_b, fee_usd,
              reward_usd, rewards_json, raw_json,
              tick_lower, tick_upper, liquidity, price_lower, price_upper, in_range
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        runId, takenAt, wallet, p.positionId, p.poolId, p.priceA,
        p.amountA, p.amountB, p.usdValue, p.unclaimedFeeAmountA, p.unclaimedFeeAmountB, p.unclaimedFeeUsd,
        p.unclaimedRewardUsd, JSON.stringify(p.rewards), JSON.stringify(raw),
        p.tickLower, p.tickUpper, p.liquidity, p.priceLower, p.priceUpper, p.inRange ? 1 : 0,
      ],
    });
    statements.push({
      sql: `INSERT INTO positions (
              position_id, wallet, pool_id, pool_name, symbol_a, symbol_b,
              first_seen_at, last_seen_at, closed_at, decimals_a, decimals_b
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
            ON CONFLICT (position_id) DO UPDATE SET
              last_seen_at = excluded.last_seen_at,
              closed_at = NULL,
              decimals_a = excluded.decimals_a,
              decimals_b = excluded.decimals_b`,
      args: [p.positionId, wallet, p.poolId, p.poolName, p.symbolA, p.symbolB, takenAt, takenAt, p.decimalsA, p.decimalsB],
    });
  }

  // Anything previously open that wasn't found this run (and didn't merely
  // fail to fetch) has been closed.
  const keep = [...result.positions.map((r) => r.position.positionId), ...result.failedPositionIds];
  const notIn = keep.length ? `AND position_id NOT IN (${keep.map(() => "?").join(", ")})` : "";
  statements.push({
    sql: `UPDATE positions SET closed_at = ? WHERE wallet = ? AND closed_at IS NULL ${notIn}`,
    args: [takenAt, wallet, ...keep],
  });

  statements.push({
    sql: `UPDATE snapshot_runs SET finished_at = ?, status = 'ok', positions_found = ? WHERE id = ?`,
    args: [takenAt, result.positions.length, runId],
  });

  const outcomes = await db.batch(statements, "write");
  const closedCount = Number(outcomes[outcomes.length - 2]?.rowsAffected ?? 0);

  return {
    runId,
    wallet,
    takenAt,
    positionsFound: result.positions.length,
    positionsFailed: result.failedPositionIds.length,
    positionsClosed: closedCount,
  };
}

export async function getTrackingStatus(): Promise<TrackingStatus> {
  const trackedWallet = getTrackedWallet();
  const status: TrackingStatus = {
    trackedWallet,
    intervalMinutes: getIntervalMinutes(),
    runs: 0,
    firstRunAt: null,
    lastRunAt: null,
    lastStatus: null,
    lastError: null,
    openPositions: 0,
  };
  if (!trackedWallet) return status;

  const db = await getDb();
  const [okRuns, lastRun, open] = await db.batch(
    [
      {
        sql: `SELECT COUNT(*) AS runs, MIN(finished_at) AS first_run, MAX(finished_at) AS last_run
              FROM snapshot_runs WHERE wallet = ? AND status = 'ok'`,
        args: [trackedWallet],
      },
      {
        sql: `SELECT status, error FROM snapshot_runs
              WHERE wallet = ? AND status != 'running' ORDER BY id DESC LIMIT 1`,
        args: [trackedWallet],
      },
      {
        sql: `SELECT COUNT(*) AS n FROM positions WHERE wallet = ? AND closed_at IS NULL`,
        args: [trackedWallet],
      },
    ],
    "read",
  );

  const runsRow = okRuns.rows[0];
  status.runs = Number(runsRow?.runs ?? 0);
  status.firstRunAt = (runsRow?.first_run as string | null) ?? null;
  status.lastRunAt = (runsRow?.last_run as string | null) ?? null;
  const last = lastRun.rows[0];
  status.lastStatus = (last?.status as "ok" | "failed" | undefined) ?? null;
  status.lastError = (last?.error as string | null) ?? null;
  status.openPositions = Number(open.rows[0]?.n ?? 0);
  return status;
}
