import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyTx, type TxFacts } from "../ledger";
import { groupRolls, reconcile, type RunTotals } from "../ledger-analytics";
import type { SnapshotRow } from "../analytics";
import type { LedgerEntry } from "../types";

const close = (a: number, b: number, tol = 1e-9) => assert.ok(Math.abs(a - b) <= tol * Math.max(1, Math.abs(b)), `${a} != ${b}`);
const CLMM = "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK";
const POS = "PositionAddress111111111111111111111111111";
const known = new Set([POS]);
const facts = (o: Partial<TxFacts>): TxFacts => ({ signature: "s", blockTime: 0, deltaA: 0, deltaB: 0, others: [], accountKeys: [], ...o });

test("transactions are sorted into position, swap, external and unclassified", () => {
  assert.deepEqual(classifyTx(facts({ deltaA: -5, deltaB: -1000, accountKeys: [CLMM, POS], others: [{ mint: "nft", delta: 1, decimals: 0 }] }), known), { kind: "position", positionId: POS, note: "deposit" });
  assert.deepEqual(classifyTx(facts({ deltaA: 3, deltaB: 900, accountKeys: [CLMM, POS] }), known), { kind: "position", positionId: POS, note: "withdraw" });
  assert.equal(classifyTx(facts({ deltaA: -5, deltaB: -1000, accountKeys: [CLMM, "OtherPosition"], others: [{ mint: "nft2", delta: 1, decimals: 0 }] }), known).note, "untracked position");
  // A swap through the CLMM pool touches the same program but mints no NFT.
  assert.deepEqual(classifyTx(facts({ deltaA: 1.5, deltaB: -400, accountKeys: [CLMM, "PoolState"] }), known), { kind: "swap", positionId: null, note: "bought A" });
  assert.deepEqual(classifyTx(facts({ deltaA: 2, deltaB: -500 }), known), { kind: "swap", positionId: null, note: "bought A" });
  assert.equal(classifyTx(facts({ deltaA: -2, deltaB: 500 }), known).note, "sold A");
  assert.deepEqual(classifyTx(facts({ deltaA: 0.02 }), known), { kind: "external", positionId: null, note: "in" }); // airdrop
  assert.equal(classifyTx(facts({ deltaB: -400, others: [{ mint: "meme", delta: 1e6, decimals: 6 }] }), known).note, "out via 1 other token");
  assert.equal(classifyTx(facts({ deltaA: 1, deltaB: 1 }), known).note, "in"); // both in: a transfer
  assert.equal(classifyTx(facts({ deltaA: 1, deltaB: -300, others: [{ mint: "x", delta: -7, decimals: 6 }] }), known).kind, "unclassified");
});

const T0 = 1_000_000;
const iso = (sec: number) => new Date(sec * 1000).toISOString();
const row = (t: number, o: Partial<SnapshotRow>): SnapshotRow => ({
  takenAt: iso(t), positionId: "p1", priceA: 100, amountA: 10, amountB: 1000, usdValue: 2000, feeAmountA: 0, feeAmountB: 0, feeUsd: 0, rewardUsd: 0, liquidity: "L", priceLower: 50, priceUpper: 200, ...o,
});

test("holdings changes are fully explained when nothing unexpected happens", () => {
  // Position trades 1 A for 95 B (pool cost -5 at end price 100); fees +2 B accrue; a swap buys 1 A for 101 B; 50 B arrives from outside.
  const runs: RunTotals[] = [
    { t: T0, price: 90, posA: 10, posB: 1000, feeA: 0, feeB: 0, freeA: 0, freeB: 500 },
    { t: T0 + 300, price: 100, posA: 9, posB: 1095, feeA: 0, feeB: 2, freeA: 1, freeB: 500 - 101 + 50 },
  ];
  const rowsByRun = new Map([
    [T0, [row(T0, { priceA: 90 })]],
    [T0 + 300, [row(T0 + 300, { amountA: 9, amountB: 1095, feeAmountB: 2 })]],
  ]);
  const ledger: LedgerEntry[] = [
    { signature: "sw", at: iso(T0 + 100), kind: "swap", note: "bought A", positionId: null, deltaA: 1, deltaB: -101, others: [], priceA: 100, swapCostB: -1 },
    { signature: "ex", at: iso(T0 + 200), kind: "external", note: "in", positionId: null, deltaA: 0, deltaB: 50, others: [], priceA: null, swapCostB: null },
  ];
  const r = reconcile("test", runs, rowsByRun, ledger, T0, T0 + 300)!;
  close(r.priceMoveB, 10 * 10); // 10 A held at the start, price +10
  close(r.feesB, 2);
  close(r.poolCostB, -1 * 100 + 95); // gave 1 A, got 95 B, at 100 -> -5
  close(r.swapsB, 1 * 100 - 101); // bought 1 A at 101 when it was worth 100 -> -1
  close(r.externalB, 50);
  close(r.changeB, r.priceMoveB + r.feesB + r.poolCostB + r.swapsB + r.externalB);
  close(r.unexplainedB, 0, 1e-9);
});

