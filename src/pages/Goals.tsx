import { useEffect, useMemo, useState } from "react";
import { Target, Plus, Pencil, Trash2, Trophy, Loader2, Flag } from "lucide-react";
import { useApp } from "../store/AppContext";
import { useAuth } from "../store/AuthContext";
import type { Goal, GoalMetric, GoalPeriod, GoalScopeType, Milestone } from "../types";
import {
  listGoals,
  createGoal,
  updateGoal,
  deleteGoal,
  createMilestone,
  deleteMilestone,
  type GoalInput,
} from "../lib/resource-client";
import {
  PageHeader,
  Button,
  Card,
  Badge,
  Field,
  Input,
  Select,
  NumberField,
  SectionTitle,
  EmptyState,
} from "../components/ui";
import { Modal, ConfirmModal } from "../components/ui/Modal";
import { goalProgress, paceProjection, resolveGoalPeriod, milestoneViews } from "../lib/goals";
import { formatCurrency, formatNumber, todayISO } from "../lib/format";

const METRIC_LABEL: Record<GoalMetric, string> = {
  revenue: "Revenue",
  clients_closed: "Clients closed",
  referrals: "Referrals",
  mrr: "Monthly recurring revenue",
  commission_earned: "Commission earned",
  activity: "Activity",
};
const MONEY_METRICS = new Set<GoalMetric>(["revenue", "mrr", "commission_earned"]);
const fmtMetric = (metric: GoalMetric, v: number) =>
  MONEY_METRICS.has(metric) ? formatCurrency(v) : formatNumber(v);

const PERIOD_LABEL: Record<GoalPeriod, string> = { monthly: "This month", quarterly: "This quarter", custom: "Custom range" };

interface GoalDraft {
  id: string | null;
  scopeType: GoalScopeType;
  salespersonId: string;
  metric: GoalMetric;
  title: string;
  targetValue: number;
  period: GoalPeriod;
  periodStart: string;
  periodEnd: string;
}
function emptyDraft(): GoalDraft {
  return { id: null, scopeType: "salesperson", salespersonId: "", metric: "revenue", title: "", targetValue: 1000, period: "monthly", periodStart: "", periodEnd: "" };
}

