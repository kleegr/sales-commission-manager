import { useState } from "react";
import type {
  MonthlyResidualRule,
  Rule,
  RuleType,
  SalaryRule,
  SetupFeeRule,
  SignupBonusRule,
} from "../../types";
import { Modal } from "../ui/Modal";
import { Button, Badge } from "../ui/primitives";
import { Checkbox, Field, Input, NumberField, Select } from "../ui/form";
import { uid, formatCurrency } from "../../lib/format";
import {
  CircleDollarSign,
  Gift,
  Repeat,
  Wallet,
} from "lucide-react";

const RULE_META: Record<
  RuleType,
  { label: string; icon: typeof Gift; blurb: string }
> = {
  setup_fee: {
    label: "Setup Fee",
    icon: CircleDollarSign,
    blurb: "Commission on the one-time setup fee.",
  },
  signup_bonus: {
    label: "Signup Bonus",
    icon: Gift,
    blurb: "Flat bonus paid once when a client signs up.",
  },
  monthly_residual: {
    label: "Monthly Residual",
    icon: Repeat,
    blurb: "Recurring commission on the monthly subscription.",
  },
  salary: {
    label: "Salary",
    icon: Wallet,
    blurb: "Fixed weekly pay over a period (preview only).",
  },
};

export function newRuleOfType(type: RuleType, suggestedStart = 1): Rule {
  switch (type) {
    case "setup_fee":
      return { id: uid("rule"), type, mode: "percentage", value: 50 };
    case "signup_bonus":
      return { id: uid("rule"), type, amount: 500 };
    case "monthly_residual":
      return {
        id: uid("rule"),
        type,
        startMonth: suggestedStart,
        endMonth: suggestedStart,
        continueForever: false,
        valueType: "percentage",
        value: 10,
      };
    case "salary":
      return {
        id: uid("rule"),
        type,
        weeklyAmount: 500,
        startDate: null,
        endDate: null,
        maxWeeks: null,
      };
  }
}

export function RuleEditorModal({
  open,
  rule,
  sampleSetup,
  sampleMonthly,
  onClose,
  onSave,
}: {
  open: boolean;
  rule: Rule | null;
  sampleSetup: number;
  sampleMonthly: number;
  onClose: () => void;
  onSave: (rule: Rule) => void;
}) {
  const [draft, setDraft] = useState<Rule | null>(rule);

  // Re-seed the draft whenever a different rule is opened.
  if (open && rule && draft?.id !== rule.id) setDraft(rule);
  if (!open || !draft) return null;

  const meta = RULE_META[draft.type];
  const Icon = meta.icon;

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="md"
      title={
        <span className="flex items-center gap-2">
          <Icon className="h-5 w-5 text-brand-600" />
          {RULE_META[draft.type].label} rule
        </span>
      }
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => onSave(draft)}>Save rule</Button>
        </>
      }
    >
      <p className="mb-4 text-sm text-slate-500 dark:text-slate-400">{meta.blurb}</p>

      {draft.type === "setup_fee" && (
        <SetupFeeEditor
          rule={draft}
          sampleSetup={sampleSetup}
          onChange={setDraft}
        />
      )}
      {draft.type === "signup_bonus" && (
        <SignupBonusEditor rule={draft} onChange={setDraft} />
      )}
      {draft.type === "monthly_residual" && (
        <ResidualEditor
          rule={draft}
          sampleMonthly={sampleMonthly}
          onChange={setDraft}
        />
      )}
      {draft.type === "salary" && <SalaryEditor rule={draft} onChange={setDraft} />}
    </Modal>
  );
}

function PreviewLine({ children }: { children: React.ReactNode }) {
  return (
    <div className="mt-4 rounded-lg bg-brand-50 px-3 py-2 text-sm text-brand-800 dark:bg-brand-500/10 dark:text-brand-200">
      {children}
    </div>
  );
}

function SetupFeeEditor({
  rule,
  sampleSetup,
  onChange,
}: {
  rule: SetupFeeRule;
  sampleSetup: number;
  onChange: (r: SetupFeeRule) => void;
}) {
  const result =
    rule.mode === "none"
      ? 0
      : rule.mode === "percentage"
        ? (sampleSetup * rule.value) / 100
        : rule.value;
  return (
    <div className="space-y-4">
      <Field label="Setup fee commission">
        <Select
          value={rule.mode}
          onChange={(e) =>
            onChange({ ...rule, mode: e.target.value as SetupFeeRule["mode"] })
          }
        >
          <option value="none">No setup fee commission</option>
          <option value="percentage">Percentage of setup fee</option>
          <option value="fixed">Fixed dollar amount</option>
        </Select>
      </Field>
      {rule.mode === "percentage" && (
        <Field label="Percentage">
          <NumberField
            value={rule.value}
            onChange={(v) => onChange({ ...rule, value: v })}
            suffix="%"
            min={0}
            max={100}
          />
        </Field>
      )}
      {rule.mode === "fixed" && (
        <Field label="Fixed amount">
          <NumberField
            value={rule.value}
            onChange={(v) => onChange({ ...rule, value: v })}
            prefix="$"
            min={0}
          />
        </Field>
      )}
      {rule.mode !== "none" && (
        <PreviewLine>
          On a {formatCurrency(sampleSetup)} setup fee →{" "}
          <strong>{formatCurrency(result)}</strong> commission
        </PreviewLine>
      )}
    </div>
  );
}

