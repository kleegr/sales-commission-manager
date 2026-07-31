// ============================================================================
// PORTAL SKELETON
//
// The loading placeholder for the self-scoped workspaces (/portal). It mirrors
// the real layout — header, profile strip, four stat tiles, a chart block and
// the list cards — so the page does not jump when the dataset lands.
//
// This replaces what used to render during the first ~1-2s of a launch: the
// "No profile found" empty state, which was simply wrong for every correctly
// linked user. See src/lib/portal-state.ts for the decision rule.
// ============================================================================

import { Card, Skeleton } from "./ui";

function TableCardSkeleton({ rows = 4 }: { rows?: number }) {
  return (
    <Card padded={false} className="overflow-hidden">
      <div className="border-b border-slate-100 p-4 dark:border-slate-800">
        <Skeleton className="h-3.5 w-32" />
      </div>
      <div className="divide-y divide-slate-100 dark:divide-slate-800">
        {Array.from({ length: rows }, (_, i) => (
          <div key={i} className="flex items-center justify-between gap-4 px-4 py-3.5">
            <Skeleton className="h-3.5 w-2/5" />
            <Skeleton className="h-3.5 w-16" />
            <Skeleton className="h-5 w-14 rounded-full" />
          </div>
        ))}
      </div>
    </Card>
  );
}

export function PortalSkeleton({ title }: { title: string }) {
  return (
    <div role="status" aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading {title}…</span>

      {/* header */}
      <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-slate-900 dark:text-white sm:text-2xl">
            {title}
          </h1>
          <Skeleton className="mt-2 h-3.5 w-56" />
        </div>
        <Skeleton className="h-9 w-28 rounded-lg" />
      </div>

      {/* profile / referral strip */}
      <Card className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Skeleton className="h-11 w-11 rounded-full" />
          <div>
            <Skeleton className="h-5 w-36" />
            <Skeleton className="mt-2 h-3 w-52" />
          </div>
        </div>
        <Skeleton className="h-5 w-16 rounded-full" />
      </Card>

      {/* stat tiles */}
      <div className="mb-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }, (_, i) => (
          <Card key={i}>
            <Skeleton className="h-3.5 w-24" />
            <Skeleton className="mt-2.5 h-7 w-28" />
          </Card>
        ))}
      </div>

      {/* chart */}
      <Card className="mb-5">
        <Skeleton className="h-3.5 w-36" />
        <Skeleton className="mt-4 h-[240px] w-full rounded-lg" />
      </Card>

      {/* list cards */}
      <div className="grid gap-5 lg:grid-cols-2">
        <TableCardSkeleton />
        <TableCardSkeleton rows={3} />
      </div>
    </div>
  );
}
