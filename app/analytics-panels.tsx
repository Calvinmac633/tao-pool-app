"use client";

import { useState } from "react";
import type { LedgerEntry, PortfolioAnalytics, PositionAnalytics, Projection, WalletAnalytics } from "@/lib/types";
import { amount, aprText, formatDate, formatDuration, pct, pctSigned, perDay, perDaySigned, price, usd, usdSigned, WINDOW_SECONDS } from "./format";

const gain = (n: number) => (n >= 0 ? "text-emerald-700 dark:text-emerald-400" : "text-red-600 dark:text-red-400");
const th = "py-2 pr-4 font-medium";
const thRight = "py-2 pr-4 text-right font-medium";
const headRow = "border-b border-neutral-300 text-left text-neutral-600 dark:border-neutral-700 dark:text-neutral-400";
const bodyRow = "border-b border-neutral-200 dark:border-neutral-800";
const num = "py-2 pr-4 text-right tabular-nums whitespace-nowrap";

/** Fees over several windows, shared by the open-positions and overall panels. */
function WindowsTable({ p, sinceLabel }: { p: PortfolioAnalytics; sinceLabel: string }) {
  const rowFor = (label: string, w: PortfolioAnalytics["sinceStart"], windowSeconds?: number) => (
    <tr key={label} className={bodyRow}>
      <td className="py-2 pr-4">{label}</td>
      <td className={num}>{usd(w.earnedUsd)}</td>
      <td className={num}>{usd(w.avgCapitalUsd)}</td>
      <td className={num}>{w.apr != null && w.coveredSeconds >= 600 ? perDay(w.apr / 365) : "—"}</td>
      <td className={num}>{aprText(w, windowSeconds)}</td>
    </tr>
  );
  return (
    <div className="mt-3 overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className={headRow}>
            <th className={th}>Window</th>
            <th className={thRight}>Fees earned</th>
            <th className={thRight}>Avg capital</th>
            <th className={thRight}>Fees per day</th>
            <th className={thRight}>Fee APR</th>
          </tr>
        </thead>
        <tbody>
          {["24h", "7d"].map((k) => rowFor(k, p.windows[k], WINDOW_SECONDS[k]))}
          {rowFor(sinceLabel, p.sinceStart)}
        </tbody>
      </table>
    </div>
  );
}

/** Pick the fee rate to plan with: the longest window with at least a day of data, else since the start. */
function planningRate(p: PortfolioAnalytics): { label: string; apr: number | null } {
  if ((p.windows["7d"]?.coveredSeconds ?? 0) >= 86400) return { label: "7d", apr: p.windows["7d"].apr };
  if ((p.windows["24h"]?.coveredSeconds ?? 0) >= 3600) return { label: "24h", apr: p.windows["24h"].apr };
  return { label: "since open", apr: p.sinceStart.coveredSeconds >= 600 ? p.sinceStart.apr : null };
}

