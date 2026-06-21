// ============================================================================
// KLEEGR SMART PRODUCTIVITY  —  integration core (server-side only)
//
// Sales Commission Manager integrates with GoHighLevel **only** through Kleegr
// Smart Productivity (a white-label bridge). This module is the single
// server-side entry point for everything that talks to Kleegr:
//
//   - readKleegrConfig() / requireKleegrConfig()  — env-var resolution
//   - verifyIntegrationToken()                    — Step 1 (server↔Kleegr)
//   - verifyLaunchToken() + validateLaunchClaims()— Step 2 (launch flow)
//   - mapKleegrRole()                             — Step 2 (role mapping)
//   - kleegrGateway() + resource helpers          — Step 4 (gateway client)
//   - reportIntegrationStatus()                   — Step 6 (status reporting)
//   - verifyWebhookSignature()                    — Step 7 (webhook receiver)
//
// SECRETS: the integration token and webhook secret are read from the
// environment by NAME only (KLEEGR_INTEGRATION_TOKEN / KLEEGR_WEBHOOK_SECRET)
// and never logged, never returned to the browser, and never placed in the
// manifest. There is NO direct GoHighLevel OAuth, API call, or webhook here —
// Kleegr owns the GoHighLevel layer.
//
// TESTABILITY: every function that performs a network call accepts an optional
// `fetchImpl` (defaulting to the global fetch) so the error/parse mapping can
// be unit-tested offline with an injected fake (see kleegr.test.ts). The pure
// functions (signature verification, role mapping, claim validation) need no
// network at all.
// ============================================================================

import { createHmac, timingSafeEqual } from "node:crypto";

/** Stable identity of this app inside Kleegr / GoHighLevel. */
export const APP_KEY = "sales-commission-manager";
export const APP_NAME = "Sales Commission Manager";
export const APP_VERSION = "1.0.0";

/** Documented Kleegr base URL; only used if KLEEGR_API_BASE_URL is unset. */
const DEFAULT_KLEEGR_BASE_URL = "https://smart-productivity-pied.vercel.app";

/** Network timeout for every server↔Kleegr call (ms). */
const KLEEGR_TIMEOUT_MS = 10_000;

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface KleegrConfig {
  baseUrl: string;
  integrationToken: string;
  webhookSecret: string;
}

export interface KleegrConfigReport {
  /** True when every required server-side secret is present. */
  ok: boolean;
  baseUrl: string;
  hasIntegrationToken: boolean;
  hasWebhookSecret: boolean;
  /** Names (never values) of the env vars that are missing. */
  missing: string[];
}

function envValue(name: string): string {
  return (process.env[name] ?? "").trim();
}

/** Resolve the Kleegr base URL (env var first, documented default as fallback). */
export function kleegrBaseUrl(): string {
  return envValue("KLEEGR_API_BASE_URL") || DEFAULT_KLEEGR_BASE_URL;
}

/**
 * Non-throwing config inspection for /api/kleegr/status and the settings UI.
 * Reports ONLY presence (booleans) and the public base URL — never any secret.
 */
export function readKleegrConfig(): KleegrConfigReport {
  const hasIntegrationToken = !!envValue("KLEEGR_INTEGRATION_TOKEN");
  const hasWebhookSecret = !!envValue("KLEEGR_WEBHOOK_SECRET");
  const missing: string[] = [];
  if (!hasIntegrationToken) missing.push("KLEEGR_INTEGRATION_TOKEN");
  if (!hasWebhookSecret) missing.push("KLEEGR_WEBHOOK_SECRET");
  return {
    ok: hasIntegrationToken && hasWebhookSecret,
    baseUrl: kleegrBaseUrl(),
    hasIntegrationToken,
    hasWebhookSecret,
    missing,
  };
}

