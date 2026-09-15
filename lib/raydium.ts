import { Connection, PublicKey, type AccountInfo } from "@solana/web3.js";
import { decodePersonalPosition } from "./clmm-account";
import { isInRange, tickToPrice } from "./clmm-math";
import type { Position } from "./types";

// Raydium concentrated-liquidity (CLMM) program on mainnet.
const CLMM_PROGRAM_ID = new PublicKey("CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK");
const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const TOKEN_2022_PROGRAM_ID = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
const RAYDIUM_POSITION_API = "https://dynamic-ipfs.raydium.io/clmm/position";

// getMultipleAccounts accepts at most 100 pubkeys per call.
const GET_MULTIPLE_ACCOUNTS_LIMIT = 100;

// Only the fields we read from the Raydium position endpoint.
type RaydiumPositionResponse = {
  poolInfo?: {
    id?: string;
    price?: number;
    mintA?: { symbol?: string; decimals?: number };
    mintB?: { symbol?: string; decimals?: number };
  };
  positionInfo?: {
    usdValue?: number;
    amountA?: number;
    amountB?: number;
    unclaimedFee?: {
      amountA?: number;
      amountB?: number;
      usdFeeValue?: number;
      reward?: unknown[];
      usdRewardValue?: number;
      usdValue?: number;
    };
  };
};

/** A fetched position plus the full API payload, kept for the snapshot store. */
export type FetchedPosition = { position: Position; raw: unknown };

export type WalletPositions = {
  positions: FetchedPosition[];
  /** Verified on-chain positions whose Raydium API request failed this time. */
  failedPositionIds: string[];
};

export function getConnection(): Connection {
  const url = process.env.SOLANA_RPC_URL;
  const apiKey = process.env.SOLANA_RPC_API_KEY;
  if (!url || !apiKey) {
    throw new Error("SOLANA_RPC_URL and SOLANA_RPC_API_KEY must be set in .env.local");
  }
  // Some providers (Tatum) authenticate with an x-api-key header; others
  // (Helius) put the key in the URL and ignore the header.
  return new Connection(url, {
    commitment: "confirmed",
    httpHeaders: { "x-api-key": apiKey },
  });
}

/**
 * Every token account owned by the wallet that looks like an NFT (amount 1,
 * zero decimals). Raydium mints position NFTs under either the classic Token
 * program or Token-2022 depending on which open-position instruction was
 * used, so both programs are scanned.
 */
async function findCandidateNftMints(connection: Connection, wallet: PublicKey): Promise<PublicKey[]> {
  const [classic, token2022] = await Promise.all([
    connection.getParsedTokenAccountsByOwner(wallet, { programId: TOKEN_PROGRAM_ID }),
    connection.getParsedTokenAccountsByOwner(wallet, { programId: TOKEN_2022_PROGRAM_ID }),
  ]);

  const mints: PublicKey[] = [];
  for (const { account } of [...classic.value, ...token2022.value]) {
    const info = account.data.parsed?.info;
    const tokenAmount = info?.tokenAmount;
    if (tokenAmount?.amount === "1" && tokenAmount?.decimals === 0 && typeof info.mint === "string") {
      mints.push(new PublicKey(info.mint));
    }
  }
  return mints;
}

/**
 * A CLMM position account is a PDA of the CLMM program derived from the
 * position NFT's mint, with the literal seed "position".
 */
function derivePositionPda(nftMint: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("position"), nftMint.toBuffer()],
    CLMM_PROGRAM_ID,
  );
  return pda;
}

/**
 * Most NFTs in a wallet are not Raydium positions, so their derived PDA
 * simply won't exist. Keep only PDAs that exist on-chain AND are owned by the
 * CLMM program. This is the ownership check that ties a position to the
 * wallet: the Raydium API does no verification of its own and will return
 * data for any position id it's given.
 */
type VerifiedPosition = { pda: PublicKey; account: AccountInfo<Buffer> };

