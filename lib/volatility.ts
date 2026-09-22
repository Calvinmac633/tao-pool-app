/**
 * Realised volatility from the tracker's own price series, and the expected
 * cost of providing concentrated liquidity at that volatility.
 */
import type { Range } from "./clmm-math";

export type PricePoint = { t: number; price: number }; // epoch seconds

/**
 * Daily volatility (standard deviation of log returns, scaled to one day)
 * over the points within `windowSeconds` of `now`. Returns null when there
 * isn't enough data to be meaningful.
 */
export function dailyVolatility(points: PricePoint[], windowSeconds: number, now: number): { dailyVol: number; points: number; spanSeconds: number } | null {
  const inWindow = points
    .filter((p) => p.t >= now - windowSeconds && p.price > 0)
    .sort((a, b) => a.t - b.t)
    .filter((p, i, arr) => i === 0 || p.t !== arr[i - 1].t);
  if (inWindow.length < 10) return null;
  const span = inWindow[inWindow.length - 1].t - inWindow[0].t;
  if (span < windowSeconds * 0.25) return null;
  let sumSq = 0;
  for (let i = 1; i < inWindow.length; i++) {
    const r = Math.log(inWindow[i].price / inWindow[i - 1].price);
    sumSq += r * r;
  }
  // Sum of squared returns over the span is the realised variance for that
  // span; scale the variance rate to one day.
  const dailyVar = (sumSq / span) * 86400;
  return { dailyVol: Math.sqrt(dailyVar), points: inWindow.length, spanSeconds: span };
}

/**
 * How much more "active" a concentrated position is than a full-range one
 * holding the same value: the ratio of the equivalent full-range position's
 * value to the real position's value. 1 for full range; grows as the range
 * tightens. Null when the price is outside the range (the position holds a
 * single token and does no trading).
 */
export function concentrationFactor(range: Range, price: number): number | null {
  if (price < range.priceLower || price >= range.priceUpper) return null;
  const sqrtP = Math.sqrt(price);
  const real = 2 * sqrtP - Math.sqrt(range.priceLower) - price / Math.sqrt(range.priceUpper);
  return real > 0 ? (2 * sqrtP) / real : null;
}

/**
 * Expected cost of providing liquidity, as a fraction of position value per
 * day, while in range. This is the standard "loss versus rebalancing"
 * result: a full-range position bleeds dailyVol^2 / 8 per day, and a
 * concentrated one multiplies that by its concentration factor.
 */
export function expectedCostPerDay(dailyVol: number, concentration: number): number {
  return ((dailyVol * dailyVol) / 8) * concentration;
}