/** The positions open right now: fees, expected pool cost, and what that means in dollars. */
export function OpenPositionsPanel({ data }: { data: WalletAnalytics }) {
  const p = data.openPortfolio;
  const { label, apr } = planningRate(p);
  if (data.open.length === 0) return null;

  const feePerDay = apr != null ? apr / 365 : null;
  const costPerDay = p.expectedCostPerDay; // fraction of capital per day, positive number
  const netPerDay = feePerDay != null && costPerDay != null ? feePerDay - costPerDay : null;
  const capital = p.currentCapitalUsd;
  const vol = data.market.dailyVol24h ?? data.market.dailyVol7d;
  const realised = data.history;

  return (
    <section className="mt-10">
      <h2 className="text-lg font-semibold">Income from open positions</h2>
      <p className="mt-1 text-xs text-neutral-500">
        Fees earned by the {data.open.length === 1 ? "position open now" : `${data.open.length} positions open now`}, since {formatDate(p.trackingStartedAt)}.
      </p>
      <WindowsTable p={p} sinceLabel="Since open" />

      <div className="mt-4 rounded border border-neutral-200 p-4 text-sm dark:border-neutral-800">
        <div className="font-medium">At current rates, per day</div>
        <table className="mt-2 text-sm">
          <tbody>
            <tr>
              <td className="pr-4 py-0.5 text-neutral-600 dark:text-neutral-400">Fees</td>
              <td className="py-0.5 text-right tabular-nums text-emerald-700 dark:text-emerald-400">{feePerDay != null ? "+" + perDay(feePerDay) : "—"}</td>
              <td className="pl-3 py-0.5 text-xs text-neutral-500">{apr != null ? `fee APR ${pct(apr, 0)}, ${label}` : "not enough data yet"}</td>
            </tr>
            <tr>
              <td className="pr-4 py-0.5 text-neutral-600 dark:text-neutral-400">Expected pool cost</td>
              <td className="py-0.5 text-right tabular-nums text-red-600 dark:text-red-400">{costPerDay != null ? "−" + perDay(costPerDay) : "—"}</td>
              <td className="pl-3 py-0.5 text-xs text-neutral-500">
                {costPerDay != null && vol != null
                  ? `for these ranges with TAO moving ${pct(vol, 1)} a day`
                  : "needs a few hours of price history"}
              </td>
            </tr>
            <tr className="font-semibold">
              <td className="pr-4 py-0.5">Net</td>
              <td className={`py-0.5 text-right tabular-nums ${netPerDay != null ? gain(netPerDay) : ""}`}>{netPerDay != null ? perDaySigned(netPerDay) : "—"}</td>
              <td className="pl-3 py-0.5 text-xs font-normal text-neutral-500">{netPerDay != null ? `about ${pctSigned(netPerDay * 365)} a year` : ""}</td>
            </tr>
          </tbody>
        </table>

        {feePerDay != null && (
          <div className="mt-3">
            <p>
              Your current <span className="font-semibold tabular-nums">{usd(capital)}</span> would earn about{" "}
              <span className="font-semibold tabular-nums">{usd(capital * feePerDay)}</span> a day in fees
              {costPerDay != null ? (
                <>
                  , minus about <span className="font-semibold tabular-nums">{usd(capital * costPerDay)}</span> a day of expected pool cost:{" "}
                  <span className={`font-semibold tabular-nums ${gain(netPerDay!)}`}>{usdSigned(capital * netPerDay!)}</span> a day net.
                </>
              ) : (
                "."
              )}
            </p>
            <p className="mt-1 text-neutral-600 dark:text-neutral-400">
              Over a year at these rates: <span className="font-semibold tabular-nums">{usd(capital * feePerDay * 365)}</span> in fees
              {costPerDay != null ? (
                <>
                  , minus <span className="font-semibold tabular-nums">{usd(capital * costPerDay * 365)}</span> of pool cost:{" "}
                  <span className={`font-semibold tabular-nums ${gain(netPerDay!)}`}>{usdSigned(capital * netPerDay! * 365)}</span> net.
                </>
              ) : (
                "."
              )}
            </p>
          </div>
        )}

        {netPerDay != null && <Calculator netPerDay={netPerDay} feePerDay={feePerDay!} costPerDay={costPerDay!} currentCapital={capital} />}

        <p className="mt-3 text-xs text-neutral-500">
          Expected pool cost is a model: the tighter the range and the more TAO moves, the more the pool trades against you. It applies while in range.
          {realised.realisedCostPerDay != null && realised.realisedFeePerDay != null && realised.closedCount >= 3 && (
            <>
              {" "}
              Over your {realised.closedCount} closed positions the real pool cost has averaged {perDay(realised.realisedCostPerDay)} against {perDay(realised.realisedFeePerDay)} of fees.
            </>
          )}
        </p>
      </div>
    </section>
  );
}

/** Whole dollars from a typed string; empty when there are none. */
const parseDollars = (text: string) => {
  const digits = text.replace(/[^0-9]/g, "");
  return digits ? Number(digits) : 0;
};
const formatDollars = (n: number) => (n > 0 ? n.toLocaleString("en-US") : "");

function DollarInput({ id, value, onChange }: { id: string; value: number; onChange: (n: number) => void }) {
  return (
    <span className="inline-flex items-center rounded border border-neutral-300 bg-transparent px-2 focus-within:border-neutral-500 dark:border-neutral-700">
      <span className="text-neutral-500">$</span>
      <input
        id={id}
        value={formatDollars(value)}
        onChange={(e) => onChange(parseDollars(e.target.value))}
        inputMode="numeric"
        placeholder="0"
        className="w-28 bg-transparent py-1 pl-1 text-right tabular-nums outline-none"
      />
    </span>
  );
}

