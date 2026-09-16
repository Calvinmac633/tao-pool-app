import { Connection, PublicKey, type TokenBalance } from "@solana/web3.js";

/**
 * What the chain tells us about a position's start: when it was opened, and
 * which tokens the wallet paid in before we began snapshotting it. The
 * position account stores no timestamp, so this comes from the transactions
 * that touched the position address.
 */
export type PositionOpen = {
  openedAt: string; // ISO, from the oldest successful transaction
  signature: string; // that transaction
  depositA: number | null; // total paid in across all transactions up to `before`; null if never touched
  depositB: number | null;
  transactions: number; // transactions inspected
};

export type Deposit = { depositA: number | null; depositB: number | null };

const SIGNATURE_PAGE = 1000;
const MAX_PAGES = 20;
const MAX_TRANSACTIONS = 50;

/** All successful transactions that reference `address`, oldest first. */
async function findSignatures(connection: Connection, address: PublicKey) {
  const all: { signature: string; blockTime?: number | null }[] = [];
  let before: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const sigs = await connection.getSignaturesForAddress(address, { before, limit: SIGNATURE_PAGE });
    if (sigs.length === 0) break;
    all.push(...sigs.filter((s) => s.err == null));
    before = sigs[sigs.length - 1].signature;
    if (sigs.length < SIGNATURE_PAGE) break;
  }
  return all.reverse();
}

/**
 * Tokens the wallet paid into one transaction, per mint, from the token
 * balance diff. Withdrawals (balance increases) count as zero: from balances
 * alone a fee collection and a partial withdrawal look the same, and
 * treating either as negative entry would be wrong for collections.
 */
export function depositsFromBalances(
  pre: TokenBalance[],
  post: TokenBalance[],
  wallet: string,
  mintA: string,
  mintB: string,
): Deposit {
  const sum = (list: TokenBalance[], mint: string) =>
    list
      .filter((b) => b.owner === wallet && b.mint === mint)
      .reduce((acc, b) => acc + Number(b.uiTokenAmount.uiAmountString ?? b.uiTokenAmount.uiAmount ?? 0), 0);
  const touched = (mint: string) => pre.some((b) => b.owner === wallet && b.mint === mint) || post.some((b) => b.owner === wallet && b.mint === mint);
  const delta = (mint: string) => (touched(mint) ? Math.max(0, sum(pre, mint) - sum(post, mint)) : null);
  return { depositA: delta(mintA), depositB: delta(mintB) };
}

/** Sum per-transaction deposits; a mint stays null only if no transaction touched it. */
export function accumulateDeposits(deposits: Deposit[]): Deposit {
  const add = (a: number | null, b: number | null) => (a == null && b == null ? null : (a ?? 0) + (b ?? 0));
  return deposits.reduce<Deposit>((acc, d) => ({ depositA: add(acc.depositA, d.depositA), depositB: add(acc.depositB, d.depositB) }), {
    depositA: null,
    depositB: null,
  });
}

/**
 * Open time and total deposit for a position, counting transactions up to
 * and including `before` (the position's first snapshot). Later adds are
 * detected from liquidity changes between snapshots, so they must not be
 * counted here too.
 */
export async function lookupPositionOpen(
  connection: Connection,
  positionPda: PublicKey,
  wallet: string,
  mintA: string,
  mintB: string,
  before: Date,
): Promise<PositionOpen | null> {
  const sigs = await findSignatures(connection, positionPda);
  const oldest = sigs[0];
  if (!oldest || oldest.blockTime == null) return null;

  const beforeSec = before.getTime() / 1000;
  const relevant = sigs.filter((s) => s.blockTime != null && s.blockTime <= beforeSec).slice(0, MAX_TRANSACTIONS);
  const deposits: Deposit[] = [];
  for (const s of relevant) {
    try {
      const tx = await connection.getParsedTransaction(s.signature, { maxSupportedTransactionVersion: 0 });
      if (tx?.meta) {
        deposits.push(depositsFromBalances(tx.meta.preTokenBalances ?? [], tx.meta.postTokenBalances ?? [], wallet, mintA, mintB));
      }
    } catch (err) {
      console.error("Failed to load position transaction", s.signature, err instanceof Error ? err.message : err);
    }
  }

  return {
    openedAt: new Date(oldest.blockTime * 1000).toISOString(),
    signature: oldest.signature,
    ...accumulateDeposits(deposits),
    transactions: relevant.length,
  };
}
