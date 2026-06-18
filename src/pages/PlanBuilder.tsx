import { useEffect, useRef, useState } from "react";
import { useNavigate, useParams, Link } from "react-router-dom";
import {
  ArrowLeft,
  Save,
  CircleDollarSign,
  Gift,
  Repeat,
  Wallet,
  ScrollText,
} from "lucide-react";
import { useApp } from "../store/AppContext";
import type {
  CommissionPlan,
  CommissionReleaseTrigger,
  CommissionTiming,
  Rule,
  RuleType,
} from "../types";
import {
  PageHeader,
  Button,
  Card,
  Field,
  Input,
  Textarea,
  Select,
  Checkbox,
  NumberField,
  SectionTitle,
  EmptyState,
} from "../components/ui";
import { RuleList } from "../components/plan/RuleList";
import { RuleEditorModal, newRuleOfType } from "../components/plan/RuleEditorModal";
import { ProjectionView } from "../components/plan/ProjectionView";
import { suggestNextStartMonth } from "../lib/commission-engine";
import {
  normalizeTiming,
  timingHeadline,
  TRIGGERS,
  TRIGGER_LABEL,
} from "../lib/commission-timing";
import { uid, todayISO } from "../lib/format";

const ADD_BUTTONS: { type: RuleType; label: string; icon: typeof Gift }[] = [
  { type: "setup_fee", label: "Setup Fee", icon: CircleDollarSign },
  { type: "signup_bonus", label: "Signup Bonus", icon: Gift },
  { type: "monthly_residual", label: "Monthly Residual", icon: Repeat },
  { type: "salary", label: "Salary", icon: Wallet },
];

function freshPlan(): CommissionPlan {
  return {
    id: uid("plan"),
    name: "",
    description: "",
    rules: [],
    sampleSetupFee: 2500,
    sampleMonthly: 250,
    createdAt: todayISO(),
  };
}

function clonePlan(p: CommissionPlan): CommissionPlan {
  return { ...p, rules: p.rules.map((r) => ({ ...r })) };
}

