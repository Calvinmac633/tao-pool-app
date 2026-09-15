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
