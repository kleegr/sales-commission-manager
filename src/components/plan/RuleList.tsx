import { useState } from "react";
import type { Rule } from "../../types";
import { ruleHeadline } from "../../lib/commission-engine";
import { classNames, uid } from "../../lib/format";
import { Badge, Button } from "../ui/primitives";
import {
  CircleDollarSign,
  Copy,
  GripVertical,
  Gift,
  Pencil,
  Repeat,
  Trash2,
  Wallet,
} from "lucide-react";

const ICONS = {
  setup_fee: CircleDollarSign,
  signup_bonus: Gift,
  monthly_residual: Repeat,
  salary: Wallet,
} as const;

const TONES = {
  setup_fee: "blue",
  signup_bonus: "violet",
  monthly_residual: "green",
  salary: "amber",
} as const;

const TYPE_LABEL = {
  setup_fee: "Setup fee",
  signup_bonus: "Signup bonus",
  monthly_residual: "Residual",
  salary: "Salary",
} as const;

export function RuleList({
  rules,
  onChange,
  onEdit,
}: {
  rules: Rule[];
  onChange: (rules: Rule[]) => void;
  onEdit: (rule: Rule) => void;
}) {
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  const [edge, setEdge] = useState<"top" | "bottom">("top");

  function handleDrop(targetId: string) {
    if (!dragId || dragId === targetId) {
      reset();
      return;
    }
    const from = rules.findIndex((r) => r.id === dragId);
    const to = rules.findIndex((r) => r.id === targetId);
    if (from === -1 || to === -1) {
      reset();
      return;
    }
    const next = [...rules];
    const [moved] = next.splice(from, 1);
    let insert = next.findIndex((r) => r.id === targetId);
    if (edge === "bottom") insert += 1;
    next.splice(insert, 0, moved);
    onChange(next);
    reset();
  }

  function reset() {
    setDragId(null);
    setOverId(null);
  }

  function duplicate(rule: Rule) {
    const copy = { ...rule, id: uid("rule") } as Rule;
    const idx = rules.findIndex((r) => r.id === rule.id);
    const next = [...rules];
    next.splice(idx + 1, 0, copy);
    onChange(next);
  }

  function remove(id: string) {
    onChange(rules.filter((r) => r.id !== id));
  }

  return (
    <ul className="space-y-2">
      {rules.map((rule) => {
        const Icon = ICONS[rule.type];
        const isDragging = dragId === rule.id;
        const isOver = overId === rule.id && dragId !== rule.id;
        return (
          <li
            key={rule.id}
            draggable
            onDragStart={() => setDragId(rule.id)}
            onDragEnd={reset}
            onDragOver={(e) => {
              e.preventDefault();
              const rect = e.currentTarget.getBoundingClientRect();
              setOverId(rule.id);
              setEdge(e.clientY - rect.top < rect.height / 2 ? "top" : "bottom");
            }}
            onDrop={() => handleDrop(rule.id)}
            className={classNames(
              "flex items-center gap-3 rounded-xl border border-slate-200 bg-white px-3 py-3 shadow-sm transition dark:border-slate-800 dark:bg-slate-900",
              isDragging && "dragging",
              isOver && edge === "top" && "drag-over-top",
              isOver && edge === "bottom" && "drag-over-bottom",
            )}
          >
            <span className="cursor-grab text-slate-300 active:cursor-grabbing dark:text-slate-600">
              <GripVertical className="h-5 w-5" />
            </span>
            <span
              className={classNames(
                "flex h-9 w-9 flex-none items-center justify-center rounded-lg",
                {
                  blue: "bg-blue-100 text-blue-600 dark:bg-blue-500/15 dark:text-blue-300",
                  violet: "bg-violet-100 text-violet-600 dark:bg-violet-500/15 dark:text-violet-300",
                  green: "bg-emerald-100 text-emerald-600 dark:bg-emerald-500/15 dark:text-emerald-300",
                  amber: "bg-amber-100 text-amber-600 dark:bg-amber-500/15 dark:text-amber-300",
                }[TONES[rule.type]],
              )}
            >
              <Icon className="h-5 w-5" />
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <Badge tone={TONES[rule.type]}>{TYPE_LABEL[rule.type]}</Badge>
              </div>
              <p className="mt-0.5 truncate text-sm font-medium text-slate-800 dark:text-slate-100">
                {ruleHeadline(rule)}
              </p>
            </div>
            <div className="flex items-center gap-1">
              <Button variant="ghost" size="sm" onClick={() => onEdit(rule)} aria-label="Edit">
                <Pencil className="h-4 w-4" />
              </Button>
              <Button variant="ghost" size="sm" onClick={() => duplicate(rule)} aria-label="Duplicate">
                <Copy className="h-4 w-4" />
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => remove(rule.id)}
                aria-label="Delete"
                className="text-rose-500 hover:bg-rose-50 dark:hover:bg-rose-500/10"
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
