// ============================================================================
// HYBRID STORE  (Neon API first; localStorage only where no server exists)
//
// Implements the DataStore interface the whole app uses. On load() it reads the
// current user's tenant-scoped AppData from /api/state (the TENANT IS DERIVED
// FROM THE SESSION on the server — never sent by the client).
//
// READS — WHY load() CLASSIFIES THE FAILURE INSTEAD OF CATCHING EVERYTHING:
// it used to answer every failure the same way — serve whatever was in
// localStorage. That is right when there is NO server (a `vite dev` run has no
// serverless functions) and wrong for everything else. When a dead session made
// /api/state return 401, the Dashboard quietly rendered stale local data and
// looked healthy, while pages without a cache showed the raw 401.
//
// The cases are separated by classifyStateResponse():
//   - 401 / 403  → the API answered and REFUSED us. Propagate, never serve
//                  cached data: the caller has to deal with the dead session
//                  (AppContext hands it to AuthContext, which drops the token
//                  and bounces to the login screen).
//   - 4xx        → a genuine application error. Propagate; stale data would
//                  only disguise the bug.
//   - not our JSON API at all → "absent": no server exists here, so the local
//                  copy IS the backend. This is the `vite dev` path.
//   - 5xx / network failure   → "outage": a server exists and is failing.
//                  Whether its cache may be shown is decided by
//                  fallback-policy.ts, which refuses in production.
//
// WRITES — THERE IS NO LONGER A SNAPSHOT WRITE.
// `PUT /api/state` has been removed (see api/state.ts). Every mutation goes
// through a per-resource endpoint, so save() no longer talks to the server at
// all. It keeps the localStorage copy up to date ONLY while no server owns the
// data; once /api/state has answered, writing a local copy would create a
// second, divergent source of truth — precisely the balance mismatch this
// refactor exists to remove.
// ============================================================================

import type { AppData } from "../../types";
import type { DataStore } from "./index";
import { LocalStorageStore } from "./localStorage";
import {
  allowCachedRead,
  allowLocalWrites,
  browserModeStore,
  coerceServerMode,
  readRememberedMode,
  rememberMode,
  type ServerMode,
} from "./fallback-policy";

export type Backend = "neon" | "local" | "unknown";

/**
 * Why a /api/state read failed — which is what decides whether the cached copy
 * is allowed to stand in for it.
 *
 *   "auth"    the session is gone (401) or refused (403)
 *   "client"  a 4xx we caused; a real error to surface
 *   "absent"  nothing answering /api/state is our API (no serverless functions)
 *   "outage"  our API exists but is failing (5xx / network)
 */
export type StateErrorKind = "auth" | "client" | "absent" | "outage";

/** A classified /api/state failure. `status` is null for a network failure. */
export class StateLoadError extends Error {
  readonly kind: StateErrorKind;
  readonly status: number | null;

  constructor(kind: StateErrorKind, status: number | null, message: string) {
    super(message);
    this.name = "StateLoadError";
    this.kind = kind;
    this.status = status;
  }
}

/** True for the one failure that means "this session is over". */
export function isAuthError(err: unknown): err is StateLoadError {
  return err instanceof StateLoadError && err.kind === "auth";
}

/** True when the data could not be loaded AND no cached copy was permitted. */
export function isUnavailableError(err: unknown): err is StateLoadError {
  return err instanceof StateLoadError && err.kind === "outage";
}

let backend: Backend = "unknown";
let offlineData = false;
let serverMode: ServerMode | null = null;

export interface BackendInfo {
  backend: Backend;
  label: string;
  /**
   * True when this deployment's data is owned by the server. The UI uses it to
   * hide local-only affordances (import / reset to demo data) that would write
   * a dataset the database never sees.
   */
  serverAuthoritative: boolean;
  readOnly: boolean;
  /** True when the data in hand came from the cache after an outage. */
  isOfflineData: boolean;
}

export function getBackendInfo(): BackendInfo {
  const label =
    backend === "neon"
      ? "Neon Postgres"
      : backend === "local"
        ? "Browser localStorage (fallback)"
        : "Detecting…";
  const authoritative = serverMode?.serverAuthoritative ?? false;
  return {
    backend,
    label,
    serverAuthoritative: authoritative,
    // Nothing in the app writes the snapshot any more, so "read-only" now means
    // exactly one thing: the local store is not a legitimate write target.
    readOnly: authoritative,
    isOfflineData: offlineData,
  };
}

