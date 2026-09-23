# Raydium CLMM Position Viewer

Enter a Solana wallet address and see its open Raydium concentrated-liquidity (CLMM) positions: pool name, price range, USD value, and uncollected fees. A background tracker snapshots one configured wallet every few minutes, and from those snapshots the app computes fees earned, rolling APRs, impermanent loss (current and projected at the range bounds), net performance, and a closed-position history.

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
SNAPSHOT_INTERVAL_MINUTES=5
```

- `SOLANA_RPC_URL` must be an RPC that allows `getTokenAccountsByOwner`. Helius's free tier does; Tatum's free tier does not. If your provider authenticates with an `x-api-key` header instead of the URL, put the key in `SOLANA_RPC_API_KEY`.
- `TRACKED_WALLET` is optional. Leave it blank to disable the tracker.

All variables are read only on the server, so keys never reach the browser. `.env.local` and the `data/` folder are git-ignored.

## Run

```bash
npm run dev     # app + tracker on http://localhost:3000
npm test        # unit tests for the CLMM maths and analytics
npm run verify  # consistency checks over the live tracker database
```

`npm run verify` recomputes each position's figures a second way and checks the accounting identities: fees that ever showed as uncollected are either still uncollected or were collected, APR equals earned over time-weighted capital, impermanent loss is never positive, and the headline IL matches the projection at the current price.

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

Each snapshot also records the position's tick range and liquidity, decoded from the on-chain position account (`lib/clmm-account.ts`), since the Raydium API does not expose them.

Fees are stored as token amounts plus price so USD figures can be recomputed later without drifting with the current price.

### Analytics (`lib/analytics.ts`, `lib/clmm-math.ts`)

Everything below is computed from stored snapshots, so it only covers time the tracker was running.

- **Fees earned**: the increase in uncollected fees between consecutive snapshots. A decrease means fees were collected; the previous amount is banked as collected and the new amount counts as earned since. Fees are valued at the price when they were observed.
- **APR**: fees earned in a window divided by the time-weighted average position value in that window, annualised. Windows are 1h, 6h, 24h, 7d per position. The **Open positions** section aggregates only the positions open now, since they were opened, and sizes capital for a target yearly return. The **Overall** section at the bottom aggregates every position since tracking began, open and closed, as one strategy. When a window is only partly covered by data, the UI says how much data backs the number.
- **Impermanent loss**: position value minus the value of the entry tokens held unchanged. The entry is the first snapshot's tokens, adjusted when liquidity changes (adds or partial withdrawals). Because a CLMM position's composition is a pure function of liquidity, range and price, IL is also projected exactly at the lower and upper range bounds. Fees are never included in projections.
- **Entry price**: implied by the token ratio of the open deposit, since a position's composition pins the price exactly. Each deposit transaction gets its own implied price; with several deposits the card shows the open price and a capital-weighted average. Every deposit and withdrawal is kept per position as an entry history.
- **Pool cost**: the app's plain name for impermanent loss. It is also shown as the pool's net trade ("sold 53.5 TAO at an average of $223, price at close $227"), which is the same number seen from the trading side.
- **LP income**: fees minus pool cost. The part of a position's result that came from providing liquidity.
- **TAO price move**: what the entry tokens gained or lost from the price changing. It would have happened in any wallet holding those tokens, and it reverses when price falls. Total = LP income + price move.
- **Expected pool cost**: a model (`lib/volatility.ts`) using realised volatility from the tracker's own price series and the position's concentration. A full-range position is expected to lose vol²/8 of its value per day; a concentrated one multiplies that by how much tighter it is. The open-positions panel nets it against the fee rate to size capital, and compares it with the pool cost actually realised over closed positions.
- **Range widths**: closed positions are grouped by width (upper/lower − 1) with fees, pool cost and time in range per group, to show which widths have paid.
- **Open time and entry**: when a position is first seen, the app reads its transaction history on-chain (`lib/position-history.ts`). The oldest transaction gives the open time. The wallet's token outflows across every transaction up to the first snapshot, summed, give the deposit, which becomes the IL baseline. Adds after the first snapshot are caught by liquidity changes between snapshots instead. Partial withdrawals before tracking are not subtracted, since from balances alone they look like fee collections; that can only make IL look worse, never better.
- **Fees of unknown age**: fees showing at a position's first snapshot only count when their age is known: the position opened after the previous snapshot run. A position present at the first ever run, or one that opened during a gap while the tracker was off, has those fees excluded and its figures labelled "since tracking". Assuming unknown age can only understate APR, never inflate it.

### Ledger (`lib/ledger.ts`, `lib/ledger-analytics.ts`)

Every wallet transaction that moved either strategy token (TAO and USDC by default; override with `STRATEGY_MINTS=<mintA>,<mintB>`) is recorded and sorted:

- **position**: touches a tracked position (open, add, withdraw, collect, close).
- **swap**: TAO and USDC moved in opposite directions and nothing else did.
- **external**: money in or out of the strategy: other coins bought or sold, transfers, airdrops.
- **unclassified**: anything else, shown for the user to look at and counted as money in/out meanwhile.

Each run also records the wallet's loose TAO and USDC. With that, the change in total holdings between runs is explained as price move + fees + pool cost + swaps + money in/out, and whatever is left is shown as "unexplained". Rolls (a close, any swaps, the next open) are listed with their swap cost against the pool price. History is filled in back to the first snapshot over the first few runs.

## API

- `GET /api/positions?wallet=<address>`: open positions and total value.
- `GET /api/snapshot`: tracker status.
- `POST /api/snapshot`: take a snapshot of the tracked wallet now.
- `GET /api/analytics?wallet=<address>`: fee, APR, IL, portfolio and ledger analytics from stored snapshots. Defaults to the tracked wallet.

## Deploy

Set the same environment variables in the hosting project. For a hosted database, set `TRACKER_DB_URL` (and `TRACKER_DB_AUTH_TOKEN`) to a libsql/Turso URL; the default is the local file. The in-process timer only runs while a server is alive, so on serverless hosting call `POST /api/snapshot` from an external scheduler instead.
