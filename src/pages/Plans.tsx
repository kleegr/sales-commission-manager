import { useMemo, useState } from "react";
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
  RotateCcw,
  ShieldCheck,
  Search,
  LayoutGrid,
  List,
  Eye,
  Maximize2,
  Building2,
  X,
} from "lucide-react";
import { useApp } from "../store/AppContext";
import type { CommissionPlan, RuleType } from "../types";
import {
  PageHeader,
  Button,
  Card,
  Badge,
  EmptyState,
  StatCard,
} from "../components/ui";
import { ConfirmModal } from "../components/ui/Modal";
import { Input, Select } from "../components/ui/form";
import { PlanPreviewModal } from "../components/plan/PlanPreviewModal";
import { timingHeadline } from "../lib/commission-timing";
import {
  planProjectedTotals,
  summarizePlanRules,
  planRuleTypes,
  planTimingFlags,
  planUsage,
  RULE_TYPE_LABEL,
  RULE_TYPE_TONE,
} from "../lib/plan-analytics";
import { uid, todayISO, formatCurrency, classNames } from "../lib/format";

type View = "cards" | "table";
type StatusFilter = "all" | "active" | "unused" | "draft";
type SortKey = "name" | "newest" | "oldest" | "assigned" | "payout";

const SORT_LABEL: Record<SortKey, string> = {
  name: "Name (A–Z)",
  newest: "Newest first",
  oldest: "Oldest first",
  assigned: "Most assigned",
  payout: "Highest 1-yr payout",
};

const USAGE_TONE = {
  active: "green",
  unused: "slate",
  draft: "amber",
} as const;