/** Throwing config accessor for the server↔Kleegr calls that need the secrets. */
export function requireKleegrConfig(): KleegrConfig {
  const integrationToken = envValue("KLEEGR_INTEGRATION_TOKEN");
  if (!integrationToken) throw new KleegrError("config_error", "KLEEGR_INTEGRATION_TOKEN is not set", 500);
  // webhookSecret is validated where it is actually used (the webhook route);
  // not every call needs it, so we don't hard-fail here on its absence.
  return {
    baseUrl: kleegrBaseUrl(),
    integrationToken,
    webhookSecret: envValue("KLEEGR_WEBHOOK_SECRET"),
  };
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type KleegrErrorCode =
  | "config_error"
  | "unauthorized"
  | "gateway_denied" // 403
  | "not_implemented" // 501
  | "ghl_upstream_error" // 502
  | "invalid_response"
  | "network_error"
  | "timeout"
  | "kleegr_error";

export class KleegrError extends Error {
  code: KleegrErrorCode;
  status: number;
  detail?: unknown;
  constructor(code: KleegrErrorCode, message: string, status = 502, detail?: unknown) {
    super(message);
    this.name = "KleegrError";
    this.code = code;
    this.status = status;
    this.detail = detail;
  }
}

// ---------------------------------------------------------------------------
// Low-level fetch helper (timeout + JSON parse + error normalization)
// ---------------------------------------------------------------------------

interface FetchJsonOptions {
  method?: "GET" | "POST";
  bearer?: string;
  body?: unknown;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

interface JsonResult {
  status: number;
  ok: boolean;
  body: any;
}

/** One server↔Kleegr round-trip. Never throws on non-2xx; returns the status. */
async function kleegrFetch(url: string, opts: FetchJsonOptions = {}): Promise<JsonResult> {
  const { method = "GET", bearer, body, fetchImpl = fetch, timeoutMs = KLEEGR_TIMEOUT_MS } = opts;
  const headers: Record<string, string> = { accept: "application/json" };
  if (bearer) headers["authorization"] = `Bearer ${bearer}`;
  if (body !== undefined) headers["content-type"] = "application/json";

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err: any) {
    if (err?.name === "AbortError") throw new KleegrError("timeout", `Kleegr request timed out: ${url}`, 504);
    throw new KleegrError("network_error", `Could not reach Kleegr: ${String(err?.message ?? err)}`, 502);
  } finally {
    clearTimeout(timer);
  }

  let parsed: any = null;
  const text = await res.text().catch(() => "");
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { raw: text.slice(0, 500) };
    }
  }
  return { status: res.status, ok: res.ok, body: parsed };
}

/** Map a non-2xx gateway response onto a typed KleegrError (Step 4 codes). */
function gatewayErrorFor(result: JsonResult): KleegrError {
  const msg = (result.body && (result.body.error || result.body.message)) || `HTTP ${result.status}`;
  switch (result.status) {
    case 401:
      return new KleegrError("unauthorized", "Kleegr rejected the token (401)", 401, result.body);
    case 403:
      return new KleegrError("gateway_denied", `Gateway denied: ${msg}`, 403, result.body);
    case 501:
      return new KleegrError("not_implemented", `Gateway resource not implemented: ${msg}`, 501, result.body);
    case 502:
      return new KleegrError("ghl_upstream_error", `GoHighLevel upstream error: ${msg}`, 502, result.body);
    default:
      return new KleegrError("kleegr_error", `Kleegr error (${result.status}): ${msg}`, result.status || 502, result.body);
  }
}

// ---------------------------------------------------------------------------
// Step 1 — verify the integration token (server↔Kleegr)
// ---------------------------------------------------------------------------

export interface IntegrationIdentity {
  ok: boolean;
  app: Record<string, unknown>;
  scopes: string[];
  subAccounts: unknown[];
}

/**
 * GET ${base}/api/integration/me with the integration token.
 * Proves the server-side credential works. A missing/invalid token yields 401
 * from Kleegr, which we surface as a typed `unauthorized` error.
 */
export async function verifyIntegrationToken(fetchImpl?: typeof fetch): Promise<IntegrationIdentity> {
  const cfg = requireKleegrConfig();
  const result = await kleegrFetch(`${cfg.baseUrl}/api/integration/me`, {
    method: "GET",
    bearer: cfg.integrationToken,
    fetchImpl,
  });
  if (!result.ok) throw gatewayErrorFor(result);
  const b = result.body ?? {};
  return {
    ok: b.ok !== false,
    app: (b.app && typeof b.app === "object") ? b.app : {},
    scopes: Array.isArray(b.scopes) ? b.scopes : [],
    subAccounts: Array.isArray(b.subAccounts) ? b.subAccounts : [],
  };
}

// ---------------------------------------------------------------------------
// Step 2 — launch-token verification + claim validation + role mapping
// ---------------------------------------------------------------------------

