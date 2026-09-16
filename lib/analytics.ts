/**
 * Pure analytics over stored snapshots: fee earnings, rolling APRs,
 * impermanent loss, projections at the range bounds, and portfolio totals.
 * No I/O here so everything is unit-testable.
 */
import { amountsAtPrice, impermanentLossAt, type Amounts, type Range } from "./clmm-math";
import type { PortfolioAnalytics, PositionAnalytics, Projection, WindowStats } from "./types";

export type SnapshotRow = {
  takenAt: string; // ISO
  positionId: string;
  priceA: number;
  amountA: number;
  amountB: number;
  usdValue: number;
  feeAmountA: number;
  feeAmountB: number;
  feeUsd: number;
  rewardUsd: number;
  liquidity: string | null;
  priceLower: number | null;
  priceUpper: number | null;
};

export type PositionRow = {
  positionId: string;
  poolId: string;
  poolName: string;
  symbolA: string;
  symbolB: string;
  decimalsA: number | null;
  decimalsB: number | null;
  firstSeenAt: string;
  lastSeenAt: string;
  closedAt: string | null;
  openedAt: string | null; // from the open transaction, when found
  entryAmountA: number | null; // deposited at open, when found
  entryAmountB: number | null;
};

export const WINDOWS: Record<string, number> = {
  "1h": 3600,
  "6h": 6 * 3600,
  "24h": 24 * 3600,
  "7d": 7 * 24 * 3600,
};

const SECONDS_PER_YEAR = 365 * 24 * 3600;

/** One stretch between consecutive snapshots of a position. */
export type Interval = {
  start: number; // epoch seconds
  end: number;
  earnedUsd: number; // fees + rewards accrued during the interval
  capitalUsd: number; // position value at the start of the interval
};

const toSec = (iso: string) => new Date(iso).getTime() / 1000;

/**
 * USD price of one unit of token B implied by a snapshot. The API values the
 * whole position in USD and prices A in B, so usd / (A*price + B) gives it.
 * Falls back to the fee valuation, then to 1 (B is usually a stablecoin).
 */
export function usdPerB(row: SnapshotRow): number {
  const positionB = row.amountA * row.priceA + row.amountB;
  if (positionB > 0 && row.usdValue > 0) return row.usdValue / positionB;
  const feeB = row.feeAmountA * row.priceA + row.feeAmountB;
  if (feeB > 0 && row.feeUsd > 0) return row.feeUsd / feeB;
  return 1;
}

/**
 * Fees and rewards earned between two consecutive snapshots. A drop in the
 * uncollected amount means a collection happened, in which case everything
 * showing now accrued since that collection.
 */
function earnedBetween(prev: SnapshotRow, cur: SnapshotRow): { usd: number; collectedUsd: number } {
  const dA = cur.feeAmountA - prev.feeAmountA;
  const dB = cur.feeAmountB - prev.feeAmountB;
  const collected = dA < -1e-12 || dB < -1e-12;
  const earnedA = collected ? cur.feeAmountA : Math.max(0, dA);
  const earnedB = collected ? cur.feeAmountB : Math.max(0, dB);
  const feeUsd = (earnedA * cur.priceA + earnedB) * usdPerB(cur);

  const dR = cur.rewardUsd - prev.rewardUsd;
  const rewardUsd = dR < -1e-9 ? cur.rewardUsd : Math.max(0, dR);

  const collectedUsd = collected ? (prev.feeAmountA * prev.priceA + prev.feeAmountB) * usdPerB(prev) : 0;
  return { usd: feeUsd + rewardUsd, collectedUsd };
}

/** Aggregate intervals that overlap [from, to], pro-rating partial overlaps. */
export function windowStats(intervals: Interval[], from: number, to: number): WindowStats {
  let earnedUsd = 0;
  let capitalTime = 0;
  let covered = 0;
  for (const iv of intervals) {
    const overlapStart = Math.max(iv.start, from);
    const overlapEnd = Math.min(iv.end, to);
    const overlap = overlapEnd - overlapStart;
    const length = iv.end - iv.start;
    if (length <= 0) {
      // Zero-length interval (a position's first snapshot): count its
      // earnings if it falls inside the window, no capital-time.
      if (iv.end >= from && iv.end <= to) earnedUsd += iv.earnedUsd;
      continue;
    }
    if (overlap <= 0) continue;
    const frac = overlap / length;
    earnedUsd += iv.earnedUsd * frac;
    capitalTime += iv.capitalUsd * overlap;
    covered += overlap;
  }
  const avgCapitalUsd = covered > 0 ? capitalTime / covered : 0;
  const apr = covered > 0 && avgCapitalUsd > 0 ? (earnedUsd / avgCapitalUsd) * (SECONDS_PER_YEAR / covered) : null;
  return { earnedUsd, avgCapitalUsd, coveredSeconds: covered, apr };
}

