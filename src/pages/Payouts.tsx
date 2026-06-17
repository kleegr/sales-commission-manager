import { useMemo, useState } from "react";
import { Banknote, Check, X, Send, Clock } from "lucide-react";
import { useApp } from "../store/AppContext";
import {
  PageHeader,
  Button,
  Card,
  EmptyState,
  PayoutBadge,
  StatCard,
  SectionTitle,
  Select,
  Textarea,
  Table,
  THead,
  TBody,
  TR,
  TH,
  TD,
} from "../components/ui";
import { DateRangeFilter, type DateRange } from "../components/DateRangeFilter";
import { displayStatus, clientLabel } from "../lib/ledger";
import { inRange } from "../lib/analytics";
import { formatCurrency, formatDate } from "../lib/format";

export default function Payouts() {
  const { data, dispatch } = useApp();
  const [spFilter, setSpFilter] = useState("all");
  const [range, setRange] = useState<DateRange>({ from: null, to: null });
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [notes, setNotes] = useState("");

  const spName = (id: string) => data.salespeople.find((s) => s.id === id)?.name ?? "—";
  const clientName = (id: string | null) =>
    clientLabel(data.clients.find((c) => c.id === id));

  // Eligible = real, earned commissions that are pending (not yet in a payout).
  const eligible = useMemo(
    () =>
      data.commissions
        .filter((e) => displayStatus(e) === "pending")
        .filter((e) => (spFilter === "all" ? true : e.salespersonId === spFilter))
        .filter((e) => inRange(e.paymentDate, range.from, range.to))
        .sort((a, b) => (a.dueDate < b.dueDate ? 1 : -1)),
    [data.commissions, spFilter, range],
  );

  const selectedIds = useMemo(
    () => eligible.filter((e) => selected[e.id]).map((e) => e.id),
    [eligible, selected],
  );
  const selectedTotal = useMemo(
    () =>
      eligible
        .filter((e) => selected[e.id])
        .reduce((s, e) => s + e.commissionAmount, 0),
    [eligible, selected],
  );

  const summary = useMemo(() => {
    let submitted = 0;
    let approved = 0;
    let paid = 0;
    for (const p of data.payouts) {
      if (p.status === "submitted") submitted += p.totalAmount;
      else if (p.status === "approved") approved += p.totalAmount;
      else if (p.status === "paid") paid += p.totalAmount;
    }
    const eligibleTotal = eligible.reduce((s, e) => s + e.commissionAmount, 0);
    return { submitted, approved, paid, eligibleTotal };
  }, [data.payouts, eligible]);

  const allChecked = eligible.length > 0 && eligible.every((e) => selected[e.id]);

  function toggleAll() {
    if (allChecked) {
      setSelected({});
    } else {
      const next: Record<string, boolean> = {};
      eligible.forEach((e) => (next[e.id] = true));
      setSelected(next);
    }
  }

  function submitSelected() {
    if (selectedIds.length === 0) return;
    // Group by salesperson — one payout per person.
    const byPerson = new Map<string, string[]>();
    for (const e of eligible) {
      if (!selected[e.id]) continue;
      const arr = byPerson.get(e.salespersonId) ?? [];
      arr.push(e.id);
      byPerson.set(e.salespersonId, arr);
    }
    byPerson.forEach((ids, salespersonId) =>
      dispatch({ type: "PAYOUT_SUBMIT", salespersonId, commissionEntryIds: ids, notes }),
    );
    setSelected({});
    setNotes("");
  }

  const history = useMemo(
    () => [...data.payouts].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)),
    [data.payouts],
  );

  return (
    <div>
      <PageHeader
        title="Payouts"
        subtitle="Bundle earned commissions, then submit → approve → mark paid"
      />

      <div className="mb-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Eligible to pay"
          value={formatCurrency(summary.eligibleTotal)}
          icon={<Clock className="h-5 w-5" />}
          tone="amber"
        />
        <StatCard label="Awaiting approval" value={formatCurrency(summary.submitted)} tone="violet" />
        <StatCard label="Approved" value={formatCurrency(summary.approved)} tone="indigo" />
        <StatCard label="Paid out" value={formatCurrency(summary.paid)} tone="green" />
      </div>

      {/* ---- Build a payout ---- */}
      <Card padded={false} className="mb-6 overflow-hidden">
        <div className="flex flex-wrap items-center gap-2 border-b border-slate-100 p-3 dark:border-slate-800">
          <SectionTitle>Eligible commissions</SectionTitle>
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <Select value={spFilter} onChange={(e) => setSpFilter(e.target.value)} className="w-auto">
              <option value="all">All people</option>
              {data.salespeople.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </Select>
            <DateRangeFilter value={range} onChange={setRange} />
          </div>
        </div>

        {eligible.length === 0 ? (
          <div className="p-6">
            <EmptyState
              icon={<Banknote className="h-6 w-6" />}
              title="Nothing eligible right now"
              description="Commissions appear here once their due date passes and they're pending. Projected future lines aren't payable yet."
            />
          </div>
        ) : (
          <>
            <Table>
              <THead>
                <TR>
                  <TH className="w-10">
                    <input
                      type="checkbox"
                      checked={allChecked}
                      onChange={toggleAll}
                      className="h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-500 dark:border-slate-600 dark:bg-slate-800"
                      aria-label="Select all"
                    />
                  </TH>
                  <TH>Person</TH>
                  <TH>Client</TH>
                  <TH>Rule</TH>
                  <TH>Due</TH>
                  <TH className="text-right">Commission</TH>
                </TR>
              </THead>
              <TBody>
                {eligible.map((e) => (
                  <TR key={e.id}>
                    <TD>
                      <input
                        type="checkbox"
                        checked={!!selected[e.id]}
                        onChange={(ev) =>
                          setSelected((s) => ({ ...s, [e.id]: ev.target.checked }))
                        }
                        className="h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-500 dark:border-slate-600 dark:bg-slate-800"
                        aria-label="Select line"
                      />
                    </TD>
                    <TD className="font-medium text-slate-900 dark:text-white">
                      {spName(e.salespersonId)}
                    </TD>
                    <TD className="text-slate-600 dark:text-slate-300">{clientName(e.clientId)}</TD>
                    <TD className="max-w-[220px] text-slate-600 dark:text-slate-300">{e.ruleLabel}</TD>
                    <TD className="whitespace-nowrap text-slate-500">{formatDate(e.dueDate)}</TD>
                    <TD className="text-right font-semibold tabular-nums text-slate-900 dark:text-white">
                      {formatCurrency(e.commissionAmount)}
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>

            <div className="flex flex-col gap-3 border-t border-slate-100 p-3 dark:border-slate-800 sm:flex-row sm:items-end">
              <div className="flex-1">
                <Textarea
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  rows={2}
                  placeholder="Payout note (optional)…"
                />
              </div>
              <div className="flex items-center justify-between gap-3 sm:flex-col sm:items-end">
                <div className="text-sm text-slate-500">
                  {selectedIds.length} selected ·{" "}
                  <span className="font-semibold text-slate-900 dark:text-white">
                    {formatCurrency(selectedTotal)}
                  </span>
                </div>
                <Button onClick={submitSelected} disabled={selectedIds.length === 0}>
                  <Send className="h-4 w-4" /> Submit for approval
                </Button>
              </div>
            </div>
          </>
        )}
      </Card>

      {/* ---- History ---- */}
      <SectionTitle>Payout history</SectionTitle>
      <Card padded={false} className="mt-3 overflow-hidden">
        {history.length === 0 ? (
          <div className="p-6">
            <EmptyState
              icon={<Banknote className="h-6 w-6" />}
              title="No payouts yet"
              description="Submitted payouts and their approval trail show up here."
            />
          </div>
        ) : (
          <Table>
            <THead>
              <TR>
                <TH>Person</TH>
                <TH>Lines</TH>
                <TH className="text-right">Amount</TH>
                <TH>Status</TH>
                <TH>Submitted</TH>
                <TH>Paid</TH>
                <TH className="text-right">Actions</TH>
              </TR>
            </THead>
            <TBody>
              {history.map((p) => (
                <TR key={p.id}>
                  <TD className="font-medium text-slate-900 dark:text-white">
                    {spName(p.salespersonId)}
                  </TD>
                  <TD className="text-slate-500">{p.commissionEntryIds.length}</TD>
                  <TD className="text-right font-semibold tabular-nums text-slate-900 dark:text-white">
                    {formatCurrency(p.totalAmount)}
                  </TD>
                  <TD>
                    <PayoutBadge status={p.status} />
                  </TD>
                  <TD className="whitespace-nowrap text-slate-500">
                    {p.submittedAt ? formatDate(p.submittedAt.slice(0, 10)) : "—"}
                  </TD>
                  <TD className="whitespace-nowrap text-slate-500">
                    {p.paidAt ? formatDate(p.paidAt.slice(0, 10)) : "—"}
                  </TD>
                  <TD className="text-right">
                    <div className="flex justify-end gap-1.5">
                      {p.status === "submitted" && (
                        <>
                          <Button
                            variant="secondary"
                            size="sm"
                            onClick={() => dispatch({ type: "PAYOUT_APPROVE", id: p.id })}
                          >
                            <Check className="h-3.5 w-3.5" /> Approve
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="text-rose-500"
                            onClick={() => dispatch({ type: "PAYOUT_REJECT", id: p.id })}
                          >
                            <X className="h-3.5 w-3.5" /> Reject
                          </Button>
                        </>
                      )}
                      {p.status === "approved" && (
                        <>
                          <Button
                            size="sm"
                            onClick={() => dispatch({ type: "PAYOUT_MARK_PAID", id: p.id })}
                          >
                            <Banknote className="h-3.5 w-3.5" /> Mark paid
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="text-rose-500"
                            onClick={() => dispatch({ type: "PAYOUT_REJECT", id: p.id })}
                          >
                            <X className="h-3.5 w-3.5" /> Reject
                          </Button>
                        </>
                      )}
                      {(p.status === "paid" || p.status === "rejected") && (
                        <span className="text-xs text-slate-400">—</span>
                      )}
                    </div>
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </Card>

      <p className="mt-3 text-xs text-slate-400">
        Submitting moves lines to <span className="font-medium">Submitted</span>, approving to{" "}
        <span className="font-medium">Approved</span>, and marking paid stamps the paid date.
        Rejecting a payout marks its lines rejected.
      </p>
    </div>
  );
}
