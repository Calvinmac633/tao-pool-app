/**
 * Pure maths over the ledger: does every change in the strategy's holdings
 * add up, and what did each roll (close, swap, reopen) cost. Values are in
 * token B (USDC) so the reconciliation is exact rather than subject to the
 * API's USD pricing.
 */
import type { SnapshotRow } from "./analytics";
import type { LedgerEntry, Reconciliation, Roll } from "./types";

/** Strategy holdings at one snapshot run: in positions, uncollected fees, and loose in the wallet. */
export type RunTotals = {
  t: number; // epoch seconds
  price: number;
  posA: number;
  posB: number;
  feeA: number;
  feeB: number;
  freeA: number;
  freeB: number;
};

const EPS = 1e-9;
const toSec = (iso: string) => new Date(iso).getTime() / 1000;

/** How much "unexplained" is acceptable: API pricing noise on the holdings, never more than a few dollars per $10k. */
export function unexplainedTolerance(r: { startValueB: number; endValueB: number }): number {
  return Math.max(2, 0.0005 * Math.max(r.startValueB, r.endValueB));
}

export function totalValueB(r: RunTotals): number {
  return (r.posA + r.feeA + r.freeA) * r.price + (r.posB + r.feeB + r.freeB);
}

/** Fee tokens accrued between two snapshots of one position, collection-aware. */
function feesAccrued(prev: SnapshotRow | undefined, cur: SnapshotRow | undefined): { a: number; b: number } {
  if (!cur) return { a: 0, b: 0 }; // closed during the interval: fees accrued since the last snapshot arrive with the close
  if (!prev) return { a: cur.feeAmountA, b: cur.feeAmountB }; // new position: everything showing accrued since open
  const dA = cur.feeAmountA - prev.feeAmountA;
  const dB = cur.feeAmountB - prev.feeAmountB;
  const collected = dA < -EPS || dB < -EPS;
  return { a: collected ? cur.feeAmountA : Math.max(0, dA), b: collected ? cur.feeAmountB : Math.max(0, dB) };
}

/**
 * Explain the change in holdings between consecutive runs inside [from, to].
 *
 *   change = price move + fees + pool cost + swaps + money in/out + unexplained
 *
 * Price move is the start-of-interval TAO revalued. Pool cost is what each
 * position's trading did to its tokens, found by conservation: a position's
 * tokens (including uncollected fees) change only through fees accruing,
 * the pool trading, and tokens moving to or from the wallet, and the ledger
 * has the exact wallet movements. Swaps and money in/out come from the
 * ledger. Whatever is left is unexplained and shown as such.
 */
export function reconcile(label: string, runs: RunTotals[], rowsByRun: Map<number, SnapshotRow[]>, ledger: LedgerEntry[], from: number, to: number, cadenceSeconds = 300): Reconciliation | null {
  const inWindow = runs.filter((r) => r.t >= from && r.t <= to).sort((a, b) => a.t - b.t);
  if (inWindow.length < 2) return null;
  const sorted = [...ledger].sort((a, b) => toSec(a.at) - toSec(b.at));

  let priceMove = 0, fees = 0, poolCost = 0, swaps = 0, external = 0, change = 0, gapSeconds = 0;
  for (let i = 1; i < inWindow.length; i++) {
    const r0 = inWindow[i - 1], r1 = inWindow[i];
    if (r1.t - r0.t > cadenceSeconds * 3) gapSeconds += r1.t - r0.t;
    change += totalValueB(r1) - totalValueB(r0);
    priceMove += (r0.posA + r0.feeA + r0.freeA) * (r1.price - r0.price);

    // Wallet movements in the interval, by kind and by position.
    const walletDelta = new Map<string, { a: number; b: number }>();
    for (const e of sorted) {
      const t = toSec(e.at);
      if (t <= r0.t || t > r1.t) continue;
      const valueB = e.deltaA * r1.price + e.deltaB;
      if (e.kind === "swap") swaps += valueB;
      else if (e.kind === "position" && e.positionId) {
        const d = walletDelta.get(e.positionId) ?? { a: 0, b: 0 };
        d.a += e.deltaA;
        d.b += e.deltaB;
        walletDelta.set(e.positionId, d);
      } else external += valueB; // money in/out, unclassified, or an untracked position we can't see into
    }

    const rows0 = new Map((rowsByRun.get(r0.t) ?? []).map((x) => [x.positionId, x]));
    const rows1 = new Map((rowsByRun.get(r1.t) ?? []).map((x) => [x.positionId, x]));
    const ids = new Set([...rows0.keys(), ...rows1.keys(), ...walletDelta.keys()]);
    for (const id of ids) {
      const prev = rows0.get(id), cur = rows1.get(id);
      const f = feesAccrued(prev, cur);
      fees += f.a * r1.price + f.b;
      const w = walletDelta.get(id) ?? { a: 0, b: 0 };
      // bucket1 - bucket0 = fees accrued + pool trade - tokens sent to the wallet
      const tradeA = (cur ? cur.amountA + cur.feeAmountA : 0) - (prev ? prev.amountA + prev.feeAmountA : 0) - f.a + w.a;
      const tradeB = (cur ? cur.amountB + cur.feeAmountB : 0) - (prev ? prev.amountB + prev.feeAmountB : 0) - f.b + w.b;
      poolCost += tradeA * r1.price + tradeB;
    }
  }
  const unexplained = change - priceMove - fees - poolCost - swaps - external;
  const first = inWindow[0], last = inWindow[inWindow.length - 1];
  return {
    label,
    startAt: new Date(first.t * 1000).toISOString(),
    endAt: new Date(last.t * 1000).toISOString(),
    startValueB: totalValueB(first),
    endValueB: totalValueB(last),
    changeB: change,
    priceMoveB: priceMove,
    feesB: fees,
    poolCostB: poolCost,
    swapsB: swaps,
    externalB: external,
    unexplainedB: unexplained,
    intervals: inWindow.length - 1,
    gapSeconds,
  };
}

/**
 * Group the ledger into rolls: a tracked position closes, some swaps may
 * follow, and the next position opens.
 */
export function groupRolls(ledger: LedgerEntry[]): Roll[] {
  const sorted = [...ledger].sort((a, b) => toSec(a.at) - toSec(b.at));
  const rolls: Roll[] = [];
  let open: Roll | null = null;
  for (const e of sorted) {
    if (e.kind === "position" && e.note === "close") {
      if (open) open.closedPositionIds.push(e.positionId ?? "?"); // several closes before the next open: one roll
      else open = { closedAt: e.at, closedPositionIds: [e.positionId ?? "?"], openedAt: null, openedPositionId: null, swaps: [], netSoldA: 0, swapCostB: 0, gapMinutes: null };
    } else if (open && e.kind === "swap") {
      open.swaps.push({ at: e.at, deltaA: e.deltaA, deltaB: e.deltaB, priceA: e.priceA, costB: e.swapCostB });
      open.netSoldA += -e.deltaA;
      open.swapCostB += e.swapCostB ?? 0;
    } else if (open && e.kind === "position" && e.note === "open") {
      open.openedAt = e.at;
      open.openedPositionId = e.positionId;
      open.gapMinutes = (toSec(e.at) - toSec(open.closedAt)) / 60;
      rolls.push(open);
      open = null;
    }
  }
  if (open) rolls.push(open);
  return rolls.reverse(); // most recent first
}
