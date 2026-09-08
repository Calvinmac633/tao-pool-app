import { Connection, PublicKey } from "@solana/web3.js";

// Raydium concentrated-liquidity (CLMM) program on mainnet.
const CLMM_PROGRAM_ID = new PublicKey("CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK");
const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const TOKEN_2022_PROGRAM_ID = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
const RAYDIUM_POSITION_API = "https://dynamic-ipfs.raydium.io/clmm/position";

// getMultipleAccounts accepts at most 100 pubkeys per call.
const GET_MULTIPLE_ACCOUNTS_LIMIT = 100;

export type Position = {
  positionId: string;
  poolId: string;
  poolName: string;
  usdValue: number;
  amountA: number;
  amountB: number;
  symbolA: string;
  symbolB: string;
  unclaimedFeeUsd: number;
};

export type PositionsResponse = {
  positions: Position[];
  totalUsdValue: number;
};

// Only the fields we read from the Raydium position endpoint.
type RaydiumPositionResponse = {
  poolInfo?: {
    id?: string;
    mintA?: { symbol?: string };
    mintB?: { symbol?: string };
  };
  positionInfo?: {
    usdValue?: number;
    amountA?: number;
    amountB?: number;
    unclaimedFee?: { usdValue?: number };
  };
};

function getConnection(): Connection {
  const url = process.env.SOLANA_RPC_URL;
  const apiKey = process.env.SOLANA_RPC_API_KEY;
  if (!url || !apiKey) {
    throw new Error("SOLANA_RPC_URL and SOLANA_RPC_API_KEY must be set in .env.local");
  }
  // Tatum authenticates with an x-api-key header, not a query parameter.
  return new Connection(url, {
    commitment: "confirmed",
    httpHeaders: { "x-api-key": apiKey },
  });
}

/**
 * Step 2: every token account owned by the wallet that looks like an NFT
 * (amount 1, zero decimals). Raydium mints position NFTs under either the
 * classic Token program or Token-2022 depending on which open-position
 * instruction was used, so both programs are scanned.
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
 * Step 3: a CLMM position account is a PDA of the CLMM program derived from
 * the position NFT's mint, with the literal seed "position".
 */
function derivePositionPda(nftMint: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("position"), nftMint.toBuffer()],
    CLMM_PROGRAM_ID,
  );
  return pda;
}

/**
 * Step 4: most NFTs in a wallet are not Raydium positions, so their derived
 * PDA simply won't exist. Keep only PDAs that exist on-chain AND are owned by
 * the CLMM program. This is the ownership check that ties a position to the
 * wallet: the Raydium API below does no verification of its own and will
 * return data for any position id it's given.
 */
async function filterToRealPositions(connection: Connection, pdas: PublicKey[]): Promise<PublicKey[]> {
  const verified: PublicKey[] = [];
  for (let i = 0; i < pdas.length; i += GET_MULTIPLE_ACCOUNTS_LIMIT) {
    const chunk = pdas.slice(i, i + GET_MULTIPLE_ACCOUNTS_LIMIT);
    const accounts = await connection.getMultipleAccountsInfo(chunk);
    accounts.forEach((account, idx) => {
      if (account && account.owner.equals(CLMM_PROGRAM_ID)) {
        verified.push(chunk[idx]);
      }
    });
  }
  return verified;
}

/** Step 5: fetch one position from Raydium and shape it. */
async function fetchPosition(positionPda: PublicKey): Promise<Position | null> {
  const positionId = positionPda.toBase58();
  const res = await fetch(`${RAYDIUM_POSITION_API}?id=${positionId}`, { cache: "no-store" });
  if (!res.ok) {
    throw new Error(`Raydium API returned ${res.status} for position ${positionId}`);
  }
  const data = (await res.json()) as RaydiumPositionResponse;

  // Step 6: a missing or zero usdValue means the position is closed/emptied.
  const usdValue = data.positionInfo?.usdValue;
  if (!usdValue) return null;

  const symbolA = data.poolInfo?.mintA?.symbol ?? "?";
  const symbolB = data.poolInfo?.mintB?.symbol ?? "?";

  // amountA/amountB are already human-readable decimals; usdValue is taken
  // as-is from the endpoint rather than recomputed from prices.
  return {
    positionId,
    poolId: data.poolInfo?.id ?? "",
    poolName: `${symbolA}/${symbolB}`,
    usdValue,
    amountA: data.positionInfo?.amountA ?? 0,
    amountB: data.positionInfo?.amountB ?? 0,
    symbolA,
    symbolB,
    unclaimedFeeUsd: data.positionInfo?.unclaimedFee?.usdValue ?? 0,
  };
}

export async function GET(request: Request): Promise<Response> {
  // Step 1: validate the wallet address.
  const raw = new URL(request.url).searchParams.get("wallet")?.trim() ?? "";
  let wallet: PublicKey;
  try {
    wallet = new PublicKey(raw);
  } catch {
    return Response.json({ error: "That doesn't look like a valid Solana address." }, { status: 400 });
  }

  try {
    const connection = getConnection();
    const mints = await findCandidateNftMints(connection, wallet);
    const pdas = mints.map(derivePositionPda);
    const verified = await filterToRealPositions(connection, pdas);

    // One failed Raydium request should not sink the whole response.
    const results = await Promise.allSettled(verified.map(fetchPosition));
    const positions: Position[] = [];
    for (const result of results) {
      if (result.status === "fulfilled") {
        if (result.value) positions.push(result.value);
      } else {
        console.error("Failed to fetch Raydium position:", result.reason);
      }
    }

    const totalUsdValue = positions.reduce((sum, p) => sum + p.usdValue, 0);
    const body: PositionsResponse = { positions, totalUsdValue };
    return Response.json(body);
  } catch (err) {
    console.error("Failed to load positions:", err);
    return Response.json({ error: "Couldn't reach the network. Try again." }, { status: 502 });
  }
}
