import { getDb } from "./db";
import { analyzePortfolio, analyzePosition, summarizeHistory, type Interval, type PositionRow, type SnapshotRow } from "./analytics";
import { getIntervalMinutes } from "./snapshot";
import { dailyVolatility } from "./volatility";
import type { PositionAnalytics, WalletAnalytics } from "./types";

const CLOSED_LIMIT = 20;

/** Load snapshots for a wallet and compute all analytics. */
export async function getWalletAnalytics(wallet: string, nowMs = Date.now()): Promise<WalletAnalytics> {
  const db = await getDb();
  const [positionsRes, snapshotsRes, runsRes] = await db.batch(
    [
      { sql: `SELECT * FROM positions WHERE wallet = ? ORDER BY first_seen_at`, args: [wallet] },
      {
        // raw_json is deliberately left out; it is large and not needed here.
        sql: `SELECT taken_at, position_id, price_a, amount_a, amount_b, usd_value,
                     fee_amount_a, fee_amount_b, fee_usd, reward_usd, liquidity, price_lower, price_upper
              FROM snapshots WHERE wallet = ? ORDER BY taken_at`,
        args: [wallet],
      },
      { sql: `SELECT finished_at FROM snapshot_runs WHERE wallet = ? AND status = 'ok' ORDER BY finished_at`, args: [wallet] },
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
    openedAt: r.opened_at == null ? null : String(r.opened_at),
    entryAmountA: r.entry_amount_a == null ? null : Number(r.entry_amount_a),
    entryAmountB: r.entry_amount_b == null ? null : Number(r.entry_amount_b),
    deposits: parseDeposits(r.deposits_json),
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

  const runTimes = runsRes.rows.map((r) => new Date(String(r.finished_at)).getTime() / 1000);
  const trackingStartedAt = runsRes.rows.length ? String(runsRes.rows[0].finished_at) : (rows[0]?.takenAt ?? new Date(nowMs).toISOString());
  const now = nowMs / 1000;
  // Realised volatility from the price recorded with every snapshot.
  const pricePoints = rows.map((r) => ({ t: new Date(r.takenAt).getTime() / 1000, price: r.priceA }));
  const vol24 = dailyVolatility(pricePoints, 24 * 3600, now);
  const vol7d = dailyVolatility(pricePoints, 7 * 24 * 3600, now);
  const dailyVol = vol24?.dailyVol ?? vol7d?.dailyVol ?? null;
  const analyzeOpts = { trackingStartedAt, now, runTimes, intervalSeconds: getIntervalMinutes() * 60, dailyVol };

  const open: PositionAnalytics[] = [];
  const closed: PositionAnalytics[] = [];
  const intervals: Interval[][] = [];
  const openIntervals: Interval[][] = [];
  const openIds = new Set<string>();
  for (const p of positions) {
    const result = analyzePosition(p, byPosition.get(p.positionId) ?? [], analyzeOpts);
    if (!result) continue;
    intervals.push(result.intervals);
    if (p.closedAt) {
      closed.push(result.analytics);
    } else {
      open.push(result.analytics);
      openIntervals.push(result.intervals);
      openIds.add(p.positionId);
    }
  }
  open.sort((a, b) => b.lastUsdValue - a.lastUsdValue);
  closed.sort((a, b) => (b.closedAt ?? "").localeCompare(a.closedAt ?? ""));

  // Expected cost of the open set: capital-weighted across open positions.
  const openPortfolio = analyzePortfolio(openIntervals, rows.filter((r) => openIds.has(r.positionId)), now);
  const weighted = open.filter((a) => a.expectedCostPerDay != null);
  const weight = weighted.reduce((s, a) => s + a.lastUsdValue, 0);
  openPortfolio.expectedCostPerDay = weight > 0 ? weighted.reduce((s, a) => s + a.expectedCostPerDay! * a.lastUsdValue, 0) / weight : null;

  return {
    wallet,
    asOf: rows.length ? rows[rows.length - 1].takenAt : null,
    open,
    closed: closed.slice(0, CLOSED_LIMIT),
    openPortfolio,
    portfolio: analyzePortfolio(intervals, rows, now),
    market: { dailyVol24h: vol24?.dailyVol ?? null, dailyVol7d: vol7d?.dailyVol ?? null, points: pricePoints.length },
    history: summarizeHistory(closed),
  };
}

function parseDeposits(json: unknown): PositionRow["deposits"] {
  if (typeof json !== "string") return null;
  try {
    const list = JSON.parse(json);
    return Array.isArray(list)
      ? list.map((d) => ({ at: String(d.at), amountA: Number(d.amountA ?? 0), amountB: Number(d.amountB ?? 0) }))
      : null;
  } catch {
    return null;
  }
}