type AnalyzeOptions = {
  trackingStartedAt: string; // first successful run for the wallet
  now: number; // epoch seconds
  runTimes?: number[]; // epoch seconds of every successful run for the wallet, ascending
  intervalSeconds?: number; // configured snapshot interval
};

const DEFAULT_INTERVAL_SECONDS = 300;
const RUN_TOLERANCE_SECONDS = 60;

/**
 * Decide how old the fees showing at a position's first snapshot are.
 * Returns the time they started accruing, or null if unknown (in which case
 * they are excluded from earnings rather than inflating the rate).
 *
 * - Opened after the previous run (known from the open transaction): the
 *   fees accrued since the open, so they count over that exact time.
 * - No open time known but the previous run was recent: the position opened
 *   somewhere in between; assume the earliest moment, which is conservative.
 * - Anything else (first ever run, or a tracking gap the open falls inside):
 *   unknown age.
 */
function feeAgeStart(position: PositionRow, firstSec: number, opts: AnalyzeOptions): number | null {
  const prevRun = (opts.runTimes ?? []).filter((t) => t < firstSec - 1).pop();
  if (prevRun === undefined) return null;
  if (position.openedAt) {
    const openedSec = toSec(position.openedAt);
    return openedSec >= prevRun - RUN_TOLERANCE_SECONDS ? Math.min(openedSec, firstSec) : null;
  }
  const interval = opts.intervalSeconds ?? DEFAULT_INTERVAL_SECONDS;
  return firstSec - prevRun <= interval * 2 + RUN_TOLERANCE_SECONDS ? prevRun : null;
}

export type PositionAnalysis = { analytics: PositionAnalytics; intervals: Interval[] };

export function analyzePosition(position: PositionRow, rowsIn: SnapshotRow[], opts: AnalyzeOptions): PositionAnalysis | null {
  const rows = [...rowsIn].sort((a, b) => toSec(a.takenAt) - toSec(b.takenAt));
  if (rows.length === 0) return null;
  const first = rows[0];
  const last = rows[rows.length - 1];
  const decimalsA = position.decimalsA ?? 0;
  const decimalsB = position.decimalsB ?? 0;

  const firstSec = toSec(first.takenAt);

  // Entry baseline for impermanent loss: the deposit from the open
  // transaction when known, else the tokens at the first snapshot. Adjusted
  // below whenever liquidity changes (an add or partial withdrawal).
  const chainEntry = position.entryAmountA != null && position.entryAmountB != null;
  let entry: Amounts = chainEntry
    ? { amountA: position.entryAmountA!, amountB: position.entryAmountB! }
    : { amountA: first.amountA, amountB: first.amountB };
  let capitalChanges = 0;

  // Fees showing at the first snapshot are only counted when we know how
  // long they took to accrue; otherwise they'd inflate the rate.
  const accrualStart = feeAgeStart(position, firstSec, opts);
  const preExisting = accrualStart === null;
  const baselineUncollectedUsd = preExisting ? first.feeUsd + first.rewardUsd : 0;

  const intervals: Interval[] = [];
  let collectedUsd = 0;
  if (accrualStart !== null) {
    const entryUsd = chainEntry ? (entry.amountA * first.priceA + entry.amountB) * usdPerB(first) : first.usdValue;
    intervals.push({
      start: accrualStart,
      end: firstSec,
      earnedUsd: (first.feeAmountA * first.priceA + first.feeAmountB) * usdPerB(first) + first.rewardUsd,
      capitalUsd: entryUsd > 0 ? entryUsd : first.usdValue,
    });
  }

  for (let i = 1; i < rows.length; i++) {
    const prev = rows[i - 1];
    const cur = rows[i];
    const { usd, collectedUsd: c } = earnedBetween(prev, cur);
    collectedUsd += c;
    intervals.push({ start: toSec(prev.takenAt), end: toSec(cur.takenAt), earnedUsd: usd, capitalUsd: prev.usdValue });

    if (cur.liquidity && prev.liquidity && cur.liquidity !== prev.liquidity && cur.priceLower && cur.priceUpper) {
      const range: Range = { priceLower: cur.priceLower, priceUpper: cur.priceUpper };
      const expected = amountsAtPrice(Number(prev.liquidity), range, cur.priceA, decimalsA, decimalsB);
      entry = { amountA: entry.amountA + (cur.amountA - expected.amountA), amountB: entry.amountB + (cur.amountB - expected.amountB) };
      capitalChanges++;
    }
  }

  const endSec = position.closedAt ? toSec(last.takenAt) : opts.now;
  const startSec = accrualStart ?? firstSec;
  const lifetime = windowStats(intervals, startSec, endSec);
  const windows: Record<string, WindowStats> = {};
  if (!position.closedAt) {
    for (const [label, seconds] of Object.entries(WINDOWS)) {
      windows[label] = windowStats(intervals, endSec - seconds, endSec);
    }
  }

  // Impermanent loss now, and projected at the range bounds.
  const usdB = usdPerB(last);
  const hodlUsd = (entry.amountA * last.priceA + entry.amountB) * usdB;
  const ilUsd = last.usdValue - hodlUsd;
  const ilPct = hodlUsd > 0 ? ilUsd / hodlUsd : 0;
  const netUsd = ilUsd + lifetime.earnedUsd;

  let projections: PositionAnalytics["projections"] = null;
  if (last.liquidity && last.priceLower && last.priceUpper) {
    const range: Range = { priceLower: last.priceLower, priceUpper: last.priceUpper };
    const L = Number(last.liquidity);
    const project = (price: number): Projection => {
      const r = impermanentLossAt(L, range, entry, price, decimalsA, decimalsB);
      return {
        price,
        amountA: r.position.amountA,
        amountB: r.position.amountB,
        positionUsd: r.positionValueB * usdB,
        hodlUsd: r.hodlValueB * usdB,
        ilUsd: r.ilB * usdB,
        ilPct: r.ilPct,
      };
    };
    projections = { lower: project(range.priceLower), current: project(last.priceA), upper: project(range.priceUpper) };
  }

  const analytics: PositionAnalytics = {
    positionId: position.positionId,
    poolId: position.poolId,
    poolName: position.poolName,
    symbolA: position.symbolA,
    symbolB: position.symbolB,
    openedAt: position.openedAt ?? first.takenAt,
    openedAtKnown: position.openedAt != null,
    closedAt: position.closedAt,
    preExisting,
    snapshots: rows.length,
    priceLower: last.priceLower,
    priceUpper: last.priceUpper,
    inRange: last.priceLower != null && last.priceUpper != null ? last.priceA >= last.priceLower && last.priceA < last.priceUpper : null,
    lastPrice: last.priceA,
    lastUsdValue: last.usdValue,
    lastUncollectedUsd: last.feeUsd + last.rewardUsd,
    baselineUncollectedUsd,
    collectedUsd,
    entry: { amountA: entry.amountA, amountB: entry.amountB, usd: hodlUsd, adjustments: capitalChanges, source: chainEntry ? "chain" : "snapshot" },
    lifetime,
    windows,
    ilUsd,
    ilPct,
    netUsd,
    projections,
  };
  return { analytics, intervals };
}

