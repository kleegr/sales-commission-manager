import type { ButtonHTMLAttributes, ReactNode } from "react";
import { X } from "lucide-react";
import { classNames } from "../../lib/format";
import type { CommissionStatus, PayoutStatus } from "../../types";

// ----------------------------------------------------------------------------
// Card
// ----------------------------------------------------------------------------

export function Card({
  children,
  className,
  padded = true,
}: {
  children: ReactNode;
  className?: string;
  padded?: boolean;
}) {
  return (
    <div
      className={classNames(
        "rounded-xl border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-900",
        padded && "p-5",
        className,
      )}
    >
      {children}
    </div>
  );
}

// ----------------------------------------------------------------------------
// Button
// ----------------------------------------------------------------------------

type Variant = "primary" | "secondary" | "ghost" | "danger" | "subtle";
type Size = "sm" | "md";

const variants: Record<Variant, string> = {
  primary:
    "bg-brand-600 text-white hover:bg-brand-700 focus-visible:ring-brand-500 shadow-sm",
  secondary:
    "border border-slate-300 bg-white text-slate-700 hover:bg-slate-50 focus-visible:ring-brand-500 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800",
  ghost:
    "text-slate-600 hover:bg-slate-100 focus-visible:ring-brand-500 dark:text-slate-300 dark:hover:bg-slate-800",
  subtle:
    "bg-slate-100 text-slate-700 hover:bg-slate-200 focus-visible:ring-brand-500 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700",
  danger:
    "bg-rose-600 text-white hover:bg-rose-700 focus-visible:ring-rose-500 shadow-sm",
};

const sizes: Record<Size, string> = {
  sm: "px-2.5 py-1.5 text-xs gap-1.5",
  md: "px-3.5 py-2 text-sm gap-2",
};

export function Button({
  variant = "primary",
  size = "md",
  className,
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant;
  size?: Size;
}) {
  return (
    <button
      {...rest}
      className={classNames(
        "inline-flex items-center justify-center rounded-lg font-medium transition focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-1 focus-visible:ring-offset-white disabled:cursor-not-allowed disabled:opacity-50 dark:focus-visible:ring-offset-slate-900",
        variants[variant],
        sizes[size],
        className,
      )}
    >
      {children}
    </button>
  );
}

// ----------------------------------------------------------------------------
// Badge + status colors
// ----------------------------------------------------------------------------

type Tone =
  | "slate"
  | "blue"
  | "green"
  | "amber"
  | "violet"
  | "rose"
  | "cyan"
  | "indigo";

const tones: Record<Tone, string> = {
  slate:
    "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300",
  blue: "bg-blue-100 text-blue-700 dark:bg-blue-500/15 dark:text-blue-300",
  green:
    "bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300",
  amber:
    "bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300",
  violet:
    "bg-violet-100 text-violet-700 dark:bg-violet-500/15 dark:text-violet-300",
  rose: "bg-rose-100 text-rose-700 dark:bg-rose-500/15 dark:text-rose-300",
  cyan: "bg-cyan-100 text-cyan-700 dark:bg-cyan-500/15 dark:text-cyan-300",
  indigo:
    "bg-indigo-100 text-indigo-700 dark:bg-indigo-500/15 dark:text-indigo-300",
};

