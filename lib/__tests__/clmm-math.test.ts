import { test } from "node:test";
import assert from "node:assert/strict";
import { amountsAtPrice, impermanentLossAt, isInRange, tickToPrice } from "../clmm-math";

const close = (a: number, b: number, tol = 1e-9) => assert.ok(Math.abs(a - b) <= tol * Math.max(1, Math.abs(b)), `${a} != ${b}`);

// Hand-checkable case: no decimals, range [100, 400], liquidity 6000.
// sqrt bounds are 10 and 20, so at price 225 (sqrt 15):
//   A = L (1/15 - 1/20) = L/60 = 100,  B = L (15 - 10) = 5L = 30000
const range = { priceLower: 100, priceUpper: 400 };
const L = 6000;

test("tickToPrice applies decimals", () => {
  close(tickToPrice(0, 0, 0), 1);
  close(tickToPrice(0, 9, 6), 1000);
  close(tickToPrice(1, 0, 0), 1.0001);
});

test("amounts inside the range", () => {
  const a = amountsAtPrice(L, range, 225, 0, 0);
  close(a.amountA, 100);
  close(a.amountB, 30000);
});

test("all token A below the range, all token B above", () => {
  const below = amountsAtPrice(L, range, 50, 0, 0);
  close(below.amountA, L * (1 / 10 - 1 / 20)); // 300
  close(below.amountB, 0);
  const above = amountsAtPrice(L, range, 1000, 0, 0);
  close(above.amountA, 0);
  close(above.amountB, L * (20 - 10)); // 60000
});

test("decimals scale amounts", () => {
  // Same shape with 9/6 decimals: raw price = human * 10^(6-9).
  const a = amountsAtPrice(L * 1e9, { priceLower: 100, priceUpper: 400 }, 225, 9, 6);
  const raw = amountsAtPrice(L * 1e9, { priceLower: 100e-3, priceUpper: 400e-3 }, 225e-3, 0, 0);
  close(a.amountA, raw.amountA / 1e9);
  close(a.amountB, raw.amountB / 1e6);
});

test("impermanent loss is zero at entry and negative at both bounds", () => {
  const entry = amountsAtPrice(L, range, 225, 0, 0);
  close(impermanentLossAt(L, range, entry, 225, 0, 0).ilB, 0);

  const upper = impermanentLossAt(L, range, entry, 400, 0, 0);
  close(upper.positionValueB, 60000);
  close(upper.hodlValueB, 100 * 400 + 30000); // 70000
  close(upper.ilB, -10000);
  close(upper.ilPct, -10000 / 70000);

  const lower = impermanentLossAt(L, range, entry, 100, 0, 0);
  close(lower.positionValueB, 30000); // 300 A * 100
  close(lower.hodlValueB, 100 * 100 + 30000); // 40000
  close(lower.ilB, -10000);
});

test("isInRange is inclusive at the bottom, exclusive at the top", () => {
  assert.equal(isInRange(range, 100), true);
  assert.equal(isInRange(range, 399.99), true);
  assert.equal(isInRange(range, 400), false);
  assert.equal(isInRange(range, 99), false);
});
