import { useMemo, useState } from "react";
import { Download, BookOpen, RefreshCw } from "lucide-react";
import { useApp } from "../store/AppContext";
import { useAuth } from "../store/AuthContext";
import { ADMIN_ROLES } from "../lib/roles";
import type { CommissionStatus } from "../types";
import {
  PageHeader,
  Button,
  Card,
  EmptyState,
  CommissionBadge,
  StatCard,
  Select,
  Table,
  THead,
  TBody,
  TR,
  TH,
  TD,
} from "../components/ui";
import { DateRangeFilter, type DateRange } from "../components/DateRangeFilter";
import { fullLedger, displayStatus, clientLabel } from "../lib/ledger";
import { commissionTotals, inRange } from "../lib/analytics";
import { formatCurrency, formatDate, formatPercent } from "../lib/format";
import { downloadCSV } from "../lib/export";

const PAYMENT_TYPE_LABEL: Record<string, string> = {
  setup_fee: "Setup fee",
  monthly_subscription: "Monthly",
  refund: "Refund",
  adjustment: "Adjustment",
  salary: "Salary",
};

const STATUS_OPTIONS: (CommissionStatus | "all" | "real")[] = [
  "all",
  "real",
  "projected",
  "held",
  "pending",
  "submitted",
  "approved",
  "paid",
  "rejected",
  "clawed_back",
];

