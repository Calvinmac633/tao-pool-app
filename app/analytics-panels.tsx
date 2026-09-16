"use client";

import { useState } from "react";
import type { PositionAnalytics, Projection, WalletAnalytics, WindowStats } from "@/lib/types";
import { amount, formatDate, formatDuration, pct, pctSigned, price, usd, usdSigned } from "./format";

const WINDOW_SECONDS: Record<string, number> = { "1h": 3600, "6h": 6 * 3600, "24h": 24 * 3600, "7d": 7 * 24 * 3600 };

/** APR text with a coverage note when the window isn't fully backed by data. */
function aprText(w: WindowStats | undefined, windowSeconds?: number): string {
  if (!w || w.apr == null || w.coveredSeconds < 600) return "—";
  const base = pct(w.apr, 0);
  if (windowSeconds && w.coveredSeconds < windowSeconds * 0.9) {
    return `${base} (${formatDuration(w.coveredSeconds)} of data)`;
  }
  return base;
}

const gain = (n: number) => (n >= 0 ? "text-emerald-700 dark:text-emerald-400" : "text-red-600 dark:text-red-400");

export function PortfolioPanel({ data }: { data: WalletAnalytics }) {
  const p = data.portfolio;
  const [target, setTarget] = useState("50000");

  // Size capital off the longest window with at least a day of coverage.
  const basis = p.windows["7d"]?.coveredSeconds >= 86400 ? "7d" : "24h";
  const basisApr = p.windows[basis]?.apr ?? null;
  const targetNum = Number(target.replace(/[^0-9.]/g, ""));
  const needed = basisApr && basisApr > 0 && targetNum > 0 ? targetNum / basisApr : null;

  return (
    <section className="mt-10">
      <h2 className="text-lg font-semibold">Portfolio</h2>
      <p className="mt-1 text-xs text-neutral-500">
        Fees earned across all positions, with APR on time-weighted capital. Tracking since {formatDate(p.trackingStartedAt)}.
      </p>
      <div className="mt-3 overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-neutral-300 text-left text-neutral-600 dark:border-neutral-700 dark:text-neutral-400">
              <th className="py-2 pr-4 font-medium">Window</th>
              <th className="py-2 pr-4 text-right font-medium">Fees earned</th>
              <th className="py-2 pr-4 text-right font-medium">Avg capital</th>
              <th className="py-2 text-right font-medium">APR</th>
            </tr>
          </thead>
          <tbody>
            {["24h", "7d"].map((k) => (
              <tr key={k} className="border-b border-neutral-200 dark:border-neutral-800">
                <td className="py-2 pr-4">{k}</td>
                <td className="py-2 pr-4 text-right tabular-nums">{usd(p.windows[k]?.earnedUsd ?? 0)}</td>
                <td className="py-2 pr-4 text-right tabular-nums">{usd(p.windows[k]?.avgCapitalUsd ?? 0)}</td>
                <td className="py-2 text-right tabular-nums">{aprText(p.windows[k], WINDOW_SECONDS[k])}</td>
              </tr>
            ))}
            <tr className="border-b border-neutral-200 dark:border-neutral-800">
              <td className="py-2 pr-4">Since tracking</td>
              <td className="py-2 pr-4 text-right tabular-nums">{usd(p.sinceStart.earnedUsd)}</td>
              <td className="py-2 pr-4 text-right tabular-nums">{usd(p.sinceStart.avgCapitalUsd)}</td>
              <td className="py-2 text-right tabular-nums">{aprText(p.sinceStart)}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2 text-sm">
        <label htmlFor="target">Capital needed for</label>
        <input
          id="target"
          value={target}
          onChange={(e) => setTarget(e.target.value)}
          inputMode="decimal"
          className="w-28 rounded border border-neutral-300 bg-transparent px-2 py-1 text-right tabular-nums outline-none focus:border-neutral-500 dark:border-neutral-700"
        />
        <span>per year at the {basis} APR:</span>
        <span className="font-semibold tabular-nums">{needed ? usd(needed) : "—"}</span>
      </div>
    </section>
  );
}