export function Badge({
  tone = "slate",
  children,
  className,
}: {
  tone?: Tone;
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={classNames(
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium",
        tones[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

const commissionTone: Record<CommissionStatus, Tone> = {
  projected: "cyan",
  held: "blue",
  pending: "amber",
  submitted: "violet",
  approved: "indigo",
  paid: "green",
  rejected: "rose",
  canceled: "slate",
  clawed_back: "rose",
};

const commissionLabel: Record<CommissionStatus, string> = {
  projected: "Projected",
  held: "Held",
  pending: "Pending",
  submitted: "Submitted",
  approved: "Approved",
  paid: "Paid",
  rejected: "Rejected",
  canceled: "Canceled",
  clawed_back: "Clawed back",
};

export function CommissionBadge({ status }: { status: CommissionStatus }) {
  return <Badge tone={commissionTone[status]}>{commissionLabel[status]}</Badge>;
}

const payoutTone: Record<PayoutStatus, Tone> = {
  submitted: "violet",
  approved: "indigo",
  paid: "green",
  rejected: "rose",
  canceled: "slate",
};

export function PayoutBadge({ status }: { status: PayoutStatus }) {
  const label = status.charAt(0).toUpperCase() + status.slice(1);
  return <Badge tone={payoutTone[status]}>{label}</Badge>;
}

export function StatusBadge({
  status,
}: {
  status: "active" | "inactive" | "canceled" | "refunded" | "paused" | "pending" | "approved" | "rejected";
}) {
  const map: Record<string, Tone> = {
    active: "green",
    approved: "green",
    inactive: "slate",
    canceled: "rose",
    rejected: "rose",
    refunded: "amber",
    paused: "amber",
    pending: "violet",
  };
  const label = status.charAt(0).toUpperCase() + status.slice(1);
  return <Badge tone={map[status] ?? "slate"}>{label}</Badge>;
}

// ----------------------------------------------------------------------------
// StatCard
// ----------------------------------------------------------------------------

export function StatCard({
  label,
  value,
  sub,
  icon,
  tone = "blue",
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  icon?: ReactNode;
  tone?: Tone;
}) {
  return (
    <div className="flex items-start justify-between gap-3 rounded-xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900 sm:p-5">
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-slate-500 dark:text-slate-400">
          {label}
        </p>
        <p className="mt-1 truncate text-2xl font-semibold tracking-tight text-slate-900 dark:text-white">
          {value}
        </p>
        {sub && <p className="mt-1 text-xs text-slate-500">{sub}</p>}
      </div>
      {icon && (
        <span
          className={classNames(
            "flex h-10 w-10 shrink-0 flex-none items-center justify-center rounded-lg",
            tones[tone],
          )}
        >
          {icon}
        </span>
      )}
    </div>
  );
}

// ----------------------------------------------------------------------------
// PageHeader + EmptyState
// ----------------------------------------------------------------------------

export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-slate-900 dark:text-white sm:text-2xl">
          {title}
        </h1>
        {subtitle && (
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
            {subtitle}
          </p>
        )}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon?: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-slate-300 bg-white/50 px-6 py-12 text-center dark:border-slate-700 dark:bg-slate-900/40">
      {icon && (
        <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-slate-100 text-slate-400 dark:bg-slate-800">
          {icon}
        </div>
      )}
      <h3 className="text-sm font-semibold text-slate-900 dark:text-white">
        {title}
      </h3>
      {description && (
        <p className="mt-1 max-w-sm text-sm text-slate-500 dark:text-slate-400">
          {description}
        </p>
      )}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

// ----------------------------------------------------------------------------
// Skeleton
//
// A placeholder block for content that is still loading. Use this instead of an
// empty state whenever "we have nothing yet" might just mean "the fetch hasn't
// come back" — an empty state that turns out to be wrong reads as a bug to the
// user (see the "No profile found" flash on portal launch).
//
// aria-hidden because the shapes carry no meaning; announce the wait once on the
// wrapper (role="status" + aria-busy) rather than on every bar.
// ----------------------------------------------------------------------------

export function Skeleton({ className }: { className?: string }) {
  return (
    <div
      aria-hidden="true"
      className={classNames(
        "animate-pulse rounded-md bg-slate-200/80 dark:bg-slate-800",
        className,
      )}
    />
  );
}

export function SectionTitle({
  children,
  right,
}: {
  children: ReactNode;
  right?: ReactNode;
}) {
  return (
    <div className="mb-3 flex items-center justify-between">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
        {children}
      </h2>
      {right}
    </div>
  );
}

// ----------------------------------------------------------------------------
// ErrorBanner
//
// Now that per-resource writes no longer fall back to a local copy on failure,
// a refused write has to be SEEN. This is the one place that renders that: an
// inline, dismissible strip in the page flow, so the user reads the reason next
// to the thing they were editing rather than in a toast that has already gone.
//
// role="alert" so assistive tech announces it the moment it appears.
// ----------------------------------------------------------------------------

export function ErrorBanner({
  message,
  onDismiss,
  tone = "error",
  className,
}: {
  message: string | null | undefined;
  onDismiss?: () => void;
  tone?: "error" | "warning";
  className?: string;
}) {
  if (!message) return null;
  const tones =
    tone === "warning"
      ? "border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300"
      : "border-rose-200 bg-rose-50 text-rose-700 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-300";
  return (
    <div
      role="alert"
      className={classNames(
        "mb-4 flex items-start justify-between gap-3 rounded-lg border px-3 py-2 text-sm",
        tones,
        className,
      )}
    >
      <span className="min-w-0">{message}</span>
      {onDismiss && (
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss"
          className="flex-none rounded p-0.5 text-current/70 transition hover:text-current"
        >
          <X className="h-4 w-4" />
        </button>
      )}
    </div>
  );
}
