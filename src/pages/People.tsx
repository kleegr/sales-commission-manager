import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Plus, Pencil, Trash2, Users, Check, X, Search } from "lucide-react";
import { useApp } from "../store/AppContext";
import type { Role, Salesperson } from "../types";
import {
  PageHeader,
  Button,
  Card,
  Table,
  THead,
  TBody,
  TR,
  TH,
  TD,
  Badge,
  StatusBadge,
  EmptyState,
  Modal,
  Field,
  Input,
  Select,
  NumberField,
  Textarea,
} from "../components/ui";
import { ConfirmModal } from "../components/ui/Modal";
import { uid, todayISO, formatCurrency } from "../lib/format";
import {
  createSalesperson,
  updateSalesperson,
  deactivateSalesperson,
  setSalespersonApproval,
  type SalespersonInput,
} from "../lib/resource-client";

const ROLE_LABEL: Record<Role, string> = {
  salesperson: "Salesperson",
  affiliate: "Affiliate",
  partner: "Partner",
};

function emptySalesperson(): Salesperson {
  return {
    id: uid("sp"),
    name: "",
    email: "",
    phone: "",
    role: "salesperson",
    referralCode: "",
    status: "active",
    commissionPlanId: null,
    weeklySalary: null,
    salaryStartDate: null,
    salaryEndDate: null,
    notes: "",
    source: "admin",
    approvalStatus: "approved",
    createdAt: todayISO(),
  };
}

