import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  Plus,
  Pencil,
  Copy,
  Trash2,
  ScrollText,
  LineChart,
  Users,
  Clock,
} from "lucide-react";
import { useApp } from "../store/AppContext";
import type { CommissionPlan } from "../types";
import {
  PageHeader,
  Button,
  Card,
  Badge,
  EmptyState,
} from "../components/ui";
import { ConfirmModal } from "../components/ui/Modal";
import { ruleHeadline } from "../lib/commission-engine";
import { timingHeadline } from "../lib/commission-timing";
import { uid, todayISO, formatCurrency } from "../lib/format";
import { duplicatePlan, deletePlan } from "../lib/resource-client";

const TYPE_TONE = {
  setup_fee: "blue",
  signup_bonus: "violet",
  monthly_residual: "green",
  salary: "amber",
} as const;

export default function Plans() {
  const { data, dispatch, reload } = useApp();
  const navigate = useNavigate();
  const [deleteId, setDeleteId] = useState<string | null>(null);

  const assignedCount = (planId: string) =>
    data.salespeople.filter((s) => s.commissionPlanId === planId).length;

  async function duplicate(plan: CommissionPlan) {
    const copy: CommissionPlan = {
      ...plan,
      id: uid("plan"),
      name: `${plan.name} (copy)`,
      createdAt: todayISO(),
      rules: plan.rules.map((r) => ({ ...r, id: uid("rule") })),
    };
    try {
      const { id } = await duplicatePlan(plan.id);
      await reload();
      navigate(`/plans/${id}/edit`);
    } catch {
      dispatch({ type: "PLAN_ADD", plan: copy });
      navigate(`/plans/${copy.id}/edit`);
    }
  }

  async function confirmDelete() {
    if (!deleteId) return;
    const id = deleteId;
    try {
      await deletePlan(id);
      await reload();
    } catch {
      dispatch({ type: "PLAN_DELETE", id });
    }
    setDeleteId(null);
  }

  return (
    <div>
      <PageHeader
        title="Commission Plans"
        subtitle="Build flexible, rule-based plans and preview exactly what they pay"
        actions={
          <Button onClick={() => navigate("/plans/new")}>
            <Plus className="h-4 w-4" /> New plan
          </Button>
        }
      />

      {data.plans.length === 0 ? (
        <EmptyState
          icon={<ScrollText className="h-6 w-6" />}
          title="No commission plans yet"
          description="Create your first plan from setup-fee, signup-bonus, monthly-residual, and salary rules."
          action={<Button onClick={() => navigate("/plans/new")}><Plus className="h-4 w-4" /> New plan</Button>}
        />
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {data.plans.map((plan) => (
            <Card key={plan.id} className="flex flex-col">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <h3 className="truncate text-base font-semibold text-slate-900 dark:text-white">{plan.name}</h3>
                  {plan.description && (
                    <p className="mt-0.5 line-clamp-2 text-sm text-slate-500">{plan.description}</p>
                  )}
                </div>
                {assignedCount(plan.id) > 0 && (
                  <span className="inline-flex flex-none items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-500 dark:bg-slate-800">
                    <Users className="h-3 w-3" /> {assignedCount(plan.id)}
                  </span>
                )}
              </div>

              <div className="mt-4 flex-1 space-y-1.5">
                {plan.rules.length === 0 ? (
                  <p className="text-sm text-slate-400">No rules yet</p>
                ) : (
                  plan.rules.slice(0, 5).map((r) => (
                    <div key={r.id} className="flex items-center gap-2 text-sm">
                      <Badge tone={TYPE_TONE[r.type]} className="flex-none">{r.type.replace("_", " ")}</Badge>
                      <span className="truncate text-slate-600 dark:text-slate-300">{ruleHeadline(r)}</span>
                    </div>
                  ))
                )}
                {plan.rules.length > 5 && (
                  <p className="text-xs text-slate-400">+{plan.rules.length - 5} more rules</p>
                )}
              </div>

              <div className="mt-4 flex items-center justify-between border-t border-slate-100 pt-3 text-xs text-slate-400 dark:border-slate-800">
                <span>Sample: {formatCurrency(plan.sampleSetupFee)} setup · {formatCurrency(plan.sampleMonthly)}/mo</span>
              </div>

              {plan.timing && (
                <div className="mt-2 flex items-start gap-1.5 text-xs text-slate-500 dark:text-slate-400">
                  <Clock className="mt-0.5 h-3.5 w-3.5 flex-none text-slate-400" />
                  <span>{timingHeadline(plan.timing)}</span>
                </div>
              )}

              <div className="mt-3 flex flex-wrap gap-2">
                <Link to={`/plans/${plan.id}/projection`} className="flex-1">
                  <Button variant="secondary" size="sm" className="w-full">
                    <LineChart className="h-4 w-4" /> Projection
                  </Button>
                </Link>
                <Link to={`/plans/${plan.id}/edit`}>
                  <Button variant="secondary" size="sm" aria-label="Edit"><Pencil className="h-4 w-4" /></Button>
                </Link>
                <Button variant="secondary" size="sm" onClick={() => duplicate(plan)} aria-label="Duplicate"><Copy className="h-4 w-4" /></Button>
                <Button variant="secondary" size="sm" onClick={() => setDeleteId(plan.id)} aria-label="Delete" className="text-rose-500"><Trash2 className="h-4 w-4" /></Button>
              </div>
            </Card>
          ))}
        </div>
      )}

      <ConfirmModal
        open={!!deleteId}
        onClose={() => setDeleteId(null)}
        onConfirm={confirmDelete}
        title="Delete plan?"
        message="Salespeople on this plan will be unassigned and their commissions recalculated. This cannot be undone."
      />
    </div>
  );
}