/**
 * Wallet-level earnings and capital across all positions. Capital per run is
 * the sum of open position values; earnings are attributed to the run that
 * observed them.
 */
export function analyzePortfolio(positionIntervals: Interval[][], rows: SnapshotRow[], now: number): PortfolioAnalytics {
  // Total capital at each run time.
  const capitalByRun = new Map<number, number>();
  for (const r of rows) {
    const t = toSec(r.takenAt);
    capitalByRun.set(t, (capitalByRun.get(t) ?? 0) + r.usdValue);
  }
  const runTimes = [...capitalByRun.keys()].sort((a, b) => a - b);

  // Earnings attributed to each run time, across positions.
  const earnedByRun = new Map<number, number>();
  for (const ivs of positionIntervals) {
    for (const iv of ivs) {
      earnedByRun.set(iv.end, (earnedByRun.get(iv.end) ?? 0) + iv.earnedUsd);
    }
  }

  const intervals: Interval[] = [];
  for (let i = 1; i < runTimes.length; i++) {
    intervals.push({
      start: runTimes[i - 1],
      end: runTimes[i],
      earnedUsd: earnedByRun.get(runTimes[i]) ?? 0,
      capitalUsd: capitalByRun.get(runTimes[i - 1]) ?? 0,
    });
  }
  if (runTimes.length > 0) {
    const t0 = runTimes[0];
    intervals.unshift({ start: t0, end: t0, earnedUsd: earnedByRun.get(t0) ?? 0, capitalUsd: capitalByRun.get(t0) ?? 0 });
  }

  const windows: Record<string, WindowStats> = {};
  for (const [label, seconds] of Object.entries(WINDOWS)) {
    windows[label] = windowStats(intervals, now - seconds, now);
  }
  const sinceStart = runTimes.length ? windowStats(intervals, runTimes[0], now) : windowStats([], 0, 0);
  return {
    trackingStartedAt: runTimes.length ? new Date(runTimes[0] * 1000).toISOString() : null,
    currentCapitalUsd: runTimes.length ? (capitalByRun.get(runTimes[runTimes.length - 1]) ?? 0) : 0,
    windows,
    sinceStart,
  };
}
