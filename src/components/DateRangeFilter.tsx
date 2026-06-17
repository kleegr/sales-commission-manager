import { CalendarRange } from "lucide-react";
import { Input } from "./ui";
import { classNames } from "../lib/format";

export interface DateRange {
  from: string | null;
  to: string | null;
}

const presets: { label: string; months: number | null }[] = [
  { label: "3M", months: 3 },
  { label: "6M", months: 6 },
  { label: "1Y", months: 12 },
  { label: "All", months: null },
];

function monthsAgoISO(n: number): string {
  const d = new Date();
  d.setMonth(d.getMonth() - n);
  return d.toISOString().slice(0, 10);
}

export function DateRangeFilter({
  value,
  onChange,
  className,
}: {
  value: DateRange;
  onChange: (r: DateRange) => void;
  className?: string;
}) {
  return (
    <div
      className={classNames(
        "flex flex-wrap items-center gap-2 rounded-lg border border-slate-200 bg-white px-2 py-1.5 dark:border-slate-800 dark:bg-slate-900",
        className,
      )}
    >
      <CalendarRange className="ml-1 h-4 w-4 text-slate-400" />
      <Input
        type="date"
        value={value.from ?? ""}
        onChange={(e) => onChange({ ...value, from: e.target.value || null })}
        className="h-8 w-auto py-1 text-xs"
      />
      <span className="text-xs text-slate-400">to</span>
      <Input
        type="date"
        value={value.to ?? ""}
        onChange={(e) => onChange({ ...value, to: e.target.value || null })}
        className="h-8 w-auto py-1 text-xs"
      />
      <div className="flex items-center gap-1">
        {presets.map((p) => (
          <button
            key={p.label}
            onClick={() =>
              onChange({
                from: p.months == null ? null : monthsAgoISO(p.months),
                to: null,
              })
            }
            className="rounded-md px-2 py-1 text-xs font-medium text-slate-500 transition hover:bg-slate-100 hover:text-slate-800 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-100"
          >
            {p.label}
          </button>
        ))}
      </div>
    </div>
  );
}