/** The claims we read out of a verified launch token. */
export interface LaunchClaims {
  sp_user_id: string;
  email: string | null;
  role: string | null;
  permissions: string[];
  sub_account_id: string;
  location_id: string | null;
  exp: number | null;
  /** The raw verify payload, for forward-compat fields we don't model yet. */
  raw: Record<string, unknown>;
}

export interface ClaimValidation {
  ok: boolean;
  reason?: string;
  claims?: LaunchClaims;
}

function asStringArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string");
  return [];
}

/**
 * Pure validation of a Kleegr verify response (no network). Rejects when:
 *   - valid !== true
 *   - aud !== "sales-commission-manager"
 *   - the token is expired (exp in the past)
 *   - sp_user_id is missing
 *   - sub_account_id is missing
 * `nowMs` is injectable for deterministic expiry tests.
 */
export function validateLaunchClaims(payload: any, nowMs: number = Date.now()): ClaimValidation {
  if (!payload || typeof payload !== "object") return { ok: false, reason: "empty_response" };
  if (payload.valid !== true) return { ok: false, reason: "not_valid" };

  // Claims may be nested under `claims` or returned flat — accept both.
  const c: Record<string, unknown> = (payload.claims && typeof payload.claims === "object")
    ? (payload.claims as Record<string, unknown>)
    : (payload as Record<string, unknown>);

  const aud = (c.aud ?? payload.aud) as unknown;
  if (aud !== APP_KEY) return { ok: false, reason: "aud_mismatch" };

  const expRaw = (c.exp ?? payload.exp) as unknown;
  const exp = typeof expRaw === "number" ? expRaw : null;
  if (exp !== null) {
    // exp is seconds since epoch (JWT convention); compare in ms.
    if (exp * 1000 <= nowMs) return { ok: false, reason: "expired" };
  }

  const spUserId = (c.sp_user_id ?? c.user_id) as unknown;
  if (typeof spUserId !== "string" || !spUserId) return { ok: false, reason: "missing_sp_user_id" };

  const subAccountId = (c.sub_account_id ?? c.subAccountId) as unknown;
  if (typeof subAccountId !== "string" || !subAccountId) return { ok: false, reason: "missing_sub_account_id" };

  const claims: LaunchClaims = {
    sp_user_id: spUserId,
    email: typeof c.email === "string" ? c.email : null,
    role: typeof c.role === "string" ? c.role : null,
    permissions: asStringArray(c.permissions),
    sub_account_id: subAccountId,
    location_id: typeof c.location_id === "string" ? c.location_id : (typeof c.locationId === "string" ? c.locationId : null),
    exp,
    raw: c,
  };
  return { ok: true, claims };
}

/**
 * POST ${base}/api/plugins/verify { token, appKey } and validate the claims.
 * The launch token is used ONCE here and then discarded by the caller — it is
 * never cached or reused (the caller mints its own short session instead).
 */
export async function verifyLaunchToken(
  launchToken: string,
  fetchImpl?: typeof fetch,
  nowMs: number = Date.now(),
): Promise<ClaimValidation> {
  if (!launchToken || typeof launchToken !== "string") return { ok: false, reason: "missing_token" };
  const cfg = requireKleegrConfig();
  const result = await kleegrFetch(`${cfg.baseUrl}/api/plugins/verify`, {
    method: "POST",
    body: { token: launchToken, appKey: APP_KEY },
    fetchImpl,
  });
  if (result.status === 401 || result.status === 403) return { ok: false, reason: "rejected" };
  if (!result.ok) return { ok: false, reason: `verify_http_${result.status}` };
  return validateLaunchClaims(result.body, nowMs);
}

// ---------------------------------------------------------------------------
// Role mapping (Step 2)
//
// Kleegr role  →  Sales Commission Manager role
//   agency_admin → owner (agency context) | admin (sub-account context)
//   manager      → sales_manager
//   user         → salesperson
//   <unknown>    → salesperson  (safest limited role — never owner)
//
// `context` lets the launch flow choose owner vs admin for an agency admin:
// an agency-level placement maps to `owner`; a sub-account placement maps to
// `admin`. The final mapping is documented in the README / handoff.
// ---------------------------------------------------------------------------

export type AppRole = "owner" | "admin" | "sales_manager" | "salesperson" | "affiliate" | "partner";

