import { Link, useParams } from "react-router-dom";
import { ArrowLeft, Pencil, LineChart } from "lucide-react";
import { useApp } from "../store/AppContext";
import { PageHeader, Button, Card, EmptyState, Badge } from "../components/ui";
import { ProjectionView } from "../components/plan/ProjectionView";
import { ruleHeadline } from "../lib/commission-engine";
import { formatCurrency } from "../lib/format";

const TYPE_TONE = {
  setup_fee: "blue",
  signup_bonus: "violet",
  monthly_residual: "green",
  salary: "amber",
} as const;

export default function PlanProjection() {
  const { data } = useApp();
  const { id } = useParams();
  const plan = data.plans.find((p) => p.id === id);
  const plansLoaded = data.plans.length > 0;

  if (!plan) {
    if (!plansLoaded) return null;
    return (
      <div>
        <PageHeader title="Plan not found" />
        <EmptyState
          icon={<LineChart className="h-6 w-6" />}
          title="That plan doesn't exist"
          action={
            <Link to="/plans">
              <Button>Back to plans</Button>
            </Link>
          }
        />
      </div>
    );
  }

  return (
    <div>
      <Link
        to="/plans"
        className="mb-3 inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-700 dark:hover:text-slate-300"
      >
        <ArrowLeft className="h-4 w-4" /> Plans
      </Link>

      <PageHeader
        title={plan.name}
        subtitle={plan.description || "Month-by-month and year-by-year projection"}
        actions={
          <Link to={`/plans/${plan.id}/edit`}>
            <Button variant="secondary">
              <Pencil className="h-4 w-4" /> Edit plan
            </Button>
          </Link>
        }
      />

      <Card className="mb-6">
        <p className="mb-3 text-xs font-medium uppercase tracking-wide text-slate-400">
          Rules in this plan
        </p>
        {plan.rules.length === 0 ? (
          <p className="text-sm text-slate-400">No rules yet — edit the plan to add some.</p>
        ) : (
          <div className="space-y-1.5">
            {plan.rules.map((r) => (
              <div key={r.id} className="flex items-center gap-2 text-sm">
                <Badge tone={TYPE_TONE[r.type]} className="flex-none">
                  {r.type.replace("_", " ")}
                </Badge>
                <span className="text-slate-600 dark:text-slate-300">{ruleHeadline(r)}</span>
              </div>
            ))}
          </div>
        )}
        <p className="mt-3 border-t border-slate-100 pt-3 text-xs text-slate-400 dark:border-slate-800">
          Sample inputs: {formatCurrency(plan.sampleSetupFee)} setup ·{" "}
          {formatCurrency(plan.sampleMonthly)}/mo
        </p>
      </Card>

      <ProjectionView plan={plan} initialAssumptions={data.settings.assumptions} />
    </div>
  );
}