export default function People() {
  const { data, dispatch, reload } = useApp();
  const [editing, setEditing] = useState<Salesperson | null>(null);
  const [isNew, setIsNew] = useState(false);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [roleFilter, setRoleFilter] = useState<"all" | Role>("all");
  const [search, setSearch] = useState("");
  const [busy, setBusy] = useState(false);

  // Map the edited record to the fields the per-resource API accepts.
  function toInput(sp: Salesperson): SalespersonInput {
    return {
      name: sp.name,
      email: sp.email,
      phone: sp.phone,
      role: sp.role,
      referralCode: sp.referralCode,
      status: sp.status,
      commissionPlanId: sp.commissionPlanId,
      weeklySalary: sp.weeklySalary,
      salaryStartDate: sp.salaryStartDate,
      salaryEndDate: sp.salaryEndDate,
      notes: sp.notes,
    };
  }

  const pending = data.salespeople.filter(
    (s) => s.source === "affiliate_portal" && s.approvalStatus === "pending",
  );

  const list = useMemo(() => {
    return data.salespeople
      .filter((s) => !(s.source === "affiliate_portal" && s.approvalStatus === "pending"))
      .filter((s) => roleFilter === "all" || s.role === roleFilter)
      .filter((s) =>
        search.trim() === ""
          ? true
          : `${s.name} ${s.email} ${s.referralCode}`.toLowerCase().includes(search.toLowerCase()),
      );
  }, [data.salespeople, roleFilter, search]);

  const planName = (id: string | null) =>
    data.plans.find((p) => p.id === id)?.name ?? "—";

  function openNew() {
    setEditing(emptySalesperson());
    setIsNew(true);
  }
  function openEdit(sp: Salesperson) {
    setEditing({ ...sp });
    setIsNew(false);
  }
  async function save() {
    if (!editing || busy) return;
    setBusy(true);
    try {
      if (isNew) await createSalesperson(toInput(editing));
      else await updateSalesperson(editing.id, toInput(editing));
      await reload();
    } catch {
      // API unreachable (local/dev) or rejected — keep working via local store.
      dispatch(isNew ? { type: "SP_ADD", sp: editing } : { type: "SP_UPDATE", sp: editing });
    } finally {
      setBusy(false);
      setEditing(null);
    }
  }

  async function deactivate(id: string) {
    try {
      await deactivateSalesperson(id);
      await reload();
    } catch {
      dispatch({ type: "SP_DELETE", id });
    } finally {
      setDeleteId(null);
    }
  }

  async function approve(id: string, approval: "approved" | "rejected") {
    try {
      await setSalespersonApproval(id, approval);
      await reload();
    } catch {
      dispatch({ type: "SP_APPROVAL", id, approval });
    }
  }

  return (
    <div>
      <PageHeader
        title="Salespeople, Affiliates & Partners"
        subtitle="Manage your team and assign commission plans"
        actions={
          <Button onClick={openNew}>
            <Plus className="h-4 w-4" /> Add person
          </Button>
        }
      />

      {/* Pending affiliate approvals */}
      {pending.length > 0 && (
        <Card className="mb-5 border-violet-200 bg-violet-50/60 dark:border-violet-500/30 dark:bg-violet-500/10">
          <h2 className="mb-3 text-sm font-semibold text-violet-800 dark:text-violet-200">
            {pending.length} affiliate {pending.length === 1 ? "application" : "applications"} awaiting approval
          </h2>
          <ul className="space-y-2">
            {pending.map((s) => (
              <li
                key={s.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-violet-200 bg-white px-3 py-2 dark:border-violet-500/20 dark:bg-slate-900"
              >
                <div>
                  <p className="text-sm font-medium text-slate-800 dark:text-slate-100">
                    {s.name} <span className="font-normal text-slate-400">· {s.email}</span>
                  </p>
                  <p className="text-xs text-slate-500">
                    {s.companyName ? `${s.companyName} · ` : ""}
                    {s.referralSource ? `via ${s.referralSource}` : "Self-registered"}
                  </p>
                </div>
                <div className="flex gap-2">
                  <Button size="sm" onClick={() => approve(s.id, "approved")}>
                    <Check className="h-4 w-4" /> Approve
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => approve(s.id, "rejected")}
                  >
                    <X className="h-4 w-4" /> Reject
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="relative flex-1 sm:max-w-xs">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <Input
            placeholder="Search by name, email, code…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9"
          />
        </div>
        <Select value={roleFilter} onChange={(e) => setRoleFilter(e.target.value as typeof roleFilter)} className="w-auto">
          <option value="all">All roles</option>
          <option value="salesperson">Salespeople</option>
          <option value="affiliate">Affiliates</option>
          <option value="partner">Partners</option>
        </Select>
      </div>

      {list.length === 0 ? (
        <EmptyState
          icon={<Users className="h-6 w-6" />}
          title="No people yet"
          description="Add your first salesperson, affiliate, or partner to get started."
          action={<Button onClick={openNew}><Plus className="h-4 w-4" /> Add person</Button>}
        />
      ) : (
        <Card padded={false}>
          <Table>
            <THead>
              <TR>
                <TH>Name</TH>
                <TH>Role</TH>
                <TH>Plan</TH>
                <TH>Referral code</TH>
                <TH>Salary</TH>
                <TH>Status</TH>
                <TH className="text-right">Actions</TH>
              </TR>
            </THead>
            <TBody>
              {list.map((s) => (
                <TR key={s.id}>
                  <TD>
                    <Link to={`/people/${s.id}`} className="font-medium text-slate-800 hover:text-brand-600 dark:text-slate-100">
                      {s.name || "Unnamed"}
                    </Link>
                    <div className="text-xs text-slate-400">{s.email}</div>
                  </TD>
                  <TD><Badge tone="slate">{ROLE_LABEL[s.role]}</Badge></TD>
                  <TD className="text-slate-600 dark:text-slate-300">{planName(s.commissionPlanId)}</TD>
                  <TD className="font-mono text-xs text-slate-500">{s.referralCode || "—"}</TD>
                  <TD className="tabular-nums text-slate-500">
                    {s.weeklySalary ? `${formatCurrency(s.weeklySalary)}/wk` : "—"}
                  </TD>
                  <TD><StatusBadge status={s.status} /></TD>
                  <TD className="text-right">
                    <div className="flex justify-end gap-1">
                      <Button variant="ghost" size="sm" onClick={() => openEdit(s)} aria-label="Edit">
                        <Pencil className="h-4 w-4" />
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => setDeleteId(s.id)} aria-label="Deactivate" title="Deactivate" className="text-rose-500 hover:bg-rose-50 dark:hover:bg-rose-500/10">
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </Card>
      )}

      {/* Editor modal */}
      {editing && (
        <Modal
          open
          onClose={() => setEditing(null)}
          title={isNew ? "Add person" : "Edit person"}
          size="lg"
          footer={
            <>
              <Button variant="secondary" onClick={() => setEditing(null)}>Cancel</Button>
              <Button onClick={save} disabled={busy || !editing.name.trim()}>
                {busy ? "Saving…" : "Save"}
              </Button>
            </>
          }
        >
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Full name" required>
              <Input value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} placeholder="Jane Doe" />
            </Field>
            <Field label="Email">
              <Input type="email" value={editing.email} onChange={(e) => setEditing({ ...editing, email: e.target.value })} placeholder="jane@example.com" />
            </Field>
            <Field label="Phone">
              <Input value={editing.phone} onChange={(e) => setEditing({ ...editing, phone: e.target.value })} placeholder="(555) 123-4567" />
            </Field>
            <Field label="Role">
              <Select value={editing.role} onChange={(e) => setEditing({ ...editing, role: e.target.value as Role })}>
                <option value="salesperson">Salesperson</option>
                <option value="affiliate">Affiliate</option>
                <option value="partner">Partner</option>
              </Select>
            </Field>
            <Field label="Referral code">
              <Input value={editing.referralCode} onChange={(e) => setEditing({ ...editing, referralCode: e.target.value })} placeholder="JANE10" />
            </Field>
            <Field label="Status">
              <Select value={editing.status} onChange={(e) => setEditing({ ...editing, status: e.target.value as Salesperson["status"] })}>
                <option value="active">Active</option>
                <option value="inactive">Inactive</option>
              </Select>
            </Field>
            <Field label="Commission plan" className="sm:col-span-2">
              <Select
                value={editing.commissionPlanId ?? ""}
                onChange={(e) => setEditing({ ...editing, commissionPlanId: e.target.value || null })}
              >
                <option value="">— No plan assigned —</option>
                {data.plans.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </Select>
            </Field>

            <div className="sm:col-span-2">
              <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">
                Optional salary (drives real salary ledger rows)
              </p>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                <Field label="Weekly salary">
                  <NumberField
                    value={editing.weeklySalary ?? 0}
                    onChange={(v) => setEditing({ ...editing, weeklySalary: v === 0 ? null : v })}
                    emptyValue={0}
                    prefix="$"
                    placeholder="None"
                  />
                </Field>
                <Field label="Salary start">
                  <Input type="date" value={editing.salaryStartDate ?? ""} onChange={(e) => setEditing({ ...editing, salaryStartDate: e.target.value || null })} />
                </Field>
                <Field label="Salary end">
                  <Input type="date" value={editing.salaryEndDate ?? ""} onChange={(e) => setEditing({ ...editing, salaryEndDate: e.target.value || null })} />
                </Field>
              </div>
            </div>

            <Field label="Notes" className="sm:col-span-2">
              <Textarea value={editing.notes} onChange={(e) => setEditing({ ...editing, notes: e.target.value })} />
            </Field>
          </div>
        </Modal>
      )}

      <ConfirmModal
        open={!!deleteId}
        onClose={() => setDeleteId(null)}
        onConfirm={() => deleteId && deactivate(deleteId)}
        title="Deactivate person?"
        message="This marks the person inactive so they no longer appear in active reporting. Their clients and commission history are preserved, and you can reactivate them later by editing their status."
        confirmLabel="Deactivate"
      />
    </div>
  );
}