/** Test seam + logout hook: forget everything learned about the backend. */
export function resetBackendInfo(): void {
  backend = "unknown";
  offlineData = false;
  serverMode = null;
}

/**
 * Classify a /api/state response. Returns null when it should be read as a
 * success, otherwise the kind of failure it represents.
 *
 * Content type is checked FIRST and deliberately: a response that is not JSON
 * did not come from our API at all — `vite dev` and any static host answer
 * /api/state with the SPA shell (HTML, often 200 or 404). That is an ABSENT
 * API, not an application error and not an outage, so it must reach the
 * local-backend path rather than being reported to the user.
 *
 * Pure (status + content type in, kind out) so every branch is unit-testable
 * without a live response — see apiStore.test.ts.
 */
export function classifyStateResponse(
  status: number,
  contentType: string | null,
): StateErrorKind | null {
  if (!(contentType || "").includes("application/json")) return "absent";
  if (status >= 200 && status < 300) return null;
  if (status === 401 || status === 403) return "auth";
  if (status >= 500) return "outage";
  // 410 Gone is what the retired snapshot write answers; on a GET any other 4xx
  // is a real application error.
  return "client";
}

interface StatePayload {
  data: AppData;
  mode: ServerMode | null;
}

async function apiGet(): Promise<StatePayload> {
  let res: Response;
  try {
    res = await fetch(`/api/state`, { headers: { accept: "application/json" } });
  } catch {
    // fetch() only rejects when the request never completed — offline, DNS
    // failure, connection refused. A server exists (we are deployed); it is
    // unreachable. That is an outage, not an absent API.
    throw new StateLoadError("outage", null, "state GET failed to reach the server");
  }

  const kind = classifyStateResponse(res.status, res.headers.get("content-type"));
  if (kind) throw new StateLoadError(kind, res.status, `state GET ${res.status}`);

  const body = await res.json().catch(() => null);
  if (!body || !body.data || !Array.isArray(body.data.salespeople)) {
    // A 2xx that is not the payload we asked for: the endpoint is answering but
    // not usefully. Treat it as an outage so the cache policy decides.
    throw new StateLoadError("outage", res.status, "invalid state payload");
  }
  return { data: body.data as AppData, mode: coerceServerMode(body.mode) };
}

export class HybridStore implements DataStore {
  private readonly local = new LocalStorageStore();

  get name(): string {
    return getBackendInfo().label;
  }

  async load(): Promise<AppData | null> {
    let payload: StatePayload;
    try {
      payload = await apiGet();
    } catch (err) {
      const kind = err instanceof StateLoadError ? err.kind : "outage";
      if (kind !== "absent" && kind !== "outage") {
        // The API answered and refused. Do NOT serve the cache — that is what
        // let a dead session look like a working Dashboard.
        throw err;
      }

      const remembered = readRememberedMode(browserModeStore());
      if (!allowCachedRead(kind, remembered)) {
        // Production: a stale ledger is worse than an honest error.
        serverMode = remembered;
        backend = "unknown";
        throw err instanceof StateLoadError
          ? err
          : new StateLoadError("outage", null, "state unavailable");
      }

      backend = "local";
      offlineData = true;
      if (kind === "absent") serverMode = null; // no server owns this data
      else serverMode = remembered;
      return this.local.load();
    }

    backend = "neon";
    offlineData = false;
    serverMode = payload.mode;
    if (payload.mode) rememberMode(browserModeStore(), payload.mode);
    // Cache ONLY what the server sent, so a cached read can never contain a
    // locally-mutated number the database has not seen.
    void this.local.save(payload.data).catch(() => {});
    return payload.data;
  }

  /**
   * Persist local state. A no-op wherever a server owns the data: the snapshot
   * write is gone, and a local copy of client-side edits would diverge from the
   * database. Kept for the local-only backend (`vite dev`), which has no API.
   */
  async save(data: AppData): Promise<void> {
    if (!allowLocalWrites(serverMode)) return;
    await this.local.save(data).catch(() => {});
  }

  async clear(): Promise<void> {
    await this.local.clear();
  }
}

export const store: DataStore = new HybridStore();
