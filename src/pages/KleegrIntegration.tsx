import { useEffect, useState } from "react";
import {
  Plug,
  RefreshCw,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  ShieldCheck,
  ServerCog,
  FileCheck2,
  Send,
  Users,
  Building2,
  Link2,
} from "lucide-react";
import { PageHeader, Card, Button, Badge, SectionTitle, StatCard, EmptyState } from "../components/ui";
import {
  getKleegrStatus,
  testKleegrConnection,
  reportKleegrStatus,
  validateKleegrManifest,
  type KleegrStatus,
  type TestConnectionResult,
  type ReportStatusResult,
  type ValidateManifestResult,
} from "../lib/kleegr-client";

type Tone = "slate" | "blue" | "green" | "amber" | "violet" | "rose" | "cyan" | "indigo";

function statusTone(status: string | null | undefined): Tone {
  switch (status) {
    case "connected":
      return "green";
    case "configuring":
      return "amber";
    case "error":
      return "rose";
    case "disconnected":
      return "slate";
    default:
      return "slate";
  }
}

function fmtTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return isNaN(d.getTime()) ? "—" : d.toLocaleString();
}

function ResultLine({ ok, children }: { ok: boolean; children: React.ReactNode }) {
  return (
    <div
      className={
        "flex items-start gap-2 rounded-lg px-3 py-2 text-sm " +
        (ok
          ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300"
          : "bg-rose-50 text-rose-700 dark:bg-rose-500/10 dark:text-rose-300")
      }
    >
      {ok ? <CheckCircle2 className="mt-0.5 h-4 w-4 flex-none" /> : <XCircle className="mt-0.5 h-4 w-4 flex-none" />}
      <span className="min-w-0">{children}</span>
    </div>
  );
}

function Row({ label, value, mono }: { label: string; value: React.ReactNode; mono?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-4 py-2">
      <span className="text-sm text-slate-500">{label}</span>
      <span className={"truncate text-sm font-medium text-slate-800 dark:text-slate-200 " + (mono ? "font-mono text-xs" : "")}>
        {value}
      </span>
    </div>
  );
}

