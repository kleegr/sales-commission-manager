import { useEffect, useMemo, useState } from "react";
import { UserRound, Building2 } from "lucide-react";
import { useApp } from "../store/AppContext";
import {
  PageHeader,
  Card,
  EmptyState,
  StatCard,
  CommissionBadge,
  PayoutBadge,
  StatusBadge,
  SectionTitle,
  Select,
  Field,
  Table,
  THead,
  TBody,
  TR,
  TH,
  TD,
} from "../components/ui";
import { MoneyBarChart } from "../components/charts/Charts";
import { fullLedger, displayStatus, clientLabel } from "../lib/ledger";
import { commissionTotals, monthlySeries } from "../lib/analytics";
import { formatCurrency, formatDate } from "../lib/format";

export default function SalespersonPortal() {
  const { data } = useApp();
  const active = data.salespeople.filter((s) => s.approvalStatus !== "rejected");
  const [spId, setSpId] = useState<string>("");

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
          <Field className="w-64">
            <Select value={spId} onChange={(e) => setSpId(e.target.value)}>
              {active.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </Select>
          </Field>
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
    </div>
  );
}
