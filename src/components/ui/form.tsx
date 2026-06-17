// Reusable form controls. The NumberField deliberately keeps its own string
// buffer so users can clear the box and type freely — no "trapped zero".

import {
  useEffect,
  useId,
  useState,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from "react";
import { classNames } from "../../lib/format";

const baseField =
  "w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm outline-none transition placeholder:text-slate-400 focus:border-brand-500 focus:ring-2 focus:ring-brand-500/30 disabled:cursor-not-allowed disabled:opacity-60 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100 dark:placeholder:text-slate-500";

export function Field({
  label,
  hint,
  required,
  children,
  className,
}: {
  label?: string;
  hint?: string;
  required?: boolean;
  children: ReactNode;
  className?: string;
}) {
  return (
    <label className={classNames("block", className)}>
      {label && (
        <span className="mb-1 flex items-center gap-1 text-sm font-medium text-slate-700 dark:text-slate-300">
          {label}
          {required && <span className="text-rose-500">*</span>}
        </span>
      )}
      {children}
      {hint && <span className="mt-1 block text-xs text-slate-500">{hint}</span>}
    </label>
  );
}

export function Input(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={classNames(baseField, props.className)} />;
}

export function Textarea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      rows={3}
      {...props}
      className={classNames(baseField, "resize-y", props.className)}
    />
  );
}

export function Select(props: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select {...props} className={classNames(baseField, "pr-8", props.className)}>
      {props.children}
    </select>
  );
}

export function Checkbox({
  label,
  checked,
  onChange,
  className,
}: {
  label: ReactNode;
  checked: boolean;
  onChange: (v: boolean) => void;
  className?: string;
}) {
  const id = useId();
  return (
    <label
      htmlFor={id}
      className={classNames(
        "flex cursor-pointer items-center gap-2 text-sm text-slate-700 dark:text-slate-300",
        className,
      )}
    >
      <input
        id={id}
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-500 dark:border-slate-600 dark:bg-slate-800"
      />
      {label}
    </label>
  );
}

/**
 * Numeric input that never traps a leading zero.
 * Holds the raw text locally; commits a parsed number on change. An empty box
 * reports `emptyValue` (default 0) but is shown blank so it can be edited.
 */
export function NumberField({
  value,
  onChange,
  emptyValue = 0,
  min,
  max,
  step,
  prefix,
  suffix,
  placeholder,
  disabled,
  className,
}: {
  value: number;
  onChange: (v: number) => void;
  emptyValue?: number;
  min?: number;
  max?: number;
  step?: number;
  prefix?: string;
  suffix?: string;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
}) {
  const [text, setText] = useState<string>(value === emptyValue ? "" : String(value));

  // Keep in sync when the external value changes from elsewhere (e.g. reset),
  // but don't clobber what the user is mid-typing if it already parses equal.
  useEffect(() => {
    const parsed = text.trim() === "" ? emptyValue : Number(text);
    if (parsed !== value) {
      setText(value === emptyValue && text.trim() === "" ? "" : String(value));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  function commit(next: string) {
    setText(next);
    if (next.trim() === "") {
      onChange(emptyValue);
      return;
    }
    let n = Number(next);
    if (!Number.isFinite(n)) return;
    if (min != null && n < min) n = min;
    if (max != null && n > max) n = max;
    onChange(n);
  }

  return (
    <div className="relative">
      {prefix && (
        <span className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3 text-sm text-slate-400">
          {prefix}
        </span>
      )}
      <input
        type="number"
        inputMode="decimal"
        value={text}
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        placeholder={placeholder}
        onChange={(e) => commit(e.target.value)}
        onFocus={(e) => e.target.select()}
        onBlur={() => {
          if (text.trim() === "") return;
          setText(String(Number(text)));
        }}
        className={classNames(
          baseField,
          prefix && "pl-7",
          suffix && "pr-9",
          className,
        )}
      />
      {suffix && (
        <span className="pointer-events-none absolute inset-y-0 right-0 flex items-center pr-3 text-sm text-slate-400">
          {suffix}
        </span>
      )}
    </div>
  );
}
