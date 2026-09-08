import type { ButtonHTMLAttributes, ReactNode } from "react";
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
        "rounded-xl border border-slate-200 bg-white shadow-card dark:border-slate-800 dark:bg-slate-900",
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
    "bg-brand-600 text-white hover:bg-brand-700 focus-visible:ring-brand-500 shadow-xs",
  secondary:
    "border border-slate-300 bg-white text-slate-700 shadow-xs hover:bg-slate-50 hover:text-slate-900 focus-visible:ring-brand-500 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800",
  ghost:
    "text-slate-600 hover:bg-slate-100 hover:text-slate-900 focus-visible:ring-brand-500 dark:text-slate-300 dark:hover:bg-slate-800",
  subtle:
    "bg-slate-100 text-slate-700 hover:bg-slate-200 focus-visible:ring-brand-500 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700",
  danger:
    "bg-rose-600 text-white hover:bg-rose-700 focus-visible:ring-rose-500 shadow-xs",
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
        "inline-flex items-center justify-center rounded-lg font-semibold transition focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-1 focus-visible:ring-offset-white disabled:cursor-not-allowed disabled:opacity-50 dark:focus-visible:ring-offset-slate-900",
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
    "bg-slate-50 text-slate-600 ring-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:ring-slate-700",
  blue: "bg-blue-50 text-blue-700 ring-blue-200 dark:bg-blue-500/15 dark:text-blue-300 dark:ring-blue-500/30",
  green:
    "bg-emerald-50 text-emerald-700 ring-emerald-200 dark:bg-emerald-500/15 dark:text-emerald-300 dark:ring-emerald-500/30",
  amber:
    "bg-amber-50 text-amber-700 ring-amber-200 dark:bg-amber-500/15 dark:text-amber-300 dark:ring-amber-500/30",
  violet:
    "bg-violet-50 text-violet-700 ring-violet-200 dark:bg-violet-500/15 dark:text-violet-300 dark:ring-violet-500/30",
  rose: "bg-rose-50 text-rose-700 ring-rose-200 dark:bg-rose-500/15 dark:text-rose-300 dark:ring-rose-500/30",
  cyan: "bg-cyan-50 text-cyan-700 ring-cyan-200 dark:bg-cyan-500/15 dark:text-cyan-300 dark:ring-cyan-500/30",
  indigo:
    "bg-indigo-50 text-indigo-700 ring-indigo-200 dark:bg-indigo-500/15 dark:text-indigo-300 dark:ring-indigo-500/30",
};

const toneDots: Record<Tone, string> = {
  slate: "bg-slate-400",
  blue: "bg-blue-500",
  green: "bg-emerald-500",
  amber: "bg-amber-500",
  violet: "bg-violet-500",
  rose: "bg-rose-500",
  cyan: "bg-cyan-500",
  indigo: "bg-indigo-500",
};

export function Badge({
  tone = "slate",
  children,
  className,
  dot = false,
}: {
  tone?: Tone;
  children: ReactNode;
  className?: string;
  dot?: boolean;
}) {
  return (
    <span
      className={classNames(
        "inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset",
        tones[tone],
        className,
      )}
    >
      {dot && <span className={classNames("h-1.5 w-1.5 shrink-0 rounded-full", toneDots[tone])} />}
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
  return <Badge dot tone={commissionTone[status]}>{commissionLabel[status]}</Badge>;
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
  return <Badge dot tone={payoutTone[status]}>{label}</Badge>;
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
  return <Badge dot tone={map[status] ?? "slate"}>{label}</Badge>;
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
    <div className="flex items-start justify-between gap-3 rounded-xl border border-slate-200 bg-white p-4 shadow-card transition-shadow hover:shadow-dropdown dark:border-slate-800 dark:bg-slate-900 sm:p-5">
      <div className="min-w-0 flex-1">
        <p className="text-[13px] font-medium text-slate-500 dark:text-slate-400">
          {label}
        </p>
        <p className="mt-1.5 truncate text-2xl font-semibold tracking-tight tabular-nums text-slate-900 dark:text-white">
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
