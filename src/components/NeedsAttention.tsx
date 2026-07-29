import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import {
  CheckCircle2,
  ArrowRight,
  Users,
  Building2,
  HandCoins,
  Wallet,
  UserPlus,
} from "lucide-react";
import { useApp } from "../store/AppContext";
import { Card, Badge, EmptyState, SectionTitle } from "./ui";
import { classNames } from "../lib/format";

// ----------------------------------------------------------------------------
// NeedsAttention
//
// A compact action center for the admin dashboard. It surfaces only the work
// that is actually waiting (count > 0): unassigned people/clients, held
// commissions ready to release, payouts awaiting approval, and pending
// applications. Each row links straight to the page that clears it. When there
// is nothing outstanding it shows a friendly "all caught up" state.
// ----------------------------------------------------------------------------

type Tone = "amber" | "blue" | "violet";

interface Item {
  label: string;
  count: number;
  to: string;
  tone: Tone;
  icon: ReactNode;
}

const toneTile: Record<Tone, string> = {
  amber: "bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300",
  blue: "bg-blue-100 text-blue-700 dark:bg-blue-500/15 dark:text-blue-300",
  violet: "bg-violet-100 text-violet-700 dark:bg-violet-500/15 dark:text-violet-300",
};

export function NeedsAttention() {
  const { data } = useApp();

  const peopleWithoutPlan = data.salespeople.filter(
    (s) => s.status === "active" && !s.commissionPlanId,
  ).length;
  const clientsWithoutRep = data.clients.filter((c) => !c.salespersonId).length;
  const heldCommissions = data.commissions.filter((e) => e.status === "held").length;
  const payoutsToApprove = data.payouts.filter((p) => p.status === "submitted").length;
  const pendingApplications = data.salespeople.filter(
    (s) => s.approvalStatus === "pending",
  ).length;

  const items: Item[] = [
    {
      label: "People without a commission plan",
      count: peopleWithoutPlan,
      to: "/people",
      tone: "amber",
      icon: <Users className="h-4 w-4" />,
    },
    {
      label: "Clients without an assigned rep",
      count: clientsWithoutRep,
      to: "/clients",
      tone: "amber",
      icon: <Building2 className="h-4 w-4" />,
    },
    {
      label: "Commissions held & ready to release",
      count: heldCommissions,
      to: "/ledger",
      tone: "blue",
      icon: <HandCoins className="h-4 w-4" />,
    },
    {
      label: "Payouts awaiting approval",
      count: payoutsToApprove,
      to: "/payouts",
      tone: "violet",
      icon: <Wallet className="h-4 w-4" />,
    },
    {
      label: "Pending affiliate / partner applications",
      count: pendingApplications,
      to: "/people",
      tone: "violet",
      icon: <UserPlus className="h-4 w-4" />,
    },
  ];

  const active = items.filter((i) => i.count > 0);
  const openTotal = active.reduce((n, i) => n + i.count, 0);

  return (
    <Card padded={false} className="overflow-hidden">
      <div className="flex items-center justify-between px-5 py-4">
        <SectionTitle>Needs attention</SectionTitle>
        {active.length > 0 && <Badge tone="amber">{openTotal} open</Badge>}
      </div>

      {active.length === 0 ? (
        <div className="px-5 pb-5">
          <EmptyState
            icon={<CheckCircle2 className="h-6 w-6" />}
            title="You're all caught up"
            description="No held commissions, unassigned records, or approvals waiting on you."
          />
        </div>
      ) : (
        <ul className="border-t border-slate-100 px-2 py-2 dark:border-slate-800/60">
          {active.map((item) => (
            <li key={item.label}>
              <Link
                to={item.to}
                className="group flex items-center gap-3 rounded-lg px-3 py-2.5 transition hover:bg-slate-50 dark:hover:bg-slate-800/50"
              >
                <span
                  className={classNames(
                    "flex h-8 w-8 flex-none items-center justify-center rounded-lg",
                    toneTile[item.tone],
                  )}
                >
                  {item.icon}
                </span>
                <span className="min-w-0 flex-1 text-sm font-medium text-slate-800 dark:text-slate-100">
                  {item.label}
                </span>
                <Badge tone={item.tone}>{item.count}</Badge>
                <ArrowRight className="h-4 w-4 flex-none text-slate-300 transition group-hover:text-slate-500 dark:text-slate-600" />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
