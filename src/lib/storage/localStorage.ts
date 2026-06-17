// Browser localStorage implementation of DataStore.
// Swap this out for a GoHighLevelStore / ApiStore later — same interface.

import type { AppData } from "../../types";
import type { DataStore } from "./index";

const KEY = "scm.data.v1";

export class LocalStorageStore implements DataStore {
  readonly name = "Browser localStorage (prototype)";

  async load(): Promise<AppData | null> {
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return null;
      return JSON.parse(raw) as AppData;
    } catch {
      return null;
    }
  }

  async save(data: AppData): Promise<void> {
    try {
      localStorage.setItem(KEY, JSON.stringify(data));
    } catch (e) {
      // Quota or serialization error — surface to console for the prototype.
      console.error("Failed to persist data", e);
    }
  }

  async clear(): Promise<void> {
    localStorage.removeItem(KEY);
  }
}

export const store: DataStore = new LocalStorageStore();
