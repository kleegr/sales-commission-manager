// ============================================================================
// CLIENT DETAIL  (/clients/:id)
//
// A full, read-first overview of a single client: contact + assigned rep,
// lifetime revenue and the commissions it generated, every payment, the
// commission ledger lines tied to this client, the proposals & contracts
// attached to it, and a derived activity timeline. Editing the core fields is
// available inline (same CLIENT_UPDATE action the list uses) so a reviewer can
// open one client and see / change everything in one place.
//
// Documents are tenant-scoped and live behind /api/documents; in pure local
// (browser-storage) mode that call has no server, so we degrade gracefully to a
// short note instead of breaking the page.
// ============================================================================

import { useEffect, useMemo, useState } from "react";
import { useParams, Link, useNavigate } from "react-router-dom";
import {
  ArrowLeft, Mail, Phone, User2, Pencil, Receipt, BookOpenText,
  FileSignature, FileText, CalendarClock, CircleDollarSign, Activity,
} from "lucide-react";
import { useApp } from "../store/AppContext";
import type { Client, ClientStatus, ClientDocument, DocStatus } from "../types";
import {
  PageHeader, StatCard, Card, SectionTitle, Badge, StatusBadge, CommissionBadge,
  EmptyState, Button, Field, Input, Textarea, Select, NumberField,
  Table, THead, TBody, TR, TH, TD,
} from "../components/ui";
import { Modal } from "../components/ui/Modal";
import { fullLedger, displayStatus } from "../lib/ledger";
import { commissionTotals } from "../lib/analytics";
import { formatCurrency, formatDate, todayISO } from "../lib/format";
import { listDocuments } from "../lib/resource-client";

const STATUSES: ClientStatus[] = ["active", "paused", "canceled", "refunded"];
const cap = (s: string) => s[0].toUpperCase() + s.slice(1);

const DOC_TONE: Record<DocStatus, "slate" | "blue" | "violet" | "green" | "rose"> = {
  draft: "slate", sent: "blue", viewed: "violet", signed: "green", canceled: "rose",
};

const PAYMENT_LABEL: Record<string, string> = {
  setup_fee: "Setup fee",
  monthly_subscription: "Subscription",
  one_time: "One-time",
  refund: "Refund",
  adjustment: "Adjustment",
};

type Tone = "blue" | "green" | "rose" | "violet";

// Static class strings so Tailwind's JIT keeps them (dynamic `bg-${x}` is purged).
const TONE_DOT: Record<Tone, string> = {
  blue: "bg-blue-100 text-blue-600 dark:bg-blue-500/20 dark:text-blue-300",
  green: "bg-emerald-100 text-emerald-600 dark:bg-emerald-500/20 dark:text-emerald-300",
  rose: "bg-rose-100 text-rose-600 dark:bg-rose-500/20 dark:text-rose-300",
  violet: "bg-violet-100 text-violet-600 dark:bg-violet-500/20 dark:text-violet-300",
};

interface TimelineItem {
  date: string;
  icon: JSX.Element;
  title: string;
  detail?: string;
  tone: Tone;
}

