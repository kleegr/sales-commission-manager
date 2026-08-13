// ============================================================================
// RUNTIME ENVIRONMENT  (pure helpers, unit-tested in runtime-env.test.ts)
//
// One place that decides "is this a production deployment?" and, from that,
// whether the browser is allowed to fall back to its localStorage copy.
//
// WHY THE FALLBACK HAS TO BE OFF IN PRODUCTION
// --------------------------------------------
// The HybridStore was built to serve the cached AppData whenever /api/state was
// unreachable. In development that is a feature (`vite dev` runs no serverless
// functions at all). In production it is a financial hazard: a rep looking at a
// cached ledger sees a balance the database does not agree with, and — before
// the snapshot write was removed — could even write that divergent balance back.
// A commission system must show either the real number or an honest error, so
// in production a cached copy is never substituted for the live dataset.
//
// The escape hatch (`SCM_ALLOW_LOCAL_FALLBACK`) exists for a deliberately
// offline demo deployment. It is a two-key action: it only has an effect when
// somebody sets it on purpose, exactly like DEMO_MODE_ALLOW_IN_PRODUCTION.
// ============================================================================

export type DeploymentEnvironment = "production" | "preview" | "development";

type Env = Record<string, string | undefined>;

const TRUTHY = ["1", "true", "on", "enabled", "yes"];

/** True for the documented set of "switch this on" values, and nothing else. */
export function isEnabled(value: string | undefined): boolean {
  return TRUTHY.includes((value ?? "").trim().toLowerCase());
}

/**
 * Which deployment this is. `VERCEL_ENV` is authoritative when present (Vercel
 * sets it to production/preview/development); NODE_ENV is the fallback for
 * self-hosted or local runs. Anything unrecognised is treated as development,
 * which is the SAFE reading here: development is the only mode that relaxes
 * anything, and an unrecognised value on Vercel cannot happen because VERCEL_ENV
 * is always one of the three.
 */
export function deploymentEnvironment(env: Env): DeploymentEnvironment {
  const vercel = (env.VERCEL_ENV ?? "").trim().toLowerCase();
  if (vercel === "production") return "production";
  if (vercel === "preview") return "preview";
  if (vercel === "development") return "development";
  return (env.NODE_ENV ?? "").trim().toLowerCase() === "production" ? "production" : "development";
}

export function isProduction(env: Env): boolean {
  return deploymentEnvironment(env) === "production";
}

/**
 * May the browser serve its localStorage copy when the API is unreachable?
 *
 * Off in production and preview (both hold real tenant data); on in development.
 * `SCM_ALLOW_LOCAL_FALLBACK` re-enables it anywhere for an offline demo build.
 */
export function localFallbackAllowed(env: Env): boolean {
  if (isEnabled(env.SCM_ALLOW_LOCAL_FALLBACK)) return true;
  return deploymentEnvironment(env) === "development";
}
