// ============================================================================
// AFFILIATE / PARTNER PORTAL
//
// The self-scoped view for an affiliate or partner. The server only ever sends
// this user their OWN salesperson record, their referred clients, their
// commissions and their payouts, so everything here is already isolated.
// Submitting a referral POSTs to /api/clients, which forces the new lead to be
// assigned to this affiliate (they cannot file against anyone else).
// ============================================================================

import { useMemo, useState } from "react";
import { Handshake, Copy, Check, Plus, Link2, Loader2 } from "lucide-react";
import { useApp } from "../store/AppContext";
import {
  PageHeader,
  Card,
  StatCard,
  SectionTitle,
  Button,
  EmptyState,
  StatusBadge,
  CommissionBadge,
  PayoutBadge,
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
import { fullLedger, displayStatus, clientLabel } from "../lib/ledger";
import { commissionTotals } from "../lib/analytics";
import { formatCurrency, formatDate } from "../lib/format";

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

export default function AffiliatePortal() {
  const { data, reload, role } = useApp();
  const me = data.salespeople[0]; // self-scoped: the only person is this user
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<LeadDraft>(emptyLead());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const referrals = data.clients;
  const ledger = useMemo(() => (me ? fullLedger(data, 24).filter((e) => e.salespersonId === me.id) : []), [data, me]);
  const totals = useMemo(() => commissionTotals(ledger), [ledger]);
  const payouts = useMemo(
    () => [...data.payouts].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)),
    [data.payouts],
  );

  const roleLabel = role === "partner" ? "Partner" : "Affiliate";
  const referralCode = me?.referralCode || "—";
  const referralLink =
    typeof window !== "undefined" && me?.referralCode
      ? `${window.location.origin}/r/${me.referralCode}`
      : `https://app.example.com/r/${referralCode}`;

  function copyLink() {
    try {
      void navigator.clipboard.writeText(referralLink);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* ignore */
    }
  }

  async function submitReferral() {
    if (!draft.companyName.trim()) {
      setError("A company / client name is required.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/clients", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...draft, status: "active" }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `error_${res.status}`);
      }
      setOpen(false);
      setDraft(emptyLead());
      await reload();
    } catch (e: any) {
      setError(e?.message === "client_not_yours" ? "You can only refer your own leads." : "Couldn't submit the referral. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  if (!me) {
    return (
      <div>
        <PageHeader title={`${roleLabel} Portal`} />
        <EmptyState icon={<Handshake className="h-6 w-6" />} title="No profile found" description="This account isn't linked to an affiliate record yet." />
      </div>
    );
  }

  return (
    <div>
      <PageHeader
        title={`${roleLabel} Portal`}
        subtitle={`Welcome back, ${me.name}`}
        actions={
          <Button onClick={() => setOpen(true)}>
            <Plus className="h-4 w-4" /> Submit referral
          </Button>
        }
      />

      {/* Referral code / link */}
      <Card className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-violet-100 text-violet-600 dark:bg-violet-500/15 dark:text-violet-300">
            <Link2 className="h-5 w-5" />
          </span>
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-slate-400">Your referral code</p>
            <p className="font-mono text-lg font-semibold text-slate-900 dark:text-white">{referralCode}</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <code className="truncate rounded-lg bg-slate-100 px-3 py-2 text-xs text-slate-600 dark:bg-slate-800 dark:text-slate-300">
            {referralLink}
          </code>
          <Button variant="secondary" size="sm" onClick={copyLink}>
            {copied ? <Check className="h-4 w-4 text-emerald-500" /> : <Copy className="h-4 w-4" />}
            {copied ? "Copied" : "Copy"}
          </Button>
        </div>
      </Card>

      <div className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Pending commission" value={formatCurrency(totals.pending)} tone="amber" />
        <StatCard label="Paid out" value={formatCurrency(totals.paid)} tone="green" />
        <StatCard label="Projected (next 24 mo)" value={formatCurrency(totals.projected)} tone="cyan" />
        <StatCard label="My referrals" value={referrals.length} tone="violet" />
      </div>

      {/* Referrals */}
      <div className="mb-6">
        <SectionTitle>My referrals</SectionTitle>
        <Card padded={false} className="overflow-hidden">
          {referrals.length === 0 ? (
            <div className="p-6">
              <EmptyState
                icon={<Handshake className="h-6 w-6" />}
                title="No referrals yet"
                description="Submit your first referral to start earning commissions."
                action={<Button onClick={() => setOpen(true)}><Plus className="h-4 w-4" /> Submit referral</Button>}
              />
            </div>
          ) : (
            <Table>
              <THead>
                <TR>
                  <TH>Company</TH>
                  <TH>Contact</TH>
                  <TH>Referred</TH>
                  <TH className="text-right">Monthly</TH>
                  <TH>Status</TH>
                </TR>
              </THead>
              <TBody>
                {referrals.map((c) => (
                  <TR key={c.id}>
                    <TD className="font-medium text-slate-900 dark:text-white">{c.companyName}</TD>
                    <TD>{c.contactName || "—"}</TD>
                    <TD className="text-slate-500">{formatDate(c.signupDate)}</TD>
                    <TD className="text-right tabular-nums">{formatCurrency(c.monthlySubscription)}</TD>
                    <TD><StatusBadge status={c.status} /></TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </Card>
      </div>

      {/* Commissions */}
      <div className="mb-6">
        <SectionTitle>Recent commissions</SectionTitle>
        <Card padded={false} className="overflow-hidden">
          {ledger.length === 0 ? (
            <div className="p-6"><EmptyState icon={<Handshake className="h-6 w-6" />} title="No commissions yet" /></div>
          ) : (
            <Table>
              <THead>
                <TR>
                  <TH>Client</TH>
                  <TH>Rule</TH>
                  <TH>Due</TH>
                  <TH className="text-right">Amount</TH>
                  <TH>Status</TH>
                </TR>
              </THead>
              <TBody>
                {ledger.slice(0, 20).map((e) => (
                  <TR key={e.id}>
                    <TD>{clientLabel(data.clients.find((c) => c.id === e.clientId))}</TD>
                    <TD className="text-slate-500">{e.ruleLabel}</TD>
                    <TD className="text-slate-500">{formatDate(e.dueDate)}</TD>
                    <TD className="text-right tabular-nums">{formatCurrency(e.commissionAmount)}</TD>
                    <TD><CommissionBadge status={displayStatus(e)} /></TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </Card>
      </div>

      {/* Payouts */}
      <div>
        <SectionTitle>Payout history</SectionTitle>
        <Card padded={false} className="overflow-hidden">
          {payouts.length === 0 ? (
            <div className="p-6"><EmptyState icon={<Handshake className="h-6 w-6" />} title="No payouts yet" /></div>
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
                {payouts.map((p) => (
                  <TR key={p.id}>
                    <TD className="text-slate-500">{formatDate(p.submittedAt ?? p.createdAt)}</TD>
                    <TD className="text-right tabular-nums">{formatCurrency(p.totalAmount)}</TD>
                    <TD><PayoutBadge status={p.status} /></TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </Card>
      </div>

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Submit a referral"
        size="lg"
        footer={
          <>
            <Button variant="secondary" onClick={() => setOpen(false)} disabled={saving}>Cancel</Button>
            <Button onClick={() => void submitReferral()} disabled={saving}>
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />} Submit
            </Button>
          </>
        }
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Company / client name" required className="sm:col-span-2">
            <Input value={draft.companyName} onChange={(e) => setDraft({ ...draft, companyName: e.target.value })} />
          </Field>
          <Field label="Contact name">
            <Input value={draft.contactName} onChange={(e) => setDraft({ ...draft, contactName: e.target.value })} />
          </Field>
          <Field label="Email">
            <Input type="email" value={draft.email} onChange={(e) => setDraft({ ...draft, email: e.target.value })} />
          </Field>
          <Field label="Phone">
            <Input value={draft.phone} onChange={(e) => setDraft({ ...draft, phone: e.target.value })} />
          </Field>
          <Field label="Est. setup fee">
            <NumberField value={draft.setupFee} onChange={(v) => setDraft({ ...draft, setupFee: v })} prefix="$" min={0} />
          </Field>
          <Field label="Est. monthly">
            <NumberField value={draft.monthlySubscription} onChange={(v) => setDraft({ ...draft, monthlySubscription: v })} prefix="$" min={0} />
          </Field>
          <Field label="Notes" className="sm:col-span-2">
            <Textarea value={draft.notes} onChange={(e) => setDraft({ ...draft, notes: e.target.value })} />
          </Field>
          {error && <p className="text-sm text-rose-600 sm:col-span-2">{error}</p>}
          <p className="text-xs text-slate-400 sm:col-span-2">
            Referrals are saved to the app database and assigned to you automatically. (GoHighLevel contact sync comes later.)
          </p>
        </div>
      </Modal>
    </div>
  );
}
