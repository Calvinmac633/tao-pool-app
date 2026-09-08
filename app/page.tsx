"use client";

import { FormEvent, useState } from "react";
import type { Position, PositionsResponse } from "./api/positions/route";

const usd = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

export default function Home() {
  const [wallet, setWallet] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<PositionsResponse | null>(null);

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const address = wallet.trim();
    if (!address || loading) return;

    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch(`/api/positions?wallet=${encodeURIComponent(address)}`);
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        setError(body?.error ?? "Couldn't reach the network. Try again.");
        return;
      }
      setResult(body as PositionsResponse);
    } catch {
      setError("Couldn't reach the network. Try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="mx-auto w-full max-w-[900px] px-6 py-12">
      <h1 className="text-2xl font-semibold">Raydium CLMM positions</h1>
      <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
        Enter a Solana wallet address to see its open Raydium concentrated-liquidity positions.
      </p>

      <form onSubmit={handleSubmit} className="mt-6 flex gap-2">
        <input
          type="text"
          value={wallet}
          onChange={(e) => setWallet(e.target.value)}
          placeholder="Wallet address"
          spellCheck={false}
          autoComplete="off"
          className="flex-1 rounded border border-neutral-300 bg-transparent px-3 py-2 font-mono text-sm outline-none focus:border-neutral-500 dark:border-neutral-700"
        />
        <button
          type="submit"
          disabled={loading || !wallet.trim()}
          className="rounded bg-neutral-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50 dark:bg-neutral-100 dark:text-neutral-900"
        >
          {loading ? "Loading…" : "Load positions"}
        </button>
      </form>

      <section className="mt-8">
        {loading && <p className="text-sm text-neutral-600 dark:text-neutral-400">Loading…</p>}

        {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}

        {result && result.positions.length === 0 && (
          <p className="text-sm text-neutral-600 dark:text-neutral-400">
            No open Raydium CLMM positions found for this wallet.
          </p>
        )}

        {result && result.positions.length > 0 && <Results data={result} />}
      </section>
    </main>
  );
}

function Results({ data }: { data: PositionsResponse }) {
  return (
    <div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-neutral-300 text-left text-neutral-600 dark:border-neutral-700 dark:text-neutral-400">
              <th className="py-2 pr-4 font-medium">Pool</th>
              <th className="py-2 pr-4 text-right font-medium">Value (USD)</th>
              <th className="py-2 text-right font-medium">Uncollected fees (USD)</th>
            </tr>
          </thead>
          <tbody>
            {data.positions.map((p: Position) => (
              <tr key={p.positionId} className="border-b border-neutral-200 dark:border-neutral-800">
                <td className="py-2 pr-4">
                  <div>{p.poolName}</div>
                  <div className="font-mono text-xs text-neutral-500">{p.positionId}</div>
                </td>
                <td className="py-2 pr-4 text-right tabular-nums">{usd.format(p.usdValue)}</td>
                <td className="py-2 text-right tabular-nums">{usd.format(p.unclaimedFeeUsd)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-4 text-right text-lg font-semibold tabular-nums">
        Total: {usd.format(data.totalUsdValue)}
      </p>
    </div>
  );
}
