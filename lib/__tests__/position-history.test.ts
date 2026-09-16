import { test } from "node:test";
import assert from "node:assert/strict";
import { accumulateDeposits, depositsFromBalances } from "../position-history";
import type { TokenBalance } from "@solana/web3.js";

const bal = (owner: string, mint: string, ui: string): TokenBalance => ({
  accountIndex: 0,
  mint,
  owner,
  uiTokenAmount: { amount: "0", decimals: 6, uiAmount: Number(ui), uiAmountString: ui },
});

const W = "wallet";

test("deposits are the wallet's balance decrease per mint", () => {
  const pre = [bal(W, "A", "10"), bal(W, "B", "100"), bal("someone", "A", "5")];
  const post = [bal(W, "A", "7"), bal(W, "B", "40"), bal("someone", "A", "5")];
  const d = depositsFromBalances(pre, post, W, "A", "B");
  assert.equal(d.depositA, 3);
  assert.equal(d.depositB, 60);
});

test("a mint the wallet never touched is unknown, and increases clamp to zero", () => {
  const pre = [bal(W, "A", "10")];
  const post = [bal(W, "A", "12")];
  const d = depositsFromBalances(pre, post, W, "A", "B");
  assert.equal(d.depositA, 0);
  assert.equal(d.depositB, null);
});

test("deposits across several transactions add up, ignoring withdrawals", () => {
  const total = accumulateDeposits([
    { depositA: 10, depositB: 100 },
    { depositA: 0, depositB: 0 }, // a fee collection: balances only went up
    { depositA: 2, depositB: null },
  ]);
  assert.equal(total.depositA, 12);
  assert.equal(total.depositB, 100);
  assert.deepEqual(accumulateDeposits([]), { depositA: null, depositB: null });
});