export default function PlanBuilder() {
  const { data, dispatch } = useApp();
  const navigate = useNavigate();
  const { id } = useParams();
  const isEdit = !!id;
  const existing = id ? data.plans.find((p) => p.id === id) : undefined;
  const plansLoaded = data.plans.length > 0;

  const [draft, setDraft] = useState<CommissionPlan>(() =>
    existing ? clonePlan(existing) : freshPlan(),
  );
  const [editing, setEditing] = useState<Rule | null>(null);
  const seededFor = useRef<string | null>(existing ? existing.id : null);

  // Re-seed once the target plan becomes available after async hydration.
  useEffect(() => {
    if (isEdit && existing && seededFor.current !== existing.id) {
      setDraft(clonePlan(existing));
      seededFor.current = existing.id;
    }
  }, [isEdit, existing]);

  if (isEdit && plansLoaded && !existing) {
    return (
      <div>
        <PageHeader title="Plan not found" />
        <EmptyState
          icon={<ScrollText className="h-6 w-6" />}
          title="That plan doesn't exist"
          description="It may have been deleted."
          action={
            <Link to="/plans">
              <Button>Back to plans</Button>
            </Link>
          }
        />
      </div>
    );
  }

  function addRule(type: RuleType) {
    setEditing(newRuleOfType(type, suggestNextStartMonth(draft.rules)));
  }

  // Update the plan's timing. Store `undefined` when the config is the plain
  // "pay immediately, no conditions" default so untouched plans stay clean.
  function setTiming(patch: Partial<CommissionTiming>) {
    const next = normalizeTiming({ ...normalizeTiming(draft.timing), ...patch });
    const isDefault =
      next.trigger === "immediate" &&
      !next.requireActiveClient &&
      next.clawbackBeforeMonths === 0;
    setDraft({ ...draft, timing: isDefault ? undefined : next });
  }

  function handleRuleSave(rule: Rule) {
    setDraft((d) => {
      const exists = d.rules.some((r) => r.id === rule.id);
      return {
        ...d,
        rules: exists
          ? d.rules.map((r) => (r.id === rule.id ? rule : r))
          : [...d.rules, rule],
      };
    });
    setEditing(null);
  }

  function savePlan() {
    const plan: CommissionPlan = {
      ...draft,
      name: draft.name.trim() || "Untitled plan",
    };
    if (isEdit && existing) dispatch({ type: "PLAN_UPDATE", plan });
    else dispatch({ type: "PLAN_ADD", plan });
    navigate("/plans");
  }

  return (
    <div>
      <Link
        to="/plans"
        className="mb-3 inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-700 dark:hover:text-slate-300"
      >
        <ArrowLeft className="h-4 w-4" /> Plans
      </Link>

      <PageHeader
        title={isEdit ? "Edit commission plan" : "New commission plan"}
        subtitle="Stack setup, signup, residual, and salary rules — the preview updates instantly"
        actions={
          <>
            <Button variant="secondary" onClick={() => navigate("/plans")}>
              Cancel
            </Button>
            <Button onClick={savePlan}>
              <Save className="h-4 w-4" /> Save plan
            </Button>
          </>
        }
      />

      <div className="grid gap-6 lg:grid-cols-2">
        {/* ---- Left: configuration ---- */}
        <div className="space-y-5">
          <Card className="space-y-4">
            <SectionTitle>Plan details</SectionTitle>
            <Field label="Plan name" required>
              <Input
                value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                placeholder="e.g. Standard Sales Plan"
              />
            </Field>
            <Field label="Description" hint="Shown on plan cards and the recruiting view.">
              <Textarea
                value={draft.description}
                onChange={(e) => setDraft({ ...draft, description: e.target.value })}
                placeholder="Who is this plan for and what makes it attractive?"
              />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Sample setup fee" hint="Used to preview payouts.">
                <NumberField
                  value={draft.sampleSetupFee}
                  onChange={(v) => setDraft({ ...draft, sampleSetupFee: v })}
                  prefix="$"
                  min={0}
                />
              </Field>
              <Field label="Sample monthly" hint="Subscription amount.">
                <NumberField
                  value={draft.sampleMonthly}
                  onChange={(v) => setDraft({ ...draft, sampleMonthly: v })}
                  prefix="$"
                  min={0}
                />
              </Field>
            </div>
          </Card>

          <Card className="space-y-4">
            <SectionTitle right={<span className="text-xs text-slate-400">Drag to reorder</span>}>
              Commission rules
            </SectionTitle>

            <RuleList
              rules={draft.rules}
              onChange={(rules) => setDraft({ ...draft, rules })}
              onEdit={(rule) => setEditing(rule)}
            />

            <div>
              <p className="mb-2 text-xs font-medium uppercase tracking-wide text-slate-400">
                Add a rule
              </p>
              <div className="flex flex-wrap gap-2">
                {ADD_BUTTONS.map((b) => {
                  const Icon = b.icon;
                  return (
                    <Button
                      key={b.type}
                      variant="secondary"
                      size="sm"
                      onClick={() => addRule(b.type)}
                    >
                      <Icon className="h-4 w-4" /> {b.label}
                    </Button>
                  );
                })}
              </div>
              <p className="mt-3 text-xs text-slate-400">
                Residual rules auto-suggest their next start month so periods line up
                without gaps. Salary rules are preview-only here — a person's real salary
                is set on their profile.
              </p>
            </div>
          </Card>

          <TimingCard timing={draft.timing} onChange={setTiming} />
        </div>

        {/* ---- Right: live preview ---- */}
        <div className="space-y-3">
          <SectionTitle>Live preview</SectionTitle>
          <Card>
            <ProjectionView plan={draft} initialAssumptions={data.settings.assumptions} />
          </Card>
        </div>
      </div>

      <RuleEditorModal
        open={!!editing}
        rule={editing}
        sampleSetup={draft.sampleSetupFee}
        sampleMonthly={draft.sampleMonthly}
        onClose={() => setEditing(null)}
        onSave={handleRuleSave}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Timing editor — controls when a plan's commissions become payable, plus the
// active-client condition and the clawback window.
// ---------------------------------------------------------------------------
function TimingCard({
  timing,
  onChange,
}: {
  timing?: CommissionTiming;
  onChange: (patch: Partial<CommissionTiming>) => void;
}) {
  const t = normalizeTiming(timing);
  const showDays = t.trigger === "after_days" || t.trigger === "after_refund_window";
  const daysLabel =
    t.trigger === "after_refund_window" ? "Refund window (days)" : "Days to wait";

  return (
    <Card className="space-y-4">
      <SectionTitle right={<span className="text-xs text-slate-400">{timingHeadline(t)}</span>}>
        Commission timing
      </SectionTitle>

      <Field
        label="When does a commission become payable?"
        hint="Applies to every commission this plan generates."
      >
        <Select
          value={t.trigger}
          onChange={(e) =>
            onChange({ trigger: e.target.value as CommissionReleaseTrigger })
          }
        >
          {TRIGGERS.map((tr) => (
            <option key={tr} value={tr}>
              {TRIGGER_LABEL[tr]}
            </option>
          ))}
        </Select>
      </Field>

      {showDays && (
        <Field label={daysLabel}>
          <NumberField
            value={t.days}
            onChange={(v) => onChange({ days: v })}
            min={0}
            suffix="days"
          />
        </Field>
      )}

      {t.trigger === "after_months" && (
        <Field label="Months to wait">
          <NumberField
            value={t.months}
            onChange={(v) => onChange({ months: v })}
            min={0}
            suffix="months"
          />
        </Field>
      )}

      {t.trigger === "after_payments" && (
        <Field label="Client payments required before paying">
          <NumberField
            value={t.payments}
            onChange={(v) => onChange({ payments: v })}
            min={0}
            suffix="payments"
          />
        </Field>
      )}

      {t.trigger === "on_approval" && (
        <p className="rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-500 dark:bg-slate-800/60 dark:text-slate-400">
          Commissions stay <span className="font-medium">Held</span> until an admin releases them
          from the ledger with “Release now”.
        </p>
      )}

      <div className="space-y-3 border-t border-slate-100 pt-3 dark:border-slate-800">
        <Checkbox
          label="Pay only while the client is still active"
          checked={t.requireActiveClient}
          onChange={(v) => onChange({ requireActiveClient: v })}
        />
        <Field
          label="Claw back if the client cancels before…"
          hint="Months from signup. 0 = never claw back."
        >
          <NumberField
            value={t.clawbackBeforeMonths}
            onChange={(v) => onChange({ clawbackBeforeMonths: v })}
            min={0}
            suffix="months"
          />
        </Field>
      </div>
    </Card>
  );
}
