import type { AppData } from "../../types";
import type { DataStore } from "./index";

export type Backend = "neon" | "local" | "unknown";

/** Classification for showing authentication, request, or connection errors. */
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
 * API, so it is reported as a connection failure.
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
    // not usefully. Do not treat an invalid response as an empty workspace.
    throw new StateLoadError("outage", res.status, "invalid state payload");
  }
  return body.data as AppData;
}

export class HybridStore implements DataStore {
  private generation = 0;
  private revision = 0;
  private blocked = true;
  private queue: Promise<void> = Promise.resolve();
  get name(): string { return getBackendInfo().label; }
  async load(): Promise<AppData | null> {
    const generation = this.generation;
    try {
      const data = await apiGet();
      if (generation !== this.generation) throw new StateLoadError('client', null, 'The workspace changed.');
      this.revision = Number(data.revision || 0);
      this.blocked = false;
      backend = 'neon'; readOnly = false; offlineData = false;
      return data;
    } catch (e) {
      if (generation === this.generation) { this.blocked = true; readOnly = true; offlineData = false; }
      throw e;
    }
  }
  save(data: AppData): Promise<void> {
    const generation = this.generation;
    const task = this.queue.then(async () => {
      if (generation !== this.generation) throw new Error('The workspace changed.');
      if (this.blocked) throw new Error('Reload the current workspace before saving.');
      if (readOnly) return;
      let res: Response;
      try {
        res = await fetch('/api/state', { method: 'PUT', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ data: { ...data, revision: this.revision } }) });
      } catch {
        this.blocked = true;
        throw new Error('Changes could not be saved. Check your connection and reload.');
      }
      if (res.status === 403) { readOnly = true; return; }
      if (!res.ok) {
        this.blocked = true;
        throw new Error(res.status === 409 ? 'New data arrived. Reload before making more changes.' : 'Changes could not be saved. Please reload and retry.');
      }
      const body = await res.json();
      this.revision = Number(body.revision ?? this.revision);
    });
    this.queue = task.catch(() => {});
    return task;
  }
  async clear(): Promise<void> { this.generation++; this.blocked = true; }
}

export const store: DataStore = new HybridStore();
