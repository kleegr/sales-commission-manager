// ============================================================================
// HYBRID STORE  (Neon API first, localStorage fallback)
//
// Implements the DataStore interface the whole app uses. On load() it reads the
// current user's tenant-scoped AppData from /api/state (the TENANT IS DERIVED
// FROM THE SESSION on the server — never sent by the client). If the API is
// unreachable (e.g. `vite dev` with no serverless functions), it falls back to
// browser localStorage so the UI still renders.
//
// save() PUTs the snapshot back; this only succeeds for owner/admin sessions
// (the server rejects snapshot writes from scoped roles with 403, which the
// store treats as read-only and silently ignores).
// ============================================================================

import type { AppData } from "../../types";
import type { DataStore } from "./index";
import { LocalStorageStore } from "./localStorage";

export type Backend = "neon" | "local" | "unknown";

let backend: Backend = "unknown";
let readOnly = false;

export function getBackendInfo(): { backend: Backend; label: string; readOnly: boolean } {
  const label =
    backend === "neon"
      ? "Neon Postgres"
      : backend === "local"
        ? "Browser localStorage (fallback)"
        : "Detecting…";
  return { backend, label, readOnly };
}

async function apiGet(): Promise<AppData | null> {
  const res = await fetch(`/api/state`, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`state GET ${res.status}`);
  const ct = res.headers.get("content-type") || "";
  if (!ct.includes("application/json")) throw new Error("not json");
  const body = await res.json();
  if (!body || !body.data || !Array.isArray(body.data.salespeople)) {
    throw new Error("invalid state payload");
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
    try {
      const data = await apiGet();
      backend = "neon";
      void this.local.save(data as AppData).catch(() => {});
      return data;
    } catch {
      backend = "local";
      return this.local.load();
    }
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