/**
 * Two-way planner on the net rate (fees minus expected pool cost): what a
 * yearly income target needs in capital, and what an amount of capital earns.
 */
function Calculator({ netPerDay, feePerDay, costPerDay, currentCapital }: { netPerDay: number; feePerDay: number; costPerDay: number; currentCapital: number }) {
  const [target, setTarget] = useState(50000);
  const [capital, setCapital] = useState(Math.round(currentCapital));
  const netPerYear = netPerDay * 365;
  const needed = netPerYear > 0 && target > 0 ? target / netPerYear : null;

  return (
    <div className="mt-4 grid gap-4 border-t border-neutral-200 pt-4 sm:grid-cols-2 dark:border-neutral-800">
      <div>
        <div className="text-xs font-medium text-neutral-500">Income target</div>
        <label htmlFor="target" className="mt-1 block">
          To earn <DollarInput id="target" value={target} onChange={setTarget} /> a year after pool cost
        </label>
        <div className="mt-2">
          you would need about{" "}
          <span className="text-lg font-semibold tabular-nums">{needed != null ? usd(needed) : "—"}</span> in positions
          {needed == null && target > 0 && <span className="block text-xs text-neutral-500">not reachable while fees don&apos;t cover the expected pool cost</span>}
        </div>
      </div>
      <div>
        <div className="text-xs font-medium text-neutral-500">Capital</div>
        <label htmlFor="capital" className="mt-1 block">
          With <DollarInput id="capital" value={capital} onChange={setCapital} /> in positions
        </label>
        <div className="mt-2">
          you would earn about{" "}
          <span className={`text-lg font-semibold tabular-nums ${gain(netPerDay)}`}>{usdSigned(capital * netPerYear)}</span> a year after pool cost
          <span className="block text-xs text-neutral-500">
            {usd(capital * feePerDay * 365)} in fees minus {usd(capital * costPerDay * 365)} of pool cost, or {usdSigned(capital * netPerDay)} a day
          </span>
        </div>
      </div>
    </div>
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

/** "The pool sold 53.5 TAO at an average of $223 (price now $227), costing $207." */
function poolTradeText(p: PositionAnalytics, tense: "now" | "close"): string | null {
  const t = p.poolTrade;
  if (!t || t.avgPrice == null) return null;
  const verb = t.soldA > 0 ? "sold" : "bought";
  const priceLabel = tense === "now" ? "price now" : "price at close";
  const outcome = t.costUsd < -0.005 ? `costing ${usd(-t.costUsd)}` : "at no cost so far";
  const realised = p.realisedIlUsd < -0.005 ? ` A further ${usd(-p.realisedIlUsd)} was realised when liquidity was withdrawn earlier.` : "";
  return `The pool ${verb} ${amount(Math.abs(t.soldA), 3)} ${p.symbolA} for you at an average of ${price(t.avgPrice)} (${priceLabel} ${price(t.lastPrice)}), ${outcome}.${realised}`;
}

function PositionCard({ p }: { p: PositionAnalytics }) {
  const since = p.preExisting ? "since tracking" : "since open";
  const deposits = p.entry.history.filter((h) => h.amountA * (h.price ?? 0) + h.amountB > 0).length;
  const showAvg = p.entry.avgPrice != null && p.entry.price != null && Math.abs(p.entry.avgPrice / p.entry.price - 1) > 0.0005;
  const priceChange = p.entry.price ? p.lastPrice / p.entry.price - 1 : null;
  const collectedNote =
    p.collectedUsd > 0
      ? `${usd(p.collectedUsd)} collected` +
        (p.preExisting && p.baselineUncollectedUsd > 0 ? ` (incl. ${usd(Math.min(p.collectedUsd, p.baselineUncollectedUsd))} from before tracking)` : "")
      : undefined;
  const trade = poolTradeText(p, "now");
  return (
    <div className="rounded border border-neutral-200 p-4 text-sm dark:border-neutral-800">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <span className="font-medium">{p.poolName}</span>{" "}
          <span className="text-neutral-500">
            {price(p.priceLower)} – {price(p.priceUpper)} {p.symbolB}
            {p.rangeWidthPct != null ? ` (${p.rangeWidthPct.toFixed(1)}% wide)` : ""} · {p.inRange ? "in range" : "out of range"}
          </span>
          <div className="font-mono text-xs text-neutral-500">{p.positionId}</div>
        </div>
        <div className="text-xs text-neutral-500">
          {p.openedAtKnown ? `Opened ${formatDate(p.openedAt)}` : `First seen ${formatDate(p.openedAt)}`}
          {p.entry.price != null ? ` at ${price(p.entry.price)}` : ""}
          {showAvg ? ` · avg entry ${price(p.entry.avgPrice)} over ${deposits} deposits` : ""}
          {p.preExisting ? " · fees before tracking excluded" : ""} · {formatDuration(p.lifetime.coveredSeconds)} tracked
          {p.inRangeFraction != null ? ` · in range ${pct(p.inRangeFraction, 0)} of the time` : ""}
        </div>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-5">
        <Stat label="Value" value={usd(p.lastUsdValue)} />
        <Stat
          label="Price now"
          value={price(p.lastPrice)}
          sub={p.entry.price != null && priceChange != null ? `entry ${price(p.entry.price)} (${pctSigned(priceChange)})` : undefined}
        />
        <Stat label={`Fees earned ${since}`} value={usd(p.lifetime.earnedUsd)} sub={collectedNote} tone={gain(1)} />
        <Stat label="Pool cost so far (IL)" value={usdSigned(p.ilUsd)} sub={pctSigned(p.ilPct)} tone={gain(p.ilUsd)} />
        <Stat label={`LP income ${since}`} value={usdSigned(p.netUsd)} sub="fees minus pool cost" tone={gain(p.netUsd)} />
      </div>

      {(trade || p.expectedCostPerDay != null) && (
        <p className="mt-3 text-xs text-neutral-500">
          {trade}
          {p.expectedCostPerDay != null && (
            <>
              {" "}
              Expected pool cost at current volatility: {p.expectedCostPerDay > 0 ? perDay(p.expectedCostPerDay) : "none while out of range"}.
            </>
          )}
        </p>
      )}

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
              <td className="py-1 pr-3 text-neutral-500">Fees per day</td>
              {["1h", "6h", "24h", "7d"].map((k) => (
                <td key={k} className="py-1 pr-3 text-right tabular-nums">{p.windows[k]?.apr != null && p.windows[k].coveredSeconds >= 600 ? perDay(p.windows[k].apr / 365) : "—"}</td>
              ))}
              <td className="py-1 text-right tabular-nums">{p.lifetime.apr != null && p.lifetime.coveredSeconds >= 600 ? perDay(p.lifetime.apr / 365) : "—"}</td>
            </tr>
            <tr>
              <td className="py-1 pr-3 text-neutral-500">Fee APR</td>
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
            What the position would hold, and the pool cost (IL), if price moved. Compared with the {amount(p.entry.amountA)} {p.symbolA} + {amount(p.entry.amountB, 2)} {p.symbolB} that went in
            {p.entry.note ? ` (${p.entry.note})` : p.entry.source === "chain" ? "" : " (from the first snapshot)"}
            {p.entry.adjustments > 0 ? `, adjusted for ${p.entry.adjustments} liquidity change${p.entry.adjustments > 1 ? "s" : ""}` : ""}. Fees are not included.
          </div>
          <div className="mt-2 overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left text-neutral-500">
                  <th className="py-1 pr-3 font-medium">If price is</th>
                  <th className="py-1 pr-3 text-right font-medium">Position holds</th>
                  <th className="py-1 pr-3 text-right font-medium">Position value</th>
                  <th className="py-1 pr-3 text-right font-medium">Entry tokens would be worth</th>
                  <th className="py-1 text-right font-medium">Pool cost (IL)</th>
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

export function ClosedPositionsTable({ positions, total }: { positions: PositionAnalytics[]; total: number }) {
  if (positions.length === 0) return null;
  return (
    <section className="mt-10">
      <h2 className="text-lg font-semibold">Closed positions</h2>
      <p className="mt-1 text-xs text-neutral-500">
        Most recent first{total > positions.length ? `, showing ${positions.length} of ${total}` : ""}. LP income is fees minus pool cost. Total adds what TAO&apos;s price did to the tokens while held.
      </p>
      <div className="mt-3 overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className={headRow}>
              <th className={th}>Pool / range</th>
              <th className={th}>Closed</th>
              <th className={thRight}>Held</th>
              <th className={thRight}>Fees</th>
              <th className={thRight}>Pool cost</th>
              <th className={thRight}>LP income</th>
              <th className={thRight}>TAO price move</th>
              <th className="py-2 text-right font-medium">Total</th>
            </tr>
          </thead>
          <tbody>
            {positions.map((p) => (
              <tr key={p.positionId} className={bodyRow}>
                <td className="py-2 pr-4">
                  <div>
                    {p.poolName}{" "}
                    <span className="text-xs text-neutral-500">
                      {price(p.priceLower)} – {price(p.priceUpper)}
                      {p.rangeWidthPct != null ? ` (${p.rangeWidthPct.toFixed(1)}% wide)` : ""}
                    </span>
                  </div>
                  <div className="max-w-md text-xs text-neutral-500">{poolTradeText(p, "close")}</div>
                </td>
                <td className="py-2 pr-4 whitespace-nowrap text-xs">{formatDate(p.closedAt)}</td>
                <td className={num}>
                  {formatDuration(p.lifetime.coveredSeconds)}
                  {p.inRangeFraction != null && <div className="text-xs text-neutral-500">{pct(p.inRangeFraction, 0)} in range</div>}
                </td>
                <td className={num}>
                  {usd(p.lifetime.earnedUsd)}
                  <div className="text-xs text-neutral-500">{aprText(p.lifetime)}</div>
                </td>
                <td className={`${num} ${gain(p.ilUsd)}`}>{usdSigned(p.ilUsd)}</td>
                <td className={`${num} font-medium ${gain(p.netUsd)}`}>{usdSigned(p.netUsd)}</td>
                <td className={`${num} ${gain(p.priceMoveUsd)}`}>{usdSigned(p.priceMoveUsd)}</td>
                <td className={`py-2 text-right tabular-nums whitespace-nowrap ${gain(p.totalUsd)}`}>{usdSigned(p.totalUsd)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/** Every closed position as one strategy: where the profit came from, and which range widths pay. */
export function OverallPanel({ data }: { data: WalletAnalytics }) {
  const h = data.history;
  const p = data.portfolio;
  return (
    <section className="mt-10">
      <h2 className="text-lg font-semibold">Overall results</h2>
      <p className="mt-1 text-xs text-neutral-500">
        All {h.closedCount} closed position{h.closedCount === 1 ? "" : "s"} since tracking began on {formatDate(p.trackingStartedAt)}.
      </p>

      {h.closedCount > 0 && (
        <>
          <div className="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-3">
            <div className="rounded border border-neutral-200 p-4 dark:border-neutral-800">
              <div className="text-xs text-neutral-500">Total profit</div>
              <div className={`text-xl font-semibold tabular-nums ${gain(h.totalUsd)}`}>{usdSigned(h.totalUsd)}</div>
              <div className="text-xs text-neutral-500">everything the closed positions made or lost</div>
            </div>
            <div className="rounded border border-neutral-200 p-4 dark:border-neutral-800">
              <div className="text-xs text-neutral-500">LP income</div>
              <div className={`text-xl font-semibold tabular-nums ${gain(h.lpIncomeUsd)}`}>{usdSigned(h.lpIncomeUsd)}</div>
              <div className="text-xs text-neutral-500">
                fees {usd(h.feesUsd)} minus pool cost {usd(-h.poolCostUsd)}
              </div>
            </div>
            <div className="rounded border border-neutral-200 p-4 dark:border-neutral-800">
              <div className="text-xs text-neutral-500">From TAO&apos;s price moving</div>
              <div className={`text-xl font-semibold tabular-nums ${gain(h.priceMoveUsd)}`}>{usdSigned(h.priceMoveUsd)}</div>
              <div className="text-xs text-neutral-500">what the TAO you held gained or lost</div>
            </div>
          </div>
          <p className="mt-2 text-xs text-neutral-500">
            LP income is what providing liquidity actually earned: it is the part you can count on repeating. The price part would have happened in any wallet holding that TAO, and it reverses when price falls.
            {h.realisedFeePerDay != null && h.realisedCostPerDay != null && (
              <>
                {" "}
                Across all closed positions, fees ran {perDay(h.realisedFeePerDay)} of capital and pool cost {perDay(h.realisedCostPerDay)}.
              </>
            )}
          </p>

          {h.buckets.length > 0 && (
            <>
              <h3 className="mt-6 text-sm font-semibold">Which range widths pay</h3>
              <p className="mt-1 text-xs text-neutral-500">Closed positions grouped by how far apart their bounds were, as a share of the lower bound. Thin groups will be noisy until more positions close.</p>
              <div className="mt-2 overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className={headRow}>
                      <th className={th}>Range width</th>
                      <th className={thRight}>Positions</th>
                      <th className={thRight}>In range</th>
                      <th className={thRight}>Fees per day</th>
                      <th className={thRight}>Pool cost per day</th>
                      <th className={thRight}>Net per day</th>
                      <th className="py-2 text-right font-medium">LP income</th>
                    </tr>
                  </thead>
                  <tbody>
                    {h.buckets.map((b) => {
                      const net = b.feePerDay != null && b.costPerDay != null ? b.feePerDay - b.costPerDay : null;
                      return (
                        <tr key={b.label} className={bodyRow}>
                          <td className="py-2 pr-4">{b.label}</td>
                          <td className={num}>{b.positions}</td>
                          <td className={num}>{pct(b.inRangeFraction, 0)}</td>
                          <td className={num}>{perDay(b.feePerDay)}</td>
                          <td className={num}>{perDay(b.costPerDay)}</td>
                          <td className={`${num} ${net != null ? gain(net) : ""}`}>{net != null ? perDaySigned(net) : "—"}</td>
                          <td className={`py-2 text-right tabular-nums ${gain(b.lpIncomeUsd)}`}>{usdSigned(b.lpIncomeUsd)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </>
      )}

      <h3 className="mt-6 text-sm font-semibold">Fee rate over time, open and closed together</h3>
      <WindowsTable p={p} sinceLabel="Since tracking" />
    </section>
  );
}

// ---- Ledger ----

const kindLabel: Record<LedgerEntry["kind"], string> = { position: "Position", swap: "Swap", external: "Money in/out", unclassified: "Unclassified" };

/** Token amount for the holdings table: two decimals for the stable side, four for the other. */
const holding = (n: number, isB: boolean) => (isB ? n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : amount(n, 4));

function tokenDelta(n: number, symbol: string): string {
  if (Math.abs(n) < 1e-9) return "";
  return `${n > 0 ? "+" : "−"}${amount(Math.abs(n), symbol === "USDC" ? 2 : 4)} ${symbol}`;
}

/** Holdings, the reconciliation, rolls, and recent activity. */
export function LedgerPanel({ data, symbolA, symbolB }: { data: WalletAnalytics; symbolA: string; symbolB: string }) {
  const l = data.ledger;
  const h = l.holdings;
  return (
    <section className="mt-10">
      <h2 className="text-lg font-semibold">Ledger</h2>
      <p className="mt-1 text-xs text-neutral-500">
        Every wallet transaction that moved {symbolA} or {symbolB}, and a check that all changes in your holdings add up.
        {l.txCount ? ` ${l.txCount} transactions recorded.` : " Nothing recorded yet; the tracker fills this in on its next runs."}
        {!l.backfillDone && l.txCount > 0 ? " Still loading older history." : ""}
      </p>

      {h && (
        <div className="mt-3 overflow-x-auto">
          <table className="text-sm">
            <thead>
              <tr className={headRow}>
                <th className={th}>Holdings as of {formatDate(h.at)}</th>
                <th className={thRight}>{symbolA}</th>
                <th className={thRight}>{symbolB}</th>
              </tr>
            </thead>
            <tbody>
              <tr className={bodyRow}><td className="py-1 pr-4">In positions</td><td className={num}>{holding(h.posA, false)}</td><td className={num}>{holding(h.posB, true)}</td></tr>
              <tr className={bodyRow}><td className="py-1 pr-4">Uncollected fees</td><td className={num}>{holding(h.feeA, false)}</td><td className={num}>{holding(h.feeB, true)}</td></tr>
              <tr className={bodyRow}><td className="py-1 pr-4">Loose in the wallet</td><td className={num}>{holding(h.freeA, false)}</td><td className={num}>{holding(h.freeB, true)}</td></tr>
              <tr className="font-medium"><td className="py-1 pr-4">Total, worth {usd(h.totalValueB)} at {price(h.priceA)}</td><td className={num}>{holding(h.posA + h.feeA + h.freeA, false)}</td><td className={num}>{holding(h.posB + h.feeB + h.freeB, true)}</td></tr>
            </tbody>
          </table>
        </div>
      )}

      {l.reconciliations.length > 0 && (
        <>
          <h3 className="mt-6 text-sm font-semibold">Does it all add up?</h3>
          <p className="mt-1 text-xs text-neutral-500">
            The change in what your {symbolA} and {symbolB} are worth, explained piece by piece. &quot;Unexplained&quot; should stay near zero; if it doesn&apos;t, something moved that the app didn&apos;t understand. Figures in {symbolB}.
          </p>
          <div className="mt-2 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className={headRow}>
                  <th className={th}>Window</th>
                  <th className={thRight}>Change</th>
                  <th className={thRight}>{symbolA} price move</th>
                  <th className={thRight}>Fees</th>
                  <th className={thRight}>Pool cost</th>
                  <th className={thRight}>Swaps</th>
                  <th className={thRight}>Money in/out</th>
                  <th className="py-2 text-right font-medium">Unexplained</th>
                </tr>
              </thead>
              <tbody>
                {l.reconciliations.map((r) => {
                  const ok = Math.abs(r.unexplainedB) <= Math.max(2, 0.0005 * Math.max(r.startValueB, r.endValueB));
                  return (
                    <tr key={r.label} className={bodyRow}>
                      <td className="py-2 pr-4">
                        {r.label}
                        <div className="text-xs text-neutral-500">{usd(r.startValueB)} → {usd(r.endValueB)}</div>
                        {r.gapSeconds > 0 && (
                          <div className="text-xs text-amber-700 dark:text-amber-400">
                            includes {formatDuration(r.gapSeconds)} with the tracker off; fees collected at closes in that time show under pool cost
                          </div>
                        )}
                      </td>
                      <td className={`${num} ${gain(r.changeB)}`}>{usdSigned(r.changeB)}</td>
                      <td className={`${num} ${gain(r.priceMoveB)}`}>{usdSigned(r.priceMoveB)}</td>
                      <td className={`${num} ${gain(r.feesB)}`}>{usdSigned(r.feesB)}</td>
                      <td className={`${num} ${gain(r.poolCostB)}`}>{usdSigned(r.poolCostB)}</td>
                      <td className={`${num} ${gain(r.swapsB)}`}>{usdSigned(r.swapsB)}</td>
                      <td className={num}>{usdSigned(r.externalB)}</td>
                      <td className={`py-2 text-right tabular-nums ${ok ? "text-neutral-500" : "font-semibold text-red-600 dark:text-red-400"}`}>
                        {usdSigned(r.unexplainedB)}
                        <div className="text-xs font-normal">{ok ? "all explained" : "check activity"}</div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}

      {l.unclassified.length > 0 && (
        <>
          <h3 className="mt-6 text-sm font-semibold text-red-600 dark:text-red-400">Unclassified transactions</h3>
          <p className="mt-1 text-xs text-neutral-500">The app couldn&apos;t tell what these were. They are counted as money in or out until sorted.</p>
          <ActivityTable entries={l.unclassified} symbolA={symbolA} symbolB={symbolB} />
        </>
      )}

      {l.rolls.length > 0 && (
        <>
          <h3 className="mt-6 text-sm font-semibold">Rolls</h3>
          <p className="mt-1 text-xs text-neutral-500">Each time a position closed and the next one opened, with any swaps in between. Swap cost is what the swap lost against the pool price at the time.</p>
          <div className="mt-2 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className={headRow}>
                  <th className={th}>Closed</th>
                  <th className={th}>Reopened</th>
                  <th className={thRight}>Gap</th>
                  <th className={thRight}>Swapped</th>
                  <th className="py-2 text-right font-medium">Swap cost</th>
                </tr>
              </thead>
              <tbody>
                {l.rolls.map((r) => (
                  <tr key={r.closedAt} className={bodyRow}>
                    <td className="py-2 pr-4 text-xs">
                      {formatDate(r.closedAt)}
                      <div className="font-mono text-neutral-500">{r.closedPositionIds.map((id) => id.slice(0, 8)).join(", ")}</div>
                    </td>
                    <td className="py-2 pr-4 text-xs">
                      {r.openedAt ? formatDate(r.openedAt) : "not yet"}
                      <div className="font-mono text-neutral-500">{r.openedPositionId?.slice(0, 8)}</div>
                    </td>
                    <td className={num}>{r.gapMinutes != null ? formatDuration(r.gapMinutes * 60) : "—"}</td>
                    <td className={num}>
                      {r.swaps.length === 0 ? "no swaps" : `${r.netSoldA > 0 ? "sold" : "bought"} ${amount(Math.abs(r.netSoldA), 4)} ${symbolA} in ${r.swaps.length}`}
                    </td>
                    <td className={`py-2 text-right tabular-nums ${r.swaps.length ? gain(r.swapCostB) : ""}`}>{r.swaps.length ? usdSigned(r.swapCostB) : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {l.recent.length > 0 && (
        <>
          <h3 className="mt-6 text-sm font-semibold">Recent activity</h3>
          <ActivityTable entries={l.recent} symbolA={symbolA} symbolB={symbolB} />
        </>
      )}
    </section>
  );
}

function ActivityTable({ entries, symbolA, symbolB }: { entries: LedgerEntry[]; symbolA: string; symbolB: string }) {
  return (
    <div className="mt-2 overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className={headRow}>
            <th className={th}>When</th>
            <th className={th}>What</th>
            <th className={thRight}>{symbolA}</th>
            <th className={thRight}>{symbolB}</th>
            <th className="py-2 text-right font-medium">Note</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((e) => (
            <tr key={e.signature} className={bodyRow}>
              <td className="py-1 pr-4 whitespace-nowrap text-xs">{formatDate(e.at)}</td>
              <td className="py-1 pr-4">
                {kindLabel[e.kind]}
                <span className="text-xs text-neutral-500"> {e.note}{e.positionId ? ` · ${e.positionId.slice(0, 8)}` : ""}</span>
              </td>
              <td className={`py-1 pr-4 text-right tabular-nums ${e.deltaA > 0 ? "text-emerald-700 dark:text-emerald-400" : e.deltaA < 0 ? "text-red-600 dark:text-red-400" : ""}`}>{tokenDelta(e.deltaA, symbolA)}</td>
              <td className={`py-1 pr-4 text-right tabular-nums ${e.deltaB > 0 ? "text-emerald-700 dark:text-emerald-400" : e.deltaB < 0 ? "text-red-600 dark:text-red-400" : ""}`}>{tokenDelta(e.deltaB, symbolB)}</td>
              <td className="py-1 text-right text-xs text-neutral-500">
                {e.kind === "swap" && e.swapCostB != null ? `cost ${usdSigned(e.swapCostB)} vs pool` : ""}
                {e.others.length ? `${e.others.length} other token${e.others.length > 1 ? "s" : ""}` : ""}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---- Danger zone ----

/** Erases all tracked history after the user types DELETE to confirm. */
export function DangerZone({ onReset }: { onReset: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function reset() {
    const typed = window.prompt("This erases every snapshot, position, and ledger record the tracker has stored. It cannot be undone.\n\nType DELETE to confirm.");
    if (typed !== "DELETE") return;
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch("/api/reset", { method: "POST" });
      const body = await res.json().catch(() => null);
      setMessage(res.ok ? "History erased. Tracking starts again from now." : body?.error ?? "Couldn't reset the history.");
      if (res.ok) await onReset();
    } catch {
      setMessage("Couldn't reach the server.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="mt-16 border-t border-neutral-200 pt-6 dark:border-neutral-800">
      <div className="flex flex-wrap items-center gap-3 text-xs text-neutral-500">
        <button
          type="button"
          onClick={reset}
          disabled={busy}
          className="rounded border border-red-300 px-2 py-1 text-red-700 hover:bg-red-50 disabled:opacity-50 dark:border-red-900 dark:text-red-400 dark:hover:bg-red-950"
        >
          {busy ? "Erasing…" : "Delete all tracked history"}
        </button>
        <span>Starts tracking over from now. Positions on-chain are untouched.</span>
        {message && <span className="text-neutral-700 dark:text-neutral-300">{message}</span>}
      </div>
    </section>
  );
}