export default function Plans() {
  const { data, dispatch, tenant } = useApp();
  const navigate = useNavigate();

  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [previewPlan, setPreviewPlan] = useState<CommissionPlan | null>(null);
  const [view, setView] = useState<View>("cards");
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<StatusFilter>("all");
  const [typeFilter, setTypeFilter] = useState<RuleType | "all">("all");
  const [assignee, setAssignee] = useState<string>("all");
  const [sort, setSort] = useState<SortKey>("name");

  // Derive everything the list needs once per data change.
  const rows = useMemo(
    () =>
      data.plans.map((plan) => {
        const usage = planUsage(plan, data.salespeople);
        const totals = planProjectedTotals(plan, data.settings.assumptions);
        return {
          plan,
          usage,
          totals,
          summary: summarizePlanRules(plan),
          types: planRuleTypes(plan),
          flags: planTimingFlags(plan),
          assignedIds: data.salespeople
            .filter((s) => s.commissionPlanId === plan.id)
            .map((s) => s.id),
        };
      }),
    [data.plans, data.salespeople, data.settings.assumptions],
  );

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const out = rows.filter((r) => {
      if (q && !`${r.plan.name} ${r.plan.description}`.toLowerCase().includes(q))
        return false;
      if (status !== "all" && r.usage.kind !== status) return false;
      if (typeFilter !== "all" && !r.types.includes(typeFilter)) return false;
      if (assignee !== "all" && !r.assignedIds.includes(assignee)) return false;
      return true;
    });
    out.sort((a, b) => {
      switch (sort) {
        case "name":
          return a.plan.name.localeCompare(b.plan.name);
        case "newest":
          return b.plan.createdAt.localeCompare(a.plan.createdAt);
        case "oldest":
          return a.plan.createdAt.localeCompare(b.plan.createdAt);
        case "assigned":
          return b.assignedIds.length - a.assignedIds.length;
        case "payout":
          return b.totals.total12 - a.totals.total12;
      }
    });
    return out;
  }, [rows, search, status, typeFilter, assignee, sort]);

  const totalAssigned = data.salespeople.filter(
    (s) => s.commissionPlanId,
  ).length;
  const inUseCount = rows.filter((r) => r.usage.kind === "active").length;

  const filtersActive =
    search.trim() !== "" ||
    status !== "all" ||
    typeFilter !== "all" ||
    assignee !== "all";

  function duplicate(plan: CommissionPlan) {
    const copy: CommissionPlan = {
      ...plan,
      id: uid("plan"),
      name: `${plan.name} (copy)`,
      createdAt: todayISO(),
      rules: plan.rules.map((r) => ({ ...r, id: uid("rule") })),
    };
    dispatch({ type: "PLAN_ADD", plan: copy });
    navigate(`/plans/${copy.id}/edit`);
  }

  function clearFilters() {
    setSearch("");
    setStatus("all");
    setTypeFilter("all");
    setAssignee("all");
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

      {/* Workspace + at-a-glance numbers */}
      {tenant && (
        <div className="mb-4 inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm text-slate-600 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-300">
          <Building2 className="h-4 w-4 text-slate-400" />
          Workspace: <span className="font-medium text-slate-900 dark:text-white">{tenant}</span>
          <span className="text-slate-400">· plans here belong only to this sub-account</span>
        </div>
      )}

      {data.plans.length === 0 ? (
        <EmptyState
          icon={<ScrollText className="h-6 w-6" />}
          title="No commission plans yet"
          description="Create your first plan from setup-fee, signup-bonus, monthly-residual, and salary rules."
          action={
            <Button onClick={() => navigate("/plans/new")}>
              <Plus className="h-4 w-4" /> New plan
            </Button>
          }
        />
      ) : (
        <>
          <div className="mb-5 grid gap-4 sm:grid-cols-3">
            <StatCard
              label="Total plans"
              value={data.plans.length}
              icon={<ScrollText className="h-5 w-5" />}
              tone="blue"
            />
            <StatCard
              label="In use"
              value={inUseCount}
              sub={`${data.plans.length - inUseCount} not assigned`}
              icon={<Users className="h-5 w-5" />}
              tone="green"
            />
            <StatCard
              label="People assigned"
              value={totalAssigned}
              icon={<Users className="h-5 w-5" />}
              tone="violet"
            />
          </div>

          {/* Toolbar */}
          <Card padded={false} className="mb-5 p-3">
            <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
              <div className="relative flex-1">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                <Input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search plans by name or description…"
                  className="pl-9"
                />
              </div>
              <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap sm:items-center">
                <Select
                  value={status}
                  onChange={(e) => setStatus(e.target.value as StatusFilter)}
                  aria-label="Filter by status"
                >
                  <option value="all">All statuses</option>
                  <option value="active">In use</option>
                  <option value="unused">Not assigned</option>
                  <option value="draft">Draft (no rules)</option>
                </Select>
                <Select
                  value={typeFilter}
                  onChange={(e) => setTypeFilter(e.target.value as RuleType | "all")}
                  aria-label="Filter by rule type"
                >
                  <option value="all">All plan types</option>
                  <option value="setup_fee">Has setup fee</option>
                  <option value="signup_bonus">Has signup bonus</option>
                  <option value="monthly_residual">Has residual</option>
                  <option value="salary">Has salary</option>
                </Select>
                <Select
                  value={assignee}
                  onChange={(e) => setAssignee(e.target.value)}
                  aria-label="Filter by assigned person"
                >
                  <option value="all">Anyone assigned</option>
                  {data.salespeople.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </Select>
                <Select
                  value={sort}
                  onChange={(e) => setSort(e.target.value as SortKey)}
                  aria-label="Sort plans"
                >
                  {(Object.keys(SORT_LABEL) as SortKey[]).map((k) => (
                    <option key={k} value={k}>
                      Sort: {SORT_LABEL[k]}
                    </option>
                  ))}
                </Select>
                <div className="col-span-2 inline-flex rounded-lg border border-slate-200 bg-white p-0.5 dark:border-slate-800 dark:bg-slate-900 sm:col-span-1">
                  <ViewButton active={view === "cards"} onClick={() => setView("cards")} label="Card view">
                    <LayoutGrid className="h-4 w-4" />
                  </ViewButton>
                  <ViewButton active={view === "table"} onClick={() => setView("table")} label="List view">
                    <List className="h-4 w-4" />
                  </ViewButton>
                </div>
              </div>
            </div>
            {filtersActive && (
              <div className="mt-2 flex items-center gap-2 text-xs text-slate-500">
                <span>
                  {filtered.length} of {data.plans.length} plans
                </span>
                <button
                  onClick={clearFilters}
                  className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 font-medium text-slate-600 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700"
                >
                  <X className="h-3 w-3" /> Clear filters
                </button>
              </div>
            )}
          </Card>

          {filtered.length === 0 ? (
            <EmptyState
              icon={<Search className="h-6 w-6" />}
              title="No plans match your filters"
              description="Try a different search term or clear the filters."
              action={<Button variant="secondary" onClick={clearFilters}>Clear filters</Button>}
            />
          ) : view === "cards" ? (
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
              {filtered.map((r) => (
                <PlanCard
                  key={r.plan.id}
                  row={r}
                  onPreview={() => setPreviewPlan(r.plan)}
                  onDuplicate={() => duplicate(r.plan)}
                  onDelete={() => setDeleteId(r.plan.id)}
                />
              ))}
            </div>
          ) : (
            <PlanTable
              rows={filtered}
              onPreview={(p) => setPreviewPlan(p)}
              onDuplicate={duplicate}
              onDelete={(id) => setDeleteId(id)}
            />
          )}
        </>
      )}

      <PlanPreviewModal
        open={!!previewPlan}
        plan={previewPlan}
        assumptions={data.settings.assumptions}
        onClose={() => setPreviewPlan(null)}
      />

      <ConfirmModal
        open={!!deleteId}
        onClose={() => setDeleteId(null)}
        onConfirm={() => deleteId && dispatch({ type: "PLAN_DELETE", id: deleteId })}
        title="Delete plan?"
        message="Salespeople on this plan will be unassigned and their commissions recalculated. This cannot be undone."
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
type Row = {
  plan: CommissionPlan;
  usage: ReturnType<typeof planUsage>;
  totals: ReturnType<typeof planProjectedTotals>;
  summary: ReturnType<typeof summarizePlanRules>;
  types: RuleType[];
  flags: ReturnType<typeof planTimingFlags>;
  assignedIds: string[];
};

function TimingBadges({ flags, plan }: { flags: Row["flags"]; plan: CommissionPlan }) {
  if (!flags.hasTiming) return null;
  return (
    <div className="flex flex-wrap gap-1.5">
      {flags.hasHold && (
        <Badge tone="blue">
          <Clock className="h-3 w-3" /> Hold/release
        </Badge>
      )}
      {flags.activeOnly && (
        <Badge tone="amber">
          <ShieldCheck className="h-3 w-3" /> Active only
        </Badge>
      )}
      {flags.hasClawback && (
        <Badge tone="rose">
          <RotateCcw className="h-3 w-3" /> Clawback
        </Badge>
      )}
    </div>
  );
}

function RuleSummaryRows({ summary }: { summary: Row["summary"] }) {
  const items: { tone: keyof typeof RULE_TYPE_TONE; label: string; text: string }[] = [];
  if (summary.setup) items.push({ tone: "setup_fee", label: "Setup", text: summary.setup });
  if (summary.signupBonus)
    items.push({ tone: "signup_bonus", label: "Bonus", text: summary.signupBonus });
  if (summary.residual)
    items.push({ tone: "monthly_residual", label: "Residual", text: summary.residual });
  if (summary.salary) items.push({ tone: "salary", label: "Salary", text: summary.salary });

  if (items.length === 0)
    return <p className="text-sm text-slate-400">No rules yet</p>;

  return (
    <div className="space-y-1.5">
      {items.map((it, i) => (
        <div key={i} className="flex items-center gap-2 text-sm">
          <Badge tone={RULE_TYPE_TONE[it.tone]} className="flex-none">
            {it.label}
          </Badge>
          <span className="truncate text-slate-600 dark:text-slate-300">{it.text}</span>
        </div>
      ))}
    </div>
  );
}

function PlanCard({
  row,
  onPreview,
  onDuplicate,
  onDelete,
}: {
  row: Row;
  onPreview: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
}) {
  const { plan, usage, totals, summary, flags } = row;
  return (
    <Card className="flex flex-col">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="truncate text-base font-semibold text-slate-900 dark:text-white">
            {plan.name}
          </h3>
          {plan.description && (
            <p className="mt-0.5 line-clamp-2 text-sm text-slate-500">{plan.description}</p>
          )}
        </div>
        <Badge tone={USAGE_TONE[usage.kind]} className="flex-none">
          {usage.label}
          {usage.kind === "active" && ` · ${usage.total}`}
        </Badge>
      </div>

      <div className="mt-4 flex-1">
        <RuleSummaryRows summary={summary} />
      </div>

      {/* Projected payout */}
      <div className="mt-4 grid grid-cols-3 gap-2 rounded-xl border border-slate-100 bg-slate-50/70 p-3 dark:border-slate-800 dark:bg-slate-800/30">
        <Money label="Upfront" value={totals.upfront} />
        <Money label="1-yr" value={totals.total12} accent />
        <Money label="2-yr" value={totals.total24} />
      </div>
      <p className="mt-1.5 text-[11px] text-slate-400">
        Per client · {formatCurrency(totals.setupFee)} setup · {formatCurrency(totals.monthly)}/mo
      </p>

      <div className="mt-3">
        <TimingBadges flags={flags} plan={plan} />
      </div>

      <div className="mt-4 flex flex-wrap gap-2 border-t border-slate-100 pt-3 dark:border-slate-800">
        <Button variant="secondary" size="sm" onClick={onPreview} className="flex-1">
          <Maximize2 className="h-4 w-4" /> Preview
        </Button>
        <Link to={`/plans/${plan.id}/projection`} className="flex-1">
          <Button variant="secondary" size="sm" className="w-full">
            <LineChart className="h-4 w-4" /> View
          </Button>
        </Link>
        <Link to={`/plans/${plan.id}/edit`}>
          <Button variant="secondary" size="sm" aria-label="Edit plan">
            <Pencil className="h-4 w-4" />
          </Button>
        </Link>
        <Button variant="secondary" size="sm" onClick={onDuplicate} aria-label="Duplicate plan">
          <Copy className="h-4 w-4" />
        </Button>
        <Button
          variant="secondary"
          size="sm"
          onClick={onDelete}
          aria-label="Delete plan"
          className="text-rose-500"
        >
          <Trash2 className="h-4 w-4" />
        </Button>
      </div>
    </Card>
  );
}

function Money({ label, value, accent }: { label: string; value: number; accent?: boolean }) {
  return (
    <div className="min-w-0">
      <p className="text-[11px] uppercase tracking-wide text-slate-400">{label}</p>
      <p
        className={classNames(
          "truncate text-sm font-semibold tabular-nums",
          accent ? "text-brand-600 dark:text-brand-300" : "text-slate-900 dark:text-white",
        )}
      >
        {formatCurrency(value)}
      </p>
    </div>
  );
}

function PlanTable({
  rows,
  onPreview,
  onDuplicate,
  onDelete,
}: {
  rows: Row[];
  onPreview: (p: CommissionPlan) => void;
  onDuplicate: (p: CommissionPlan) => void;
  onDelete: (id: string) => void;
}) {
  return (
    <Card padded={false} className="overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500 dark:bg-slate-800/40">
            <tr>
              <th className="px-4 py-3 font-semibold">Plan</th>
              <th className="px-4 py-3 font-semibold">Status</th>
              <th className="px-4 py-3 text-center font-semibold">People</th>
              <th className="px-4 py-3 font-semibold">Timing</th>
              <th className="px-4 py-3 text-right font-semibold">Upfront</th>
              <th className="px-4 py-3 text-right font-semibold">1-yr</th>
              <th className="px-4 py-3 text-right font-semibold">2-yr</th>
              <th className="px-4 py-3 text-right font-semibold">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 dark:divide-slate-800/60">
            {rows.map((r) => (
              <tr key={r.plan.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/40">
                <td className="px-4 py-3">
                  <p className="font-medium text-slate-800 dark:text-slate-100">{r.plan.name}</p>
                  <p className="mt-0.5 flex flex-wrap gap-1">
                    {r.types.map((t) => (
                      <Badge key={t} tone={RULE_TYPE_TONE[t]} className="text-[10px]">
                        {RULE_TYPE_LABEL[t]}
                      </Badge>
                    ))}
                    {r.types.length === 0 && (
                      <span className="text-xs text-slate-400">No rules</span>
                    )}
                  </p>
                </td>
                <td className="px-4 py-3">
                  <Badge tone={USAGE_TONE[r.usage.kind]}>{r.usage.label}</Badge>
                </td>
                <td className="px-4 py-3 text-center tabular-nums text-slate-600 dark:text-slate-300">
                  {r.assignedIds.length}
                </td>
                <td className="px-4 py-3">
                  {r.flags.hasTiming ? (
                    <span className="text-xs text-slate-500" title={timingHeadline(r.plan.timing)}>
                      {timingHeadline(r.plan.timing)}
                    </span>
                  ) : (
                    <span className="text-xs text-slate-400">Pays immediately</span>
                  )}
                </td>
                <td className="px-4 py-3 text-right tabular-nums text-slate-600 dark:text-slate-300">
                  {formatCurrency(r.totals.upfront)}
                </td>
                <td className="px-4 py-3 text-right font-medium tabular-nums text-brand-600 dark:text-brand-300">
                  {formatCurrency(r.totals.total12)}
                </td>
                <td className="px-4 py-3 text-right tabular-nums text-slate-600 dark:text-slate-300">
                  {formatCurrency(r.totals.total24)}
                </td>
                <td className="px-4 py-3">
                  <div className="flex items-center justify-end gap-1">
                    <Button variant="ghost" size="sm" onClick={() => onPreview(r.plan)} aria-label="Preview plan">
                      <Eye className="h-4 w-4" />
                    </Button>
                    <Link to={`/plans/${r.plan.id}/edit`}>
                      <Button variant="ghost" size="sm" aria-label="Edit plan">
                        <Pencil className="h-4 w-4" />
                      </Button>
                    </Link>
                    <Button variant="ghost" size="sm" onClick={() => onDuplicate(r.plan)} aria-label="Duplicate plan">
                      <Copy className="h-4 w-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => onDelete(r.plan.id)}
                      aria-label="Delete plan"
                      className="text-rose-500 hover:bg-rose-50 dark:hover:bg-rose-500/10"
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function ViewButton({
  active,
  onClick,
  label,
  children,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      aria-label={label}
      aria-pressed={active}
      className={classNames(
        "inline-flex flex-1 items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition",
        active
          ? "bg-brand-600 text-white shadow-sm"
          : "text-slate-600 hover:text-slate-900 dark:text-slate-300 dark:hover:text-white",
      )}
    >
      {children}
    </button>
  );
}
