// ============================================================================
// AGENCY / SUPER ADMIN VIEW
//
// The agency-level overview that sits ABOVE the individual sub-accounts
// (GoHighLevel locations). It reads /api/agency — an access-controlled rollup
// that spans every sub-account in review mode (and just the caller's own tenant
// under real auth), aggregated server-side from the persisted data so one
// tenant's records are never exposed to another.
//
// What it makes obvious: the app is built for MANY sub-accounts; the agency
// owner sees across them (revenue, commission liability vs paid, payouts,
// documents, feature access, last activity); and each sub-account is its own
// isolated workspace you can open. "Open workspace" switches the active
// sub-account and drops into its admin product. The GoHighLevel card + the
// per-tenant location id are foundation placeholders for the future OAuth phase.
//
// Degrades gracefully: if /api/agency is unavailable (no database, or the
// local-storage fallback backend) it falls back to the public /api/health
// counts so the page still renders.
// ============================================================================

import { useEffect, useState } from "react";
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
  DollarSign,
  Coins,
  Wallet,
  FileText,
  AlertTriangle,
  MapPin,
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
import {
  getAgencyOverview,
  type AgencyOverview,
  type AgencyTenantRollup,
} from "../lib/resource-client";
import { FEATURES, type FeatureKey } from "../lib/features";
import { formatCurrency, formatNumber, formatDate } from "../lib/format";

const FEATURE_LABEL: Record<string, string> = Object.fromEntries(
  FEATURES.map((f) => [f.key, f.label]),
);

interface HealthTenant {
  slug: string;
  name: string;
  ghlLocationId: string | null;
  counts: Record<string, number>;
}

