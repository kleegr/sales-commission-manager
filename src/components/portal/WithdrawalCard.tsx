// ============================================================================
// WITHDRAWAL CARD  (salesperson / affiliate portal)
//
// "Here is what you can be paid, why that is the number, and a button to ask
// for it."
//
// The composition is shown, not just the total, because a balance a rep cannot
// reconcile against their own ledger is worse than no balance at all: they will
// assume it is wrong, and they will sometimes be right. Every dollar in their
// ledger appears in exactly one row here — available, awaiting approval, not yet
// released, or already paid — and clawbacks are shown as an explicit deduction
// rather than silently shrinking the headline figure.
//
// The rep asks for an AMOUNT; the server decides which ledger lines back it and
// answers with what it could actually cover. A line cannot be split, so a
// partial request is honoured to the nearest whole line and says so.
// ============================================================================

import { useCallback, useEffect, useState } from "react";
import { Wallet, Loader2, ArrowDownToLine, Info } from "lucide-react";
import {
  Card,
  Button,
  SectionTitle,
  Badge,
  Field,
  NumberField,
  Textarea,
  ErrorBanner,
} from "../ui";
import { Modal } from "../ui/Modal";
import { fetchBalance, requestWithdrawal, type RepBalance } from "../../lib/payouts-client";
import { errorMessage } from "../../lib/api-errors";
import { formatCurrency } from "../../lib/format";

/** One line of the composition. Money rows are always signed the same way. */
function Line({
  label,
  value,
  hint,
  tone = "default",
}: {
  label: string;
  value: number;
  hint?: string;
  tone?: "default" | "muted" | "negative";
}) {
  if (value === 0 && tone !== "default") return null;
  const valueClass =
    tone === "negative"
      ? "text-rose-600 dark:text-rose-400"
      : tone === "muted"
        ? "text-slate-500"
        : "text-slate-900 dark:text-white";
  return (
    <div className="flex items-baseline justify-between gap-3 py-1.5">
      <span className="text-sm text-slate-600 dark:text-slate-300">
        {label}
        {hint && <span className="ml-1 text-xs text-slate-400">{hint}</span>}
      </span>
      <span className={`text-sm font-medium tabular-nums ${valueClass}`}>
        {tone === "negative" ? `−${formatCurrency(Math.abs(value))}` : formatCurrency(value)}
      </span>
    </div>
  );
}

