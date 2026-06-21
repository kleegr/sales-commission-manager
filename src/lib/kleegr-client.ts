// ============================================================================
// KLEEGR CLIENT  (browser)
//
// Thin fetch wrappers for the /api/kleegr/* endpoints used by the Kleegr
// Integration settings page. The browser NEVER sees any secret or token — these
// endpoints return only status, presence flags, and Kleegr's own verdicts.
// Cookies (the app session) are sent automatically for same-origin requests.
// ============================================================================

export interface KleegrConnection {
  subAccountId: string | null;
  locationId: string | null;
  connectionStatus: string | null;
  connectedAt: string | null;
  lastSyncAt: string | null;
  connectedUser: { email: string; role: string; kleegrRole: string | null } | null;
  counts: { importedClients: number; linkedClients: number; kleegrUsers: number };
}

export interface KleegrStatus {
  ok: boolean;
  app: { appKey: string; appName: string; appVersion: string };
  config: {
    baseUrl: string;
    hasIntegrationToken: boolean;
    hasWebhookSecret: boolean;
    missing: string[];
    ready: boolean;
  };
  manifest: { present: boolean; appKey: string; appVersion: string; scopes: string[]; webhookEvents: string[] };
  availableResources: string[];
  authenticated: boolean;
  workspace?: { tenantSlug: string; tenantName: string; role: string };
  connection?: KleegrConnection;
}

export interface TestConnectionResult {
  ok: boolean;
  code?: string;
  message?: string;
  baseUrl?: string;
  identity?: { app: Record<string, unknown>; scopes: string[]; subAccounts: unknown[] };
  missing?: string[];
}

export interface ReportStatusResult {
  ok: boolean;
  reported?: string;
  subAccountId?: string;
  kleegrStatus?: number;
  error?: string;
  message?: string;
}

export interface ValidateManifestResult {
  ok: boolean;
  valid: boolean;
  code?: string;
  message?: string;
  kleegrStatus?: number;
  body?: unknown;
}

async function getJSON<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: { accept: "application/json" } });
  return (await res.json()) as T;
}
async function postJSON<T>(url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return (await res.json()) as T;
}

export function getKleegrStatus(): Promise<KleegrStatus> {
  return getJSON<KleegrStatus>("/api/kleegr/status");
}
export function testKleegrConnection(): Promise<TestConnectionResult> {
  return postJSON<TestConnectionResult>("/api/kleegr/test-connection");
}
export function reportKleegrStatus(status: string, detail?: string): Promise<ReportStatusResult> {
  return postJSON<ReportStatusResult>("/api/kleegr/report-status", { status, detail });
}
export function validateKleegrManifest(): Promise<ValidateManifestResult> {
  return postJSON<ValidateManifestResult>("/api/kleegr/validate-manifest");
}
