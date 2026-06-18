// Small, dependency-free helpers used across the app.

export function uid(prefix = "id"): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random()
    .toString(36)
    .slice(2, 8)}`;
}

export function formatCurrency(n: number, opts: { cents?: boolean } = {}): string {
  const value = Number.isFinite(n) ? n : 0;
  return value.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: opts.cents ? 2 : 0,
    maximumFractionDigits: opts.cents ? 2 : 0,
  });
}

export function formatNumber(n: number, digits = 0): string {
  const value = Number.isFinite(n) ? n : 0;
  return value.toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

export function formatPercent(n: number, digits = 0): string {
  return `${formatNumber(n, digits)}%`;
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

export function isoToDate(iso: string): Date {
  // Treat plain yyyy-mm-dd as local date
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) {
    const [y, m, d] = iso.split("-").map(Number);
    return new Date(y, m - 1, d);
  }
  return new Date(iso);
}

/** Add `n` whole months to an ISO date, returning ISO (yyyy-mm-dd). */
export function addMonthsISO(iso: string, n: number): string {
  const d = isoToDate(iso);
  d.setMonth(d.getMonth() + n);
  return d.toISOString().slice(0, 10);
}

/** Whole weeks between two ISO dates (>=0). */
export function weeksBetween(startISO: string, endISO: string): number {
  const a = isoToDate(startISO).getTime();
  const b = isoToDate(endISO).getTime();
  if (isNaN(a) || isNaN(b) || b <= a) return 0;
  return Math.floor((b - a) / (7 * 24 * 60 * 60 * 1000));
}

/** Add `n` whole days to an ISO date, returning ISO (yyyy-mm-dd). */
export function addDaysISO(iso: string, n: number): string {
  const d = isoToDate(iso);
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Whole days between two ISO dates (can be negative if end precedes start). */
export function daysBetween(startISO: string, endISO: string): number {
  const a = isoToDate(startISO).getTime();
  const b = isoToDate(endISO).getTime();
  if (isNaN(a) || isNaN(b)) return 0;
  return Math.round((b - a) / (24 * 60 * 60 * 1000));
}

/** Whole calendar months between two ISO dates (end - start; can be negative). */
export function monthsBetween(startISO: string, endISO: string): number {
  const a = isoToDate(startISO);
  const b = isoToDate(endISO);
  if (isNaN(a.getTime()) || isNaN(b.getTime())) return 0;
  let months =
    (b.getFullYear() - a.getFullYear()) * 12 + (b.getMonth() - a.getMonth());
  // Don't count the final month until the day-of-month is reached.
  if (b.getDate() < a.getDate()) months -= 1;
  return months;
}

/** Number of whole months a date is in the past/future relative to today. */
export function monthsSince(iso: string): number {
  const d = isoToDate(iso);
  const now = new Date();
  return (
    (now.getFullYear() - d.getFullYear()) * 12 +
    (now.getMonth() - d.getMonth())
  );
}

export function clampNum(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

export function classNames(...xs: Array<string | false | null | undefined>): string {
  return xs.filter(Boolean).join(" ");
}

export const YEAR_LABELS = [
  "Year 1 (Months 1–12)",
  "Year 2 (Months 13–24)",
  "Year 3 (Months 25–36)",
  "Year 4 (Months 37–48)",
  "Year 5 (Months 49–60)",
];