test("adds, closes and opens inside an interval are explained using the ledger's amounts", () => {
  // p1 holds 10 A + 1000 B, then 2 A + 300 B are added (ledger: wallet -2 A, -300 B) and the pool trades 1 A for 95 B.
  // p2 is opened with 4 A + 400 B from the wallet and immediately trades 0.5 A for 48 B.
  const runs: RunTotals[] = [
    { t: T0, price: 100, posA: 10, posB: 1000, feeA: 0, feeB: 0, freeA: 6, freeB: 700 },
    { t: T0 + 300, price: 100, posA: 11 + 3.5, posB: 1395 + 448, feeA: 0, feeB: 0, freeA: 0, freeB: 0 },
  ];
  const rowsByRun = new Map([
    [T0, [row(T0, { positionId: "p1" })]],
    [T0 + 300, [row(T0 + 300, { positionId: "p1", amountA: 11, amountB: 1395, liquidity: "L2" }), row(T0 + 300, { positionId: "p2", amountA: 3.5, amountB: 448, liquidity: "M" })]],
  ]);
  const ledger: LedgerEntry[] = [
    { signature: "add", at: iso(T0 + 60), kind: "position", note: "add", positionId: "p1", deltaA: -2, deltaB: -300, others: [], priceA: null, swapCostB: null },
    { signature: "open", at: iso(T0 + 120), kind: "position", note: "open", positionId: "p2", deltaA: -4, deltaB: -400, others: [], priceA: null, swapCostB: null },
  ];
  const r = reconcile("test", runs, rowsByRun, ledger, T0, T0 + 300)!;
  close(r.poolCostB, (-1 * 100 + 95) + (-0.5 * 100 + 48)); // -5 and -2
  close(r.unexplainedB, 0, 1e-9);
});

test("a token movement the ledger didn't see shows up as unexplained", () => {
  const runs: RunTotals[] = [
    { t: T0, price: 100, posA: 0, posB: 0, feeA: 0, feeB: 0, freeA: 0, freeB: 500 },
    { t: T0 + 300, price: 100, posA: 0, posB: 0, feeA: 0, feeB: 0, freeA: 0, freeB: 400 },
  ];
  const r = reconcile("test", runs, new Map(), [], T0, T0 + 300)!;
  close(r.unexplainedB, -100);
});

test("rolls group a close, its swaps, and the next open", () => {
  const e = (at: number, kind: LedgerEntry["kind"], note: string, deltaA: number, deltaB: number, positionId: string | null = null): LedgerEntry => ({
    signature: `${at}`, at: iso(at), kind, note, positionId, deltaA, deltaB, others: [], priceA: 100, swapCostB: kind === "swap" ? deltaA * 100 + deltaB : null,
  });
  const ledger = [
    e(T0 - 30, "position", "close", 1, 100, "p0"),
    e(T0, "position", "close", 5, 500, "p1"),
    e(T0 + 60, "swap", "bought A", 2, -202),
    e(T0 + 90, "external", "out", 0, -50),
    e(T0 + 120, "swap", "bought A", 1, -100),
    e(T0 + 180, "position", "open", -8, -148, "p2"),
    e(T0 + 900, "position", "close", 8, 150, "p2"),
  ];
  const rolls = groupRolls(ledger);
  assert.equal(rolls.length, 2);
  const [latest, first] = rolls; // most recent first
  assert.deepEqual(first.closedPositionIds, ["p0", "p1"]); // two closes before the reopen make one roll
  assert.equal(first.openedPositionId, "p2");
  assert.equal(first.swaps.length, 2);
  close(first.netSoldA, -3); // bought 3 A
  close(first.swapCostB, -2); // paid 202 + 100 for 3 A worth 300
  close(first.gapMinutes!, 3.5);
  assert.equal(latest.openedPositionId, null); // closed, not yet reopened
});
