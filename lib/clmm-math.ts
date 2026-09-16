/**
 * Pure maths for Raydium/Uniswap-v3 style concentrated liquidity positions.
 *
 * Conventions:
 * - "price" is the human-readable price of token A quoted in token B
 *   (e.g. USDC per TAO). Raydium's poolInfo.price uses the same convention.
 * - Amounts are human-readable decimals unless a name ends in Raw.
 * - `liquidity` is the on-chain u128 liquidity value (raw units).
 *
 * A position's composition at any price is a pure function of
 * (liquidity, lower price, upper price, current price), which is what makes
 * impermanent-loss projections at the range bounds exact.
 */

export type Range = { priceLower: number; priceUpper: number };
export type Amounts = { amountA: number; amountB: number };

/** Human price of A in B for a tick index. */
export function tickToPrice(tick: number, decimalsA: number, decimalsB: number): number {
  return Math.pow(1.0001, tick) * Math.pow(10, decimalsA - decimalsB);
}

/** Convert a human price (B per A) to the raw price used by the pool maths. */
function toRawPrice(price: number, decimalsA: number, decimalsB: number): number {
  return price * Math.pow(10, decimalsB - decimalsA);
}

/**
 * Token amounts held by a position with the given liquidity when the pool
 * price is `price`. Below the range it is all token A, above it all token B.
 */
export function amountsAtPrice(
  liquidity: number,
  range: Range,
  price: number,
  decimalsA: number,
  decimalsB: number,
): Amounts {
  const sqrtP = Math.sqrt(toRawPrice(price, decimalsA, decimalsB));
  const sqrtLower = Math.sqrt(toRawPrice(range.priceLower, decimalsA, decimalsB));
  const sqrtUpper = Math.sqrt(toRawPrice(range.priceUpper, decimalsA, decimalsB));

  let amountARaw = 0;
  let amountBRaw = 0;
  if (sqrtP <= sqrtLower) {
    amountARaw = liquidity * (1 / sqrtLower - 1 / sqrtUpper);
  } else if (sqrtP >= sqrtUpper) {
    amountBRaw = liquidity * (sqrtUpper - sqrtLower);
  } else {
    amountARaw = liquidity * (1 / sqrtP - 1 / sqrtUpper);
    amountBRaw = liquidity * (sqrtP - sqrtLower);
  }
  return {
    amountA: amountARaw / Math.pow(10, decimalsA),
    amountB: amountBRaw / Math.pow(10, decimalsB),
  };
}

/** Value of a token bundle, in token B. */
export function valueInB(amounts: Amounts, price: number): number {
  return amounts.amountA * price + amounts.amountB;
}

export type IlResult = {
  price: number;
  position: Amounts;
  positionValueB: number; // value of the position's tokens, in B
  hodlValueB: number; // value of the entry tokens if simply held, in B
  ilB: number; // positionValueB - hodlValueB (negative = loss)
  ilPct: number; // ilB / hodlValueB
};

/**
 * Impermanent (divergence) loss of a position at `price`, relative to
 * holding the `entry` token amounts unchanged.
 */
export function impermanentLossAt(
  liquidity: number,
  range: Range,
  entry: Amounts,
  price: number,
  decimalsA: number,
  decimalsB: number,
): IlResult {
  const position = amountsAtPrice(liquidity, range, price, decimalsA, decimalsB);
  const positionValueB = valueInB(position, price);
  const hodlValueB = valueInB(entry, price);
  const ilB = positionValueB - hodlValueB;
  return {
    price,
    position,
    positionValueB,
    hodlValueB,
    ilB,
    ilPct: hodlValueB > 0 ? ilB / hodlValueB : 0,
  };
}

/**
 * Pool price at the moment of a two-sided deposit into `range`, implied by
 * the ratio of the two tokens: a position's composition is a pure function
 * of price, so the ratio pins the price exactly. Null for a single-sided
 * deposit (price was outside the range, exact value unknown).
 */
export function impliedPriceFromDeposit(deposit: Amounts, range: Range, decimalsA: number, decimalsB: number): number | null {
  if (!(deposit.amountA > 0) || !(deposit.amountB > 0)) return null;
  const A = deposit.amountA * Math.pow(10, decimalsA);
  const B = deposit.amountB * Math.pow(10, decimalsB);
  const sqrtLower = Math.sqrt(toRawPrice(range.priceLower, decimalsA, decimalsB));
  const sqrtUpper = Math.sqrt(toRawPrice(range.priceUpper, decimalsA, decimalsB));
  // In range: A = L (1/x - 1/sqrtUpper) and B = L (x - sqrtLower) with x = sqrt(price).
  // Eliminating L gives A x^2 + (B/sqrtUpper - A sqrtLower) x - B = 0.
  const qa = A;
  const qb = B / sqrtUpper - A * sqrtLower;
  const qc = -B;
  const x = (-qb + Math.sqrt(qb * qb - 4 * qa * qc)) / (2 * qa);
  if (!Number.isFinite(x) || x <= 0) return null;
  return x * x * Math.pow(10, decimalsA - decimalsB);
}

export function isInRange(range: Range, price: number): boolean {
  return price >= range.priceLower && price < range.priceUpper;
}
