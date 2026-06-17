import { useMemo, useState } from "react";
import { useParams, Link, useNavigate } from "react-router-dom";
import { ArrowLeft, Mail, Phone, Tag } from "lucide-react";
import { useApp } from "../store/AppContext";
import {
  PageHeader,
  StatCard,
  Card,
  SectionTitle,
  Badge,
  StatusBadge,
  CommissionBadge,
  EmptyState,
  Table,
  THead,
  TBody,
  TR,
  TH,
  TD,
  Button,
} from "../components/ui";
import { DateRangeFilter, type DateRange } from "../components/DateRangeFilter";
import { MoneyBarChart } from "../components/charts/Charts";
import { fullLedger, displayStatus, clientLabel } from "../lib/ledger";
import { commissionTotals, inRange, monthlySeries } from "../lib/analytics";
import { formatCurrency, formatDate } from "../lib/format";

export default function SalespersonDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { data } = useApp();
  const [range, setRange] = useState<DateRange>({ from: null, to: null });

  const sp = data.salespeople.find((s) => s.id === id);
  const plan = data.plans.find((p) => p.id === sp?.commissionPlanId);
  const myClients = data.clients.filter((c) => c.salespersonId === id);

  const ledger = useMemo(
    () => (id ? fullLedger(data, 24).filter((e) => e.salespersonId === id) : []),
    [data, id],
  );
  const inRangeLedger = useMemo(
    () => ledger.filter((e) => inRange(e.dueDate, range.from, range.to)),
    [ledger, range],
  );
  const totals = useMemo(() => commissionTotals(inRangeLedger), [inRangeLedger]);

  const series = useMemo(() => monthlySeries(ledger, 6, 6), [ledger]);
  const seriesData = series.map((p) => ({ label: p.label, Earned: p.earned, Projected: p.projected }));

  if (!sp) {
    return (
      <EmptyState
        title="Salesperson not found"
        action={<Button onClick={() => navigate("/people")}>Back to people</Button>}
      />
    );
  }

  const recent = [...inRangeLedger].sort(
    (a, b) => new Date(b.dueDate).getTime() - new Date(a.dueDate).getTime(),
  );

  return (
    <div>
      <Link to="/people" className="mb-4 inline-flex items-center gap-1 text-sm text-slate-500 hover:text-brand-600">
        <ArrowLeft className="h-4 w-4" /> All people
      </Link>

      <PageHeader
        title={sp.name}
        subtitle={plan ? `On plan: ${plan.name}` : "No commission plan assigned"}
        actions={<DateRangeFilter value={range} onChange={setRange} />}
      />

      <div className="mb-6 flex flex-wrap items-center gap-3">
        <Badge tone="slate">{sp.role}</Badge>
        <StatusBadge status={sp.status} />
        {sp.email && (
          <span className="inline-flex items-center gap-1 text-sm text-slate-500">
            <Mail className="h-4 w-4" /> {sp.email}
          </span>
        )}
        {sp.phone && (
          <span className="inline-flex items-center gap-1 text-sm text-slate-500">
            <Phone className="h-4 w-4" /> {sp.phone}
          </span>
        )}
        {sp.referralCode && (
          <span className="inline-flex items-center gap-1 font-mono text-xs text-slate-500">
            <Tag className="h-4 w-4" /> {sp.referralCode}
          </span>
        )}
      </div>

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard label="Total earned" value={formatCurrency(totals.earned)} tone="blue" />
        <StatCard label="Paid" value={formatCurrency(totals.paid)} tone="green" />
        <StatCard label="Pending" value={formatCurrency(totals.pending)} tone="amber" />
        <StatCard label="Projected" value={formatCurrency(totals.projected)} tone="cyan" />
      </div>

      <Card className="mt-6">
        <SectionTitle right={<span className="text-xs text-slate-400">Earned vs projected</span>}>
          Monthly performance & projection
        </SectionTitle>
        <MoneyBarChart
          data={seriesData}
          xKey="label"
          stacked
          series={[
            { key: "Earned", name: "Earned", color: "#3366ff" },
            { key: "Projected", name: "Projected", color: "#06b6d4" },
          ]}
        />
      </Card>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <Card padded={false}>
          <div className="px-5 py-4"><SectionTitle>Assigned clients ({myClients.length})</SectionTitle></div>
          {myClients.length === 0 ? (
            <div className="px-5 pb-5"><EmptyState title="No clients assigned" /></div>
          ) : (
            <Table>
              <THead>
                <TR>
                  <TH>Client</TH>
                  <TH className="text-right">Monthly</TH>
                  <TH>Status</TH>
                </TR>
              </THead>
              <TBody>
                {myClients.map((c) => (
                  <TR key={c.id}>
                    <TD>
                      <Link to="/clients" className="font-medium text-slate-800 hover:text-brand-600 dark:text-slate-100">
                        {c.companyName}
                      </Link>
                    </TD>
                    <TD className="text-right tabular-nums text-slate-600 dark:text-slate-300">{formatCurrency(c.monthlySubscription)}</TD>
                    <TD><StatusBadge status={c.status} /></TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </Card>

        <Card padded={false}>
          <div className="px-5 py-4"><SectionTitle>Recent commissions</SectionTitle></div>
          {recent.length === 0 ? (
            <div className="px-5 pb-5"><EmptyState title="No commissions in range" /></div>
          ) : (
            <Table>
              <THead>
                <TR>
                  <TH>Due</TH>
                  <TH>Client</TH>
                  <TH>Rule</TH>
                  <TH className="text-right">Amount</TH>
                  <TH>Status</TH>
                </TR>
              </THead>
              <TBody>
                {recent.slice(0, 12).map((e) => (
                  <TR key={e.id}>
                    <TD className="whitespace-nowrap text-slate-500">{formatDate(e.dueDate)}</TD>
                    <TD className="text-slate-600 dark:text-slate-300">
                      {e.paymentType === "salary" ? "—" : clientLabel(data.clients.find((c) => c.id === e.clientId))}
                    </TD>
                    <TD className="text-xs text-slate-500">{e.ruleLabel}</TD>
                    <TD className="text-right font-medium tabular-nums text-slate-800 dark:text-slate-100">{formatCurrency(e.commissionAmount)}</TD>
                    <TD><CommissionBadge status={displayStatus(e)} /></TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </Card>
      </div>
    </div>
  );
}
