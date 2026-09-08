# Raydium CLMM Position Viewer

Enter a Solana wallet address and see its open Raydium concentrated-liquidity (CLMM) positions: pool name, USD value, and uncollected fees.

## Setup

```bash
npm install
cp .env.local.example .env.local
```

Open `.env.local` and paste your Tatum API key:

```
SOLANA_RPC_URL=https://solana-mainnet.gateway.tatum.io
SOLANA_RPC_API_KEY=<your Tatum key>
```

Both variables are read only on the server (in `app/api/positions/route.ts`), so the key never reaches the browser. `.env.local` is git-ignored.

## Run

```bash
npm run dev
```

Then open [http://localhost:3000](http://localhost:3000).

## How it works

1. `GET /api/positions?wallet=<address>` validates the address.
2. Lists the wallet's token accounts under both the classic Token program and Token-2022, keeping NFT-like accounts (amount 1, zero decimals).
3. Derives the Raydium CLMM position PDA for each NFT mint (seed `"position"` + mint).
4. Checks on-chain which PDAs exist and are owned by the CLMM program. This is the ownership check; the Raydium API does not verify ownership itself.
5. Fetches each verified position from `https://dynamic-ipfs.raydium.io/clmm/position?id=<pda>` and drops positions with zero USD value.

## Deploy

No changes are needed for Vercel. Set the same two environment variables in the project settings.
