import { test } from "node:test";
import assert from "node:assert/strict";
import { concentrationFactor, dailyVolatility, expectedCostPerDay } from "../volatility";

const close = (a: number, b: number, tol = 1e-9) => assert.ok(Math.abs(a - b) <= tol * Math.max(1, Math.abs(b)), `${a} != ${b}`);

test("a flat price has zero volatility; a known return series scales to one day", () => {
  const now = 100_000;
  const flat = Array.from({ length: 50 }, (_, i) => ({ t: now - 86400 + i * 1800, price: 100 }));
  close(dailyVolatility(flat, 86400, now)!.dailyVol, 0);

  // Alternating +1% / -1% log moves every 30 minutes over a day: 48 moves,
  // variance = 48 * (0.01)^2 over 86400 s -> daily variance = that exactly.
  const pts = Array.from({ length: 49 }, (_, i) => ({ t: now - 86400 + i * 1800, price: 100 * Math.exp(0.01 * (i % 2)) }));
  close(dailyVolatility(pts, 86400, now)!.dailyVol, Math.sqrt(48 * 0.0001), 1e-9);
});

test("too little data gives null", () => {
  const now = 100_000;
  assert.equal(dailyVolatility([{ t: now - 10, price: 1 }, { t: now, price: 1.1 }], 86400, now), null);
  const short = Array.from({ length: 20 }, (_, i) => ({ t: now - 600 + i * 30, price: 100 + i })); // only 10 min of a 24h window
  assert.equal(dailyVolatility(short, 86400, now), null);
});

test("concentration factor is 1 for an effectively full range and grows as the range tightens", () => {
  const wide = concentrationFactor({ priceLower: 1e-9, priceUpper: 1e9 }, 100)!;
  close(wide, 1, 1e-3);
  // Symmetric range with ratio r around the geometric mid: factor = 1 / (1 - r^-1/4)
  const r = 1.081;
  const mid = 220;
  const f = concentrationFactor({ priceLower: mid / Math.sqrt(r), priceUpper: mid * Math.sqrt(r) }, mid)!;
  close(f, 1 / (1 - Math.pow(r, -0.25)), 1e-9);
  assert.ok(f > 40 && f < 60);
  assert.equal(concentrationFactor({ priceLower: 100, priceUpper: 200 }, 250), null);
});

test("expected cost is vol^2 / 8 times the concentration", () => {
  close(expectedCostPerDay(0.05, 1), 0.0025 / 8);
  close(expectedCostPerDay(0.05, 50), (0.0025 / 8) * 50);
});