function timeAgo(iso: string | null): string {
  if (!iso) return "No activity yet";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "—";
  const m = Math.floor((Date.now() - then) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  return formatDate(iso.slice(0, 10));
}

export default function Agency() {
  const { demo, setDemo } = useAuth();
  const navigate = useNavigate();
  const [overview, setOverview] = useState<AgencyOverview | null>(null);
  const [fallback, setFallback] = useState<HealthTenant[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [opening, setOpening] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await getAgencyOverview();
        if (!cancelled) setOverview(data);
      } catch {
        // Fall back to the public counts-only health endpoint.
        try {
          const res = await fetch("/api/health", { headers: { accept: "application/json" } });
          const body = await res.json();
          if (cancelled) return;
          if (Array.isArray(body?.tenants)) {
            setFallback(
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
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

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

  // ---- error / loading ----------------------------------------------------
  if (error) {
    return (
      <div>
        <PageHeader title="Agency Control" subtitle="All sub-accounts that use the Commission Manager" />
        <EmptyState icon={<Network className="h-6 w-6" />} title="Couldn't load sub-accounts" description={error} />
      </div>
    );
  }

  if (!overview && !fallback) {
    return (
      <div>
        <PageHeader title="Agency Control" subtitle="All sub-accounts that use the Commission Manager" />
        <Card className="flex items-center justify-center py-10 text-slate-400">
          <Loader2 className="mr-2 h-5 w-5 animate-spin" /> Loading sub-accounts…
        </Card>
      </div>
    );
  }

  // ---- degraded (counts-only) fallback ------------------------------------
  if (!overview && fallback) {
    return (
      <div>
        <PageHeader title="Agency Control" subtitle="All sub-accounts that use the Commission Manager" />
        <div className="mb-5 flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:border-amber-900/50 dark:bg-amber-950/40 dark:text-amber-200">
          <AlertTriangle className="mt-0.5 h-4 w-4 flex-none" />
          <span>Showing limited data (counts only). Full agency rollups need the database-backed API and review mode.</span>
        </div>
        <SectionTitle>Sub-accounts</SectionTitle>
        <div className="grid gap-4 lg:grid-cols-2">
          {fallback.map((t) => (
            <Card key={t.slug} className="flex flex-col gap-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <h3 className="truncate text-base font-semibold text-slate-900 dark:text-white">{t.name}</h3>
                  <p className="mt-0.5 text-xs text-slate-400">
                    Tenant <span className="font-mono">{t.slug}</span>
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
        <IntegrationsCard />
      </div>
    );
  }

  // ---- full rollup --------------------------------------------------------
  const data = overview!;
  const agencyScope = data.scope === "agency";
  const s = data.summary;
  const maxRevenue = Math.max(1, ...data.tenants.map((t) => t.revenue.net));

  return (
    <div>
      <PageHeader
        title="Agency Control"
        subtitle={
          agencyScope
            ? "Every GoHighLevel sub-account that uses the Commission Manager, in one place"
            : "Your sub-account overview"
        }
        actions={
          <Badge tone={agencyScope ? "indigo" : "slate"}>
            <Network className="h-3 w-3" />
            {agencyScope ? "Agency view · all sub-accounts" : "Single sub-account"}
          </Badge>
        }
      />

      {/* Cross-tenant summary */}
      <div className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
        <StatCard
          label="Sub-accounts"
          value={s.tenantCount}
          sub={`${s.activeTenants} active`}
          icon={<Network className="h-5 w-5" />}
          tone="indigo"
        />
        <StatCard
          label="Revenue (net)"
          value={formatCurrency(s.totalRevenue)}
          sub="All sub-accounts"
          icon={<DollarSign className="h-5 w-5" />}
          tone="green"
        />
        <StatCard
          label="Commission liability"
          value={formatCurrency(s.totalCommissionLiability)}
          sub="Owed, not yet paid"
          icon={<Coins className="h-5 w-5" />}
          tone="amber"
        />
        <StatCard
          label="Commissions paid"
          value={formatCurrency(s.totalCommissionsPaid)}
          icon={<Wallet className="h-5 w-5" />}
          tone="blue"
        />
        <StatCard
          label="People"
          value={formatNumber(s.totalSalespeople)}
          icon={<Users className="h-5 w-5" />}
          tone="violet"
        />
        <StatCard
          label="Clients"
          value={formatNumber(s.totalClients)}
          icon={<Building2 className="h-5 w-5" />}
          tone="blue"
        />
      </div>

      {/* Sub-account comparison */}
      {agencyScope && data.tenants.length > 1 && (
        <div className="mb-6">
          <SectionTitle>Sub-account comparison</SectionTitle>
          <Card>
            <p className="mb-3 text-xs font-medium uppercase tracking-wide text-slate-400">Revenue by sub-account</p>
            <div className="space-y-3">
              {data.tenants.map((t) => (
                <div key={t.slug} className="flex items-center gap-3">
                  <div className="w-36 flex-none truncate text-sm font-medium text-slate-700 dark:text-slate-200">{t.name}</div>
                  <div className="h-2.5 flex-1 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800">
                    <div
                      className="h-full rounded-full bg-brand-500"
                      style={{ width: `${Math.round((t.revenue.net / maxRevenue) * 100)}%` }}
                    />
                  </div>
                  <div className="w-28 flex-none text-right text-sm tabular-nums text-slate-600 dark:text-slate-300">
                    {formatCurrency(t.revenue.net)}
                  </div>
                  <div className="hidden w-32 flex-none text-right text-xs tabular-nums text-amber-600 dark:text-amber-400 sm:block">
                    {formatCurrency(t.commissions.liability)} owed
                  </div>
                </div>
              ))}
            </div>
          </Card>
        </div>
      )}

      {/* Per-sub-account cards */}
      <SectionTitle>Sub-accounts</SectionTitle>
      <div className="grid gap-4 lg:grid-cols-2">
        {data.tenants.map((t) => (
          <TenantCard
            key={t.slug}
            t={t}
            opening={opening === t.slug}
            onOpen={() => void openWorkspace(t.slug)}
          />
        ))}
      </div>

      <IntegrationsCard />
    </div>
  );
}

function TenantCard({
  t,
  opening,
  onOpen,
}: {
  t: AgencyTenantRollup;
  opening: boolean;
  onOpen: () => void;
}) {
  const disabled = t.disabledFeatures as FeatureKey[];
  return (
    <Card className="flex flex-col gap-4">
      {/* Header */}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="truncate text-base font-semibold text-slate-900 dark:text-white">{t.name}</h3>
            {t.appEnabled ? (
              <Badge tone="green">
                <CheckCircle2 className="h-3 w-3" /> App enabled
              </Badge>
            ) : (
              <Badge tone="rose">Disabled · {t.status}</Badge>
            )}
          </div>
          <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-slate-400">
            <span>
              Tenant <span className="font-mono">{t.slug}</span>
            </span>
            <span className="inline-flex items-center gap-1">
              <MapPin className="h-3 w-3" />
              {t.ghlLocationId ? (
                <>
                  GHL <span className="font-mono">{t.ghlLocationId}</span>
                </>
              ) : (
                <span className="italic">GHL location not connected</span>
              )}
            </span>
          </p>
        </div>
        <Button size="sm" onClick={onOpen} disabled={opening}>
          {opening ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowRight className="h-4 w-4" />}
          Open workspace
        </Button>
      </div>

      {/* Financials */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <MiniStat icon={<DollarSign className="h-3.5 w-3.5" />} label="Revenue" money value={t.revenue.net} />
        <MiniStat icon={<Coins className="h-3.5 w-3.5" />} label="Owed" money value={t.commissions.liability} tone="amber" />
        <MiniStat icon={<Wallet className="h-3.5 w-3.5" />} label="Paid" money value={t.commissions.paid} />
        <MiniStat icon={<CreditCard className="h-3.5 w-3.5" />} label="Payouts pending" money value={t.payouts.pendingAmount} />
      </div>

      {/* Usage */}
      <div className="grid grid-cols-3 gap-3 sm:grid-cols-6">
        <MiniStat icon={<Users className="h-3.5 w-3.5" />} label="People" value={t.counts.salespeople} />
        <MiniStat icon={<Building2 className="h-3.5 w-3.5" />} label="Clients" value={t.counts.clients} />
        <MiniStat icon={<ScrollText className="h-3.5 w-3.5" />} label="Plans" value={t.counts.plans} />
        <MiniStat icon={<CreditCard className="h-3.5 w-3.5" />} label="Payments" value={t.counts.payments} />
        <MiniStat icon={<FileText className="h-3.5 w-3.5" />} label="Docs" value={t.documents.total} />
        <MiniStat icon={<Wallet className="h-3.5 w-3.5" />} label="Payouts" value={t.counts.payouts} />
      </div>

      {/* Feature access */}
      <div>
        <p className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-slate-400">Feature access</p>
        {disabled.length === 0 ? (
          <span className="inline-flex items-center gap-1 rounded-md bg-emerald-50 px-2 py-1 text-xs font-medium text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300">
            <CheckCircle2 className="h-3.5 w-3.5" /> All features enabled
          </span>
        ) : (
          <div className="flex flex-wrap items-center gap-1.5">
            {disabled.map((k) => (
              <span
                key={k}
                className="inline-flex items-center gap-1 rounded-md bg-rose-50 px-2 py-0.5 text-[11px] font-medium text-rose-600 line-through dark:bg-rose-500/10 dark:text-rose-300"
                title="Disabled for this sub-account"
              >
                {FEATURE_LABEL[k] ?? k}
              </span>
            ))}
            <span className="text-[11px] text-slate-400">{disabled.length} disabled</span>
          </div>
        )}
      </div>

      {/* Footer: last activity */}
      <div className="mt-auto border-t border-slate-100 pt-3 text-xs text-slate-400 dark:border-slate-800">
        Last activity · {timeAgo(t.lastActivityAt)}
      </div>
    </Card>
  );
}

function IntegrationsCard() {
  return (
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
  );
}

function MiniStat({
  icon,
  label,
  value,
  money = false,
  tone = "slate",
}: {
  icon: React.ReactNode;
  label: string;
  value: number;
  money?: boolean;
  tone?: "slate" | "amber";
}) {
  return (
    <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 dark:border-slate-800 dark:bg-slate-800/40">
      <div className="flex items-center gap-1 text-[11px] font-medium uppercase tracking-wide text-slate-400">
        {icon} <span className="truncate">{label}</span>
      </div>
      <p
        className={
          "mt-0.5 text-lg font-semibold tabular-nums " +
          (tone === "amber" ? "text-amber-600 dark:text-amber-400" : "text-slate-900 dark:text-white")
        }
      >
        {money ? formatCurrency(value) : formatNumber(value)}
      </p>
    </div>
  );
}
