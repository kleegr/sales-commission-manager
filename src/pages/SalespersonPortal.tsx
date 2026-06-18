import { useEffect, useMemo, useState } from "react";
import { UserRound, Building2, Plus, Loader2, Flag } from "lucide-react";
import { useApp } from "../store/AppContext";
import {
  PageHeader,
  Card,
  Button,
  EmptyState,
  StatCard,
  CommissionBadge,
  PayoutBadge,
  StatusBadge,
  SectionTitle,
  Badge,
  Select,
  Field,
  Input,
  Textarea,
  NumberField,
  Table,
  THead,
  TBody,
  TR,
  TH,
  TD,
} from "../components/ui";
import { Modal } from "../components/ui/Modal";
import { MoneyBarChart } from "../components/charts/Charts";
import { fullLedger, displayStatus, clientLabel } from "../lib/ledger";
import { commissionTotals, monthlySeries } from "../lib/analytics";
import { formatCurrency, formatDate, formatNumber, todayISO } from "../lib/format";
import { listGoals } from "../lib/resource-client";
import type { Goal, Milestone } from "../types";
import { goalProgress, paceProjection, resolveGoalPeriod, nextMilestone, projectedCommissionPerDeal } from "../lib/goals";

interface LeadDraft {
  companyName: string;
  contactName: string;
  email: string;
  phone: string;
  setupFee: number;
  monthlySubscription: number;
  notes: string;
}
function emptyLead(): LeadDraft {
  return { companyName: "", contactName: "", email: "", phone: "", setupFee: 0, monthlySubscription: 0, notes: "" };
}

const GOAL_MONEY_METRICS = new Set(["revenue", "mrr", "commission_earned"]);
const fmtGoalMetric = (metric: string, v: number) =>
  GOAL_MONEY_METRICS.has(metric) ? formatCurrency(v) : formatNumber(v);
const GOAL_METRIC_NOUN: Record<string, string> = {
  revenue: "revenue",
  clients_closed: "clients",
  referrals: "referrals",
  mrr: "MRR",
  commission_earned: "commission",
  activity: "activities",
};
const GOAL_PERIOD_LABEL: Record<string, string> = { monthly: "this month", quarterly: "this quarter", custom: "this period" };