export function mapKleegrRole(
  kleegrRole: string | null | undefined,
  context: "agency" | "sub_account" = "sub_account",
): AppRole {
  switch ((kleegrRole ?? "").trim().toLowerCase()) {
    case "agency_admin":
      return context === "agency" ? "owner" : "admin";
    case "manager":
      return "sales_manager";
    case "user":
      return "salesperson";
    default:
      // Unknown / unset → safest limited role. NEVER owner.
      return "salesperson";
  }
}

// ---------------------------------------------------------------------------
// Step 4 — Kleegr gateway client (server↔Kleegr, Bearer = launch token)
// ---------------------------------------------------------------------------

export type GatewayResource = "subaccount" | "users" | "opportunities" | "contacts" | "conversations";

export const GATEWAY_RESOURCES: GatewayResource[] = [
  "subaccount",
  "users",
  "opportunities",
  "contacts",
  "conversations",
];

/**
 * POST ${base}/api/plugins/gateway with the (short-lived) launch token.
 * Kleegr proxies the read to GoHighLevel and returns the data. Errors are
 * mapped to typed codes (gateway_denied / not_implemented / ghl_upstream_error).
 *
 * The launch token is passed in by the caller and never persisted; it lives
 * only for the duration of the launch request.
 */
export async function kleegrGateway<T = any>(
  launchToken: string,
  resource: GatewayResource,
  params: Record<string, unknown> = {},
  fetchImpl?: typeof fetch,
): Promise<T> {
  if (!launchToken) throw new KleegrError("unauthorized", "missing launch token for gateway call", 401);
  const cfg = requireKleegrConfig();
  const result = await kleegrFetch(`${cfg.baseUrl}/api/plugins/gateway`, {
    method: "POST",
    bearer: launchToken,
    body: { resource, params },
    fetchImpl,
  });
  if (!result.ok) throw gatewayErrorFor(result);
  // Unwrap a `{ data: ... }` envelope if Kleegr uses one; otherwise return body.
  const b = result.body;
  return (b && typeof b === "object" && "data" in b ? (b as any).data : b) as T;
}

/** Convenience: the sub-account profile. */
export function gatewaySubaccount<T = any>(launchToken: string, fetchImpl?: typeof fetch): Promise<T> {
  return kleegrGateway<T>(launchToken, "subaccount", {}, fetchImpl);
}
/** Convenience: users in the sub-account. */
export function gatewayUsers<T = any>(launchToken: string, params: Record<string, unknown> = {}, fetchImpl?: typeof fetch): Promise<T> {
  return kleegrGateway<T>(launchToken, "users", params, fetchImpl);
}
/** Convenience: contacts in the sub-account. */
export function gatewayContacts<T = any>(launchToken: string, params: Record<string, unknown> = {}, fetchImpl?: typeof fetch): Promise<T> {
  return kleegrGateway<T>(launchToken, "contacts", params, fetchImpl);
}
/** Convenience: opportunities in the sub-account. */
export function gatewayOpportunities<T = any>(launchToken: string, params: Record<string, unknown> = {}, fetchImpl?: typeof fetch): Promise<T> {
  return kleegrGateway<T>(launchToken, "opportunities", params, fetchImpl);
}

// ---------------------------------------------------------------------------
// Step 6 — report connection status to Kleegr (server↔Kleegr)
// ---------------------------------------------------------------------------

export type IntegrationStatus = "connected" | "configuring" | "error" | "disconnected";

export const INTEGRATION_STATUSES: IntegrationStatus[] = ["connected", "configuring", "error", "disconnected"];

export interface ReportStatusResult {
  ok: boolean;
  status: number;
  body: unknown;
}

/**
 * POST ${base}/api/integration/status with the integration token.
 * Called when launch succeeds, a gateway test succeeds, a sync fails, or on
 * disconnect. Best-effort by design: the caller decides whether a failure here
 * should block (it usually should not).
 */
export async function reportIntegrationStatus(
  status: IntegrationStatus,
  subAccountId: string,
  detail: string,
  fetchImpl?: typeof fetch,
): Promise<ReportStatusResult> {
  const cfg = requireKleegrConfig();
  const result = await kleegrFetch(`${cfg.baseUrl}/api/integration/status`, {
    method: "POST",
    bearer: cfg.integrationToken,
    body: { status, subAccountId, detail },
    fetchImpl,
  });
  return { ok: result.ok, status: result.status, body: result.body };
}

