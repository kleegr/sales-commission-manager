import { useApp } from "../../store/AppContext";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { formatCurrency } from "../../lib/format";

function useChartTheme() {
  const { data } = useApp();
  const dark = data.settings.theme === "dark";
  return {
    grid: dark ? "#1e293b" : "#e2e8f0",
    axis: dark ? "#94a3b8" : "#64748b",
    tooltipBg: dark ? "#0f172a" : "#ffffff",
    tooltipBorder: dark ? "#334155" : "#e2e8f0",
    text: dark ? "#e2e8f0" : "#0f172a",
  };
}

const money = (v: number) => formatCurrency(v);
const compact = (v: number) =>
  v >= 1000 ? `$${(v / 1000).toFixed(0)}k` : `$${v.toFixed(0)}`;

function tooltipStyle(t: ReturnType<typeof useChartTheme>) {
  return {
    contentStyle: {
      background: t.tooltipBg,
      border: `1px solid ${t.tooltipBorder}`,
      borderRadius: 10,
      fontSize: 12,
      color: t.text,
    },
    labelStyle: { color: t.text, fontWeight: 600 },
    itemStyle: { color: t.text },
  };
}

export interface SeriesDef {
  key: string;
  name: string;
  color: string;
}

export function MoneyBarChart({
  data,
  xKey,
  series,
  height = 280,
  stacked,
}: {
  data: Record<string, unknown>[];
  xKey: string;
  series: SeriesDef[];
  height?: number;
  stacked?: boolean;
}) {
  const t = useChartTheme();
  const ts = tooltipStyle(t);
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke={t.grid} vertical={false} />
        <XAxis dataKey={xKey} tick={{ fill: t.axis, fontSize: 12 }} tickLine={false} axisLine={{ stroke: t.grid }} />
        <YAxis tickFormatter={compact} tick={{ fill: t.axis, fontSize: 12 }} tickLine={false} axisLine={false} width={48} />
        <Tooltip formatter={(v: number) => money(v)} {...ts} cursor={{ fill: t.grid, opacity: 0.3 }} />
        {series.length > 1 && <Legend wrapperStyle={{ fontSize: 12, color: t.text }} />}
        {series.map((s) => (
          <Bar
            key={s.key}
            dataKey={s.key}
            name={s.name}
            fill={s.color}
            radius={[4, 4, 0, 0]}
            stackId={stacked ? "a" : undefined}
            maxBarSize={48}
          />
        ))}
      </BarChart>
    </ResponsiveContainer>
  );
}

export function CategoryBarChart({
  data,
  xKey,
  dataKey,
  colors,
  height = 280,
}: {
  data: Record<string, unknown>[];
  xKey: string;
  dataKey: string;
  colors: string[];
  height?: number;
}) {
  const t = useChartTheme();
  const ts = tooltipStyle(t);
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke={t.grid} vertical={false} />
        <XAxis dataKey={xKey} tick={{ fill: t.axis, fontSize: 12 }} tickLine={false} axisLine={{ stroke: t.grid }} />
        <YAxis tickFormatter={compact} tick={{ fill: t.axis, fontSize: 12 }} tickLine={false} axisLine={false} width={48} />
        <Tooltip formatter={(v: number) => money(v)} {...ts} cursor={{ fill: t.grid, opacity: 0.3 }} />
        <Bar dataKey={dataKey} radius={[4, 4, 0, 0]} maxBarSize={56}>
          {data.map((_, i) => (
            <Cell key={i} fill={colors[i % colors.length]} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

export function MoneyAreaChart({
  data,
  xKey,
  series,
  height = 280,
}: {
  data: Record<string, unknown>[];
  xKey: string;
  series: SeriesDef[];
  height?: number;
}) {
  const t = useChartTheme();
  const ts = tooltipStyle(t);
  return (
    <ResponsiveContainer width="100%" height={height}>
      <AreaChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
        <defs>
          {series.map((s) => (
            <linearGradient key={s.key} id={`grad-${s.key}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor={s.color} stopOpacity={0.35} />
              <stop offset="95%" stopColor={s.color} stopOpacity={0} />
            </linearGradient>
          ))}
        </defs>
        <CartesianGrid strokeDasharray="3 3" stroke={t.grid} vertical={false} />
        <XAxis dataKey={xKey} tick={{ fill: t.axis, fontSize: 12 }} tickLine={false} axisLine={{ stroke: t.grid }} />
        <YAxis tickFormatter={compact} tick={{ fill: t.axis, fontSize: 12 }} tickLine={false} axisLine={false} width={48} />
        <Tooltip formatter={(v: number) => money(v)} {...ts} />
        {series.length > 1 && <Legend wrapperStyle={{ fontSize: 12, color: t.text }} />}
        {series.map((s) => (
          <Area
            key={s.key}
            type="monotone"
            dataKey={s.key}
            name={s.name}
            stroke={s.color}
            strokeWidth={2}
            fill={`url(#grad-${s.key})`}
          />
        ))}
      </AreaChart>
    </ResponsiveContainer>
  );
}

export function MoneyLineChart({
  data,
  xKey,
  series,
  height = 280,
}: {
  data: Record<string, unknown>[];
  xKey: string;
  series: SeriesDef[];
  height?: number;
}) {
  const t = useChartTheme();
  const ts = tooltipStyle(t);
  return (
    <ResponsiveContainer width="100%" height={height}>
      <LineChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke={t.grid} vertical={false} />
        <XAxis dataKey={xKey} tick={{ fill: t.axis, fontSize: 12 }} tickLine={false} axisLine={{ stroke: t.grid }} />
        <YAxis tickFormatter={compact} tick={{ fill: t.axis, fontSize: 12 }} tickLine={false} axisLine={false} width={48} />
        <Tooltip formatter={(v: number) => money(v)} {...ts} />
        {series.length > 1 && <Legend wrapperStyle={{ fontSize: 12, color: t.text }} />}
        {series.map((s) => (
          <Line
            key={s.key}
            type="monotone"
            dataKey={s.key}
            name={s.name}
            stroke={s.color}
            strokeWidth={2}
            dot={false}
          />
        ))}
      </LineChart>
    </ResponsiveContainer>
  );
}