export default function ClientDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { data, dispatch } = useApp();

  const client = data.clients.find((c) => c.id === id);
  const rep = data.salespeople.find((s) => s.id === client?.salespersonId) ?? null;

  const payments = useMemo(
    () => data.payments.filter((p) => p.clientId === id).sort((a, b) => b.date.localeCompare(a.date)),
    [data.payments, id],
  );

  const ledger = useMemo(
    () => (id ? fullLedger(data, 24).filter((e) => e.clientId === id) : []),
    [data, id],
  );
  const totals = useMemo(() => commissionTotals(ledger), [ledger]);

  const lifetimeRevenue = useMemo(
    () => payments.reduce((sum, p) => sum + (p.type === "refund" ? -p.amount : p.amount), 0),
    [payments],
  );

  // --- documents attached to this client (server-scoped; optional) ----------
  const [docs, setDocs] = useState<ClientDocument[]>([]);
  const [docsState, setDocsState] = useState<"loading" | "ready" | "unavailable">("loading");
  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    setDocsState("loading");
    listDocuments({ clientId: id })
      .then((res) => {
        if (cancelled) return;
        setDocs(res.documents ?? []);
        setDocsState("ready");
      })
      .catch(() => {
        if (cancelled) return;
        setDocsState("unavailable");
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  const proposals = docs.filter((d) => d.kind === "proposal");
  const contracts = docs.filter((d) => d.kind === "contract");

  // --- inline edit ----------------------------------------------------------
  const [editing, setEditing] = useState<Client | null>(null);
  function saveEdit() {
    if (!editing) return;
    dispatch({ type: "CLIENT_UPDATE", client: editing });
    setEditing(null);
  }

  // --- activity timeline (derived) ------------------------------------------
  const timeline = useMemo<TimelineItem[]>(() => {
    if (!client) return [];
    const items: TimelineItem[] = [];
    items.push({
      date: client.signupDate,
      icon: <User2 className="h-3.5 w-3.5" />,
      title: "Client signed up",
      detail: rep ? `Assigned to ${rep.name}` : "Unassigned",
      tone: "blue",
    });
    for (const p of payments) {
      items.push({
        date: p.date,
        icon: <Receipt className="h-3.5 w-3.5" />,
        title: `${PAYMENT_LABEL[p.type] ?? cap(p.type)} ${p.type === "refund" ? "issued" : "received"}`,
        detail: formatCurrency(p.amount) + (p.notes ? ` · ${p.notes}` : ""),
        tone: p.type === "refund" ? "rose" : "green",
      });
    }
    for (const d of docs) {
      const stamp = d.signedAt ?? d.sentAt ?? d.createdAt;
      items.push({
        date: stamp,
        icon: d.kind === "contract" ? <FileSignature className="h-3.5 w-3.5" /> : <FileText className="h-3.5 w-3.5" />,
        title: `${cap(d.kind)} "${d.title}" · ${cap(d.status)}`,
        detail: d.amount ? formatCurrency(d.amount) : undefined,
        tone: "violet",
      });
    }
    if ((client.status === "canceled" || client.status === "refunded") && client.canceledDate) {
      items.push({
        date: client.canceledDate,
        icon: <CalendarClock className="h-3.5 w-3.5" />,
        title: `Client ${client.status}`,
        detail: "Past commissions are retained; clawback window anchored here",
        tone: "rose",
      });
    }
    return items.sort((a, b) => b.date.localeCompare(a.date));
  }, [client, rep, payments, docs]);

  if (!client) {
    return (
      <EmptyState
        icon={<User2 className="h-6 w-6" />}
        title="Client not found"
        description="This client may have been removed."
        action={<Button onClick={() => navigate("/clients")}>Back to clients</Button>}
      />
    );
  }

  return (
    <div>
      <Link to="/clients" className="mb-4 inline-flex items-center gap-1 text-sm text-slate-500 hover:text-brand-600">
        <ArrowLeft className="h-4 w-4" /> All clients
      </Link>

      <PageHeader
        title={client.companyName}
        subtitle={rep ? `Assigned rep: ${rep.name}` : "No rep assigned"}
        actions={
          <Button variant="secondary" onClick={() => setEditing({ ...client })}>
            <Pencil className="h-4 w-4" /> Edit client
          </Button>
        }
      />

      <div className="mb-6 flex flex-wrap items-center gap-3">
        <StatusBadge status={client.status} />
        {client.contactName && (
          <span className="inline-flex items-center gap-1 text-sm text-slate-500">
            <User2 className="h-4 w-4" /> {client.contactName}
          </span>
        )}
        {client.email && (
          <span className="inline-flex items-center gap-1 text-sm text-slate-500">
            <Mail className="h-4 w-4" /> {client.email}
          </span>
        )}
        {client.phone && (
          <span className="inline-flex items-center gap-1 text-sm text-slate-500">
            <Phone className="h-4 w-4" /> {client.phone}
          </span>
        )}
        <span className="inline-flex items-center gap-1 text-sm text-slate-500">
          <CalendarClock className="h-4 w-4" /> Signed {formatDate(client.signupDate)}
        </span>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard label="Lifetime revenue" value={formatCurrency(lifetimeRevenue)} tone="blue" />
        <StatCard label="Commissions paid" value={formatCurrency(totals.paid)} tone="green" />
        <StatCard label="Commissions pending" value={formatCurrency(totals.pending)} tone="amber" />
        <StatCard label="Projected" value={formatCurrency(totals.projected)} tone="cyan" />
      </div>

      {/* Account terms */}
      <Card className="mt-6">
        <SectionTitle right={<CircleDollarSign className="h-4 w-4 text-slate-400" />}>Account terms</SectionTitle>
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <Term label="Setup fee" value={formatCurrency(client.setupFee)} />
          <Term label="Monthly" value={formatCurrency(client.monthlySubscription)} />
          <Term label="Status" value={cap(client.status)} />
          <Term label="Rep" value={rep?.name ?? "Unassigned"} />
        </div>
        {client.notes && (
          <div className="mt-4 rounded-lg bg-slate-50 p-3 text-sm text-slate-600 dark:bg-slate-800/60 dark:text-slate-300">
            {client.notes}
          </div>
        )}
      </Card>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        {/* Payments */}
        <Card padded={false}>
          <div className="flex items-center justify-between px-5 py-4">
            <SectionTitle>Payments ({payments.length})</SectionTitle>
            <Link to="/payments" className="text-xs font-medium text-brand-600 hover:underline">Manage</Link>
          </div>
          {payments.length === 0 ? (
            <div className="px-5 pb-5">
              <EmptyState icon={<Receipt className="h-5 w-5" />} title="No payments yet"
                description="Record a payment to generate commissions." />
            </div>
          ) : (
            <Table>
              <THead>
                <TR><TH>Date</TH><TH>Type</TH><TH className="text-right">Amount</TH></TR>
              </THead>
              <TBody>
                {payments.slice(0, 12).map((p) => (
                  <TR key={p.id}>
                    <TD className="whitespace-nowrap text-slate-500">{formatDate(p.date)}</TD>
                    <TD className="text-slate-600 dark:text-slate-300">
                      {PAYMENT_LABEL[p.type] ?? cap(p.type)}
                      {p.paymentNumber ? <span className="text-slate-400"> · #{p.paymentNumber}</span> : null}
                    </TD>
                    <TD className={`text-right font-medium tabular-nums ${p.type === "refund" ? "text-rose-600" : "text-slate-800 dark:text-slate-100"}`}>
                      {p.type === "refund" ? "−" : ""}{formatCurrency(p.amount)}
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </Card>

        {/* Commission ledger for this client */}
        <Card padded={false}>
          <div className="flex items-center justify-between px-5 py-4">
            <SectionTitle>Commission ledger ({ledger.length})</SectionTitle>
            <Link to="/ledger" className="text-xs font-medium text-brand-600 hover:underline">Full ledger</Link>
          </div>
          {ledger.length === 0 ? (
            <div className="px-5 pb-5">
              <EmptyState icon={<BookOpenText className="h-5 w-5" />} title="No commissions yet" />
            </div>
          ) : (
            <Table>
              <THead>
                <TR><TH>Due</TH><TH>Rule</TH><TH className="text-right">Amount</TH><TH>Status</TH></TR>
              </THead>
              <TBody>
                {[...ledger]
                  .sort((a, b) => b.dueDate.localeCompare(a.dueDate))
                  .slice(0, 12)
                  .map((e) => (
                    <TR key={e.id}>
                      <TD className="whitespace-nowrap text-slate-500">{formatDate(e.dueDate)}</TD>
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

      {/* Documents */}
      <Card className="mt-6" padded={false}>
        <div className="flex items-center justify-between px-5 py-4">
          <SectionTitle>Proposals &amp; contracts</SectionTitle>
          <Link to="/documents" className="text-xs font-medium text-brand-600 hover:underline">Documents hub</Link>
        </div>
        <div className="px-5 pb-5">
          {docsState === "loading" ? (
            <p className="text-sm text-slate-400">Loading documents…</p>
          ) : docsState === "unavailable" ? (
            <p className="text-sm text-slate-400">
              Documents are managed on the server and aren't available in local-storage mode.
            </p>
          ) : docs.length === 0 ? (
            <EmptyState
              icon={<FileSignature className="h-5 w-5" />}
              title="No documents for this client"
              description="Create a proposal or contract from the Documents hub and attach it to this client."
              action={<Button variant="secondary" onClick={() => navigate("/documents")}>Open documents</Button>}
            />
          ) : (
            <div className="grid gap-3 sm:grid-cols-2">
              <DocColumn title="Proposals" icon={<FileText className="h-4 w-4" />} items={proposals} />
              <DocColumn title="Contracts" icon={<FileSignature className="h-4 w-4" />} items={contracts} />
            </div>
          )}
        </div>
      </Card>

      {/* Activity timeline */}
      <Card className="mt-6">
        <SectionTitle right={<Activity className="h-4 w-4 text-slate-400" />}>Activity</SectionTitle>
        {timeline.length === 0 ? (
          <EmptyState title="No activity yet" />
        ) : (
          <ol className="relative space-y-4 border-l border-slate-200 pl-5 dark:border-slate-700">
            {timeline.map((t, i) => (
              <li key={i} className="relative">
                <span className={`absolute -left-[27px] flex h-5 w-5 items-center justify-center rounded-full ring-4 ring-white dark:ring-slate-900 ${TONE_DOT[t.tone]}`}>
                  {t.icon}
                </span>
                <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                  <p className="text-sm font-medium text-slate-700 dark:text-slate-200">{t.title}</p>
                  <span className="text-xs text-slate-400">{formatDate(t.date)}</span>
                </div>
                {t.detail && <p className="text-xs text-slate-500">{t.detail}</p>}
              </li>
            ))}
          </ol>
        )}
      </Card>

      {/* Edit modal */}
      <Modal
        open={!!editing}
        onClose={() => setEditing(null)}
        title="Edit client"
        size="lg"
        footer={
          <>
            <Button variant="secondary" onClick={() => setEditing(null)}>Cancel</Button>
            <Button onClick={saveEdit}>Save changes</Button>
          </>
        }
      >
        {editing && (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Company name" required>
              <Input value={editing.companyName} onChange={(e) => setEditing({ ...editing, companyName: e.target.value })} />
            </Field>
            <Field label="Contact name">
              <Input value={editing.contactName} onChange={(e) => setEditing({ ...editing, contactName: e.target.value })} />
            </Field>
            <Field label="Email">
              <Input type="email" value={editing.email} onChange={(e) => setEditing({ ...editing, email: e.target.value })} />
            </Field>
            <Field label="Phone">
              <Input value={editing.phone} onChange={(e) => setEditing({ ...editing, phone: e.target.value })} />
            </Field>
            <Field label="Assigned rep">
              <Select value={editing.salespersonId ?? ""} onChange={(e) => setEditing({ ...editing, salespersonId: e.target.value || null })}>
                <option value="">Unassigned</option>
                {data.salespeople.map((s) => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </Select>
            </Field>
            <Field label="Signup date">
              <Input type="date" value={editing.signupDate} onChange={(e) => setEditing({ ...editing, signupDate: e.target.value })} />
            </Field>
            <Field label="Setup fee">
              <NumberField value={editing.setupFee} onChange={(v) => setEditing({ ...editing, setupFee: v })} prefix="$" min={0} />
            </Field>
            <Field label="Monthly subscription">
              <NumberField value={editing.monthlySubscription} onChange={(v) => setEditing({ ...editing, monthlySubscription: v })} prefix="$" min={0} />
            </Field>
            <Field label="Status">
              <Select value={editing.status} onChange={(e) => {
                const status = e.target.value as ClientStatus;
                const needsDate = status === "canceled" || status === "refunded";
                setEditing({
                  ...editing,
                  status,
                  canceledDate: needsDate ? (editing.canceledDate ?? todayISO()) : null,
                });
              }}>
                {STATUSES.map((s) => <option key={s} value={s}>{cap(s)}</option>)}
              </Select>
            </Field>
            {(editing.status === "canceled" || editing.status === "refunded") && (
              <Field label="Canceled / refunded date" hint="Anchors the clawback window.">
                <Input type="date" value={editing.canceledDate ?? ""} onChange={(e) => setEditing({ ...editing, canceledDate: e.target.value || null })} />
              </Field>
            )}
            <Field label="Notes" className="sm:col-span-2">
              <Textarea value={editing.notes} onChange={(e) => setEditing({ ...editing, notes: e.target.value })} />
            </Field>
          </div>
        )}
      </Modal>
    </div>
  );
}

function Term({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-[11px] font-medium uppercase tracking-wide text-slate-400">{label}</p>
      <p className="mt-0.5 text-sm font-semibold text-slate-800 dark:text-slate-100">{value}</p>
    </div>
  );
}

function DocColumn({ title, icon, items }: { title: string; icon: JSX.Element; items: ClientDocument[] }) {
  return (
    <div className="rounded-lg border border-slate-200 p-3 dark:border-slate-700">
      <p className="mb-2 inline-flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-slate-400">
        {icon} {title} ({items.length})
      </p>
      {items.length === 0 ? (
        <p className="text-xs text-slate-400">None yet</p>
      ) : (
        <ul className="space-y-1.5">
          {items.map((d) => (
            <li key={d.id} className="flex items-center justify-between gap-2">
              <span className="truncate text-sm text-slate-700 dark:text-slate-200">{d.title}</span>
              <Badge tone={DOC_TONE[d.status]}>{cap(d.status)}</Badge>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
