import { getDb } from "./db";
import { analyzePortfolio, analyzePosition, summarizeHistory, type Interval, type PositionRow, type SnapshotRow } from "./analytics";
import { getIntervalMinutes } from "./snapshot";
import { dailyVolatility } from "./volatility";
import { groupRolls, reconcile, totalValueB, type RunTotals } from "./ledger-analytics";
import type { LedgerAnalytics, LedgerEntry } from "./types";
import type { PositionAnalytics, WalletAnalytics } from "./types";

const CLOSED_LIMIT = 20;

/** Load snapshots for a wallet and compute all analytics. */
export async function getWalletAnalytics(wallet: string, nowMs = Date.now()): Promise<WalletAnalytics> {
  const db = await getDb();
  const [positionsRes, snapshotsRes, runsRes, ledgerRes, ledgerStateRes] = await db.batch(
    [
      { sql: `SELECT * FROM positions WHERE wallet = ? ORDER BY first_seen_at`, args: [wallet] },
      {
        // raw_json is deliberately left out; it is large and not needed here.
        sql: `SELECT taken_at, position_id, price_a, amount_a, amount_b, usd_value,
                     fee_amount_a, fee_amount_b, fee_usd, reward_usd, liquidity, price_lower, price_upper
              FROM snapshots WHERE wallet = ? ORDER BY taken_at`,
        args: [wallet],
      },
      { sql: `SELECT finished_at, free_amount_a, free_amount_b, positions_failed FROM snapshot_runs WHERE wallet = ? AND status = 'ok' ORDER BY finished_at`, args: [wallet] },
      { sql: `SELECT signature, block_time, kind, note, position_id, delta_a, delta_b, others_json, price_a, swap_cost_b FROM wallet_txs WHERE wallet = ? ORDER BY block_time`, args: [wallet] },
      { sql: `SELECT backfill_done FROM ledger_state WHERE wallet = ?`, args: [wallet] },
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
    historyWithdrawals: r.history_withdrawals == null ? null : Number(r.history_withdrawals),
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

  // ---- Ledger: holdings per run, reconciliation, rolls ----
  const byRun = new Map<number, SnapshotRow[]>();
  for (const r of rows) {
    const t = new Date(r.takenAt).getTime() / 1000;
    byRun.set(t, [...(byRun.get(t) ?? []), r]);
  }
  const runTotals: RunTotals[] = [];
  for (const r of runsRes.rows) {
    if (r.free_amount_a == null || r.free_amount_b == null) continue; // before balances were recorded
    if (Number(r.positions_failed ?? 0) > 0) continue; // a position was missing from this run's totals
    const t = new Date(String(r.finished_at)).getTime() / 1000;
    const snaps = byRun.get(t) ?? [];
    const price = snaps[0]?.priceA ?? runTotals[runTotals.length - 1]?.price;
    if (price == null) continue;
    runTotals.push({
      t, price,
      posA: snaps.reduce((s, x) => s + x.amountA, 0), posB: snaps.reduce((s, x) => s + x.amountB, 0),
      feeA: snaps.reduce((s, x) => s + x.feeAmountA, 0), feeB: snaps.reduce((s, x) => s + x.feeAmountB, 0),
      freeA: Number(r.free_amount_a), freeB: Number(r.free_amount_b),
    });
  }

  // Name position transactions: the first deposit of a position is its open,
  // the last withdrawal of a closed position is its close, the rest are adds
  // and withdrawals or collections.
  const posById = new Map(positions.map((p) => [p.positionId, p]));
  const firstDeposit = new Map<string, string>();
  const lastWithdraw = new Map<string, string>();
  for (const r of ledgerRes.rows) {
    if (r.kind !== "position" || r.position_id == null) continue;
    const pid = String(r.position_id), sig = String(r.signature);
    if (r.note === "deposit" && !firstDeposit.has(pid)) firstDeposit.set(pid, sig); // rows are in time order
    if (r.note === "withdraw") lastWithdraw.set(pid, sig);
  }
  const ledger: LedgerEntry[] = ledgerRes.rows.map((r) => {
    let note = String(r.note ?? "");
    const pid = r.position_id == null ? null : String(r.position_id);
    if (r.kind === "position" && pid) {
      const sig = String(r.signature);
      if (note === "deposit") note = firstDeposit.get(pid) === sig ? "open" : "add";
      else if (note === "withdraw") note = posById.get(pid)?.closedAt && lastWithdraw.get(pid) === sig ? "close" : "withdraw or collect";
    }
    return {
      signature: String(r.signature),
      at: String(r.block_time),
      kind: String(r.kind) as LedgerEntry["kind"],
      note,
      positionId: pid,
      deltaA: Number(r.delta_a),
      deltaB: Number(r.delta_b),
      others: safeJson(r.others_json),
      priceA: r.price_a == null ? null : Number(r.price_a),
      swapCostB: r.swap_cost_b == null ? null : Number(r.swap_cost_b),
    };
  });

  const lastRun = runTotals[runTotals.length - 1];
  const cadence = getIntervalMinutes() * 60;
  const reconciliations = [
    reconcile("24h", runTotals, byRun, ledger, now - 24 * 3600, now, cadence),
    reconcile("7d", runTotals, byRun, ledger, now - 7 * 24 * 3600, now, cadence),
    runTotals.length ? reconcile("Since balances were first recorded", runTotals, byRun, ledger, runTotals[0].t, now, cadence) : null,
  ].filter((x): x is NonNullable<typeof x> => x != null);

  const ledgerAnalytics: LedgerAnalytics = {
    holdings: lastRun
      ? { at: new Date(lastRun.t * 1000).toISOString(), priceA: lastRun.price, posA: lastRun.posA, posB: lastRun.posB, feeA: lastRun.feeA, feeB: lastRun.feeB, freeA: lastRun.freeA, freeB: lastRun.freeB, totalValueB: totalValueB(lastRun) }
      : null,
    reconciliations,
    rolls: groupRolls(ledger).slice(0, 20),
    recent: [...ledger].reverse().slice(0, 40),
    unclassified: ledger.filter((e) => e.kind === "unclassified").reverse(),
    txCount: ledger.length,
    backfillDone: Number(ledgerStateRes.rows[0]?.backfill_done ?? 0) === 1,
  };

  return {
    wallet,
    asOf: rows.length ? rows[rows.length - 1].takenAt : null,
    open,
    closed: closed.slice(0, CLOSED_LIMIT),
    openPortfolio,
    portfolio: analyzePortfolio(intervals, rows, now),
    market: { dailyVol24h: vol24?.dailyVol ?? null, dailyVol7d: vol7d?.dailyVol ?? null, points: pricePoints.length },
    history: summarizeHistory(closed),
    ledger: ledgerAnalytics,
  };
}

function safeJson(v: unknown): { mint: string; delta: number }[] {
  try {
    const list = JSON.parse(String(v ?? "[]"));
    return Array.isArray(list) ? list.map((o) => ({ mint: String(o.mint), delta: Number(o.delta) })) : [];
  } catch {
    return [];
  }
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
