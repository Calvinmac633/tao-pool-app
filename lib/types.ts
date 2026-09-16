// Shared types. No runtime imports so this is safe to import from client code.

export type Position = {
  positionId: string;
  poolId: string;
  poolName: string; // `${symbolA}/${symbolB}`
  usdValue: number;
  amountA: number;
  amountB: number;
  symbolA: string;
  symbolB: string;
  unclaimedFeeUsd: number;
  // Fields below are captured for tracking. amounts are human-readable decimals.
  priceA: number; // price of token A quoted in token B, from poolInfo.price
  unclaimedFeeAmountA: number;
  unclaimedFeeAmountB: number;
  unclaimedRewardUsd: number; // emission rewards (farm-style), separate from trading fees
  rewards: unknown[]; // raw reward entries from the API; none of the tracked pools emit yet
  decimalsA: number;
  decimalsB: number;
  mintA: string;
  mintB: string;
  // Range and liquidity decoded from the on-chain position account.
  tickLower: number;
  tickUpper: number;
  liquidity: string; // u128 as a decimal string
  priceLower: number; // price of A in B at tickLower
  priceUpper: number;
  inRange: boolean;
};

export type PositionsResponse = {
  positions: Position[];
  totalUsdValue: number;
};

export type SnapshotSummary = {
  runId: number;
  wallet: string;
  takenAt: string;
  positionsFound: number;
  positionsFailed: number;
  positionsClosed: number;
  historyLookups: number; // open-transaction lookups that succeeded this run
};

export type TrackingStatus = {
  trackedWallet: string | null;
  intervalMinutes: number;
  runs: number; // successful snapshot runs
  firstRunAt: string | null;
  lastRunAt: string | null;
  lastStatus: "ok" | "failed" | null;
  lastError: string | null;
  openPositions: number;
};

// ---- Analytics (computed from stored snapshots) ----

export type WindowStats = {
  earnedUsd: number; // fees + rewards earned in the window
  avgCapitalUsd: number; // time-weighted average position value
  coveredSeconds: number; // how much of the window has snapshot coverage
  apr: number | null; // annualised earned / avgCapital over the covered time; 1 = 100%
};

export type Projection = {
  price: number;
  amountA: number;
  amountB: number;
  positionUsd: number;
  hodlUsd: number; // value of the entry tokens if simply held at this price
  ilUsd: number; // positionUsd - hodlUsd
  ilPct: number;
};

export type PositionAnalytics = {
  positionId: string;
  poolId: string;
  poolName: string;
  symbolA: string;
  symbolB: string;
  openedAt: string; // from the open transaction when known, else the first snapshot
  openedAtKnown: boolean;
  closedAt: string | null;
  preExisting: boolean; // fees at first sight were of unknown age and are excluded; figures are "since tracking"
  snapshots: number;
  priceLower: number | null;
  priceUpper: number | null;
  inRange: boolean | null;
  lastPrice: number;
  lastUsdValue: number;
  lastUncollectedUsd: number;
  baselineUncollectedUsd: number; // fees of unknown age at the first snapshot (pre-existing only)
  collectedUsd: number; // collections detected while tracking
  entry: {
    amountA: number; // total tokens put in (deposits, adjusted for later liquidity changes)
    amountB: number;
    usd: number; // value of those tokens at the last price
    adjustments: number; // liquidity changes seen between snapshots
    source: "chain" | "snapshot";
    price: number | null; // pool price at the open deposit, implied by its token ratio
    avgPrice: number | null; // capital-weighted across all deposits
    history: EntryEvent[]; // every deposit / withdrawal known, oldest first
  };
  lifetime: WindowStats;
  windows: Record<string, WindowStats>; // "1h", "6h", "24h", "7d" (open positions only)
  ilUsd: number;
  ilPct: number;
  netUsd: number; // ilUsd + lifetime earned
  projections: { entry: Projection | null; lower: Projection; current: Projection; upper: Projection } | null;
};

/** A change to the tokens in a position: a deposit (positive) or withdrawal (negative). */
export type EntryEvent = {
  at: string;
  amountA: number;
  amountB: number;
  price: number | null; // pool price at the time; null if it could not be determined
  source: "chain" | "snapshot"; // from a transaction, or inferred from a liquidity change between snapshots
};

export type PortfolioAnalytics = {
  trackingStartedAt: string | null; // earliest point the figures cover
  currentCapitalUsd: number; // sum of the latest values of the positions included
  windows: Record<string, WindowStats>;
  sinceStart: WindowStats; // everything since trackingStartedAt
};

export type WalletAnalytics = {
  wallet: string;
  asOf: string | null; // time of the latest snapshot
  open: PositionAnalytics[];
  closed: PositionAnalytics[]; // most recent first
  openPortfolio: PortfolioAnalytics; // only the positions open now, since their opens
  portfolio: PortfolioAnalytics; // every position since tracking began, open and closed
};
