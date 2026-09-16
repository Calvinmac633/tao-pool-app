import { test } from "node:test";
import assert from "node:assert/strict";
import { analyzePortfolio, analyzePosition, windowStats, type PositionRow, type SnapshotRow } from "../analytics";
import { amountsAtPrice } from "../clmm-math";

const close = (a: number, b: number, tol = 1e-9) => assert.ok(Math.abs(a - b) <= tol * Math.max(1, Math.abs(b)), `${a} != ${b}`);

const T0 = Date.UTC(2026, 8, 15, 12, 0, 0) / 1000; // epoch seconds
const iso = (minutes: number) => new Date((T0 + minutes * 60) * 1000).toISOString();

const position: PositionRow = {
  positionId: "pos1",
  poolId: "pool",
  poolName: "TAO/USDC",
  symbolA: "TAO",
  symbolB: "USDC",
  decimalsA: 0,
  decimalsB: 0,
  firstSeenAt: iso(0),
  lastSeenAt: iso(0),
  closedAt: null,
  openedAt: null,
  entryAmountA: null,
  entryAmountB: null,
  deposits: null,
};

function row(minutes: number, o: Partial<SnapshotRow> = {}): SnapshotRow {
  return {
    takenAt: iso(minutes),
    positionId: "pos1",
    priceA: 225,
    amountA: 0,
    amountB: 1000,
    usdValue: 1000,
    feeAmountA: 0,
    feeAmountB: 0,
    feeUsd: 0,
    rewardUsd: 0,
    liquidity: null,
    priceLower: null,
    priceUpper: null,
    ...o,
  };
}

// Tracking began well before the position and the previous run was 5 minutes
// before its first snapshot, so its first snapshot counts (opened since then).
const opts = (nowMinutes: number) => ({
  trackingStartedAt: iso(-60),
  now: T0 + nowMinutes * 60,
  runTimes: [T0 - 300],
  intervalSeconds: 300,
});

test("fees accumulate across intervals and survive a collection", () => {
  const rows = [
    row(0, { feeAmountB: 0, feeUsd: 0 }),
    row(5, { feeAmountB: 10, feeUsd: 10 }),
    row(10, { feeAmountB: 20, feeUsd: 20 }),
    row(15, { feeAmountB: 5, feeUsd: 5 }), // collected 20, then earned 5
  ];
  const r = analyzePosition(position, rows, opts(15))!;
  close(r.analytics.lifetime.earnedUsd, 25);
  close(r.analytics.collectedUsd, 20);
  assert.equal(r.analytics.preExisting, false);
  close(r.analytics.lastUncollectedUsd, 5);
});

test("a position present at the first ever run excludes fees of unknown age", () => {
  const rows = [row(0, { feeAmountB: 7, feeUsd: 7 }), row(5, { feeAmountB: 9, feeUsd: 9 })];
  const r = analyzePosition(position, rows, { trackingStartedAt: iso(0), now: T0 + 300, runTimes: [T0, T0 + 300] })!;
  assert.equal(r.analytics.preExisting, true);
  close(r.analytics.baselineUncollectedUsd, 7);
  close(r.analytics.lifetime.earnedUsd, 2);
});

test("with no open time, a recent previous run dates first-sight fees to that run", () => {
  const rows = [row(0, { feeAmountB: 1, feeUsd: 1 }), row(5, { feeAmountB: 2, feeUsd: 2 })];
  const r = analyzePosition(position, rows, opts(5))!.analytics;
  assert.equal(r.preExisting, false);
  close(r.lifetime.earnedUsd, 2);
  close(r.lifetime.coveredSeconds, 600); // 5 min assumed before first snapshot + 5 min after
  assert.equal(r.openedAtKnown, false);
});

test("with no open time, a position first seen after a tracking gap is treated as unknown age", () => {
  const rows = [row(0, { feeAmountB: 50, feeUsd: 50 }), row(5, { feeAmountB: 51, feeUsd: 51 })];
  const r = analyzePosition(position, rows, { ...opts(5), runTimes: [T0 - 19 * 3600] })!.analytics;
  assert.equal(r.preExisting, true);
  close(r.baselineUncollectedUsd, 50);
  close(r.lifetime.earnedUsd, 1);
});

test("a known open time after the previous run dates fees exactly, even across a gap", () => {
  const rows = [row(0, { feeAmountB: 1, feeUsd: 1 }), row(5, { feeAmountB: 2, feeUsd: 2 })];
  const opened = { ...position, openedAt: iso(-10) };
  const r = analyzePosition(opened, rows, { ...opts(5), runTimes: [T0 - 20 * 60] })!.analytics;
  assert.equal(r.preExisting, false);
  assert.equal(r.openedAtKnown, true);
  assert.equal(r.openedAt, iso(-10));
  close(r.lifetime.earnedUsd, 2);
  close(r.lifetime.coveredSeconds, 900); // 10 min since open + 5 min tracked
});