function SignupBonusEditor({
  rule,
  onChange,
}: {
  rule: SignupBonusRule;
  onChange: (r: SignupBonusRule) => void;
}) {
  return (
    <div className="space-y-4">
      <Field label="Bonus amount per new client" hint="Paid once at signup.">
        <NumberField
          value={rule.amount}
          onChange={(v) => onChange({ ...rule, amount: v })}
          prefix="$"
          min={0}
        />
      </Field>
      <PreviewLine>
        Each new signup pays <strong>{formatCurrency(rule.amount)}</strong>.
      </PreviewLine>
    </div>
  );
}

function ResidualEditor({
  rule,
  sampleMonthly,
  onChange,
}: {
  rule: MonthlyResidualRule;
  sampleMonthly: number;
  onChange: (r: MonthlyResidualRule) => void;
}) {
  const monthly =
    rule.valueType === "percentage"
      ? (sampleMonthly * rule.value) / 100
      : rule.value;
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3">
        <Field label="Start month">
          <NumberField
            value={rule.startMonth}
            onChange={(v) => onChange({ ...rule, startMonth: Math.max(1, v) })}
            emptyValue={1}
            min={1}
            max={60}
          />
        </Field>
        <Field label="End month">
          <NumberField
            value={rule.endMonth ?? rule.startMonth}
            onChange={(v) => onChange({ ...rule, endMonth: v })}
            emptyValue={rule.startMonth}
            min={rule.startMonth}
            max={60}
            disabled={rule.continueForever}
          />
        </Field>
      </div>

      <Checkbox
        label="Continue forever (no end month)"
        checked={rule.continueForever}
        onChange={(v) =>
          onChange({
            ...rule,
            continueForever: v,
            endMonth: v ? null : rule.startMonth,
          })
        }
      />

      <div className="grid grid-cols-2 gap-3">
        <Field label="Commission type">
          <Select
            value={rule.valueType}
            onChange={(e) =>
              onChange({
                ...rule,
                valueType: e.target.value as MonthlyResidualRule["valueType"],
              })
            }
          >
            <option value="percentage">Percentage</option>
            <option value="fixed">Fixed $ / month</option>
          </Select>
        </Field>
        <Field label={rule.valueType === "percentage" ? "Percentage" : "Amount"}>
          <NumberField
            value={rule.value}
            onChange={(v) => onChange({ ...rule, value: v })}
            prefix={rule.valueType === "fixed" ? "$" : undefined}
            suffix={rule.valueType === "percentage" ? "%" : undefined}
            min={0}
            max={rule.valueType === "percentage" ? 100 : undefined}
          />
        </Field>
      </div>

      <PreviewLine>
        {rule.continueForever
          ? `Months ${rule.startMonth}+ `
          : rule.startMonth === rule.endMonth
            ? `Month ${rule.startMonth} `
            : `Months ${rule.startMonth}–${rule.endMonth} `}
        on a {formatCurrency(sampleMonthly)}/mo subscription →{" "}
        <strong>{formatCurrency(monthly)}/mo</strong>
      </PreviewLine>
    </div>
  );
}

function SalaryEditor({
  rule,
  onChange,
}: {
  rule: SalaryRule;
  onChange: (r: SalaryRule) => void;
}) {
  const monthly = (rule.weeklyAmount || 0) * (52 / 12);
  return (
    <div className="space-y-4">
      <Field label="Weekly salary amount">
        <NumberField
          value={rule.weeklyAmount}
          onChange={(v) => onChange({ ...rule, weeklyAmount: v })}
          prefix="$"
          min={0}
        />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Start date" hint="Optional in plan preview">
          <Input
            type="date"
            value={rule.startDate ?? ""}
            onChange={(e) => onChange({ ...rule, startDate: e.target.value || null })}
          />
        </Field>
        <Field label="End date" hint="Optional">
          <Input
            type="date"
            value={rule.endDate ?? ""}
            onChange={(e) => onChange({ ...rule, endDate: e.target.value || null })}
          />
        </Field>
      </div>
      <Field label="Max weeks" hint="Optional — leave blank for ongoing">
        <NumberField
          value={rule.maxWeeks ?? 0}
          onChange={(v) => onChange({ ...rule, maxWeeks: v === 0 ? null : v })}
          emptyValue={0}
          min={0}
          placeholder="Ongoing"
        />
      </Field>
      <PreviewLine>
        ≈ <strong>{formatCurrency(monthly)}/mo</strong> while active{" "}
        <Badge tone="amber" className="ml-1">
          preview only
        </Badge>
      </PreviewLine>
    </div>
  );
}
