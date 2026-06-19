import { Link } from "react-router-dom";
import { Users, ChevronRight, UserPlus } from "lucide-react";
import type { CommissionPlan, Role, Salesperson } from "../../types";
import { useApp } from "../../store/AppContext";
import {
  assignmentsForPlan,
  planProjectedTotals,
} from "../../lib/plan-analytics";
import { Card, Badge, StatusBadge, SectionTitle, EmptyState } from "../ui/primitives";
import { formatCurrency } from "../../lib/format";

const ROLE_LABEL: Record<Role, string> = {
  salesperson: "Salespeople",
  affiliate: "Affiliates",
  partner: "Partners",
};
const ROLE_ORDER: Role[] = ["salesperson", "affiliate", "partner"];

/**
 * Shows who is assigned to a plan, grouped by role, with each person's client
 * count and a projected first-year exposure (Year-1 per-client payout times
 * their active clients). Read-only — it never changes roles or assignments,
 * just makes the plan's reach visible and links through to each person.
 */
export function PlanAssignments({ plan }: { plan: CommissionPlan }) {
  const { data } = useApp();
  const assignments = assignmentsForPlan(plan, data.salespeople, data.clients);
  const perClientY1 = planProjectedTotals(plan, data.settings.assumptions).total12;

  if (assignments.length === 0) {
    return (
      <Card>
        <SectionTitle>Assigned people</SectionTitle>
        <div className="mt-3">
          <EmptyState
            icon={<UserPlus className="h-5 w-5" />}
            title="Nobody is on this plan yet"
            description="Assign a salesperson, affiliate, or partner to this plan from their profile to see them here."
          />
        </div>
      </Card>
    );
  }

  const totalExposure = assignments.reduce(
    (sum, a) => sum + perClientY1 * a.activeClientCount,
    0,
  );

  const byRole = ROLE_ORDER.map((role) => ({
    role,
    people: assignments.filter((a) => a.person.role === role),
  })).filter((g) => g.people.length > 0);

  return (
    <Card padded={false}>
      <div className="flex items-center justify-between gap-2 px-5 pt-5">
        <SectionTitle>
          Assigned people
          <span className="ml-2 font-normal text-slate-400">
            {assignments.length} total
          </span>
        </SectionTitle>
        {totalExposure > 0 && (
          <div className="text-right">
            <p className="text-xs text-slate-400">Projected Y1 exposure</p>
            <p className="text-sm font-semibold text-slate-900 dark:text-white">
              {formatCurrency(totalExposure)}
            </p>
          </div>
        )}
      </div>

      <div className="px-5 pb-5">
        {byRole.map((group) => (
          <div key={group.role} className="mt-4 first:mt-2">
            <p className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-slate-400">
              <Users className="h-3.5 w-3.5" />
              {ROLE_LABEL[group.role]}
              <span className="font-normal">· {group.people.length}</span>
            </p>
            <ul className="divide-y divide-slate-100 overflow-hidden rounded-xl border border-slate-200 dark:divide-slate-800/60 dark:border-slate-800">
              {group.people.map(({ person, clientCount, activeClientCount }) => (
                <li key={person.id}>
                  <Link
                    to={`/people/${person.id}`}
                    className="flex items-center gap-3 bg-white px-4 py-3 transition hover:bg-slate-50 dark:bg-slate-900 dark:hover:bg-slate-800/60"
                  >
                    <Avatar person={person} />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-slate-800 dark:text-slate-100">
                        {person.name}
                      </p>
                      <p className="truncate text-xs text-slate-500">
                        {clientCount} client{clientCount === 1 ? "" : "s"}
                        {activeClientCount !== clientCount &&
                          ` · ${activeClientCount} active`}
                      </p>
                    </div>
                    <StatusBadge status={person.status} />
                    {perClientY1 > 0 && activeClientCount > 0 && (
                      <span className="hidden text-right sm:block">
                        <span className="block text-xs text-slate-400">Y1 exposure</span>
                        <span className="text-sm font-medium tabular-nums text-slate-700 dark:text-slate-200">
                          {formatCurrency(perClientY1 * activeClientCount)}
                        </span>
                      </span>
                    )}
                    <ChevronRight className="h-4 w-4 flex-none text-slate-300 dark:text-slate-600" />
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ))}

        <p className="mt-4 text-xs text-slate-400">
          Exposure is an estimate: this plan's Year-1 per-client payout ({formatCurrency(perClientY1)}){" "}
          times each person's active clients. It is not a committed amount.
        </p>
      </div>
    </Card>
  );
}

function Avatar({ person }: { person: Salesperson }) {
  const initials = person.name
    .split(" ")
    .map((n) => n[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase();
  return (
    <span className="flex h-9 w-9 flex-none items-center justify-center rounded-full bg-brand-100 text-xs font-semibold text-brand-700 dark:bg-brand-500/15 dark:text-brand-300">
      {initials || "?"}
    </span>
  );
}
