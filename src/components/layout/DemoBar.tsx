// ============================================================================
// DEMO / REVIEW BAR
//
// Sticky top bar shown ONLY when the server is in review mode (no login
// required). Lets a reviewer instantly switch the active sub-account (tenant)
// and the role they are "viewing as", so every portal can be seen without
// credentials. Selections are persisted as cookies and the session is
// re-resolved on the server (see AuthContext.setDemo + api/_lib/auth.ts).
// ============================================================================

import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Eye, Building2, ChevronDown, Loader2 } from "lucide-react";
import { useAuth } from "../../store/AuthContext";
import type { Role } from "../../lib/roles";
import { classNames } from "../../lib/format";

interface TenantOpt {
  slug: string;
  name: string;
}

interface Preset {
  key: string;
  label: string;
  role: Role;
  landing: string;
}

// The five reviewer personas, mapped to a server role + landing screen.
const PRESETS: Preset[] = [
  { key: "agency", label: "Agency Owner / Super Admin", role: "owner", landing: "/agency" },
  { key: "admin", label: "Sub-account Admin", role: "admin", landing: "/" },
  { key: "manager", label: "Sales Manager", role: "sales_manager", landing: "/" },
  { key: "salesperson", label: "Salesperson", role: "salesperson", landing: "/portal" },
  { key: "affiliate", label: "Affiliate / Partner", role: "affiliate", landing: "/portal" },
];

const FALLBACK_TENANTS: TenantOpt[] = [
  { slug: "demo", name: "Northwind Agency — Demo" },
  { slug: "acme", name: "Acme Partners" },
];

export function DemoBar() {
  const { user, demo, setDemo } = useAuth();
  const navigate = useNavigate();
  const [tenants, setTenants] = useState<TenantOpt[]>(FALLBACK_TENANTS);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/tenants", { headers: { accept: "application/json" } });
        const body = await res.json();
        if (!cancelled && Array.isArray(body?.tenants) && body.tenants.length) {
          setTenants(body.tenants.map((t: any) => ({ slug: t.slug, name: t.name })));
        }
      } catch {
        /* keep fallback */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (!demo) return null;

  const currentTenant = user?.tenantSlug ?? "demo";
  // Highlight the preset whose role matches (partner shares the affiliate tile).
  const activeRole = user?.role ?? "owner";
  const activeKey =
    PRESETS.find((p) => p.role === activeRole)?.key ??
    (activeRole === "partner" ? "affiliate" : "agency");

  async function choose(p: Preset) {
    setBusy(p.key);
    await setDemo(currentTenant, p.role);
    setBusy(null);
    navigate(p.landing);
  }

  async function switchTenant(slug: string) {
    setBusy("tenant");
    const preset = PRESETS.find((p) => p.key === activeKey) ?? PRESETS[0];
    await setDemo(slug, preset.role);
    setBusy(null);
    navigate(preset.landing);
  }

  return (
    <div className="sticky top-0 z-40 border-b border-indigo-200 bg-gradient-to-r from-indigo-50 via-white to-amber-50 dark:border-indigo-900/60 dark:from-indigo-950 dark:via-slate-950 dark:to-slate-950">
      <div className="mx-auto flex max-w-[1600px] flex-col gap-2 px-4 py-2 lg:flex-row lg:items-center lg:gap-4 lg:px-8">
        <div className="flex items-center gap-2">
          <span className="inline-flex items-center gap-1.5 rounded-full bg-indigo-600 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide text-white shadow-sm">
            <Eye className="h-3.5 w-3.5" /> Review Mode
          </span>
          <span className="hidden text-xs text-slate-500 dark:text-slate-400 sm:inline">
            No login required — switch tenant &amp; role to preview each portal
          </span>
        </div>

        {/* Tenant switcher */}
        <div className="flex items-center gap-2">
          <span className="text-[11px] font-medium uppercase tracking-wide text-slate-400">Tenant</span>
          <div className="relative">
            <Building2 className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
            <select
              value={currentTenant}
              disabled={busy !== null}
              onChange={(e) => void switchTenant(e.target.value)}
              className="appearance-none rounded-lg border border-slate-300 bg-white py-1.5 pl-8 pr-7 text-xs font-medium text-slate-800 shadow-sm focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/30 disabled:opacity-60 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
            >
              {tenants.map((t) => (
                <option key={t.slug} value={t.slug}>
                  {t.name}
                </option>
              ))}
            </select>
            <ChevronDown className="pointer-events-none absolute right-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
          </div>
        </div>

        {/* Role switcher */}
        <div className="flex flex-1 flex-wrap items-center gap-1.5">
          <span className="text-[11px] font-medium uppercase tracking-wide text-slate-400">Viewing as</span>
          {PRESETS.map((p) => {
            const active = p.key === activeKey;
            return (
              <button
                key={p.key}
                type="button"
                disabled={busy !== null}
                onClick={() => void choose(p)}
                className={classNames(
                  "inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-medium transition disabled:opacity-60",
                  active
                    ? "border-indigo-500 bg-indigo-600 text-white shadow-sm"
                    : "border-slate-300 bg-white text-slate-700 hover:border-indigo-400 hover:bg-indigo-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800",
                )}
              >
                {busy === p.key && <Loader2 className="h-3 w-3 animate-spin" />}
                {p.label}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
