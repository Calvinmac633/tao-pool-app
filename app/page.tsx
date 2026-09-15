"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";
import type { Position, PositionsResponse, TrackingStatus } from "@/lib/types";

const usd = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const NETWORK_ERROR = "Couldn't reach the network. Try again.";

async function loadTrackingStatus(): Promise<TrackingStatus | null> {
  try {
    const res = await fetch("/api/snapshot");
    return res.ok ? ((await res.json()) as TrackingStatus) : null;
  } catch {
    // Tracking status is informational; ignore failures.
    return null;
  }
}

export default function Home() {
  const [wallet, setWallet] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<PositionsResponse | null>(null);
  const [loadedWallet, setLoadedWallet] = useState<string | null>(null);
  const [tracking, setTracking] = useState<TrackingStatus | null>(null);

  const applyTracking = useCallback((status: TrackingStatus | null) => {
    if (!status) return;
    setTracking(status);
    // Prefill the tracked wallet for convenience if the input is still empty.
    const tracked = status.trackedWallet;
    if (tracked) setWallet((current) => current || tracked);
  }, []);

  const refreshTracking = useCallback(
    () => loadTrackingStatus().then(applyTracking),
    [applyTracking],
  );

  // Load tracking status on mount.
  useEffect(() => {
    let cancelled = false;
    loadTrackingStatus().then((status) => {
      if (!cancelled) applyTracking(status);
    });
    return () => {
      cancelled = true;
    };
  }, [applyTracking]);

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const address = wallet.trim();
    if (!address || loading) return;

    setLoading(true);
    setError(null);
    setResult(null);
    setLoadedWallet(null);
    try {
      const res = await fetch(`/api/positions?wallet=${encodeURIComponent(address)}`);
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        setError(body?.error ?? NETWORK_ERROR);
        return;
      }
      setResult(body as PositionsResponse);
      setLoadedWallet(address);
    } catch {
      setError(NETWORK_ERROR);
    } finally {
      setLoading(false);
    }
  }

  const isTrackedWallet = !!tracking?.trackedWallet && loadedWallet === tracking.trackedWallet;

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

        {result && isTrackedWallet && tracking && (
          <TrackingLine status={tracking} onRefresh={refreshTracking} />
        )}
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

/** Small status line for the wallet that the background tracker is snapshotting. */
function TrackingLine({ status, onRefresh }: { status: TrackingStatus; onRefresh: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function snapshotNow() {
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch("/api/snapshot", { method: "POST" });
      const body = await res.json().catch(() => null);
      setMessage(res.ok ? `Snapshot saved (${body.positionsFound} positions).` : body?.error ?? NETWORK_ERROR);
      await onRefresh();
    } catch {
      setMessage(NETWORK_ERROR);
    } finally {
      setBusy(false);
    }
  }

  const summary =
    status.runs === 0
      ? "No snapshots recorded yet."
      : `Tracking since ${formatDate(status.firstRunAt)} · ${status.runs} snapshot${status.runs === 1 ? "" : "s"} · last ${formatAgo(status.lastRunAt)}`;

  return (
    <div className="mt-6 flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-neutral-200 pt-4 text-xs text-neutral-500 dark:border-neutral-800">
      <span>{summary}</span>
      <span>· every {status.intervalMinutes} min</span>
      <button
        type="button"
        onClick={snapshotNow}
        disabled={busy}
        className="rounded border border-neutral-300 px-2 py-0.5 text-xs disabled:opacity-50 dark:border-neutral-700"
      >
        {busy ? "Saving…" : "Snapshot now"}
      </button>
      {status.lastStatus === "failed" && (
        <span className="text-red-600 dark:text-red-400">Last snapshot failed.</span>
      )}
      {message && <span>{message}</span>}
    </div>
  );
}

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });
}

function formatAgo(iso: string | null): string {
  if (!iso) return "—";
  const minutes = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}