export default function SalespersonPortal() {
  const { data, reload } = useApp();
  const active = data.salespeople.filter((s) => s.approvalStatus !== "rejected");
  const [spId, setSpId] = useState<string>("");

  const [leadOpen, setLeadOpen] = useState(false);
  const [lead, setLead] = useState<LeadDraft>(emptyLead());
  const [saving, setSaving] = useState(false);
  const [leadError, setLeadError] = useState<string | null>(null);

  async function submitLead() {
    if (!lead.companyName.trim()) {
      setLeadError("A company / client name is required.");
      return;
    }
    setSaving(true);
    setLeadError(null);
    try {
      const res = await fetch("/api/clients", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...lead, status: "active" }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `error_${res.status}`);
      }
      setLeadOpen(false);
      setLead(emptyLead());
      await reload();
    } catch {
      setLeadError("Couldn't add the lead. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  useEffect(() => {
    if (!spId && active.length > 0) setSpId(active[0].id);
  }, [active, spId]);

  const sp = data.salespeople.find((s) => s.id === spId);

  const mine = useMemo(
    () => (sp ? fullLedger(data, 24).filter((e) => e.salespersonId === sp.id) : []),
    [data, sp],
  );
  const totals = useMemo(() => commissionTotals(mine), [mine]);
  const myClients = useMemo(
    () => (sp ? data.clients.filter((c) => c.salespersonId === sp.id) : []),
    [data.clients, sp],
  );
  const myPayouts = useMemo(
    () =>
      sp
        ? [...data.payouts]
            .filter((p) => p.salespersonId === sp.id)
            .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
        : [],
    [data.payouts, sp],
  );
  const series = useMemo(() => monthlySeries(mine, 5, 6), [mine]);
  const seriesData = useMemo(
    () => series.map((p) => ({ label: p.label, earned: p.earned, projected: p.projected })),
    [series],
  );
  const recent = useMemo(
    () => [...mine].sort((a, b) => (a.dueDate < b.dueDate ? 1 : -1)).slice(0, 15),
    [mine],
  );

  // Goals & milestones (server-owned; each goal carries a server-computed actual).
  const [allGoals, setAllGoals] = useState<Goal[]>([]);
  const [allMilestones, setAllMilestones] = useState<Milestone[]>([]);
  useEffect(() => {
    let alive = true;
    listGoals()
      .then((r) => {
        if (!alive) return;
        setAllGoals(r.goals);
        setAllMilestones(r.milestones);
      })
      .catch(() => {
        /* API unreachable (e.g. offline) — the goals section simply stays hidden */
      });
    return () => {
      alive = false;
    };
  }, []);

  // The selected rep sees their own salesperson goals plus any company-wide goal.
  const myGoals = useMemo(
    () =>
      sp
        ? allGoals.filter(
            (g) => g.scopeType === "tenant" || (g.scopeType === "salesperson" && g.salespersonId === sp.id),
          )
        : [],
    [allGoals, sp],
  );
  const milestonesByGoal = useMemo(() => {
    const m = new Map<string, Milestone[]>();
    for (const ms of allMilestones) {
      const list = m.get(ms.goalId) ?? [];
      list.push(ms);
      m.set(ms.goalId, list);
    }
    return m;
  }, [allMilestones]);

  // "Each new client like your average earns ~$X in commission (first 12 months)."
  const perDealCommission = useMemo(() => {
    if (!sp) return 0;
    const plan = data.plans.find((p) => p.id === sp.commissionPlanId) ?? null;
    const a = data.settings.assumptions;
    return projectedCommissionPerDeal(plan, a.avgSetupFee, a.avgMonthly);
  }, [sp, data.plans, data.settings.assumptions]);

  if (active.length === 0) {
    return (
      <div>
        <PageHeader title="Salesperson portal" />
        <EmptyState
          icon={<UserRound className="h-6 w-6" />}
          title="No people to view"
          description="Add a salesperson, affiliate, or partner first."
        />
      </div>
    );
  }

  return (
    <div>
      <PageHeader
        title="Salesperson portal"
        subtitle="A simulated rep login — each person sees only their own clients and earnings"
        actions={
          <div className="flex items-center gap-2">
            <Field className="w-56">
              <Select value={spId} onChange={(e) => setSpId(e.target.value)}>
                {active.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Button onClick={() => setLeadOpen(true)}>
              <Plus className="h-4 w-4" /> Add lead
            </Button>
          </div>
        }
      />

      {sp && (
        <>
          <Card className="mb-5 flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <span className="flex h-11 w-11 items-center justify-center rounded-full bg-brand-100 text-brand-700 dark:bg-brand-500/15 dark:text-brand-300">
                <UserRound className="h-6 w-6" />
              </span>
              <div>
                <h2 className="text-lg font-semibold text-slate-900 dark:text-white">{sp.name}</h2>
                <p className="text-sm text-slate-500">
                  {sp.role[0].toUpperCase() + sp.role.slice(1)} ·{" "}
                  {sp.email || "no email on file"}
                </p>
              </div>
            </div>
            <StatusBadge status={sp.status} />
          </Card>

          <div className="mb-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard label="Total earned" value={formatCurrency(totals.earned)} tone="green" />
            <StatCard label="Paid" value={formatCurrency(totals.paid)} tone="blue" />
            <StatCard label="Pending" value={formatCurrency(totals.pending)} tone="amber" />
            <StatCard label="Projected" value={formatCurrency(totals.projected)} tone="cyan" />
          </div>

          {myGoals.length > 0 && (
            <Card className="mb-5">
              <div className="flex items-center justify-between">
                <SectionTitle>Your goals &amp; milestones</SectionTitle>
                {perDealCommission > 0 && (
                  <span className="hidden text-xs text-slate-500 sm:block">
                    Each new client ≈ <span className="font-semibold text-emerald-600 dark:text-emerald-400">{formatCurrency(perDealCommission)}</span> commission
                  </span>
                )}
              </div>
              <div className="mt-4 space-y-5">
                {myGoals.map((g) => {
                  const actual = g.actual ?? 0;
                  const prog = goalProgress(actual, g.targetValue);
                  const period = resolveGoalPeriod(g, todayISO());
                  const pace = paceProjection(actual, g.targetValue, period, todayISO());
                  const next = nextMilestone(milestonesByGoal.get(g.id) ?? [], actual);
                  const isCount = !GOAL_MONEY_METRICS.has(g.metric);
                  const dealsToGo = isCount ? Math.ceil(prog.remaining) : 0;
                  return (
                    <div key={g.id}>
                      <div className="flex items-baseline justify-between gap-2">
                        <p className="truncate text-sm font-medium text-slate-900 dark:text-white">
                          {g.title}
                          {g.scopeType === "tenant" && (
                            <Badge tone="violet" className="ml-2 align-middle">Company</Badge>
                          )}
                        </p>
                        <p className="flex-none text-xs text-slate-500">
                          {fmtGoalMetric(g.metric, actual)} / {fmtGoalMetric(g.metric, g.targetValue)} {GOAL_PERIOD_LABEL[g.period]}
                        </p>
                      </div>
                      <div className="mt-2 h-2.5 w-full overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800">
                        <div
                          className={
                            "h-full rounded-full transition-all " +
                            (prog.reached ? "bg-emerald-500" : pace.onTrack ? "bg-brand-500" : "bg-amber-500")
                          }
                          style={{ width: `${Math.max(2, prog.pct)}%` }}
                        />
                      </div>
                      <div className="mt-1.5 flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-xs">
                        <span className={prog.reached ? "font-medium text-emerald-600 dark:text-emerald-400" : "text-slate-600 dark:text-slate-300"}>
                          {prog.reached
                            ? "Goal reached — nice work! 🎉"
                            : `${prog.pct}% there · ${fmtGoalMetric(g.metric, prog.remaining)} ${GOAL_METRIC_NOUN[g.metric]} to go`}
                        </span>
                        {!prog.reached && g.period !== "custom" && (
                          <span className={pace.onTrack ? "text-emerald-600 dark:text-emerald-400" : "text-amber-600 dark:text-amber-400"}>
                            {pace.onTrack ? "On pace ✓" : "Behind pace"} · projecting {fmtGoalMetric(g.metric, pace.projectedEnd)}
                          </span>
                        )}
                      </div>

                      {/* motivational nudge for count-based goals */}
                      {!prog.reached && isCount && dealsToGo > 0 && perDealCommission > 0 && (g.metric === "clients_closed" || g.metric === "referrals") && (
                        <p className="mt-1.5 rounded-lg bg-emerald-50 px-3 py-1.5 text-xs text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300">
                          Close <span className="font-semibold">{dealsToGo} more</span> to hit this goal — about{" "}
                          <span className="font-semibold">{formatCurrency(dealsToGo * perDealCommission)}</span> in commission.
                        </p>
                      )}

                      {next && (
                        <div className="mt-1.5 flex items-center gap-1.5 text-xs text-slate-500">
                          <Flag className="h-3.5 w-3.5 text-slate-400" />
                          Next milestone: <span className="font-medium text-slate-700 dark:text-slate-200">{next.title}</span>
                          {" "}at {fmtGoalMetric(g.metric, next.thresholdValue)}
                          {" "}({fmtGoalMetric(g.metric, next.remaining)} away){next.reward && ` — ${next.reward}`}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </Card>
          )}

          <Card className="mb-5">
            <SectionTitle>Earnings over time</SectionTitle>
            <div className="mt-3">
              <MoneyBarChart
                data={seriesData}
                xKey="label"
                stacked
                series={[
                  { key: "earned", name: "Earned", color: "#16a34a" },
                  { key: "projected", name: "Projected", color: "#06b6d4" },
                ]}
                height={240}
              />
            </div>
          </Card>

          <div className="grid gap-5 lg:grid-cols-2">
            <Card padded={false} className="overflow-hidden">
              <div className="border-b border-slate-100 p-4 dark:border-slate-800">
                <SectionTitle>My clients ({myClients.length})</SectionTitle>
              </div>
              {myClients.length === 0 ? (
                <div className="p-6">
                  <EmptyState icon={<Building2 className="h-6 w-6" />} title="No clients assigned" />
                </div>
              ) : (
                <Table>
                  <THead>
                    <TR>
                      <TH>Company</TH>
                      <TH className="text-right">Monthly</TH>
                      <TH>Status</TH>
                    </TR>
                  </THead>
                  <TBody>
                    {myClients.map((c) => (
                      <TR key={c.id}>
                        <TD className="font-medium text-slate-900 dark:text-white">
                          {c.companyName}
                        </TD>
                        <TD className="text-right tabular-nums">
                          {formatCurrency(c.monthlySubscription)}
                        </TD>
                        <TD>
                          <StatusBadge status={c.status} />
                        </TD>
                      </TR>
                    ))}
                  </TBody>
                </Table>
              )}
            </Card>

            <Card padded={false} className="overflow-hidden">
              <div className="border-b border-slate-100 p-4 dark:border-slate-800">
                <SectionTitle>My payouts</SectionTitle>
              </div>
              {myPayouts.length === 0 ? (
                <div className="p-6">
                  <EmptyState icon={<UserRound className="h-6 w-6" />} title="No payouts yet" />
                </div>
              ) : (
                <Table>
                  <THead>
                    <TR>
                      <TH>Submitted</TH>
                      <TH className="text-right">Amount</TH>
                      <TH>Status</TH>
                    </TR>
                  </THead>
                  <TBody>
                    {myPayouts.map((p) => (
                      <TR key={p.id}>
                        <TD className="text-slate-500">
                          {p.submittedAt ? formatDate(p.submittedAt.slice(0, 10)) : "—"}
                        </TD>
                        <TD className="text-right font-semibold tabular-nums text-slate-900 dark:text-white">
                          {formatCurrency(p.totalAmount)}
                        </TD>
                        <TD>
                          <PayoutBadge status={p.status} />
                        </TD>
                      </TR>
                    ))}
                  </TBody>
                </Table>
              )}
            </Card>
          </div>

          <Card padded={false} className="mt-5 overflow-hidden">
            <div className="border-b border-slate-100 p-4 dark:border-slate-800">
              <SectionTitle>Recent commissions</SectionTitle>
            </div>
            {recent.length === 0 ? (
              <div className="p-6">
                <EmptyState icon={<UserRound className="h-6 w-6" />} title="No commissions yet" />
              </div>
            ) : (
              <Table>
                <THead>
                  <TR>
                    <TH>Client</TH>
                    <TH>Rule</TH>
                    <TH>Due</TH>
                    <TH className="text-right">Commission</TH>
                    <TH>Status</TH>
                  </TR>
                </THead>
                <TBody>
                  {recent.map((e) => (
                    <TR key={e.id}>
                      <TD className="text-slate-600 dark:text-slate-300">
                        {clientLabel(data.clients.find((c) => c.id === e.clientId))}
                      </TD>
                      <TD className="max-w-[220px] text-slate-600 dark:text-slate-300">{e.ruleLabel}</TD>
                      <TD className="whitespace-nowrap text-slate-500">{formatDate(e.dueDate)}</TD>
                      <TD className="text-right font-semibold tabular-nums text-slate-900 dark:text-white">
                        {formatCurrency(e.commissionAmount)}
                      </TD>
                      <TD>
                        <CommissionBadge status={displayStatus(e)} />
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            )}
          </Card>
        </>
      )}

      <Modal
        open={leadOpen}
        onClose={() => setLeadOpen(false)}
        title="Add a lead"
        size="lg"
        footer={
          <>
            <Button variant="secondary" onClick={() => setLeadOpen(false)} disabled={saving}>Cancel</Button>
            <Button onClick={() => void submitLead()} disabled={saving}>
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />} Save lead
            </Button>
          </>
        }
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Company / client name" required className="sm:col-span-2">
            <Input value={lead.companyName} onChange={(e) => setLead({ ...lead, companyName: e.target.value })} />
          </Field>
          <Field label="Contact name">
            <Input value={lead.contactName} onChange={(e) => setLead({ ...lead, contactName: e.target.value })} />
          </Field>
          <Field label="Email">
            <Input type="email" value={lead.email} onChange={(e) => setLead({ ...lead, email: e.target.value })} />
          </Field>
          <Field label="Phone">
            <Input value={lead.phone} onChange={(e) => setLead({ ...lead, phone: e.target.value })} />
          </Field>
          <Field label="Status">
            <Input value="Active" disabled />
          </Field>
          <Field label="Setup fee">
            <NumberField value={lead.setupFee} onChange={(v) => setLead({ ...lead, setupFee: v })} prefix="$" min={0} />
          </Field>
          <Field label="Monthly subscription">
            <NumberField value={lead.monthlySubscription} onChange={(v) => setLead({ ...lead, monthlySubscription: v })} prefix="$" min={0} />
          </Field>
          <Field label="Notes" className="sm:col-span-2">
            <Textarea value={lead.notes} onChange={(e) => setLead({ ...lead, notes: e.target.value })} />
          </Field>
          {leadError && <p className="text-sm text-rose-600 sm:col-span-2">{leadError}</p>}
          <p className="text-xs text-slate-400 sm:col-span-2">
            New leads are saved to the app database and assigned to you automatically. (GoHighLevel sync comes later.)
          </p>
        </div>
      </Modal>
    </div>
  );
}
