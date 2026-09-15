// Formatting helpers shared by the page components.

const usdFmt = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });

export const usd = (n: number) => usdFmt.format(n);

/** Signed USD, e.g. +$12.34 / −$5.00 */
export const usdSigned = (n: number) => (n >= 0 ? "+" : "−") + usdFmt.format(Math.abs(n));

/** Fraction as a percentage, 1 = 100%. */
export const pct = (fraction: number | null | undefined, digits = 1) =>
  fraction == null || !Number.isFinite(fraction) ? "—" : `${(fraction * 100).toFixed(digits)}%`;

export const pctSigned = (fraction: number) => (fraction >= 0 ? "+" : "−") + pct(Math.abs(fraction));

export const price = (n: number | null | undefined) =>
  n == null ? "—" : n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export const amount = (n: number, digits = 4) => n.toLocaleString("en-US", { maximumFractionDigits: digits });

export function formatDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });
}

export function formatAgo(iso: string | null): string {
  if (!iso) return "—";
  return formatDuration((Date.now() - new Date(iso).getTime()) / 1000) + " ago";
}

export function formatDuration(seconds: number): string {
  const s = Math.max(0, seconds);
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  const h = s / 3600;
  if (h < 48) return `${h.toFixed(h < 10 ? 1 : 0)} h`;
  return `${(h / 24).toFixed(1)} d`;
}