test("a known open time before the previous run means the first-sight fees are unknown age", () => {
  const rows = [row(0, { feeAmountB: 50, feeUsd: 50 }), row(5, { feeAmountB: 51, feeUsd: 51 })];
  const opened = { ...position, openedAt: iso(-30) };
  const r = analyzePosition(opened, rows, { ...opts(5), runTimes: [T0 - 20 * 60] })!.analytics;
  assert.equal(r.preExisting, true);
  close(r.lifetime.earnedUsd, 1);
});

test("deposit amounts from the open transaction become the IL baseline", () => {
  const range = { priceLower: 100, priceUpper: 400 };
  const a = amountsAtPrice(6000, range, 225, 0, 0); // 100 A, 30000 B
  const rows = [row(0, { ...a, usdValue: a.amountA * 225 + a.amountB, liquidity: "6000", ...range })];
  // Deposited at a different price earlier: 120 A + 25500 B (worth 52500 at 225).
  const opened = { ...position, openedAt: iso(-3), entryAmountA: 120, entryAmountB: 25500 };
  const r = analyzePosition(opened, rows, opts(0))!.analytics;
  assert.equal(r.entry.source, "chain");
  close(r.entry.amountA, 120);
  close(r.entry.amountB, 25500);
  close(r.ilUsd, 52500 - (120 * 225 + 25500)); // 0 here by construction
  close(r.projections!.upper.hodlUsd, 120 * 400 + 25500);
});

test("APR annualises earnings over time-weighted capital", () => {
  // $1 per hour on $1000 for 24 hours -> 24/1000 * 365 = 876%
  const rows = Array.from({ length: 25 }, (_, h) => row(h * 60, { feeAmountB: h, feeUsd: h }));
  const r = analyzePosition(position, rows, opts(24 * 60))!;
  const w = r.analytics.windows["24h"];
  close(w.earnedUsd, 24);
  close(w.avgCapitalUsd, 1000);
  close(w.coveredSeconds, 24 * 3600);
  close(w.apr!, 8.76);
  // The 1h window sees only the last hour.
  close(r.analytics.windows["1h"].earnedUsd, 1);
  close(r.analytics.windows["1h"].apr!, 8.76);
});

test("windowStats pro-rates an interval that straddles the window edge", () => {
  const ivs = [{ start: 0, end: 100, earnedUsd: 10, capitalUsd: 500 }];
  const w = windowStats(ivs, 50, 100);
  close(w.earnedUsd, 5);
  close(w.avgCapitalUsd, 500);
  close(w.coveredSeconds, 50);
});

test("a liquidity change adjusts the entry baseline instead of showing as IL", () => {
  const range = { priceLower: 100, priceUpper: 400 };
  const a1 = amountsAtPrice(6000, range, 225, 0, 0); // 100 A, 30000 B
  const a2 = amountsAtPrice(12000, range, 225, 0, 0); // doubled
  const rows = [
    row(0, { ...a1, usdValue: a1.amountA * 225 + a1.amountB, liquidity: "6000", ...range }),
    row(5, { ...a2, usdValue: a2.amountA * 225 + a2.amountB, liquidity: "12000", ...range }),
  ];
  const r = analyzePosition(position, rows, opts(5))!.analytics;
  assert.equal(r.entry.adjustments, 1);
  close(r.entry.amountA, 200);
  close(r.entry.amountB, 60000);
  close(r.ilUsd, 0, 1e-6);
});

test("projections at the bounds match the closed-form IL", () => {
  const range = { priceLower: 100, priceUpper: 400 };
  const a = amountsAtPrice(6000, range, 225, 0, 0);
  const rows = [row(0, { ...a, usdValue: a.amountA * 225 + a.amountB, liquidity: "6000", ...range })];
  const r = analyzePosition(position, rows, opts(0))!.analytics;
  assert.ok(r.projections);
  close(r.projections.current.ilUsd, 0);
  close(r.projections.upper.positionUsd, 60000);
  close(r.projections.upper.hodlUsd, 70000);
  close(r.projections.upper.ilUsd, -10000);
  close(r.projections.lower.positionUsd, 30000);
  close(r.projections.lower.ilUsd, -10000);
  assert.equal(r.inRange, true);
});

test("net performance is IL plus fees earned", () => {
  const range = { priceLower: 100, priceUpper: 400 };
  const a0 = amountsAtPrice(6000, range, 225, 0, 0);
  const a1 = amountsAtPrice(6000, range, 400, 0, 0); // price ran to the top
  const rows = [
    row(0, { ...a0, usdValue: a0.amountA * 225 + a0.amountB, liquidity: "6000", ...range }),
    row(5, { ...a1, priceA: 400, usdValue: a1.amountA * 400 + a1.amountB, liquidity: "6000", ...range, feeAmountB: 50, feeUsd: 50 }),
  ];
  const r = analyzePosition(position, rows, opts(5))!.analytics;
  close(r.ilUsd, -10000);
  close(r.lifetime.earnedUsd, 50);
  close(r.netUsd, -9950);
});