export default function Ledger() {
  const { data, dispatch } = useApp();
  const { user } = useAuth();
  const canRelease = !!user && ADMIN_ROLES.includes(user.role);
  const [spFilter, setSpFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState<CommissionStatus | "all" | "real">("all");
  const [range, setRange] = useState<DateRange>({ from: null, to: null });

  const ledger = useMemo(() => fullLedger(data, 24), [data]);
  const spName = (id: string) => data.salespeople.find((s) => s.id === id)?.name ?? "—";
  const clientName = (id: string | null) =>
    clientLabel(data.clients.find((c) => c.id === id));

  const rows = useMemo(() => {
    return ledger
      .filter((e) => {
        if (spFilter !== "all" && e.salespersonId !== spFilter) return false;
        if (!inRange(e.paymentDate, range.from, range.to)) return false;
        const st = displayStatus(e);
        if (statusFilter === "real") return st !== "projected";
        if (statusFilter !== "all" && st !== statusFilter) return false;
        return true;
      })
      .sort((a, b) => (a.dueDate < b.dueDate ? 1 : -1));
  }, [ledger, spFilter, statusFilter, range]);

  const totals = useMemo(() => commissionTotals(rows), [rows]);
  const heldTotal = useMemo(
    () =>
      rows
        .filter((e) => displayStatus(e) === "held")
        .reduce((s, e) => s + e.commissionAmount, 0),
    [rows],
  );

  function releaseOne(id: string) {
    dispatch({ type: "RELEASE_COMMISSION", ids: [id] });
  }

  function exportCSV() {
    const header = [
      "Salesperson",
      "Client",
      "Payment date",
      "Payment type",
      "Base amount",
      "Rule",
      "Rate",
      "Commission",
      "Status",
      "Due date",
      "Release date",
      "Paid date",
      "Hold / clawback reason",
    ];
    const body = rows.map((e) => [
      spName(e.salespersonId),
      clientName(e.clientId),
      e.paymentDate,
      PAYMENT_TYPE_LABEL[e.paymentType] ?? e.paymentType,
      e.paymentAmount,
      e.ruleLabel,
      e.commissionValueType === "percentage"
        ? `${e.commissionValue}%`
        : formatCurrency(e.commissionValue),
      e.commissionAmount,
      displayStatus(e),
      e.dueDate,
      e.releaseDate ?? "",
      e.paidDate ?? "",
      e.clawbackReason || e.holdReason || "",
    ]);
    downloadCSV("commission-ledger.csv", [header, ...body]);
  }

  return (
    <div>
      <PageHeader
        title="Commission Ledger"
        subtitle="Every commission line — which rule fired, what it pays, and where it stands"
        actions={
          <Button variant="secondary" onClick={exportCSV} disabled={rows.length === 0}>
            <Download className="h-4 w-4" /> Export CSV
          </Button>
        }
      />

      <div className="mb-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
        <StatCard label="Earned (real)" value={formatCurrency(totals.earned)} tone="green" />
        <StatCard label="Paid" value={formatCurrency(totals.paid)} tone="blue" />
        <StatCard label="Pending / owed" value={formatCurrency(totals.pending)} tone="amber" />
        <StatCard label="Held" value={formatCurrency(heldTotal)} tone="violet" />
        <StatCard label="Projected (future)" value={formatCurrency(totals.projected)} tone="cyan" />
      </div>

      <Card padded={false} className="overflow-hidden">
        <div className="flex flex-wrap items-center gap-2 border-b border-slate-100 p-3 dark:border-slate-800">
          <Select
            value={spFilter}
            onChange={(e) => setSpFilter(e.target.value)}
            className="w-auto"
          >
            <option value="all">All people</option>
            {data.salespeople.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </Select>
          <Select
            value={statusFilter}
            onChange={(e) =>
              setStatusFilter(e.target.value as CommissionStatus | "all" | "real")
            }
            className="w-auto"
          >
            {STATUS_OPTIONS.map((s) => (
              <option key={s} value={s}>
                {s === "all"
                  ? "All statuses"
                  : s === "real"
                    ? "Real only"
                    : s[0].toUpperCase() + s.slice(1).replace("_", " ")}
              </option>
            ))}
          </Select>
          <DateRangeFilter value={range} onChange={setRange} className="ml-auto" />
        </div>

        {rows.length === 0 ? (
          <div className="p-6">
            <EmptyState
              icon={<BookOpen className="h-6 w-6" />}
              title="No commission lines"
              description="Adjust the filters, or add payments and active clients to populate the ledger."
            />
          </div>
        ) : (
          <Table>
            <THead>
              <TR>
                <TH>Person</TH>
                <TH>Client</TH>
                <TH>Payment</TH>
                <TH className="text-right">Base</TH>
                <TH>Rule</TH>
                <TH className="text-right">Rate</TH>
                <TH className="text-right">Commission</TH>
                <TH>Status</TH>
                <TH>Release</TH>
                <TH>Due</TH>
              </TR>
            </THead>
            <TBody>
              {rows.map((e) => (
                <TR key={e.id}>
                  <TD className="font-medium text-slate-900 dark:text-white">
                    {spName(e.salespersonId)}
                  </TD>
                  <TD className="text-slate-600 dark:text-slate-300">{clientName(e.clientId)}</TD>
                  <TD>
                    <div className="text-slate-700 dark:text-slate-200">
                      {PAYMENT_TYPE_LABEL[e.paymentType] ?? e.paymentType}
                    </div>
                    <div className="text-xs text-slate-400">{formatDate(e.paymentDate)}</div>
                  </TD>
                  <TD className="text-right tabular-nums text-slate-500">
                    {formatCurrency(e.paymentAmount)}
                  </TD>
                  <TD className="max-w-[220px]">
                    <span className="text-slate-600 dark:text-slate-300">{e.ruleLabel}</span>
                  </TD>
                  <TD className="text-right tabular-nums text-slate-500">
                    {e.commissionValueType === "percentage"
                      ? formatPercent(e.commissionValue)
                      : formatCurrency(e.commissionValue)}
                  </TD>
                  <TD className="text-right font-semibold tabular-nums text-slate-900 dark:text-white">
                    {formatCurrency(e.commissionAmount)}
                  </TD>
                  <TD>
                    <div className="flex flex-col items-start gap-1">
                      <CommissionBadge status={displayStatus(e)} />
                      {(e.clawbackReason || e.holdReason) && (
                        <span className="max-w-[220px] text-xs leading-snug text-slate-400">
                          {e.clawbackReason || e.holdReason}
                        </span>
                      )}
                      {canRelease && displayStatus(e) === "held" && (
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() => releaseOne(e.id)}
                          title="Release this commission for payout now"
                        >
                          <RefreshCw className="h-3 w-3" /> Release now
                        </Button>
                      )}
                    </div>
                  </TD>
                  <TD className="whitespace-nowrap text-slate-500">
                    {e.releaseDate ? formatDate(e.releaseDate) : "—"}
                  </TD>
                  <TD className="whitespace-nowrap text-slate-500">{formatDate(e.dueDate)}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </Card>

      <p className="mt-3 text-xs text-slate-400">
        Lines due in the future show as <span className="font-medium">Projected</span> until their
        due date passes. A plan's timing rule can <span className="font-medium">Hold</span> a
        commission (until a refund window or wait period passes, enough client payments arrive, the
        client is active, or an admin approves it); it then becomes <span className="font-medium">Pending</span>
        and ready to pay out. Commissions for clients who cancel inside the clawback window are
        <span className="font-medium"> Clawed back</span>. Submitting, approving, paying, or clawing
        back a line locks its status.
      </p>
    </div>
  );
}
