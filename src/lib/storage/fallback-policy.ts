// ============================================================================
// LOCAL-FALLBACK POLICY  (pure; unit-tested in fallback-policy.test.ts)
//
// Decides when the browser's localStorage copy of AppData may stand in for the
// live database, and when a write may go to localStorage at all.
//
// The rule this encodes
// ---------------------
// A commission system must never show a balance the database does not agree
// with. In production the cached copy is therefore NEVER substituted for the
// live dataset: an unreachable API produces an honest error, not a stale
// ledger. In local development the opposite is true — `vite dev` serves no
// serverless functions at all, so localStorage is the ONLY backend there and
// the app has to work against it.
//
// Those two cases are distinguishable from the response itself, which is why
// `StateSourceKind` separates them:
//
//   "absent"  the thing that answered /api/state is not our JSON API (the SPA
//             shell came back instead). There is no server to be authoritative,
//             so local mode is legitimate — this is `vite dev` / a static host.
//   "outage"  our JSON API answered 5xx, or the request never completed. A
//             server EXISTS and is failing. Whether its cache may be shown is a
//             policy question, answered by the deployment environment.
//
// The environment is remembered from the last successful load (see
// rememberMode/readRememberedMode) so the policy still applies on the very
// first request of a session, when the API is already down and cannot tell us
// what environment it is.
// ============================================================================

/** Deployment environment as reported by the server in GET /api/state. */
export type DeploymentEnvironment = "production" | "preview" | "development";

/** What the /api/state response says about who owns the data. */
export interface ServerMode {
  serverAuthoritative: boolean;
  environment: DeploymentEnvironment;
  /** Server's verdict on whether a cached read is permitted at all. */
  localFallback: boolean;
}

const MODE_KEY = "scm.state_mode";

const ENVIRONMENTS: DeploymentEnvironment[] = ["production", "preview", "development"];

/** Coerce an unknown `mode` payload into a ServerMode, or null if unusable. */
export function coerceServerMode(input: unknown): ServerMode | null {
  if (!input || typeof input !== "object") return null;
  const m = input as Record<string, unknown>;
  const environment = ENVIRONMENTS.includes(m.environment as DeploymentEnvironment)
    ? (m.environment as DeploymentEnvironment)
    : null;
  if (!environment) return null;
  return {
    serverAuthoritative: m.serverAuthoritative !== false,
    environment,
    // Absent flag ⇒ derive it, so an older server that predates the field is
    // still treated safely rather than as "fallback allowed".
    localFallback:
      typeof m.localFallback === "boolean" ? m.localFallback : environment === "development",
  };
}

/**
 * May a cached copy be shown for this failure?
 *
 * - "absent": always — there is no server to disagree with.
 * - "outage": only when the last known mode permitted it. An unknown mode
 *   (nothing remembered, so this device has never reached the API) is refused:
 *   without evidence that this is a development build, a stale financial
 *   number is the more expensive mistake.
 */
export function allowCachedRead(
  kind: "absent" | "outage",
  lastKnown: ServerMode | null,
): boolean {
  if (kind === "absent") return true;
  if (!lastKnown) return false;
  return lastKnown.localFallback;
}

/**
 * May the app persist mutations to localStorage?
 *
 * Only when no server owns the data. The moment /api/state answers, every write
 * belongs to a per-resource endpoint and a local copy would be a second,
 * divergent source of truth.
 */
export function allowLocalWrites(lastKnown: ServerMode | null): boolean {
  if (!lastKnown) return true; // no server seen yet — dev/local mode
  return !lastKnown.serverAuthoritative;
}

// ---------------------------------------------------------------------------
// Remembered mode (thin localStorage glue; the decisions above stay pure)
// ---------------------------------------------------------------------------

/** Minimal storage surface, so the glue is testable without a DOM. */
export interface ModeStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export function rememberMode(store: ModeStore | undefined, mode: ServerMode): void {
  try {
    store?.setItem(MODE_KEY, JSON.stringify(mode));
  } catch {
    /* storage disabled — the policy just falls back to "unknown", which is safe */
  }
}

export function readRememberedMode(store: ModeStore | undefined): ServerMode | null {
  try {
    const raw = store?.getItem(MODE_KEY);
    if (!raw) return null;
    return coerceServerMode(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function clearRememberedMode(store: ModeStore | undefined): void {
  try {
    store?.removeItem(MODE_KEY);
  } catch {
    /* ignore */
  }
}

export function browserModeStore(): ModeStore | undefined {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    return undefined;
  }
}