export default function KleegrIntegration() {
  const [status, setStatus] = useState<KleegrStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<TestConnectionResult | null>(null);
  const [reporting, setReporting] = useState(false);
  const [reportResult, setReportResult] = useState<ReportStatusResult | null>(null);
  const [validating, setValidating] = useState(false);
  const [validateResult, setValidateResult] = useState<ValidateManifestResult | null>(null);

  async function refresh() {
    setLoading(true);
    setErr(null);
    try {
      setStatus(await getKleegrStatus());
    } catch {
      setErr("Couldn't load integration status. Check that the database is connected.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  async function onTest() {
    setTesting(true);
    setTestResult(null);
    try {
      setTestResult(await testKleegrConnection());
    } catch {
      setTestResult({ ok: false, message: "Request failed." });
    } finally {
      setTesting(false);
    }
  }

  async function onReport(s: "connected" | "configuring" | "error" | "disconnected") {
    setReporting(true);
    setReportResult(null);
    try {
      setReportResult(await reportKleegrStatus(s, `Sales Commission Manager reported '${s}'.`));
    } catch {
      setReportResult({ ok: false, message: "Request failed." });
    } finally {
      setReporting(false);
      void refresh();
    }
  }

  async function onValidate() {
    setValidating(true);
    setValidateResult(null);
    try {
      setValidateResult(await validateKleegrManifest());
    } catch {
      setValidateResult({ ok: false, valid: false, message: "Request failed." });
    } finally {
      setValidating(false);
    }
  }

  const conn = status?.connection;
  const cfg = status?.config;
  const connected = (conn?.connectionStatus ?? null) === "connected";
  const linked = !!conn?.subAccountId;

  return (
    <div className="max-w-4xl">
      <PageHeader
        title="Kleegr Integration"
        subtitle="Connection, sync, and manifest status for Kleegr Smart Productivity (GoHighLevel via Kleegr)."
        actions={
          <Button variant="secondary" onClick={() => void refresh()}>
            <RefreshCw className={"h-4 w-4 " + (loading ? "animate-spin" : "")} /> Refresh
          </Button>
        }
      />

      {err && (
        <div className="mb-4 flex items-start gap-2 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:bg-rose-500/10 dark:text-rose-300">
          <AlertTriangle className="mt-0.5 h-4 w-4 flex-none" />
          <span>{err}</span>
        </div>
      )}

      {loading && !status ? (
        <Card>
          <p className="text-sm text-slate-500">Loading integration status…</p>
        </Card>
      ) : !status ? (
        <EmptyState icon={<Plug className="h-6 w-6" />} title="No status available" description="Try refreshing in a moment." />
      ) : (
        <div className="space-y-6">
          {/* Connection */}
          <Card className="space-y-4">
            <SectionTitle right={<Plug className="h-4 w-4 text-slate-400" />}>Connection</SectionTitle>

            {!linked && (
              <div className="flex items-start gap-2 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-700 dark:bg-amber-500/10 dark:text-amber-300">
                <AlertTriangle className="mt-0.5 h-4 w-4 flex-none" />
                <span>
                  This workspace isn't linked to a Kleegr sub-account yet. Open the app from a Kleegr sub-account
                  (the launch flow links it automatically and runs the first sync).
                </span>
              </div>
            )}

            <div className="flex flex-wrap items-center gap-3">
              <Badge tone={statusTone(conn?.connectionStatus)}>
                {conn?.connectionStatus ? conn.connectionStatus : "not connected"}
              </Badge>
              {status.workspace && (
                <span className="text-sm text-slate-500">
                  Workspace: <span className="font-medium text-slate-700 dark:text-slate-200">{status.workspace.tenantName}</span>{" "}
                  ({status.workspace.role})
                </span>
              )}
            </div>

            <div className="divide-y divide-slate-100 dark:divide-slate-800">
              <Row label="Kleegr sub-account ID" value={conn?.subAccountId ?? "—"} mono />
              <Row label="GoHighLevel location ID" value={conn?.locationId ?? "—"} mono />
              <Row
                label="Connected user"
                value={conn?.connectedUser ? `${conn.connectedUser.email} · ${conn.connectedUser.role}` : "—"}
              />
              <Row
                label="Kleegr role"
                value={conn?.connectedUser?.kleegrRole ? conn.connectedUser.kleegrRole : "—"}
              />
              <Row label="Connected at" value={fmtTime(conn?.connectedAt)} />
              <Row label="Last sync" value={fmtTime(conn?.lastSyncAt)} />
            </div>
          </Card>

          {/* Imported data */}
          <Card className="space-y-4">
            <SectionTitle right={<Link2 className="h-4 w-4 text-slate-400" />}>Synced data</SectionTitle>
            <div className="grid gap-3 sm:grid-cols-3">
              <StatCard label="Imported clients" value={conn?.counts.importedClients ?? 0} icon={<Building2 className="h-5 w-5" />} tone="blue" />
              <StatCard label="Linked clients" value={conn?.counts.linkedClients ?? 0} icon={<Link2 className="h-5 w-5" />} tone="violet" />
              <StatCard label="Kleegr users" value={conn?.counts.kleegrUsers ?? 0} icon={<Users className="h-5 w-5" />} tone="cyan" />
            </div>
            <p className="text-xs text-slate-500">
              Imported data is labelled (Kleegr imported / Kleegr linked) and is read through the Kleegr gateway —
              never directly from GoHighLevel. A fresh sync runs each time the app is launched from Kleegr.
            </p>
          </Card>

          {/* Configuration */}
          <Card className="space-y-4">
            <SectionTitle right={<ServerCog className="h-4 w-4 text-slate-400" />}>Configuration</SectionTitle>
            <div className="divide-y divide-slate-100 dark:divide-slate-800">
              <Row label="Kleegr API base URL" value={cfg?.baseUrl ?? "—"} mono />
              <Row
                label="KLEEGR_INTEGRATION_TOKEN"
                value={
                  cfg?.hasIntegrationToken ? (
                    <Badge tone="green">set</Badge>
                  ) : (
                    <Badge tone="rose">missing</Badge>
                  )
                }
              />
              <Row
                label="KLEEGR_WEBHOOK_SECRET"
                value={cfg?.hasWebhookSecret ? <Badge tone="green">set</Badge> : <Badge tone="rose">missing</Badge>}
              />
              <Row
                label="Manifest"
                value={
                  status.manifest.present ? (
                    <Badge tone="green">present · v{status.manifest.appVersion}</Badge>
                  ) : (
                    <Badge tone="rose">missing</Badge>
                  )
                }
              />
              <Row
                label="Available gateway resources"
                value={
                  <span className="flex flex-wrap justify-end gap-1">
                    {status.availableResources.map((r) => (
                      <Badge key={r} tone="slate">
                        {r}
                      </Badge>
                    ))}
                  </span>
                }
              />
              <Row
                label="Webhook events"
                value={
                  <span className="flex flex-wrap justify-end gap-1">
                    {status.manifest.webhookEvents.map((e) => (
                      <Badge key={e} tone="indigo">
                        {e}
                      </Badge>
                    ))}
                  </span>
                }
              />
            </div>
            {cfg && !cfg.ready && (
              <div className="flex items-start gap-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-700 dark:bg-amber-500/10 dark:text-amber-300">
                <AlertTriangle className="mt-0.5 h-4 w-4 flex-none" />
                <span>
                  Missing server env vars: {cfg.missing.join(", ") || "none"}. Add them in Vercel (Production + Preview)
                  and redeploy before launching from Kleegr.
                </span>
              </div>
            )}
          </Card>

          {/* Actions */}
          <Card className="space-y-4">
            <SectionTitle right={<ShieldCheck className="h-4 w-4 text-slate-400" />}>Actions</SectionTitle>

            {/* Test server connection */}
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-sm font-medium text-slate-800 dark:text-slate-200">Test server connection</p>
                  <p className="text-xs text-slate-500">Verifies the integration token against Kleegr (server-side).</p>
                </div>
                <Button variant="secondary" onClick={() => void onTest()} disabled={testing}>
                  <ServerCog className="h-4 w-4" /> {testing ? "Testing…" : "Test"}
                </Button>
              </div>
              {testResult && (
                <ResultLine ok={testResult.ok}>
                  {testResult.ok ? (
                    <>
                      Token verified. Scopes: {testResult.identity?.scopes?.join(", ") || "—"} · sub-accounts:{" "}
                      {testResult.identity?.subAccounts?.length ?? 0}
                    </>
                  ) : (
                    <>Failed{testResult.code ? ` (${testResult.code})` : ""}: {testResult.message ?? "unknown error"}</>
                  )}
                </ResultLine>
              )}
            </div>

            {/* Validate manifest */}
            <div className="space-y-2 border-t border-slate-100 pt-4 dark:border-slate-800">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-sm font-medium text-slate-800 dark:text-slate-200">Validate manifest</p>
                  <p className="text-xs text-slate-500">Runs Kleegr's dry-run import for smart-productivity.app.json.</p>
                </div>
                <Button variant="secondary" onClick={() => void onValidate()} disabled={validating}>
                  <FileCheck2 className="h-4 w-4" /> {validating ? "Validating…" : "Validate"}
                </Button>
              </div>
              {validateResult && (
                <ResultLine ok={validateResult.ok && validateResult.valid}>
                  {validateResult.ok && validateResult.valid ? (
                    <>Manifest is valid (dry run passed).</>
                  ) : (
                    <>
                      Not valid{validateResult.code ? ` (${validateResult.code})` : ""}:{" "}
                      {validateResult.message ?? JSON.stringify(validateResult.body ?? {})}
                    </>
                  )}
                </ResultLine>
              )}
            </div>

            {/* Report status */}
            <div className="space-y-2 border-t border-slate-100 pt-4 dark:border-slate-800">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <p className="text-sm font-medium text-slate-800 dark:text-slate-200">Report status to Kleegr</p>
                  <p className="text-xs text-slate-500">
                    Sends a status update for this sub-account {linked ? "" : "(link the workspace first)"}.
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button variant="secondary" onClick={() => void onReport("connected")} disabled={reporting || !linked}>
                    <Send className="h-4 w-4" /> Connected
                  </Button>
                  <Button variant="ghost" onClick={() => void onReport("configuring")} disabled={reporting || !linked}>
                    Configuring
                  </Button>
                  <Button variant="ghost" onClick={() => void onReport("error")} disabled={reporting || !linked}>
                    Error
                  </Button>
                </div>
              </div>
              {reportResult && (
                <ResultLine ok={reportResult.ok}>
                  {reportResult.ok ? (
                    <>Reported '{reportResult.reported}' for {reportResult.subAccountId}.</>
                  ) : (
                    <>Failed: {reportResult.message ?? reportResult.error ?? "unknown error"}</>
                  )}
                </ResultLine>
              )}
            </div>
          </Card>

          <p className="text-center text-xs text-slate-400">
            {status.app.appName} · v{status.app.appVersion} · integrates with GoHighLevel only through Kleegr Smart Productivity.
          </p>
        </div>
      )}
    </div>
  );
}
