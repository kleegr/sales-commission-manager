import { useMemo, useState } from "react";
import { Plus, Pencil, Trash2, Building2, Search } from "lucide-react";
import { useApp } from "../store/AppContext";
import type { Client, ClientStatus } from "../types";
import {
  PageHeader,
  Button,
  Card,
  EmptyState,
  StatusBadge,
  Field,
  Input,
  Textarea,
  Select,
  NumberField,
  Table,
  THead,
  TBody,
  TR,
  TH,
  TD,
} from "../components/ui";
import { Modal, ConfirmModal } from "../components/ui/Modal";
import { uid, todayISO, formatCurrency, formatDate } from "../lib/format";

const STATUSES: ClientStatus[] = ["active", "paused", "canceled", "refunded"];

function emptyClient(): Client {
  return {
    id: uid("cl"),
    companyName: "",
    contactName: "",
    email: "",
    phone: "",
    salespersonId: null,
    signupDate: todayISO(),
    setupFee: 2500,
    monthlySubscription: 250,
    status: "active",
    notes: "",
    createdAt: todayISO(),
  };
}

export default function Clients() {
  const { data, dispatch } = useApp();
  const [editing, setEditing] = useState<Client | null>(null);
  const [isNew, setIsNew] = useState(false);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | ClientStatus>("all");

  const spName = (spId: string | null) =>
    data.salespeople.find((s) => s.id === spId)?.name ?? "Unassigned";

  const rows = useMemo(() => {
    const q = search.toLowerCase();
    return data.clients.filter((c) => {
      if (statusFilter !== "all" && c.status !== statusFilter) return false;
      if (!q) return true;
      return `${c.companyName} ${c.contactName} ${c.email}`.toLowerCase().includes(q);
    });
  }, [data.clients, search, statusFilter]);

  function openNew() {
    setEditing(emptyClient());
    setIsNew(true);
  }
  function openEdit(c: Client) {
    setEditing({ ...c });
    setIsNew(false);
  }
  function save() {
    if (!editing) return;
    dispatch({ type: isNew ? "CLIENT_ADD" : "CLIENT_UPDATE", client: editing });
    setEditing(null);
  }

  return (
    <div>
      <PageHeader
        title="Clients"
        subtitle="Accounts, their assigned rep, and the revenue that drives commissions"
        actions={
          <Button onClick={openNew}>
            <Plus className="h-4 w-4" /> Add client
          </Button>
        }
      />

      <Card padded={false} className="overflow-hidden">
        <div className="flex flex-wrap items-center gap-2 border-b border-slate-100 p-3 dark:border-slate-800">
          <div className="relative flex-1 min-w-[180px]">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search clients…"
              className="pl-9"
            />
          </div>
          <Select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as "all" | ClientStatus)}
            className="w-auto"
          >
            <option value="all">All statuses</option>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {s[0].toUpperCase() + s.slice(1)}
              </option>
            ))}
          </Select>
        </div>

        {rows.length === 0 ? (
          <div className="p-6">
            <EmptyState
              icon={<Building2 className="h-6 w-6" />}
              title={data.clients.length === 0 ? "No clients yet" : "No clients match"}
              description={
                data.clients.length === 0
                  ? "Add your first client to start generating payments and commissions."
                  : "Try a different search or status filter."
              }
              action={
                data.clients.length === 0 ? (
                  <Button onClick={openNew}>
                    <Plus className="h-4 w-4" /> Add client
                  </Button>
                ) : undefined
              }
            />
          </div>
        ) : (
          <Table>
            <THead>
              <TR>
                <TH>Company</TH>
                <TH>Contact</TH>
                <TH>Rep</TH>
                <TH>Signed</TH>
                <TH className="text-right">Setup</TH>
                <TH className="text-right">Monthly</TH>
                <TH>Status</TH>
                <TH className="text-right">Actions</TH>
              </TR>
            </THead>
            <TBody>
              {rows.map((c) => (
                <TR key={c.id}>
                  <TD className="font-medium text-slate-900 dark:text-white">
                    {c.companyName}
                  </TD>
                  <TD>
                    <div className="text-slate-700 dark:text-slate-200">{c.contactName || "—"}</div>
                    <div className="text-xs text-slate-400">{c.email}</div>
                  </TD>
                  <TD className="text-slate-600 dark:text-slate-300">{spName(c.salespersonId)}</TD>
                  <TD className="text-slate-500">{formatDate(c.signupDate)}</TD>
                  <TD className="text-right tabular-nums">{formatCurrency(c.setupFee)}</TD>
                  <TD className="text-right tabular-nums">{formatCurrency(c.monthlySubscription)}</TD>
                  <TD>
                    <StatusBadge status={c.status} />
                  </TD>
                  <TD className="text-right">
                    <div className="flex justify-end gap-1">
                      <Button variant="ghost" size="sm" onClick={() => openEdit(c)} aria-label="Edit">
                        <Pencil className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setDeleteId(c.id)}
                        aria-label="Delete"
                        className="text-rose-500"
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </Card>

      <Modal
        open={!!editing}
        onClose={() => setEditing(null)}
        title={isNew ? "Add client" : "Edit client"}
        size="lg"
        footer={
          <>
            <Button variant="secondary" onClick={() => setEditing(null)}>
              Cancel
            </Button>
            <Button onClick={save}>{isNew ? "Add client" : "Save changes"}</Button>
          </>
        }
      >
        {editing && (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Company name" required>
              <Input
                value={editing.companyName}
                onChange={(e) => setEditing({ ...editing, companyName: e.target.value })}
              />
            </Field>
            <Field label="Contact name">
              <Input
                value={editing.contactName}
                onChange={(e) => setEditing({ ...editing, contactName: e.target.value })}
              />
            </Field>
            <Field label="Email">
              <Input
                type="email"
                value={editing.email}
                onChange={(e) => setEditing({ ...editing, email: e.target.value })}
              />
            </Field>
            <Field label="Phone">
              <Input
                value={editing.phone}
                onChange={(e) => setEditing({ ...editing, phone: e.target.value })}
              />
            </Field>
            <Field label="Assigned rep">
              <Select
                value={editing.salespersonId ?? ""}
                onChange={(e) =>
                  setEditing({ ...editing, salespersonId: e.target.value || null })
                }
              >
                <option value="">Unassigned</option>
                {data.salespeople.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Signup date">
              <Input
                type="date"
                value={editing.signupDate}
                onChange={(e) => setEditing({ ...editing, signupDate: e.target.value })}
              />
            </Field>
            <Field label="Setup fee">
              <NumberField
                value={editing.setupFee}
                onChange={(v) => setEditing({ ...editing, setupFee: v })}
                prefix="$"
                min={0}
              />
            </Field>
            <Field label="Monthly subscription">
              <NumberField
                value={editing.monthlySubscription}
                onChange={(v) => setEditing({ ...editing, monthlySubscription: v })}
                prefix="$"
                min={0}
              />
            </Field>
            <Field label="Status">
              <Select
                value={editing.status}
                onChange={(e) =>
                  setEditing({ ...editing, status: e.target.value as ClientStatus })
                }
              >
                {STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {s[0].toUpperCase() + s.slice(1)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Notes" className="sm:col-span-2">
              <Textarea
                value={editing.notes}
                onChange={(e) => setEditing({ ...editing, notes: e.target.value })}
              />
            </Field>
            <p className="text-xs text-slate-400 sm:col-span-2">
              Only <span className="font-medium">active</span> clients generate forward-looking
              projected commissions. Canceled or refunded clients keep their past ledger entries.
            </p>
          </div>
        )}
      </Modal>

      <ConfirmModal
        open={!!deleteId}
        onClose={() => setDeleteId(null)}
        onConfirm={() => deleteId && dispatch({ type: "CLIENT_DELETE", id: deleteId })}
        title="Delete client?"
        message="This removes the client and its payments, and recalculates affected commissions. This cannot be undone."
      />
    </div>
  );
}
