// ============================================================================
// HYBRID STORE  (Neon API first, localStorage fallback)
//
// Implements the DataStore interface the whole app uses. On load() it reads the
// current user's tenant-scoped AppData from /api/state (the TENANT IS DERIVED
// FROM THE SESSION on the server — never sent by the client).
//
// WHY load() CLASSIFIES THE FAILURE INSTEAD OF CATCHING EVERYTHING:
// it used to answer every failure the same way — serve whatever was in
// localStorage. That is right for an OUTAGE (the API is unreachable, so a
// cached copy beats a blank screen) and wrong for a REFUSAL. When a dead
// session made /api/state return 401, the Dashboard quietly rendered stale
// local data and looked healthy, while pages without a cache (Documents,
// Goals) showed the raw 401. The failure was real; the fallback just hid it on
// the one page people looked at first.
//
// So the three cases are now separated:
//   - 401 / 403  → the API answered and REFUSED us. Propagate, never serve
//                  cached data: the caller has to deal with the dead session
//                  (AppContext hands it to AuthContext, which drops the token
//                  and bounces to the login screen).
//   - 4xx        → a genuine application error. Propagate; stale data would
//                  only disguise the bug.
//   - 5xx / network / a response that isn't our JSON API at all (e.g. `vite
//                  dev` with no serverless functions, which answers /api/state
//                  with the SPA's index.html) → an OUTAGE. Fall back to the
//                  cached copy and raise the `isOfflineData` flag so the UI can
//                  say the data is stale.
//
// save() PUTs the snapshot back; this only succeeds for owner/admin sessions
// (the server rejects snapshot writes from scoped roles with 403, which the
// store treats as read-only and silently ignores).
// ============================================================================

import type { AppData } from "../../types";
import type { DataStore } from "./index";
import { LocalStorageStore } from "./localStorage";

export type Backend = "neon" | "local" | "unknown";

/**
 * Why a /api/state read failed — which is what decides whether the cached copy
 * is allowed to stand in for it.
 *
 *   "auth"    the session is gone (401) or refused (403)
 *   "client"  a 4xx we caused; a real error to surface
 *   "outage"  unreachable or broken upstream; cached data is better than none
 */
export type StateErrorKind = "auth" | "client" | "outage";

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

let backend: Backend = "unknown";
let readOnly = false;
let offlineData = false;

export interface BackendInfo {
  backend: Backend;
  label: string;
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
  return { backend, label, readOnly, isOfflineData: offlineData };
}

/**
 * Classify a /api/state response. Returns null when it should be read as a
 * success, otherwise the kind of failure it represents.
 *
 * Content type is checked FIRST and deliberately: a response that is not JSON
 * did not come from our API at all — `vite dev` and any static host answer
 * /api/state with the SPA shell (HTML, often 200 or 404). That is an absent
 * API, not an application error, so it must reach the cached-data path rather
 * than being reported to the user as a 404.
 *
 * Pure (status + content type in, kind out) so every branch is unit-testable
 * without a live response — see apiStore.test.ts.
 */
export function classifyStateResponse(
  status: number,
  contentType: string | null,
): StateErrorKind | null {
  if (!(contentType || "").includes("application/json")) return "outage";
  if (status >= 200 && status < 300) return null;
  if (status === 401 || status === 403) return "auth";
  if (status >= 500) return "outage";
  return "client";
}

async function apiGet(): Promise<AppData> {
  let res: Response;
  try {
    res = await fetch(`/api/state`, { headers: { accept: "application/json" } });
  } catch {
    // fetch() only rejects when the request never completed — offline, DNS
    // failure, connection refused. Always an outage.
    throw new StateLoadError("outage", null, "state GET failed to reach the server");
  }

  const kind = classifyStateResponse(res.status, res.headers.get("content-type"));
  if (kind) throw new StateLoadError(kind, res.status, `state GET ${res.status}`);

  const body = await res.json().catch(() => null);
  if (!body || !body.data || !Array.isArray(body.data.salespeople)) {
    // A 2xx that is not the payload we asked for: the endpoint is answering but
    // not usefully. Cached data still beats an empty screen.
    throw new StateLoadError("outage", res.status, "invalid state payload");
  }
  return body.data as AppData;
}

async function apiPut(data: AppData): Promise<void> {
  const res = await fetch(`/api/state`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ data }),
  });
  if (res.status === 403) {
    // scoped role: snapshot writes aren't allowed — go read-only, don't error
    readOnly = true;
    return;
  }
  if (!res.ok) throw new Error(`state PUT ${res.status}`);
}

export class HybridStore implements DataStore {
  private readonly local = new LocalStorageStore();
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private pending: AppData | null = null;

  get name(): string {
    return getBackendInfo().label;
  }

  async load(): Promise<AppData | null> {
    let data: AppData;
    try {
      data = await apiGet();
    } catch (err) {
      // Anything not already classified reached us from outside apiGet(); the
      // safe reading is "unreachable", which is also the pre-existing behaviour.
      const kind = err instanceof StateLoadError ? err.kind : "outage";
      if (kind !== "outage") {
        // The API answered and refused. Do NOT serve the cache — that is what
        // let a dead session look like a working Dashboard. `backend` is left
        // alone so save() cannot start PUTting against a session we know the
        // server is rejecting.
        throw err;
      }
      backend = "local";
      offlineData = true;
      return this.local.load();
    }

    backend = "neon";
    offlineData = false;
    void this.local.save(data).catch(() => {});
    return data;
  }

  async save(data: AppData): Promise<void> {
    void this.local.save(data).catch(() => {});
    if (backend !== "neon" || readOnly) return;

    this.pending = data;
    if (this.saveTimer) clearTimeout(this.saveTimer);
    await new Promise<void>((resolve) => {
      this.saveTimer = setTimeout(async () => {
        const snapshot = this.pending;
        this.pending = null;
        if (!snapshot) return resolve();
        try {
          await apiPut(snapshot);
        } catch {
          backend = "local";
        } finally {
          resolve();
        }
      }, 350);
    });
  }

  async clear(): Promise<void> {
    await this.local.clear();
  }
}

export const store: DataStore = new HybridStore();