async function filterToRealPositions(connection: Connection, pdas: PublicKey[]): Promise<VerifiedPosition[]> {
  const verified: VerifiedPosition[] = [];
  for (let i = 0; i < pdas.length; i += GET_MULTIPLE_ACCOUNTS_LIMIT) {
    const chunk = pdas.slice(i, i + GET_MULTIPLE_ACCOUNTS_LIMIT);
    const accounts = await connection.getMultipleAccountsInfo(chunk);
    accounts.forEach((account, idx) => {
      if (account && account.owner.equals(CLMM_PROGRAM_ID)) {
        verified.push({ pda: chunk[idx], account });
      }
    });
  }
  return verified;
}

/** Fetch one position from Raydium and shape it. Returns null if closed/empty. */
async function fetchPosition({ pda, account }: VerifiedPosition): Promise<FetchedPosition | null> {
  const positionId = pda.toBase58();
  // Tick range and liquidity come from the on-chain account; the API does
  // not expose them. They drive range display and impermanent-loss maths.
  const onChain = decodePersonalPosition(account.data);
  const res = await fetch(`${RAYDIUM_POSITION_API}?id=${positionId}`, { cache: "no-store" });
  if (!res.ok) {
    throw new Error(`Raydium API returned ${res.status} for position ${positionId}`);
  }
  const data = (await res.json()) as RaydiumPositionResponse;

  // A missing or zero usdValue means the position is closed/emptied.
  const usdValue = data.positionInfo?.usdValue;
  if (!usdValue) return null;

  const symbolA = data.poolInfo?.mintA?.symbol ?? "?";
  const symbolB = data.poolInfo?.mintB?.symbol ?? "?";
  const fee = data.positionInfo?.unclaimedFee;
  const decimalsA = data.poolInfo?.mintA?.decimals ?? 0;
  const decimalsB = data.poolInfo?.mintB?.decimals ?? 0;
  const priceA = data.poolInfo?.price ?? 0;
  const range = {
    priceLower: tickToPrice(onChain.tickLower, decimalsA, decimalsB),
    priceUpper: tickToPrice(onChain.tickUpper, decimalsA, decimalsB),
  };

  // amountA/amountB are already human-readable decimals; usdValue is taken
  // as-is from the endpoint rather than recomputed from prices.
  const position: Position = {
    positionId,
    poolId: data.poolInfo?.id ?? "",
    poolName: `${symbolA}/${symbolB}`,
    usdValue,
    amountA: data.positionInfo?.amountA ?? 0,
    amountB: data.positionInfo?.amountB ?? 0,
    symbolA,
    symbolB,
    unclaimedFeeUsd: fee?.usdValue ?? 0,
    priceA,
    unclaimedFeeAmountA: fee?.amountA ?? 0,
    unclaimedFeeAmountB: fee?.amountB ?? 0,
    unclaimedRewardUsd: fee?.usdRewardValue ?? 0,
    rewards: Array.isArray(fee?.reward) ? fee.reward : [],
    decimalsA,
    decimalsB,
    tickLower: onChain.tickLower,
    tickUpper: onChain.tickUpper,
    liquidity: onChain.liquidity.toString(),
    priceLower: range.priceLower,
    priceUpper: range.priceUpper,
    inRange: isInRange(range, priceA),
  };
  return { position, raw: data };
}

/**
 * Find and fetch every open Raydium CLMM position for a wallet.
 * Throws if the RPC is unreachable; individual Raydium API failures are
 * reported in `failedPositionIds` rather than failing the whole call.
 */
export async function fetchWalletPositions(wallet: PublicKey): Promise<WalletPositions> {
  const connection = getConnection();
  const mints = await findCandidateNftMints(connection, wallet);
  const pdas = mints.map(derivePositionPda);
  const verified = await filterToRealPositions(connection, pdas);

  const results = await Promise.allSettled(verified.map(fetchPosition));
  const positions: FetchedPosition[] = [];
  const failedPositionIds: string[] = [];
  results.forEach((result, idx) => {
    if (result.status === "fulfilled") {
      if (result.value) positions.push(result.value);
    } else {
      failedPositionIds.push(verified[idx].pda.toBase58());
      console.error("Failed to fetch Raydium position:", result.reason);
    }
  });

  return { positions, failedPositionIds };
}
