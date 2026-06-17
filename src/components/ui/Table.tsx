import type { ReactNode, ThHTMLAttributes, TdHTMLAttributes } from "react";
import { classNames } from "../../lib/format";

export function Table({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className="overflow-x-auto">
      <table className={classNames("w-full border-collapse text-sm", className)}>
        {children}
      </table>
    </div>
  );
}

export function THead({ children }: { children: ReactNode }) {
  return (
    <thead className="border-b border-slate-200 text-left dark:border-slate-800">
      {children}
    </thead>
  );
}

export function TBody({ children }: { children: ReactNode }) {
  return (
    <tbody className="divide-y divide-slate-100 dark:divide-slate-800/70">
      {children}
    </tbody>
  );
}

export function TR({
  children,
  className,
  onClick,
}: {
  children: ReactNode;
  className?: string;
  onClick?: () => void;
}) {
  return (
    <tr
      onClick={onClick}
      className={classNames(
        onClick && "cursor-pointer",
        "transition hover:bg-slate-50 dark:hover:bg-slate-800/40",
        className,
      )}
    >
      {children}
    </tr>
  );
}

export function TH({
  children,
  className,
  ...rest
}: ThHTMLAttributes<HTMLTableCellElement> & { children?: ReactNode }) {
  return (
    <th
      {...rest}
      className={classNames(
        "whitespace-nowrap px-3 py-2.5 text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400",
        className,
      )}
    >
      {children}
    </th>
  );
}

export function TD({
  children,
  className,
  ...rest
}: TdHTMLAttributes<HTMLTableCellElement> & { children?: ReactNode }) {
  return (
    <td
      {...rest}
      className={classNames(
        "px-3 py-2.5 align-middle text-slate-700 dark:text-slate-200",
        className,
      )}
    >
      {children}
    </td>
  );
}
