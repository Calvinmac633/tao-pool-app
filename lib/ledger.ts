import { Connection, PublicKey, type ParsedTransactionWithMeta } from "@solana/web3.js";

import { getDb } from "./db";
import { CLMM_PROGRAM_ID } from "./raydium";

/**
 * The ledger: every wallet transaction that moved the strategy's two tokens,
 * sorted into what it was. Kinds:
 *   position     touches one of the tracked positions (open, add, withdraw, collect, close)
 *   swap         token A and token B moved in opposite directions and nothing else did
 *   external     money moving in or out of the strategy: buying other coins, transfers, airdrops
 *   unclassified none of the above; shown for the user to look at
 */
export type LedgerKind = "position" | "swap" | "external" | "unclassified";

export type TxFacts = {
  signature: string;
  blockTime: number; // epoch seconds
  deltaA: number; // wallet's change in token A (human units)
  deltaB: number;
  others: { mint: string; delta: number; decimals: number }[]; // other tokens that moved, non-zero only
  accountKeys: string[];
};

export type Classified = { kind: LedgerKind; positionId: string | null; note: string };

const EPS = 1e-9;

/** Pure classification so it can be unit tested. */
export function classifyTx(tx: TxFacts, knownPositions: Set<string>): Classified {
  const position = tx.accountKeys.find((k) => knownPositions.has(k)) ?? null;
  const touchesClmm = tx.accountKeys.includes(CLMM_PROGRAM_ID.toBase58());
  // A position NFT (0 decimals, +/-1) being minted or burned marks an open or
  // close. Swaps go through the same CLMM program but never touch an NFT.
  const nftMoved = tx.others.some((o) => o.decimals === 0 && Math.abs(Math.abs(o.delta) - 1) < EPS);
  const others = tx.others.filter((o) => !(o.decimals === 0 && Math.abs(Math.abs(o.delta) - 1) < EPS));
  const a = tx.deltaA, b = tx.deltaB;
  const movedA = Math.abs(a) > EPS, movedB = Math.abs(b) > EPS;

  if (position) {
    const note = a <= EPS && b <= EPS ? "deposit" : a >= -EPS && b >= -EPS ? "withdraw" : "position";
    return { kind: "position", positionId: position, note };
  }
  if (touchesClmm && nftMoved && others.length === 0 && (movedA || movedB)) {
    return { kind: "position", positionId: null, note: "untracked position" };
  }
  if (movedA && movedB && a * b < 0 && others.length === 0) {
    return { kind: "swap", positionId: null, note: a > 0 ? "bought A" : "sold A" };
  }
  if (!movedA && !movedB) {
    return { kind: "external", positionId: null, note: "no strategy tokens moved" };
  }
  if (others.length === 0 || !(movedA && movedB && a * b < 0)) {
    // One-sided or same-direction movement, with or without other tokens:
    // money in or out of the strategy.
    const dir = (movedA ? a : b) > 0 ? "in" : "out";
    const via = others.length ? ` via ${others.length} other token${others.length > 1 ? "s" : ""}` : "";
    return { kind: "external", positionId: null, note: `${dir}${via}` };
  }
  return { kind: "unclassified", positionId: null, note: "A and B moved opposite ways alongside other tokens" };
}

/** Wallet token deltas from a parsed transaction. */
export function factsFromTransaction(sig: string, blockTime: number, tx: ParsedTransactionWithMeta, wallet: string, mintA: string, mintB: string): TxFacts {
  const byMint = new Map<string, { delta: number; decimals: number }>();
  const add = (list: NonNullable<typeof tx.meta>["preTokenBalances"], sign: number) => {
    for (const b of list ?? []) {
      if (b.owner !== wallet) continue;
      const cur = byMint.get(b.mint) ?? { delta: 0, decimals: b.uiTokenAmount.decimals };
      cur.delta += sign * Number(b.uiTokenAmount.uiAmountString ?? b.uiTokenAmount.uiAmount ?? 0);
      byMint.set(b.mint, cur);
    }
  };
  add(tx.meta?.preTokenBalances, -1);
  add(tx.meta?.postTokenBalances, +1);
  const others: TxFacts["others"] = [];
  for (const [mint, v] of byMint) {
    if (mint === mintA || mint === mintB) continue;
    if (Math.abs(v.delta) > EPS) others.push({ mint, delta: v.delta, decimals: v.decimals });
  }
  const keys = tx.transaction.message.accountKeys.map((k) => k.pubkey.toBase58());
  return {
    signature: sig,
    blockTime,
    deltaA: byMint.get(mintA)?.delta ?? 0,
    deltaB: byMint.get(mintB)?.delta ?? 0,
    others,
    accountKeys: keys,
  };
}

