// ============================================================================
// HYBRID STORE  (Neon API first, localStorage fallback)
//
// Implements the same DataStore interface the whole app already uses. On the
// first load() it probes the serverless API:
//   - API reachable + DB configured  -> read/write the active tenant via /api/state
//   - otherwise (e.g. `vite dev` with no functions, or DB not set) -> localStorage
//
// Because it satisfies DataStore, NOTHING else in the app changes: the commission
// engine, reducer, and every page keep working exactly as before — the bytes
// just now live in Postgres, scoped per tenant.
// ============================================================================

import type { AppData } from "../../types";
import type { DataStore } from "./index";
import { LocalStorageStore } from "./localStorage";

const TENANT_KEY = "scm.tenant";
const DEFAULT_TENANT = "demo";

export function getActiveTenant(): string {
  try {
    return localStorage.getItem(TENANT_KEY) || DEFAULT_TENANT;
  } catch {
    return DEFAULT_TENANT;
  }
}

export function setActiveTenant(slug: string): void {
  try {
    localStorage.setItem(TENANT_KEY, slug);
  } catch {
    /* ignore */
  }
}

export type Backend = "neon" | "local" | "unknown";

interface BackendInfo {
  backend: Backend;
  tenant: string;
  label: string;
}

let backend: Backend = "unknown";

export function getBackendInfo(): BackendInfo {
  const tenant = getActiveTenant();
  const label =
    backend === "neon"
      ? `Neon Postgres · tenant “${tenant}”`
      : backend === "local"
        ? "Browser localStorage (fallback)"
        : "Detecting…";
  return { backend, tenant, label };
}

async function apiGet(tenant: string): Promise<AppData | null> {
  const res = await fetch(`/api/state?tenant=${encodeURIComponent(tenant)}`, {
    headers: { accept: "application/json" },
  });
  if (!res.ok) throw new Error(`state GET ${res.status}`);
  const ct = res.headers.get("content-type") || "";
  if (!ct.includes("application/json")) throw new Error("not json");
  const body = await res.json();
  if (!body || !body.data || !Array.isArray(body.data.salespeople)) {
    throw new Error("invalid state payload");
  }
  return body.data as AppData;
}

async function apiPut(tenant: string, data: AppData): Promise<void> {
  const res = await fetch(`/api/state?tenant=${encodeURIComponent(tenant)}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ data }),
  });
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
    const tenant = getActiveTenant();
    try {
      const data = await apiGet(tenant);
      backend = "neon";
      // mirror to localStorage as an offline cache / backup
      void this.local.save(data as AppData).catch(() => {});
      return data;
    } catch {
      backend = "local";
      return this.local.load();
    }
  }

  async save(data: AppData): Promise<void> {
    // always keep a local backup immediately
    void this.local.save(data).catch(() => {});
    if (backend !== "neon") return;

    // debounce API writes so a burst of edits coalesces into one PUT
    this.pending = data;
    if (this.saveTimer) clearTimeout(this.saveTimer);
    await new Promise<void>((resolve) => {
      this.saveTimer = setTimeout(async () => {
        const snapshot = this.pending;
        this.pending = null;
        if (!snapshot) return resolve();
        try {
          await apiPut(getActiveTenant(), snapshot);
        } catch {
          // network blip: the local backup above still has the data
          backend = "local";
        } finally {
          resolve();
        }
      }, 350);
    });
  }

  async clear(): Promise<void> {
    await this.local.clear();
    // server data is re-seedable via POST /api/seed?reset=1; we don't drop it here
  }
}

export const store: DataStore = new HybridStore();
