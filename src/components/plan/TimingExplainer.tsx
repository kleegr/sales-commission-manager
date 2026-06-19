import type { CommissionPlan } from "../../types";
import { normalizeTiming } from "../../lib/commission-timing";
import { Clock, ShieldCheck, RotateCcw, Zap } from "lucide-react";
import { classNames } from "../../lib/format";

/**
 * Turns a plan's CommissionTiming into a short list of plain-English rules a
 * non-technical reader (or a recruit) can understand. Mirrors the resolver in
 * commission-timing.ts so the explanation always matches what actually happens.
 */
export function timingRuleLines(plan: CommissionPlan): {
  icon: typeof Clock;
  tone: "blue" | "amber" | "rose" | "green";
  text: string;
}[] {
  const t = normalizeTiming(plan.timing);
  const lines: {
    icon: typeof Clock;
    tone: "blue" | "amber" | "rose" | "green";
    text: string;
  }[] = [];

  switch (t.trigger) {
    case "immediate":
      lines.push({
        icon: Zap,
        tone: "green",
        text: "Commissions are payable as soon as they're earned — no hold.",
      });
      break;
    case "after_days":
      lines.push({
        icon: Clock,
        tone: "blue",
        text: `Each commission is held for ${t.days} day${
          t.days === 1 ? "" : "s"
        } after it's earned, then becomes payable.`,
      });
      break;
    case "after_months":
      lines.push({
        icon: Clock,
        tone: "blue",
        text: `Each commission is held for ${t.months} month${
          t.months === 1 ? "" : "s"
        } after it's earned, then becomes payable.`,
      });
      break;
    case "after_payments":
      lines.push({
        icon: Clock,
        tone: "blue",
        text: `A commission is held until the client has made ${t.payments} payment${
          t.payments === 1 ? "" : "s"
        }, then it's released.`,
      });
      break;
    case "on_approval":
      lines.push({
        icon: ShieldCheck,
        tone: "amber",
        text: "Every commission is held until an admin approves and releases it.",
      });
      break;
    case "after_refund_window":
      lines.push({
        icon: ShieldCheck,
        tone: "amber",
        text: `Commissions are held through a ${t.days}-day refund window before they're paid, so refunds never claw back a paid commission.`,
      });
      break;
  }

  if (t.requireActiveClient) {
    lines.push({
      icon: ShieldCheck,
      tone: "amber",
      text: "A commission is only released while the client is still active. If the client cancels first, it stays held.",
    });
  }

  if (t.clawbackBeforeMonths > 0) {
    lines.push({
      icon: RotateCcw,
      tone: "rose",
      text: `If a client cancels or refunds within ${t.clawbackBeforeMonths} month${
        t.clawbackBeforeMonths === 1 ? "" : "s"
      } of signing up, the related commission is clawed back (reversed).`,
    });
  }

  return lines;
}

const TONE_BG: Record<string, string> = {
  blue: "bg-blue-100 text-blue-600 dark:bg-blue-500/15 dark:text-blue-300",
  amber: "bg-amber-100 text-amber-600 dark:bg-amber-500/15 dark:text-amber-300",
  rose: "bg-rose-100 text-rose-600 dark:bg-rose-500/15 dark:text-rose-300",
  green: "bg-emerald-100 text-emerald-600 dark:bg-emerald-500/15 dark:text-emerald-300",
};

export function TimingExplainer({ plan }: { plan: CommissionPlan }) {
  const lines = timingRuleLines(plan);
  return (
    <ul className="space-y-3">
      {lines.map((l, i) => {
        const Icon = l.icon;
        return (
          <li key={i} className="flex items-start gap-3">
            <span
              className={classNames(
                "flex h-8 w-8 flex-none items-center justify-center rounded-lg",
                TONE_BG[l.tone],
              )}
            >
              <Icon className="h-4 w-4" />
            </span>
            <p className="pt-1 text-sm text-slate-700 dark:text-slate-200">{l.text}</p>
          </li>
        );
      })}
    </ul>
  );
}
