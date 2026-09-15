import { getDb } from "./db";
import { analyzePortfolio, analyzePosition, type Interval, type PositionRow, type SnapshotRow } from "./analytics";
import type { PositionAnalytics, WalletAnalytics } from "./types";

const CLOSED_LIMIT = 20;

/** Load snapshots for a wallet and compute all analytics. */
export async function getWalletAnalytics(wallet: string, nowMs = Date.now()): Promise<WalletAnalytics> {
  const db = await getDb();
  const [positionsRes, snapshotsRes, firstRunRes] = await db.batch(
    [
      { sql: `SELECT * FROM positions WHERE wallet = ? ORDER BY first_seen_at`, args: [wallet] },
      {
        // raw_json is deliberately left out; it is large and not needed here.
        sql: `SELECT taken_at, position_id, price_a, amount_a, amount_b, usd_value,
                     fee_amount_a, fee_amount_b, fee_usd, reward_usd, liquidity, price_lower, price_upper
              FROM snapshots WHERE wallet = ? ORDER BY taken_at`,
        args: [wallet],
      },
      { sql: `SELECT MIN(finished_at) AS t FROM snapshot_runs WHERE wallet = ? AND status = 'ok'`, args: [wallet] },
    ],
    "read",
  );

  const positions: PositionRow[] = positionsRes.rows.map((r) => ({
    positionId: String(r.position_id),
    poolId: String(r.pool_id),
    poolName: String(r.pool_name),
    symbolA: String(r.symbol_a),
    symbolB: String(r.symbol_b),
    decimalsA: r.decimals_a == null ? null : Number(r.decimals_a),
    decimalsB: r.decimals_b == null ? null : Number(r.decimals_b),
    firstSeenAt: String(r.first_seen_at),
    lastSeenAt: String(r.last_seen_at),
    closedAt: r.closed_at == null ? null : String(r.closed_at),
  }));

  const rows: SnapshotRow[] = snapshotsRes.rows.map((r) => ({
    takenAt: String(r.taken_at),
    positionId: String(r.position_id),
    priceA: Number(r.price_a),
    amountA: Number(r.amount_a),
    amountB: Number(r.amount_b),
    usdValue: Number(r.usd_value),
    feeAmountA: Number(r.fee_amount_a),
    feeAmountB: Number(r.fee_amount_b),
    feeUsd: Number(r.fee_usd),
    rewardUsd: Number(r.reward_usd),
    liquidity: r.liquidity == null ? null : String(r.liquidity),
    priceLower: r.price_lower == null ? null : Number(r.price_lower),
    priceUpper: r.price_upper == null ? null : Number(r.price_upper),
  }));

  const byPosition = new Map<string, SnapshotRow[]>();
  for (const r of rows) {
    const list = byPosition.get(r.positionId) ?? [];
    list.push(r);
    byPosition.set(r.positionId, list);
  }

  const trackingStartedAt = (firstRunRes.rows[0]?.t as string | null) ?? rows[0]?.takenAt ?? new Date(nowMs).toISOString();
  const now = nowMs / 1000;

  const open: PositionAnalytics[] = [];
  const closed: PositionAnalytics[] = [];
  const intervals: Interval[][] = [];
  for (const p of positions) {
    const result = analyzePosition(p, byPosition.get(p.positionId) ?? [], { trackingStartedAt, now });
    if (!result) continue;
    intervals.push(result.intervals);
    (p.closedAt ? closed : open).push(result.analytics);
  }
  open.sort((a, b) => b.lastUsdValue - a.lastUsdValue);
  closed.sort((a, b) => (b.closedAt ?? "").localeCompare(a.closedAt ?? ""));

  return {
    wallet,
    asOf: rows.length ? rows[rows.length - 1].takenAt : null,
    open,
    closed: closed.slice(0, CLOSED_LIMIT),
    portfolio: analyzePortfolio(intervals, rows, now),
  };
}