export function WithdrawalCard({
  onRequested,
  canRequest = true,
}: {
  /** Called after a successful request so the page can refresh its own data. */
  onRequested?: () => void | Promise<void>;
  /** False on the local-storage backend, which has no server to reconcile a balance. */
  canRequest?: boolean;
}) {
  const [balance, setBalance] = useState<RepBalance | null>(null);
  const [loading, setLoading] = useState(true);
  const [unavailable, setUnavailable] = useState(false);
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState<number>(0);
  const [wholeBalance, setWholeBalance] = useState(true);
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const b = await fetchBalance();
      setBalance(b);
      setUnavailable(false);
    } catch {
      // No server (local backend) or the rep isn't linked to a record yet.
      // Neither is an error worth shouting about on a portal — hide the card.
      setUnavailable(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (unavailable || !canRequest) return null;

  if (loading) {
    return (
      <Card className="space-y-3">
        <SectionTitle right={<Wallet className="h-4 w-4 text-slate-400" />}>Your balance</SectionTitle>
        <div className="flex items-center gap-2 text-sm text-slate-400">
          <Loader2 className="h-4 w-4 animate-spin" /> Reconciling your ledger…
        </div>
      </Card>
    );
  }
  if (!balance) return null;

  const canSubmit = balance.available > 0 && !balance.hasOpenRequest;

  async function submit() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await requestWithdrawal(wholeBalance ? null : amount, notes);
      if (!res.ok) {
        setError(errorMessage(res.error));
        return;
      }
      const paid = Number(res.data?.amount ?? 0);
      setConfirmation(
        res.data?.partial
          ? `Requested ${formatCurrency(paid)} — a commission line can't be split, so this covers whole lines up to the amount you asked for.`
          : `Requested ${formatCurrency(paid)}. You'll be notified once it's approved.`,
      );
      setOpen(false);
      setNotes("");
      await load();
      await onRequested?.();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Card className="space-y-3">
        <SectionTitle right={<Wallet className="h-4 w-4 text-slate-400" />}>Your balance</SectionTitle>

        <ErrorBanner message={error} onDismiss={() => setError(null)} />
        {confirmation && (
          <p className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-300">
            {confirmation}
          </p>
        )}

        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-slate-400">
            Available to withdraw
          </p>
          <p className="text-3xl font-semibold tabular-nums text-slate-900 dark:text-white">
            {formatCurrency(balance.available)}
          </p>
        </div>

        <div className="divide-y divide-slate-100 border-y border-slate-100 dark:divide-slate-800 dark:border-slate-800">
          <Line label="Commission" value={balance.commission} />
          <Line label="Salary" value={balance.salary} tone={balance.salary === 0 ? "muted" : "default"} />
          <Line
            label="Deductions"
            hint="refunds & chargebacks"
            value={balance.deductions}
            tone="negative"
          />
        </div>

        <div className="divide-y divide-slate-100 dark:divide-slate-800">
          <Line label="Awaiting approval" value={balance.awaitingApproval} tone="muted" />
          <Line label="Not yet released" hint="held or projected" value={balance.notYetReleased} tone="muted" />
          <Line label="Paid to you so far" value={balance.paidToDate} tone="muted" />
        </div>

        {balance.net < 0 && (
          <p className="flex items-start gap-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:bg-amber-500/10 dark:text-amber-300">
            <Info className="mt-0.5 h-3.5 w-3.5 flex-none" />
            Refunds currently exceed your earned commission by{" "}
            {formatCurrency(Math.abs(balance.net))}. New commission will go toward that first.
          </p>
        )}

        {balance.hasOpenRequest ? (
          <div className="flex items-center gap-2">
            <Badge tone="violet">Request pending</Badge>
            <span className="text-xs text-slate-500">
              You already have a withdrawal awaiting review.
            </span>
          </div>
        ) : (
          <Button
            onClick={() => {
              setAmount(balance.available);
              setWholeBalance(true);
              setConfirmation(null);
              setOpen(true);
            }}
            disabled={!canSubmit}
          >
            <ArrowDownToLine className="h-4 w-4" /> Request withdrawal
          </Button>
        )}
      </Card>

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Request a withdrawal"
        footer={
          <>
            <Button variant="secondary" onClick={() => setOpen(false)} disabled={busy}>
              Cancel
            </Button>
            <Button onClick={submit} disabled={busy || (!wholeBalance && amount <= 0)}>
              {busy ? "Sending…" : "Send request"}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <p className="text-sm text-slate-500">
            This goes to your manager or an admin for approval. Approving it doesn't move money on
            its own — they mark it paid once it has been sent.
          </p>

          <Field label="Amount">
            <div className="space-y-2">
              <label className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-200">
                <input
                  type="radio"
                  checked={wholeBalance}
                  onChange={() => setWholeBalance(true)}
                  className="h-4 w-4 text-brand-600 focus:ring-brand-500"
                />
                My whole balance ({formatCurrency(balance.available)})
              </label>
              <label className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-200">
                <input
                  type="radio"
                  checked={!wholeBalance}
                  onChange={() => setWholeBalance(false)}
                  className="h-4 w-4 text-brand-600 focus:ring-brand-500"
                />
                A specific amount
              </label>
              {!wholeBalance && (
                <NumberField
                  value={amount}
                  onChange={setAmount}
                  prefix="$"
                  min={0}
                  max={balance.available}
                />
              )}
            </div>
          </Field>

          {!wholeBalance && (
            <p className="text-xs text-slate-400">
              Commissions are paid as whole lines, so the request is filled with the oldest lines
              that fit — you'll see the exact amount once it's sent.
            </p>
          )}

          {balance.deductions > 0 && wholeBalance && (
            <p className="text-xs text-slate-400">
              {formatCurrency(balance.deductions)} of refunds and chargebacks is settled in this
              payout, which is why the total is less than your commission.
            </p>
          )}

          <Field label="Note" hint="Optional — anything the approver should know.">
            <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} />
          </Field>
        </div>
      </Modal>
    </>
  );
}