export function OpenPositionCards({ positions, asOf }: { positions: PositionAnalytics[]; asOf: string | null }) {
  if (positions.length === 0) return null;
  return (
    <section className="mt-10">
      <h2 className="text-lg font-semibold">Position performance</h2>
      <p className="mt-1 text-xs text-neutral-500">As of the last snapshot, {formatDate(asOf)}.</p>
      <div className="mt-3 grid gap-4">
        {positions.map((p) => (
          <PositionCard key={p.positionId} p={p} />
        ))}
      </div>
    </section>
  );
}

function PositionCard({ p }: { p: PositionAnalytics }) {
  const since = p.preExisting ? "since tracking" : "since open";
  return (
    <div className="rounded border border-neutral-200 p-4 text-sm dark:border-neutral-800">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <span className="font-medium">{p.poolName}</span>{" "}
          <span className="text-neutral-500">
            {price(p.priceLower)} – {price(p.priceUpper)} {p.symbolB} · {p.inRange ? "in range" : "out of range"}
          </span>
          <div className="font-mono text-xs text-neutral-500">{p.positionId}</div>
        </div>
        <div className="text-xs text-neutral-500">
          {p.openedAtKnown ? `Opened ${formatDate(p.openedAt)}` : `First seen ${formatDate(p.openedAt)}`}
          {p.preExisting ? " · fees before tracking excluded" : ""} · {formatDuration(p.lifetime.coveredSeconds)} tracked
        </div>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-4">
        <Stat label="Value" value={usd(p.lastUsdValue)} />
        <Stat label={`Fees earned ${since}`} value={usd(p.lifetime.earnedUsd)} sub={p.collectedUsd > 0 ? `${usd(p.collectedUsd)} collected` : undefined} />
        <Stat label="Impermanent loss now" value={usdSigned(p.ilUsd)} sub={pctSigned(p.ilPct)} tone={gain(p.ilUsd)} />
        <Stat label={`Net ${since}`} value={usdSigned(p.netUsd)} sub="IL + fees" tone={gain(p.netUsd)} />
      </div>

      <div className="mt-4 overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-left text-neutral-500">
              <th className="py-1 pr-3 font-medium">Window</th>
              {["1h", "6h", "24h", "7d"].map((k) => (
                <th key={k} className="py-1 pr-3 text-right font-medium">{k}</th>
              ))}
              <th className="py-1 text-right font-medium">{since}</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td className="py-1 pr-3 text-neutral-500">Fees</td>
              {["1h", "6h", "24h", "7d"].map((k) => (
                <td key={k} className="py-1 pr-3 text-right tabular-nums">{p.windows[k] ? usd(p.windows[k].earnedUsd) : "—"}</td>
              ))}
              <td className="py-1 text-right tabular-nums">{usd(p.lifetime.earnedUsd)}</td>
            </tr>
            <tr>
              <td className="py-1 pr-3 text-neutral-500">APR</td>
              {["1h", "6h", "24h", "7d"].map((k) => (
                <td key={k} className="py-1 pr-3 text-right tabular-nums">{aprText(p.windows[k], WINDOW_SECONDS[k])}</td>
              ))}
              <td className="py-1 text-right tabular-nums">{aprText(p.lifetime)}</td>
            </tr>
          </tbody>
        </table>
      </div>

      {p.projections && (
        <div className="mt-4">
          <div className="text-xs text-neutral-500">
            Impermanent loss versus holding the entry tokens ({amount(p.entry.amountA)} {p.symbolA} + {amount(p.entry.amountB, 2)} {p.symbolB},{" "}
            {p.entry.source === "chain" ? "from the open transaction" : "from the first snapshot"}
            {p.entry.adjustments > 0 ? `, adjusted for ${p.entry.adjustments} liquidity change${p.entry.adjustments > 1 ? "s" : ""}` : ""}).
            Fees are not included in the projections.
          </div>
          <div className="mt-2 overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left text-neutral-500">
                  <th className="py-1 pr-3 font-medium">If price is</th>
                  <th className="py-1 pr-3 text-right font-medium">Position holds</th>
                  <th className="py-1 pr-3 text-right font-medium">Position value</th>
                  <th className="py-1 pr-3 text-right font-medium">Hold value</th>
                  <th className="py-1 text-right font-medium">IL</th>
                </tr>
              </thead>
              <tbody>
                <ProjectionRow label={`Lower bound ${price(p.priceLower)}`} pr={p.projections.lower} p={p} />
                <ProjectionRow label={`Now ${price(p.lastPrice)}`} pr={p.projections.current} p={p} />
                <ProjectionRow label={`Upper bound ${price(p.priceUpper)}`} pr={p.projections.upper} p={p} />
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

function ProjectionRow({ label, pr, p }: { label: string; pr: Projection; p: PositionAnalytics }) {
  return (
    <tr className="border-t border-neutral-100 dark:border-neutral-800">
      <td className="py-1 pr-3">{label}</td>
      <td className="py-1 pr-3 text-right tabular-nums">
        {amount(pr.amountA)} {p.symbolA} + {amount(pr.amountB, 2)} {p.symbolB}
      </td>
      <td className="py-1 pr-3 text-right tabular-nums">{usd(pr.positionUsd)}</td>
      <td className="py-1 pr-3 text-right tabular-nums">{usd(pr.hodlUsd)}</td>
      <td className={`py-1 text-right tabular-nums ${gain(pr.ilUsd)}`}>
        {usdSigned(pr.ilUsd)} ({pctSigned(pr.ilPct)})
      </td>
    </tr>
  );
}

function Stat({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: string }) {
  return (
    <div>
      <div className="text-xs text-neutral-500">{label}</div>
      <div className={`font-semibold tabular-nums ${tone ?? ""}`}>{value}</div>
      {sub && <div className="text-xs text-neutral-500">{sub}</div>}
    </div>
  );
}

export function ClosedPositionsTable({ positions }: { positions: PositionAnalytics[] }) {
  if (positions.length === 0) return null;
  return (
    <section className="mt-10">
      <h2 className="text-lg font-semibold">Closed positions</h2>
      <p className="mt-1 text-xs text-neutral-500">Most recent first. Figures cover the time each position was tracked.</p>
      <div className="mt-3 overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-neutral-300 text-left text-neutral-600 dark:border-neutral-700 dark:text-neutral-400">
              <th className="py-2 pr-4 font-medium">Pool / range</th>
              <th className="py-2 pr-4 font-medium">Closed</th>
              <th className="py-2 pr-4 text-right font-medium">Held</th>
              <th className="py-2 pr-4 text-right font-medium">Avg capital</th>
              <th className="py-2 pr-4 text-right font-medium">Fees</th>
              <th className="py-2 pr-4 text-right font-medium">APR</th>
              <th className="py-2 pr-4 text-right font-medium">IL at close</th>
              <th className="py-2 text-right font-medium">Net</th>
            </tr>
          </thead>
          <tbody>
            {positions.map((p) => (
              <tr key={p.positionId} className="border-b border-neutral-200 dark:border-neutral-800">
                <td className="py-2 pr-4">
                  <div>{p.poolName}</div>
                  <div className="text-xs text-neutral-500">
                    {price(p.priceLower)} – {price(p.priceUpper)}
                  </div>
                </td>
                <td className="py-2 pr-4 whitespace-nowrap text-xs">{formatDate(p.closedAt)}</td>
                <td className="py-2 pr-4 text-right tabular-nums">{formatDuration(p.lifetime.coveredSeconds)}</td>
                <td className="py-2 pr-4 text-right tabular-nums">{usd(p.lifetime.avgCapitalUsd)}</td>
                <td className="py-2 pr-4 text-right tabular-nums">{usd(p.lifetime.earnedUsd)}</td>
                <td className="py-2 pr-4 text-right tabular-nums">{aprText(p.lifetime)}</td>
                <td className={`py-2 pr-4 text-right tabular-nums ${gain(p.ilUsd)}`}>{usdSigned(p.ilUsd)}</td>
                <td className={`py-2 text-right tabular-nums ${gain(p.netUsd)}`}>{usdSigned(p.netUsd)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