// ---------------------------------------------------------------------------
// Step 10 — manifest dry-run validation (server↔Kleegr)
// ---------------------------------------------------------------------------

export interface ManifestValidation {
  ok: boolean;
  valid: boolean;
  status: number;
  body: unknown;
}

/**
 * POST ${base}/api/agency/apps/import { manifest, dryRun:true } with the
 * integration token. Returns Kleegr's validation verdict for the manifest.
 */
export async function validateManifestDryRun(
  manifest: unknown,
  fetchImpl?: typeof fetch,
): Promise<ManifestValidation> {
  const cfg = requireKleegrConfig();
  const result = await kleegrFetch(`${cfg.baseUrl}/api/agency/apps/import`, {
    method: "POST",
    bearer: cfg.integrationToken,
    body: { manifest, dryRun: true },
    fetchImpl,
  });
  const b = result.body ?? {};
  return { ok: result.ok && b.ok !== false, valid: b.valid === true, status: result.status, body: b };
}

// ---------------------------------------------------------------------------
// Step 7 — webhook signature verification (pure, no network)
//
// Kleegr signs every webhook with HMAC-SHA256 over the RAW request body and
// sends it as `X-SP-Signature: sha256=<hex>`. Verification FAILS CLOSED:
//   - missing signature        → false
//   - missing/empty secret     → throws config_error (caller returns 500)
//   - signature mismatch       → false (constant-time compare)
//   - valid signature          → true
// ---------------------------------------------------------------------------

/** Compute the expected `sha256=<hex>` signature for a raw body + secret. */
export function computeWebhookSignature(rawBody: string | Buffer, secret: string): string {
  const hex = createHmac("sha256", secret).update(rawBody).digest("hex");
  return `sha256=${hex}`;
}

/**
 * Constant-time verification of the X-SP-Signature header. Throws KleegrError
 * `config_error` when the secret is absent (a server misconfiguration the
 * caller must surface as 500 — never silently accept).
 */
export function verifyWebhookSignature(
  rawBody: string | Buffer,
  signatureHeader: string | null | undefined,
  secret: string | null | undefined,
): boolean {
  if (!secret) throw new KleegrError("config_error", "KLEEGR_WEBHOOK_SECRET is not set", 500);
  if (!signatureHeader || typeof signatureHeader !== "string") return false;

  const expected = computeWebhookSignature(rawBody, secret);
  // Accept either "sha256=<hex>" or a bare "<hex>" for robustness.
  const provided = signatureHeader.includes("=") ? signatureHeader.trim() : `sha256=${signatureHeader.trim()}`;

  const a = Buffer.from(expected);
  const b = Buffer.from(provided);
  if (a.length !== b.length) return false; // length mismatch → not equal (and avoids timingSafeEqual throw)
  try {
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Webhook events we actually handle (must match the manifest's webhookEvents).
// ---------------------------------------------------------------------------

export const HANDLED_WEBHOOK_EVENTS = [
  "app.installed",
  "subaccount.connected",
  "subaccount.disconnected",
  "contact.created",
  "contact.updated",
  "opportunity.created",
  "opportunity.updated",
] as const;

export type HandledWebhookEvent = (typeof HANDLED_WEBHOOK_EVENTS)[number];

export function isHandledWebhookEvent(name: string): name is HandledWebhookEvent {
  return (HANDLED_WEBHOOK_EVENTS as readonly string[]).includes(name);
}

// ---------------------------------------------------------------------------
// writeState support: preserve externally-owned mapping across snapshot saves
//
// The /api/state snapshot (AppData) does NOT carry Kleegr/GHL mapping columns,
// so the transactional replace-all in writeState() would otherwise wipe them on
// every admin save. writeState captures the mapping BEFORE the delete and uses
// this helper to restore it AFTER re-insert — but only for rows that still
// exist in the new snapshot (a row removed from the snapshot correctly loses
// its mapping). This is a pure function so it is unit-tested offline.
// ---------------------------------------------------------------------------

export function preserveExternalMapping<T extends { id: string }>(
  captured: T[],
  survivingIds: Iterable<string>,
): T[] {
  const keep = new Set(survivingIds);
  return captured.filter((row) => keep.has(row.id));
}
