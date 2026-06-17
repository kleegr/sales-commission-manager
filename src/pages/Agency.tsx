// ============================================================================
// AGENCY / SUPER ADMIN VIEW
//
// The agency-level overview that sits ABOVE the individual sub-accounts
// (GoHighLevel locations). It reads the public /api/tenants + /api/health
// endpoints, which report each tenant and its row counts WITHOUT exposing one
// tenant's records to another — so this rolls up high-level stats while the
// strict per-tenant data isolation stays intact.
//
// In review mode, "Open workspace" switches the active sub-account + drops you
// into its admin product. The GoHighLevel connection card is a foundation
// placeholder for the future OAuth/location-install phase.
// ============================================================================

import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Network,
  Building2,
  Users,
  ScrollText,
  CreditCard,
  ArrowRight,
  Plug,
  CheckCircle2,
  Loader2,
} from "lucide-react";
import {
  PageHeader,
  Card,
  StatCard,
  SectionTitle,
  Button,
  Badge,
  EmptyState,
} from "../components/ui";
import { useAuth } from "../store/AuthContext";
import { formatNumber } from "../lib/format";

interface TenantHealth {
  slug: string;
  name: string;
  ghlLocationId: string | null;
  counts: Record<string, number>;
}

export default function Agency() {
  const { demo, setDemo } = useAuth();
  const navigate = useNavigate();
  const [tenants, setTenants] = useState<TenantHealth[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [opening, setOpening] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/health", { headers: { accept: "application/json" } });
        const body = await res.json();
        if (cancelled) return;
        if (Array.isArray(body?.tenants)) {
          setTenants(
            body.tenants.map((t: any) => ({
              slug: t.slug,
              name: t.name,
              ghlLocationId: t.ghlLocationId ?? null,
              counts: t.counts ?? {},
            })),
          );
        } else {
          setError("Could not load sub-accounts.");
        }
      } catch {
        if (!cancelled) setError("Could not reach the server.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const totals = useMemo(() => {
    const t = { salespeople: 0, clients: 0, plans: 0, payments: 0 };
    for (const x of tenants ?? []) {
      t.salespeople += x.counts.salespeople ?? 0;
      t.clients += x.counts.clients ?? 0;
      t.plans += x.counts.commission_plans ?? 0;
      t.payments += x.counts.payments ?? 0;
    }
    return t;
  }, [tenants]);

  async function openWorkspace(slug: string) {
    setOpening(slug);
    if (demo) {
      await setDemo(slug, "admin");
      setOpening(null);
      navigate("/");
    } else {
      setOpening(null);
    }
  }

  return (
    <div>
      <PageHeader
        title="Agency Control"
        subtitle="All GoHighLevel sub-accounts that use the Commission Manager, in one place"
      />

      <div className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Sub-accounts"
          value={tenants ? tenants.length : "—"}
          icon={<Network className="h-5 w-5" />}
          tone="indigo"
        />
        <StatCard
          label="People (all accounts)"
          value={tenants ? formatNumber(totals.salespeople) : "—"}
          icon={<Users className="h-5 w-5" />}
          tone="blue"
        />
        <StatCard
          label="Clients (all accounts)"
          value={tenants ? formatNumber(totals.clients) : "—"}
          icon={<Building2 className="h-5 w-5" />}
          tone="green"
        />
        <StatCard
          label="Commission plans"
          value={tenants ? formatNumber(totals.plans) : "—"}
          icon={<ScrollText className="h-5 w-5" />}
          tone="violet"
        />
      </div>

      <SectionTitle>Sub-accounts</SectionTitle>
      {error ? (
        <EmptyState icon={<Network className="h-6 w-6" />} title="Couldn't load sub-accounts" description={error} />
      ) : !tenants ? (
        <Card className="flex items-center justify-center py-10 text-slate-400">
          <Loader2 className="mr-2 h-5 w-5 animate-spin" /> Loading sub-accounts…
        </Card>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {tenants.map((t) => (
            <Card key={t.slug} className="flex flex-col gap-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <h3 className="truncate text-base font-semibold text-slate-900 dark:text-white">{t.name}</h3>
                    <Badge tone="green">
                      <CheckCircle2 className="h-3 w-3" /> App enabled
                    </Badge>
                  </div>
                  <p className="mt-0.5 text-xs text-slate-400">
                    Tenant <span className="font-mono">{t.slug}</span>
                    {t.ghlLocationId && (
                      <>
                        {" · "}GHL location <span className="font-mono">{t.ghlLocationId}</span>
                      </>
                    )}
                  </p>
                </div>
                <Button size="sm" onClick={() => void openWorkspace(t.slug)} disabled={opening === t.slug}>
                  {opening === t.slug ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowRight className="h-4 w-4" />}
                  Open workspace
                </Button>
              </div>

              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <MiniStat icon={<Users className="h-3.5 w-3.5" />} label="People" value={t.counts.salespeople ?? 0} />
                <MiniStat icon={<Building2 className="h-3.5 w-3.5" />} label="Clients" value={t.counts.clients ?? 0} />
                <MiniStat icon={<ScrollText className="h-3.5 w-3.5" />} label="Plans" value={t.counts.commission_plans ?? 0} />
                <MiniStat icon={<CreditCard className="h-3.5 w-3.5" />} label="Payments" value={t.counts.payments ?? 0} />
              </div>
            </Card>
          ))}
        </div>
      )}

      <div className="mt-6">
        <SectionTitle>Integrations</SectionTitle>
        <Card className="flex flex-col items-start gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-3">
            <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-slate-100 text-slate-400 dark:bg-slate-800">
              <Plug className="h-5 w-5" />
            </span>
            <div>
              <p className="text-sm font-semibold text-slate-900 dark:text-white">Connect GoHighLevel</p>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                Choose which GHL locations can use this app. OAuth install + webhook sync arrive in the next phase.
              </p>
            </div>
          </div>
          <Badge tone="amber">Coming soon</Badge>
        </Card>
      </div>
    </div>
  );
}

function MiniStat({ icon, label, value }: { icon: React.ReactNode; label: string; value: number }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 dark:border-slate-800 dark:bg-slate-800/40">
      <div className="flex items-center gap-1 text-[11px] font-medium uppercase tracking-wide text-slate-400">
        {icon} {label}
      </div>
      <p className="mt-0.5 text-lg font-semibold tabular-nums text-slate-900 dark:text-white">{formatNumber(value)}</p>
    </div>
  );
}
