import { useRef, useState } from "react";
import {
  SlidersHorizontal,
  Download,
  Upload,
  RotateCcw,
  Database,
  Sun,
  Moon,
} from "lucide-react";
import { useApp } from "../store/AppContext";
import type { AppData, ProjectionAssumptions } from "../types";
import {
  PageHeader,
  Button,
  Card,
  SectionTitle,
  Field,
  Input,
  NumberField,
} from "../components/ui";
import { ConfirmModal } from "../components/ui/Modal";
import { downloadJSON } from "../lib/export";

export default function Settings() {
  const { data, dispatch, storeName } = useApp();
  const fileRef = useRef<HTMLInputElement>(null);
  const [resetOpen, setResetOpen] = useState(false);
  const [importMsg, setImportMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const a = data.settings.assumptions;
  const setAssumptions = (patch: Partial<ProjectionAssumptions>) =>
    dispatch({ type: "SET_ASSUMPTIONS", assumptions: { ...a, ...patch } });

  function exportJSON() {
    downloadJSON("commission-data.json", data);
  }

  function onImportFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(String(reader.result)) as AppData;
        if (!parsed || !Array.isArray(parsed.salespeople) || !Array.isArray(parsed.plans)) {
          throw new Error("missing expected fields");
        }
        dispatch({ type: "IMPORT", data: parsed });
        setImportMsg({ ok: true, text: "Data imported and commissions recalculated." });
      } catch (err) {
        setImportMsg({
          ok: false,
          text: "Couldn't import that file — it doesn't look like a valid export.",
        });
      }
    };
    reader.readAsText(file);
    e.target.value = "";
  }

  return (
    <div className="max-w-3xl">
      <PageHeader title="Settings" subtitle="Company details, projection defaults, and your data" />

      <div className="space-y-6">
        {/* Company + theme */}
        <Card className="space-y-4">
          <SectionTitle>General</SectionTitle>
          <Field label="Company name" hint="Shown in the sidebar and on the recruiting view.">
            <Input
              value={data.settings.companyName}
              onChange={(e) => dispatch({ type: "SET_COMPANY", name: e.target.value })}
              placeholder="Your company"
            />
          </Field>
          <Field label="Theme">
            <div className="flex gap-2">
              <Button
                variant={data.settings.theme === "light" ? "primary" : "secondary"}
                onClick={() => dispatch({ type: "SET_THEME", theme: "light" })}
              >
                <Sun className="h-4 w-4" /> Light
              </Button>
              <Button
                variant={data.settings.theme === "dark" ? "primary" : "secondary"}
                onClick={() => dispatch({ type: "SET_THEME", theme: "dark" })}
              >
                <Moon className="h-4 w-4" /> Dark
              </Button>
            </div>
          </Field>
        </Card>

        {/* Projection defaults */}
        <Card className="space-y-4">
          <SectionTitle right={<SlidersHorizontal className="h-4 w-4 text-slate-400" />}>
            Default projection assumptions
          </SectionTitle>
          <p className="text-sm text-slate-500">
            These seed every projection and the recruiting view. Each projection can still be
            adjusted on its own.
          </p>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Average setup fee">
              <NumberField
                value={a.avgSetupFee}
                onChange={(v) => setAssumptions({ avgSetupFee: v })}
                prefix="$"
                min={0}
              />
            </Field>
            <Field label="Average monthly subscription">
              <NumberField
                value={a.avgMonthly}
                onChange={(v) => setAssumptions({ avgMonthly: v })}
                prefix="$"
                min={0}
              />
            </Field>
            <Field label="Closings per month">
              <NumberField
                value={a.closingsPerMonth}
                onChange={(v) => setAssumptions({ closingsPerMonth: v })}
                min={0}
              />
            </Field>
            <Field label="Monthly churn">
              <NumberField
                value={a.monthlyChurnPct}
                onChange={(v) => setAssumptions({ monthlyChurnPct: v })}
                suffix="%"
                min={0}
                max={100}
              />
            </Field>
            <Field label="Projection horizon" hint="Months (max 60).">
              <NumberField
                value={a.months}
                onChange={(v) => setAssumptions({ months: Math.round(v) })}
                suffix="mo"
                min={1}
                max={60}
              />
            </Field>
          </div>
        </Card>

        {/* Data */}
        <Card className="space-y-4">
          <SectionTitle right={<Database className="h-4 w-4 text-slate-400" />}>Data</SectionTitle>
          <p className="text-sm text-slate-500">
            All data lives in your browser via <span className="font-medium">{storeName}</span>.
            Nothing is sent to a server. Export to back it up or move it between browsers.
          </p>

          {importMsg && (
            <p
              className={
                "rounded-lg px-3 py-2 text-sm " +
                (importMsg.ok
                  ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300"
                  : "bg-rose-50 text-rose-700 dark:bg-rose-500/10 dark:text-rose-300")
              }
            >
              {importMsg.text}
            </p>
          )}

          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" onClick={exportJSON}>
              <Download className="h-4 w-4" /> Export JSON
            </Button>
            <Button variant="secondary" onClick={() => fileRef.current?.click()}>
              <Upload className="h-4 w-4" /> Import JSON
            </Button>
            <input
              ref={fileRef}
              type="file"
              accept="application/json,.json"
              className="hidden"
              onChange={onImportFile}
            />
            <Button variant="ghost" className="text-rose-500" onClick={() => setResetOpen(true)}>
              <RotateCcw className="h-4 w-4" /> Reset to demo data
            </Button>
          </div>

          <div className="grid grid-cols-2 gap-3 border-t border-slate-100 pt-4 text-sm dark:border-slate-800 sm:grid-cols-4">
            <Stat label="People" value={data.salespeople.length} />
            <Stat label="Plans" value={data.plans.length} />
            <Stat label="Clients" value={data.clients.length} />
            <Stat label="Payments" value={data.payments.length} />
          </div>
        </Card>
      </div>

      <ConfirmModal
        open={resetOpen}
        onClose={() => setResetOpen(false)}
        onConfirm={() => {
          dispatch({ type: "RESET_DEMO" });
          setImportMsg({ ok: true, text: "Reset to demo data." });
        }}
        title="Reset to demo data?"
        message="This replaces all current data with the built-in demo set. This cannot be undone."
        confirmLabel="Reset"
      />
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <p className="text-xs text-slate-500">{label}</p>
      <p className="text-lg font-semibold text-slate-900 dark:text-white">{value}</p>
    </div>
  );
}
