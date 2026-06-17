import { useEffect, useRef, useState } from "react";
import {
  SlidersHorizontal,
  Download,
  Upload,
  RotateCcw,
  Database,
  Sun,
  Moon,
  Server,
  HardDrive,
  CheckCircle2,
  AlertTriangle,
  Building2,
  RefreshCw,
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
        {/* Data source & tenant (multi-tenant / GoHighLevel sub-account) */}
        <WorkspacePanel />

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
            Active store: <span className="font-medium">{storeName}</span>. Export to
            back up the current tenant's data or move it between environments.
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

// ---------------------------------------------------------------------------
// Data source & tenant panel
//
// Talks to the serverless API to show whether the app is actually backed by
// Neon Postgres, and lets you switch the active GoHighLevel sub-account /
// tenant. The per-tenant row counts are live proof that each location's data
// is isolated.
// ---------------------------------------------------------------------------

interface TenantReport {
  slug: string;
  name: string;
  ghlLocationId: string | null;
  counts?: Record<string, number>;
  status?: string;
}
interface HealthResponse {
  ok: boolean;
  database: {
    configured: boolean;
    envVar?: string;
    engine?: string;
    seededOnThisRequest?: boolean;
  };
  tenantCount?: number;
  tenants?: TenantReport[];
  message?: string;
  error?: string;
}

function WorkspacePanel() {
  const { backend, tenant, switchTenant } = useApp();
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [switching, setSwitching] = useState<string | null>(null);

  async function refresh() {
    setLoading(true);
    try {
      const res = await fetch("/api/health", { headers: { accept: "application/json" } });
      const ct = res.headers.get("content-type") || "";
      if (ct.includes("application/json")) {
        setHealth((await res.json()) as HealthResponse);
      } else {
        setHealth(null);
      }
    } catch {
      setHealth(null);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  async function onSwitch(slug: string) {
    if (slug === tenant) return;
    setSwitching(slug);
    try {
      await switchTenant(slug);
    } finally {
      setSwitching(null);
    }
  }

  const onNeon = backend === "neon" && health?.database.configured;
  const dbConfigured = health?.database.configured ?? false;
  const tenants = health?.tenants ?? [];

  return (
    <Card className="space-y-4">
      <SectionTitle right={<Server className="h-4 w-4 text-slate-400" />}>
        Data source &amp; workspace
      </SectionTitle>

      {/* Connection status */}
      <div className="flex items-start gap-3 rounded-lg border border-slate-200 p-3 dark:border-slate-800">
        <span
          className={
            "mt-0.5 flex h-8 w-8 flex-none items-center justify-center rounded-lg " +
            (onNeon
              ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-400"
              : "bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-400")
          }
        >
          {onNeon ? <Database className="h-4 w-4" /> : <HardDrive className="h-4 w-4" />}
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-slate-900 dark:text-white">
            {loading
              ? "Checking database…"
              : onNeon
                ? "Connected to Neon Postgres"
                : "Using browser storage (local fallback)"}
          </p>
          <p className="mt-0.5 text-xs text-slate-500">
            {loading ? (
              "Contacting /api/health"
            ) : onNeon ? (
              <>
                {health?.database.engine ?? "PostgreSQL"} · connection from{" "}
                <code className="rounded bg-slate-100 px-1 dark:bg-slate-800">
                  {health?.database.envVar}
                </code>
              </>
            ) : dbConfigured ? (
              "The API reported a database error — see the handoff notes."
            ) : (
              "No DATABASE_URL is visible to the deployment. Add the Neon string in Vercel and redeploy."
            )}
          </p>
        </div>
        <Button variant="ghost" onClick={() => void refresh()} title="Re-check">
          <RefreshCw className={"h-4 w-4 " + (loading ? "animate-spin" : "")} />
        </Button>
      </div>

      {/* Tenant switcher + per-tenant proof of isolation */}
      {onNeon && tenants.length > 0 && (
        <div className="space-y-3">
          <p className="text-sm text-slate-500">
            This app is multi-tenant. Each GoHighLevel sub-account / location has its own
            isolated data. Switch the active tenant to load a different location's records.
          </p>
          <div className="space-y-2">
            {tenants.map((t) => {
              const active = t.slug === tenant;
              return (
                <div
                  key={t.slug}
                  className={
                    "flex flex-wrap items-center gap-3 rounded-lg border p-3 " +
                    (active
                      ? "border-brand-300 bg-brand-50/60 dark:border-brand-500/40 dark:bg-brand-500/10"
                      : "border-slate-200 dark:border-slate-800")
                  }
                >
                  <span className="flex h-8 w-8 flex-none items-center justify-center rounded-lg bg-slate-100 text-slate-500 dark:bg-slate-800">
                    <Building2 className="h-4 w-4" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="flex items-center gap-2 truncate text-sm font-medium text-slate-900 dark:text-white">
                      {t.name}
                      {active && (
                        <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-medium text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-400">
                          <CheckCircle2 className="h-3 w-3" /> active
                        </span>
                      )}
                    </p>
                    <p className="truncate text-xs text-slate-500">
                      <code className="rounded bg-slate-100 px-1 dark:bg-slate-800">{t.slug}</code>
                      {t.ghlLocationId ? ` · GHL ${t.ghlLocationId}` : ""}
                      {t.counts
                        ? ` · ${t.counts.salespeople ?? 0} people, ${t.counts.clients ?? 0} clients, ${t.counts.payments ?? 0} payments`
                        : ""}
                    </p>
                  </div>
                  <Button
                    variant={active ? "secondary" : "primary"}
                    disabled={active || switching !== null}
                    onClick={() => void onSwitch(t.slug)}
                  >
                    {switching === t.slug ? "Switching…" : active ? "Current" : "Switch"}
                  </Button>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {!loading && !onNeon && (
        <div className="flex items-start gap-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-700 dark:bg-amber-500/10 dark:text-amber-300">
          <AlertTriangle className="mt-0.5 h-4 w-4 flex-none" />
          <span>
            Running in local-only mode. Your edits are saved in this browser. Once Neon is
            reachable from the deployment, the app automatically reads and writes Postgres.
          </span>
        </div>
      )}
    </Card>
  );
}
