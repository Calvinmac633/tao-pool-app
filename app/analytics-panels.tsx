"use client";

import { useState } from "react";
import type { PortfolioAnalytics, PositionAnalytics, Projection, WalletAnalytics } from "@/lib/types";
import { amount, aprText, formatDate, formatDuration, pct, pctSigned, price, usd, usdSigned, WINDOW_SECONDS } from "./format";

const gain = (n: number) => (n >= 0 ? "text-emerald-700 dark:text-emerald-400" : "text-red-600 dark:text-red-400");

/** Windows table shared by the open-positions and overall panels. */
function WindowsTable({ p, sinceLabel }: { p: PortfolioAnalytics; sinceLabel: string }) {
  return (
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
            <td className="py-2 pr-4">{sinceLabel}</td>
            <td className="py-2 pr-4 text-right tabular-nums">{usd(p.sinceStart.earnedUsd)}</td>
            <td className="py-2 pr-4 text-right tabular-nums">{usd(p.sinceStart.avgCapitalUsd)}</td>
            <td className="py-2 text-right tabular-nums">{aprText(p.sinceStart)}</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

/** Pick the APR to plan with: the longest window with at least a day of data, else since the start. */
function planningApr(p: PortfolioAnalytics): { label: string; apr: number | null } {
  if ((p.windows["7d"]?.coveredSeconds ?? 0) >= 86400) return { label: "7d", apr: p.windows["7d"].apr };
  if ((p.windows["24h"]?.coveredSeconds ?? 0) >= 3600) return { label: "24h", apr: p.windows["24h"].apr };
  return { label: "since open", apr: p.sinceStart.coveredSeconds >= 600 ? p.sinceStart.apr : null };
}

/** The positions open right now, aggregated since they were opened. */
export function OpenPositionsPanel({ data }: { data: WalletAnalytics }) {
  const p = data.openPortfolio;
  const [target, setTarget] = useState("50000");
  const { label, apr } = planningApr(p);
  const targetNum = Number(target.replace(/[^0-9.]/g, ""));
  const yearly = apr && apr > 0 ? p.currentCapitalUsd * apr : null;
  const needed = apr && apr > 0 && targetNum > 0 ? targetNum / apr : null;

  if (data.open.length === 0) return null;
  return (
    <section className="mt-10">
      <h2 className="text-lg font-semibold">Open positions</h2>
      <p className="mt-1 text-xs text-neutral-500">
        Fees earned by the {data.open.length === 1 ? "position open now" : `${data.open.length} positions open now`}, with APR on time-weighted capital. Since{" "}
        {formatDate(p.trackingStartedAt)}.
      </p>
      <WindowsTable p={p} sinceLabel="Since open" />

      <div className="mt-4 space-y-1 text-sm">
        <div>
          Your current <span className="font-semibold tabular-nums">{usd(p.currentCapitalUsd)}</span> at the {label} APR
          {apr != null ? ` (${pct(apr, 0)})` : ""} earns about <span className="font-semibold tabular-nums">{yearly ? usd(yearly) : "—"}</span> per year.
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <label htmlFor="target">For</label>
          <input
            id="target"
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            inputMode="decimal"
            className="w-28 rounded border border-neutral-300 bg-transparent px-2 py-1 text-right tabular-nums outline-none focus:border-neutral-500 dark:border-neutral-700"
          />
          <span>per year you would need</span>
          <span className="font-semibold tabular-nums">{needed ? usd(needed) : "—"}</span>
        </div>
      </div>
    </section>
  );
}

/** Every position since tracking began, open and closed, as one strategy. */
export function OverallPanel({ data }: { data: WalletAnalytics }) {
  const p = data.portfolio;
  return (
    <section className="mt-10">
      <h2 className="text-lg font-semibold">Overall</h2>
      <p className="mt-1 text-xs text-neutral-500">
        All positions since tracking began on {formatDate(p.trackingStartedAt)}, open and closed, with APR on the capital deployed at each moment.
      </p>
      <WindowsTable p={p} sinceLabel="Since tracking" />
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
  const deposits = p.entry.history.filter((h) => h.amountA * (h.price ?? 0) + h.amountB > 0).length;
  const showAvg = p.entry.avgPrice != null && p.entry.price != null && Math.abs(p.entry.avgPrice / p.entry.price - 1) > 0.0005;
  const priceChange = p.entry.price ? p.lastPrice / p.entry.price - 1 : null;
  const collectedNote =
    p.collectedUsd > 0
      ? `${usd(p.collectedUsd)} collected` +
        (p.preExisting && p.baselineUncollectedUsd > 0
          ? ` (incl. ${usd(Math.min(p.collectedUsd, p.baselineUncollectedUsd))} from before tracking)`
          : "")
      : undefined;
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
          {p.entry.price != null ? ` at ${price(p.entry.price)}` : ""}
          {showAvg ? ` · avg entry ${price(p.entry.avgPrice)} over ${deposits} deposits` : ""}
          {p.preExisting ? " · fees before tracking excluded" : ""} · {formatDuration(p.lifetime.coveredSeconds)} tracked
        </div>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-5">
        <Stat label="Value" value={usd(p.lastUsdValue)} />
        <Stat
          label="Price now"
          value={price(p.lastPrice)}
          sub={p.entry.price != null && priceChange != null ? `entry ${price(p.entry.price)} (${pctSigned(priceChange)})` : undefined}
        />
        <Stat label={`Fees earned ${since}`} value={usd(p.lifetime.earnedUsd)} sub={collectedNote} />
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
                {p.projections.entry && <ProjectionRow label={`Entry price ${price(p.projections.entry.price)}`} pr={p.projections.entry} p={p} />}
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
