"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";
import type { Position, PositionsResponse, TrackingStatus, WalletAnalytics } from "@/lib/types";
import { ClosedPositionsTable, OpenPositionCards, OpenPositionsPanel, OverallPanel } from "./analytics-panels";
import { aprText, formatAgo, formatDate, price, usd, WINDOW_SECONDS } from "./format";

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

async function loadAnalytics(wallet: string): Promise<WalletAnalytics | null> {
  try {
    const res = await fetch(`/api/analytics?wallet=${encodeURIComponent(wallet)}`);
    return res.ok ? ((await res.json()) as WalletAnalytics) : null;
  } catch {
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
  const [analytics, setAnalytics] = useState<WalletAnalytics | null>(null);

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

  const isTrackedWallet = !!tracking?.trackedWallet && loadedWallet === tracking.trackedWallet;

  const refreshAnalytics = useCallback(async (address: string) => {
    setAnalytics(await loadAnalytics(address));
  }, []);

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const address = wallet.trim();
    if (!address || loading) return;

    setLoading(true);
    setError(null);
    setResult(null);
    setLoadedWallet(null);
    setAnalytics(null);
    try {
      const res = await fetch(`/api/positions?wallet=${encodeURIComponent(address)}`);
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        setError(body?.error ?? NETWORK_ERROR);
        return;
      }
      setResult(body as PositionsResponse);
      setLoadedWallet(address);
      if (tracking?.trackedWallet === address) {
        await refreshAnalytics(address);
      }
    } catch {
      setError(NETWORK_ERROR);
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

        {result && result.positions.length > 0 && <Results data={result} analytics={analytics} />}

        {result && isTrackedWallet && tracking && (
          <TrackingLine
            status={tracking}
            onRefresh={async () => {
              await refreshTracking();
              if (loadedWallet) await refreshAnalytics(loadedWallet);
            }}
          />
        )}
      </section>

      {analytics && (
        <>
          <OpenPositionsPanel data={analytics} />
          <OpenPositionCards positions={analytics.open} asOf={analytics.asOf} />
          <ClosedPositionsTable positions={analytics.closed} total={analytics.history.closedCount} />
          <OverallPanel data={analytics} />
        </>
      )}
    </main>
  );
}

function Results({ data, analytics }: { data: PositionsResponse; analytics: WalletAnalytics | null }) {
  const byId = new Map(analytics?.open.map((a) => [a.positionId, a]) ?? []);
  return (
    <div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-neutral-300 text-left text-neutral-600 dark:border-neutral-700 dark:text-neutral-400">
              <th className="py-2 pr-4 font-medium">Pool</th>
              <th className="py-2 pr-4 text-right font-medium">Value (USD)</th>
              <th className="py-2 pr-4 text-right font-medium">Uncollected fees (USD)</th>
              {analytics && <th className="py-2 text-right font-medium">Fee APR (24h)</th>}
            </tr>
          </thead>
          <tbody>
            {data.positions.map((p: Position) => {
              const a = byId.get(p.positionId);
              return (
                <tr key={p.positionId} className="border-b border-neutral-200 dark:border-neutral-800">
                  <td className="py-2 pr-4">
                    <div>
                      {p.poolName}{" "}
                      <span className="text-xs text-neutral-500">
                        {price(p.priceLower)} – {price(p.priceUpper)} · {p.inRange ? "in range" : "out of range"}
                      </span>
                    </div>
                    <div className="font-mono text-xs text-neutral-500">{p.positionId}</div>
                  </td>
                  <td className="py-2 pr-4 text-right tabular-nums">{usd(p.usdValue)}</td>
                  <td className="py-2 pr-4 text-right tabular-nums">{usd(p.unclaimedFeeUsd)}</td>
                  {analytics && (
                    <td className="py-2 text-right tabular-nums">{aprText(a?.windows["24h"], WINDOW_SECONDS["24h"])}</td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="mt-4 text-right text-lg font-semibold tabular-nums">
        Total: {usd(data.totalUsdValue)}
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