const PAGE = 1000;
const MAX_TX_PER_RUN = 120;
const BATCH = 5; // small batches with a pause: the RPC's free tier rate-limits bursts
const BATCH_PAUSE_MS = 300;
const RETRIES = 4;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  let delay = 1000;
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (attempt >= RETRIES || !/429|Too Many Requests/.test(msg)) throw err;
      await sleep(delay);
      delay *= 2;
    }
  }
}

type SigInfo = { signature: string; blockTime?: number | null; err: unknown };

/**
 * Pull wallet transactions into the ledger. New transactions are read every
 * run; older history back to `sinceSec` is filled in a slice at a time, with
 * the cursor saved after every batch so an interrupted run loses nothing.
 */
export async function syncLedger(connection: Connection, wallet: string, mintA: string, mintB: string, sinceSec: number): Promise<{ added: number; backfillDone: boolean }> {
  const db = await getDb();
  const stateRes = await db.execute({ sql: `SELECT * FROM ledger_state WHERE wallet = ?`, args: [wallet] });
  const state = stateRes.rows[0];
  let newest = (state?.newest_signature as string | null) ?? null;
  let oldest = (state?.oldest_signature as string | null) ?? null;
  let backfillDone = Number(state?.backfill_done ?? 0) === 1;

  const positions = await db.execute({ sql: `SELECT position_id FROM positions WHERE wallet = ?`, args: [wallet] });
  const known = new Set(positions.rows.map((r) => String(r.position_id)));
  const walletKey = new PublicKey(wallet);

  // Pool price near each transaction, for swap costs.
  const priceRows = await db.execute({ sql: `SELECT taken_at, MAX(price_a) AS price FROM snapshots WHERE wallet = ? GROUP BY taken_at`, args: [wallet] });
  const prices = priceRows.rows.map((r) => ({ t: new Date(String(r.taken_at)).getTime() / 1000, price: Number(r.price) }));
  const priceNear = (t: number): number | null => {
    let best: { t: number; price: number } | null = null;
    for (const p of prices) if (!best || Math.abs(p.t - t) < Math.abs(best.t - t)) best = p;
    return best && Math.abs(best.t - t) <= 15 * 60 ? best.price : null;
  };

  const saveState = () =>
    db.execute({
      sql: `INSERT INTO ledger_state (wallet, newest_signature, oldest_signature, backfill_done, updated_at) VALUES (?, ?, ?, ?, ?)
            ON CONFLICT (wallet) DO UPDATE SET newest_signature = excluded.newest_signature, oldest_signature = excluded.oldest_signature,
              backfill_done = excluded.backfill_done, updated_at = excluded.updated_at`,
      args: [wallet, newest, oldest, backfillDone ? 1 : 0, new Date().toISOString()],
    });

  let added = 0;
  let processed = 0;

  /** Fetch, classify and store a list of signatures (any order), saving the cursor after each batch. */
  const ingest = async (sigs: SigInfo[], afterBatch: (lastSig: string) => void) => {
    const candidates = sigs.filter((s) => s.err == null && s.blockTime != null);
    for (let i = 0; i < candidates.length; i += BATCH) {
      const chunk = candidates.slice(i, i + BATCH);
      const txs = await withRetry(() => connection.getParsedTransactions(chunk.map((s) => s.signature), { maxSupportedTransactionVersion: 0 }));
      const statements = [];
      for (let j = 0; j < chunk.length; j++) {
        const tx = txs[j];
        if (!tx?.meta) continue;
        const facts = factsFromTransaction(chunk[j].signature, chunk[j].blockTime!, tx, wallet, mintA, mintB);
        if (Math.abs(facts.deltaA) < EPS && Math.abs(facts.deltaB) < EPS) continue; // nothing of ours moved
        const c = classifyTx(facts, known);
        const price = priceNear(facts.blockTime);
        // Swap cost: value received minus value at the pool price. Negative = cost.
        const swapCost = c.kind === "swap" && price != null ? facts.deltaA * price + facts.deltaB : null;
        statements.push({
          sql: `INSERT OR IGNORE INTO wallet_txs (signature, wallet, block_time, delta_a, delta_b, others_json, account_keys_json, kind, position_id, note, price_a, swap_cost_b)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          args: [facts.signature, wallet, new Date(facts.blockTime * 1000).toISOString(), facts.deltaA, facts.deltaB, JSON.stringify(facts.others), JSON.stringify(facts.accountKeys), c.kind, c.positionId, c.note, price, swapCost],
        });
      }
      if (statements.length) {
        const results = await db.batch(statements, "write");
        added += results.reduce((s, r) => s + Number(r.rowsAffected ?? 0), 0);
      }
      processed += chunk.length;
      afterBatch(chunk[chunk.length - 1].signature);
      await saveState();
      await sleep(BATCH_PAUSE_MS);
    }
  };

  // 1. Anything newer than the newest we have (usually a handful).
  if (newest) {
    const fresh: SigInfo[] = [];
    let before: string | undefined;
    for (let page = 0; page < 5; page++) {
      const sigs = await withRetry(() => connection.getSignaturesForAddress(walletKey, { before, until: newest!, limit: PAGE }));
      if (sigs.length === 0) break;
      fresh.push(...sigs);
      before = sigs[sigs.length - 1].signature;
      if (sigs.length < PAGE) break;
    }
    if (fresh.length) {
      const top = fresh[0].signature;
      await ingest(fresh.slice(0, MAX_TX_PER_RUN), () => {});
      newest = top;
      await saveState();
    }
  }

  // 2. Fill in history, newest first, a slice per run, until the tracking start.
  if (!backfillDone && processed < MAX_TX_PER_RUN) {
    const sigs = await withRetry(() => connection.getSignaturesForAddress(walletKey, { before: oldest ?? undefined, limit: PAGE }));
    if (sigs.length === 0) {
      backfillDone = true;
    } else {
      if (!newest) newest = sigs[0].signature; // first ever run: everything newer than this is "new" next time
      const inRange = sigs.filter((s) => (s.blockTime ?? 0) >= sinceSec);
      const reachedStart = inRange.length < sigs.length || sigs.length < PAGE;
      const slice = inRange.slice(0, MAX_TX_PER_RUN - processed);
      await ingest(slice, (last) => { oldest = last; });
      if (slice.length === inRange.length && reachedStart) backfillDone = true;
      else if (slice.length === 0 && reachedStart) backfillDone = true;
    }
    await saveState();
  }

  return { added, backfillDone };
}

/**
 * Re-run classification over stored transactions, e.g. after a new position
 * becomes known or the rules change. Swap costs are recomputed too.
 */
export async function reclassifyLedger(wallet: string): Promise<number> {
  const db = await getDb();
  const positions = await db.execute({ sql: `SELECT position_id FROM positions WHERE wallet = ?`, args: [wallet] });
  const known = new Set(positions.rows.map((r) => String(r.position_id)));
  const rows = await db.execute({ sql: `SELECT signature, kind, note, position_id, delta_a, delta_b, others_json, account_keys_json, price_a FROM wallet_txs WHERE wallet = ? AND account_keys_json IS NOT NULL`, args: [wallet] });
  let changed = 0;
  for (const r of rows.rows) {
    const facts: TxFacts = {
      signature: String(r.signature), blockTime: 0, deltaA: Number(r.delta_a), deltaB: Number(r.delta_b),
      others: JSON.parse(String(r.others_json)), accountKeys: JSON.parse(String(r.account_keys_json)),
    };
    const c = classifyTx(facts, known);
    if (c.kind === r.kind && c.note === r.note && (c.positionId ?? null) === (r.position_id ?? null)) continue;
    const price = r.price_a == null ? null : Number(r.price_a);
    const swapCost = c.kind === "swap" && price != null ? facts.deltaA * price + facts.deltaB : null;
    await db.execute({ sql: `UPDATE wallet_txs SET kind = ?, position_id = ?, note = ?, swap_cost_b = ? WHERE signature = ?`, args: [c.kind, c.positionId, c.note, swapCost, facts.signature] });
    changed++;
  }
  return changed;
}