export default function Goals() {
  const { data } = useApp();
  const { user } = useAuth();
  const isManager = user?.role === "sales_manager";
  const today = todayISO();

  const [goals, setGoals] = useState<Goal[]>([]);
  const [milestones, setMilestones] = useState<Milestone[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [editing, setEditing] = useState<GoalDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [deleteGoalId, setDeleteGoalId] = useState<string | null>(null);

  const [milestoneFor, setMilestoneFor] = useState<Goal | null>(null);
  const [msTitle, setMsTitle] = useState("");
  const [msThreshold, setMsThreshold] = useState(0);
  const [msReward, setMsReward] = useState("");

  const spName = (id: string | null) => data.salespeople.find((s) => s.id === id)?.name ?? "—";

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const r = await listGoals();
      setGoals(r.goals);
      setMilestones(r.milestones);
    } catch (e: any) {
      setError(e?.message ?? "could_not_load");
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const milestonesByGoal = useMemo(() => {
    const m = new Map<string, Milestone[]>();
    for (const ms of milestones) {
      const list = m.get(ms.goalId) ?? [];
      list.push(ms);
      m.set(ms.goalId, list);
    }
    return m;
  }, [milestones]);

  function openNew() {
    setFormError(null);
    const d = emptyDraft();
    if (isManager) d.scopeType = "salesperson";
    setEditing(d);
  }
  function openEdit(g: Goal) {
    setFormError(null);
    setEditing({
      id: g.id,
      scopeType: g.scopeType,
      salespersonId: g.salespersonId ?? "",
      metric: g.metric,
      title: g.title,
      targetValue: g.targetValue,
      period: g.period,
      periodStart: g.periodStart ?? "",
      periodEnd: g.periodEnd ?? "",
    });
  }

  async function saveGoal() {
    if (!editing || busy) return;
    if (editing.scopeType === "salesperson" && !editing.salespersonId) {
      setFormError("Pick a person for a salesperson goal.");
      return;
    }
    if (editing.targetValue <= 0) {
      setFormError("Set a target greater than zero.");
      return;
    }
    setBusy(true);
    setFormError(null);
    const input: GoalInput = {
      scopeType: editing.scopeType,
      salespersonId: editing.scopeType === "salesperson" ? editing.salespersonId : null,
      // team scope is pinned to the current manager server-side
      managerUserId: null,
      metric: editing.metric,
      title: editing.title.trim() || METRIC_LABEL[editing.metric],
      targetValue: editing.targetValue,
      period: editing.period,
      periodStart: editing.period === "custom" ? editing.periodStart || null : null,
      periodEnd: editing.period === "custom" ? editing.periodEnd || null : null,
    };
    try {
      if (editing.id) await updateGoal(editing.id, input);
      else await createGoal(input);
      setEditing(null);
      await load();
    } catch (e: any) {
      setFormError(humanizeError(e?.message));
    } finally {
      setBusy(false);
    }
  }

  async function removeGoal(id: string) {
    try {
      await deleteGoal(id);
      await load();
    } finally {
      setDeleteGoalId(null);
    }
  }

  function openMilestone(g: Goal) {
    setMilestoneFor(g);
    setMsTitle("");
    setMsThreshold(Math.round((g.targetValue || 0) / 2));
    setMsReward("");
  }
  async function saveMilestone() {
    if (!milestoneFor || busy || msThreshold <= 0) return;
    setBusy(true);
    try {
      await createMilestone({ goalId: milestoneFor.id, title: msTitle.trim() || "Milestone", thresholdValue: msThreshold, reward: msReward.trim() });
      setMilestoneFor(null);
      await load();
    } finally {
      setBusy(false);
    }
  }
  async function removeMilestone(id: string) {
    await deleteMilestone(id);
    await load();
  }

  return (
    <div>
      <PageHeader
        title="Goals & Milestones"
        subtitle="Set targets for people, teams, or the whole business — progress is measured live from real data"
        actions={
          <Button onClick={openNew}>
            <Plus className="h-4 w-4" /> New goal
          </Button>
        }
      />

      {loading ? (
        <div className="flex items-center gap-2 py-10 text-sm text-slate-500">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading goals…
        </div>
      ) : error ? (
        <Card className="border-rose-200 bg-rose-50/60 text-sm text-rose-700 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-300">
          Couldn't load goals ({error}). The API may be unreachable in this environment.
        </Card>
      ) : goals.length === 0 ? (
        <EmptyState
          icon={<Target className="h-6 w-6" />}
          title="No goals yet"
          description="Create a revenue, client, or commission goal for a salesperson, a team, or the whole company. Add milestones to keep people motivated."
          action={<Button onClick={openNew}><Plus className="h-4 w-4" /> New goal</Button>}
        />
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {goals.map((g) => {
            const actual = g.actual ?? 0;
            const prog = goalProgress(actual, g.targetValue);
            const period = resolveGoalPeriod(g, today);
            const pace = paceProjection(actual, g.targetValue, period, today);
            const mViews = milestoneViews(milestonesByGoal.get(g.id) ?? [], actual);
            const scopeLabel =
              g.scopeType === "tenant" ? "Whole company" : g.scopeType === "team" ? "Team" : spName(g.salespersonId);
            return (
              <Card key={g.id} className="flex flex-col">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <h3 className="truncate text-base font-semibold text-slate-900 dark:text-white">{g.title}</h3>
                    <p className="mt-0.5 text-sm text-slate-500">
                      {scopeLabel} · {METRIC_LABEL[g.metric]} · {PERIOD_LABEL[g.period]}
                    </p>
                  </div>
                  <div className="flex flex-none gap-1">
                    <Button variant="secondary" size="sm" onClick={() => openEdit(g)} aria-label="Edit"><Pencil className="h-4 w-4" /></Button>
                    <Button variant="secondary" size="sm" onClick={() => setDeleteGoalId(g.id)} aria-label="Delete" className="text-rose-500"><Trash2 className="h-4 w-4" /></Button>
                  </div>
                </div>

                {/* progress */}
                <div className="mt-4">
                  <div className="flex items-end justify-between text-sm">
                    <span className="font-semibold text-slate-900 dark:text-white">{fmtMetric(g.metric, actual)}</span>
                    <span className="text-slate-400">of {fmtMetric(g.metric, g.targetValue)}</span>
                  </div>
                  <ProgressBar pct={prog.pct} reached={prog.reached} onTrack={pace.onTrack} />
                  <div className="mt-1.5 flex items-center justify-between text-xs">
                    <span className={prog.reached ? "font-medium text-emerald-600 dark:text-emerald-400" : "text-slate-500"}>
                      {prog.pct}% {prog.reached ? "— reached 🎉" : `· ${fmtMetric(g.metric, prog.remaining)} to go`}
                    </span>
                    {!prog.reached && g.period !== "custom" && (
                      <span className={pace.onTrack ? "text-emerald-600 dark:text-emerald-400" : "text-amber-600 dark:text-amber-400"}>
                        On pace: {fmtMetric(g.metric, pace.projectedEnd)}
                      </span>
                    )}
                  </div>
                </div>

                {/* milestones */}
                <div className="mt-4 flex-1 border-t border-slate-100 pt-3 dark:border-slate-800">
                  <div className="mb-2 flex items-center justify-between">
                    <p className="text-xs font-medium uppercase tracking-wide text-slate-400">Milestones</p>
                    <Button variant="ghost" size="sm" onClick={() => openMilestone(g)}><Plus className="h-3.5 w-3.5" /> Add</Button>
                  </div>
                  {mViews.length === 0 ? (
                    <p className="text-xs text-slate-400">No milestones yet — add a few to mark the journey.</p>
                  ) : (
                    <ul className="space-y-1.5">
                      {mViews.map((m) => (
                        <li key={m.id} className="flex items-center gap-2 text-sm">
                          {m.achieved ? (
                            <Trophy className="h-4 w-4 flex-none text-amber-500" />
                          ) : (
                            <Flag className="h-4 w-4 flex-none text-slate-300 dark:text-slate-600" />
                          )}
                          <span className={"flex-1 truncate " + (m.achieved ? "text-slate-500 line-through" : "text-slate-700 dark:text-slate-200")}>
                            {m.title} · {fmtMetric(g.metric, m.thresholdValue)}
                            {m.reward && <span className="text-slate-400"> — {m.reward}</span>}
                          </span>
                          {!m.achieved && <Badge tone="slate" className="flex-none">{fmtMetric(g.metric, m.remaining)} left</Badge>}
                          <button onClick={() => removeMilestone(m.id)} className="flex-none text-slate-300 hover:text-rose-500" aria-label="Remove milestone">
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </Card>
            );
          })}
        </div>
      )}

      {/* ---- create / edit goal ---- */}
      <Modal
        open={!!editing}
        onClose={() => setEditing(null)}
        title={editing?.id ? "Edit goal" : "New goal"}
        footer={
          <>
            <Button variant="secondary" onClick={() => setEditing(null)}>Cancel</Button>
            <Button onClick={saveGoal} disabled={busy}>{busy ? "Saving…" : "Save goal"}</Button>
          </>
        }
      >
        {editing && (
          <div className="space-y-4">
            {formError && (
              <p className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-300">{formError}</p>
            )}
            <Field label="Applies to">
              <Select value={editing.scopeType} onChange={(e) => setEditing({ ...editing, scopeType: e.target.value as GoalScopeType })}>
                <option value="salesperson">A salesperson</option>
                {isManager ? <option value="team">My team</option> : <option value="tenant">The whole company</option>}
              </Select>
            </Field>
            {editing.scopeType === "salesperson" && (
              <Field label="Salesperson" required>
                <Select value={editing.salespersonId} onChange={(e) => setEditing({ ...editing, salespersonId: e.target.value })}>
                  <option value="">Select a person…</option>
                  {data.salespeople.map((s) => (
                    <option key={s.id} value={s.id}>{s.name}</option>
                  ))}
                </Select>
              </Field>
            )}
            <div className="grid grid-cols-2 gap-3">
              <Field label="Metric">
                <Select value={editing.metric} onChange={(e) => setEditing({ ...editing, metric: e.target.value as GoalMetric })}>
                  {(Object.keys(METRIC_LABEL) as GoalMetric[]).map((m) => (
                    <option key={m} value={m}>{METRIC_LABEL[m]}</option>
                  ))}
                </Select>
              </Field>
              <Field label="Target" hint={MONEY_METRICS.has(editing.metric) ? "In dollars." : "A count."}>
                <NumberField value={editing.targetValue} onChange={(v) => setEditing({ ...editing, targetValue: v })} prefix={MONEY_METRICS.has(editing.metric) ? "$" : undefined} min={0} />
              </Field>
            </div>
            <Field label="Title" hint="Optional — defaults to the metric name.">
              <Input value={editing.title} onChange={(e) => setEditing({ ...editing, title: e.target.value })} placeholder="e.g. Q1 new-client push" />
            </Field>
            <Field label="Period">
              <Select value={editing.period} onChange={(e) => setEditing({ ...editing, period: e.target.value as GoalPeriod })}>
                <option value="monthly">This month</option>
                <option value="quarterly">This quarter</option>
                <option value="custom">Custom range</option>
              </Select>
            </Field>
            {editing.period === "custom" && (
              <div className="grid grid-cols-2 gap-3">
                <Field label="Start"><Input type="date" value={editing.periodStart} onChange={(e) => setEditing({ ...editing, periodStart: e.target.value })} /></Field>
                <Field label="End"><Input type="date" value={editing.periodEnd} onChange={(e) => setEditing({ ...editing, periodEnd: e.target.value })} /></Field>
              </div>
            )}
            <p className="text-xs text-slate-400">
              Progress is computed automatically from payments, clients, and commissions — you never update it by hand.
            </p>
          </div>
        )}
      </Modal>

      {/* ---- add milestone ---- */}
      <Modal
        open={!!milestoneFor}
        onClose={() => setMilestoneFor(null)}
        title="Add milestone"
        footer={
          <>
            <Button variant="secondary" onClick={() => setMilestoneFor(null)}>Cancel</Button>
            <Button onClick={saveMilestone} disabled={busy || msThreshold <= 0}>Add milestone</Button>
          </>
        }
      >
        {milestoneFor && (
          <div className="space-y-4">
            <p className="text-sm text-slate-500">
              A checkpoint on the way to <span className="font-medium text-slate-700 dark:text-slate-200">{milestoneFor.title}</span>{" "}
              ({fmtMetric(milestoneFor.metric, milestoneFor.targetValue)} {METRIC_LABEL[milestoneFor.metric].toLowerCase()}).
            </p>
            <Field label="Label"><Input value={msTitle} onChange={(e) => setMsTitle(e.target.value)} placeholder="e.g. Halfway there" /></Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Threshold" hint="When this is reached.">
                <NumberField value={msThreshold} onChange={setMsThreshold} prefix={MONEY_METRICS.has(milestoneFor.metric) ? "$" : undefined} min={0} />
              </Field>
              <Field label="Reward" hint="Optional.">
                <Input value={msReward} onChange={(e) => setMsReward(e.target.value)} placeholder="e.g. $250 bonus" />
              </Field>
            </div>
          </div>
        )}
      </Modal>

      <ConfirmModal
        open={!!deleteGoalId}
        onClose={() => setDeleteGoalId(null)}
        onConfirm={() => deleteGoalId && removeGoal(deleteGoalId)}
        title="Delete goal?"
        message="This goal and its milestones will be removed. Progress is computed from data, so nothing else is affected."
      />
    </div>
  );
}

function ProgressBar({ pct, reached, onTrack }: { pct: number; reached: boolean; onTrack: boolean }) {
  const color = reached ? "bg-emerald-500" : onTrack ? "bg-brand-500" : "bg-amber-500";
  return (
    <div className="mt-2 h-2.5 w-full overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800">
      <div className={"h-full rounded-full transition-all " + color} style={{ width: `${Math.max(2, pct)}%` }} />
    </div>
  );
}

function humanizeError(code?: string): string {
  switch (code) {
    case "tenant_scope_admin_only": return "Only an owner/admin can set a company-wide goal.";
    case "manager_required": return "Pick which team this goal is for.";
    case "salesperson_not_on_team": return "That salesperson isn't on your team.";
    case "invalid_salesperson": return "That salesperson doesn't exist.";
    case "target_required": return "Set a target greater than zero.";
    case "salesperson_required": return "Pick a person for a salesperson goal.";
    default: return code ? `Couldn't save (${code}).` : "Couldn't save the goal.";
  }
}
