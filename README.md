# Raydium CLMM Position Viewer

Enter a Solana wallet address and see its open Raydium concentrated-liquidity (CLMM) positions: pool name, USD value, and uncollected fees. A background tracker snapshots one configured wallet on a timer so fee earnings and APR can be computed over time.

## Setup

```bash
npm install
cp .env.local.example .env.local
```

Edit `.env.local`:

```
SOLANA_RPC_URL=https://mainnet.helius-rpc.com/?api-key=<your Helius key>
SOLANA_RPC_API_KEY=unused
TRACKED_WALLET=<wallet to snapshot on a timer>
SNAPSHOT_INTERVAL_MINUTES=15
```

- `SOLANA_RPC_URL` must be an RPC that allows `getTokenAccountsByOwner`. Helius's free tier does; Tatum's free tier does not. If your provider authenticates with an `x-api-key` header instead of the URL, put the key in `SOLANA_RPC_API_KEY`.
- `TRACKED_WALLET` is optional. Leave it blank to disable the tracker.

All variables are read only on the server, so keys never reach the browser. `.env.local` and the `data/` folder are git-ignored.

## Run

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). The tracked wallet is prefilled.

While the server is running, the tracker takes a snapshot of `TRACKED_WALLET` on start and then every `SNAPSHOT_INTERVAL_MINUTES`. Snapshots stop when the server stops. A **Snapshot now** button under the table records one on demand.

## How it works

### Finding positions (`lib/raydium.ts`)

1. Lists the wallet's token accounts under both the classic Token program and Token-2022, keeping NFT-like accounts (amount 1, zero decimals).
2. Derives the Raydium CLMM position PDA for each NFT mint (seed `"position"` + mint).
3. Checks on-chain which PDAs exist and are owned by the CLMM program. This is the ownership check; the Raydium API does not verify ownership itself.
4. Fetches each verified position from `https://dynamic-ipfs.raydium.io/clmm/position?id=<pda>` and drops positions with zero USD value.

### Tracking (`lib/snapshot.ts`, `lib/tracker.ts`)

Snapshots live in a SQLite file at `data/tracker.db` (via `@libsql/client`). Three tables:

- `snapshot_runs`: one row per attempt, with status and any error.
- `snapshots`: one row per open position per successful run. Stores token amounts, uncollected fee amounts, the token price at the time, emission rewards, and the full raw API payload.
- `positions`: every position ever seen, with first-seen, last-seen, and closed-at timestamps.

Fees are stored as token amounts plus price so USD figures can be recomputed later without drifting with the current price.

## API

- `GET /api/positions?wallet=<address>`: open positions and total value.
- `GET /api/snapshot`: tracker status.
- `POST /api/snapshot`: take a snapshot of the tracked wallet now.

## Deploy

Set the same environment variables in the hosting project. For a hosted database, set `TRACKER_DB_URL` (and `TRACKER_DB_AUTH_TOKEN`) to a libsql/Turso URL; the default is the local file. The in-process timer only runs while a server is alive, so on serverless hosting call `POST /api/snapshot` from an external scheduler instead.