test("a closed position measures lifetime up to its last snapshot", () => {
  const rows = [row(0), row(60, { feeAmountB: 2, feeUsd: 2 })];
  const closed = { ...position, closedAt: iso(65), openedAt: iso(0) };
  const r = analyzePosition(closed, rows, opts(24 * 60))!.analytics;
  close(r.lifetime.coveredSeconds, 3600);
  close(r.lifetime.earnedUsd, 2);
  close(r.lifetime.apr!, (2 / 1000) * (365 * 24)); // 2/1000 per hour, annualised
  assert.deepEqual(Object.keys(r.windows), []);
});

test("portfolio sums capital and earnings across positions", () => {
  const rowsA = [row(0), row(60, { feeAmountB: 1, feeUsd: 1 })];
  const rowsB = [row(0, { positionId: "pos2" }), row(60, { positionId: "pos2", feeAmountB: 3, feeUsd: 3 })];
  const a = analyzePosition(position, rowsA, opts(60))!;
  const b = analyzePosition({ ...position, positionId: "pos2" }, rowsB, opts(60))!;
  const p = analyzePortfolio([a.intervals, b.intervals], [...rowsA, ...rowsB], T0 + 3600);
  close(p.currentCapitalUsd, 2000);
  close(p.windows["1h"].earnedUsd, 4);
  close(p.windows["1h"].avgCapitalUsd, 2000);
  close(p.windows["1h"].apr!, (4 / 2000) * (365 * 24));
  close(p.sinceStart.earnedUsd, 4);
});

test("entry price comes from the open deposit and the headline IL matches the projection", () => {
  const range = { priceLower: 100, priceUpper: 400 };
  const deposit = amountsAtPrice(6000, range, 225, 0, 0); // 100 A + 30000 B at 225
  const now = amountsAtPrice(6000, range, 256, 0, 0); // price moved to 256
  const rows = [row(0, { ...now, priceA: 256, usdValue: now.amountA * 256 + now.amountB, liquidity: "6000", ...range })];
  const opened = {
    ...position,
    openedAt: iso(-3),
    entryAmountA: deposit.amountA,
    entryAmountB: deposit.amountB,
    deposits: [{ at: iso(-3), ...deposit }],
  };
  const r = analyzePosition(opened, rows, opts(0))!.analytics;
  close(r.entry.price!, 225, 1e-9);
  close(r.entry.avgPrice!, 225, 1e-9);
  assert.equal(r.entry.history.length, 1);
  assert.ok(r.projections!.entry);
  close(r.projections!.entry!.ilUsd, 0, 1e-6);
  close(r.ilUsd, r.projections!.current.ilUsd);
  assert.ok(r.ilUsd < 0);
});

test("several deposits give an open price and a capital-weighted average", () => {
  const range = { priceLower: 100, priceUpper: 400 };
  const d1 = amountsAtPrice(6000, range, 225, 0, 0); // ~52500 B of value at 225
  const d2 = amountsAtPrice(6000, range, 300, 0, 0); // second deposit at 300
  const total = { amountA: d1.amountA + d2.amountA, amountB: d1.amountB + d2.amountB };
  const nowAmounts = amountsAtPrice(12000, range, 300, 0, 0);
  const rows = [row(0, { ...nowAmounts, priceA: 300, usdValue: nowAmounts.amountA * 300 + nowAmounts.amountB, liquidity: "12000", ...range })];
  const opened = { ...position, openedAt: iso(-10), entryAmountA: total.amountA, entryAmountB: total.amountB, deposits: [{ at: iso(-10), ...d1 }, { at: iso(-5), ...d2 }] };
  const r = analyzePosition(opened, rows, opts(0))!.analytics;
  close(r.entry.price!, 225, 1e-9);
  const w1 = d1.amountA * 225 + d1.amountB;
  const w2 = d2.amountA * 300 + d2.amountB;
  close(r.entry.avgPrice!, (225 * w1 + 300 * w2) / (w1 + w2), 1e-9);
  assert.equal(r.entry.history.length, 2);
  assert.ok(r.ilUsd <= 1e-6);
});

test("portfolio coverage starts at the earliest known position open", () => {
  const rows = [row(0, { feeAmountB: 1, feeUsd: 1 }), row(5, { feeAmountB: 2, feeUsd: 2 })];
  const opened = { ...position, openedAt: iso(-10) };
  const a = analyzePosition(opened, rows, { ...opts(5), runTimes: [T0 - 20 * 60] })!;
  const p = analyzePortfolio([a.intervals], rows, T0 + 300);
  assert.equal(p.trackingStartedAt, iso(-10));
  close(p.sinceStart.coveredSeconds, 900);
  close(p.sinceStart.earnedUsd, 2);
  close(p.sinceStart.avgCapitalUsd, 1000);
});
