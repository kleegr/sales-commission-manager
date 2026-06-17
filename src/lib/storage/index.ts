// ============================================================================
// STORAGE ABSTRACTION
//
// The entire app reads/writes data through this `DataStore` interface only
// (via the AppContext). Today it is backed by the browser's localStorage.
// Tomorrow it can be backed by GoHighLevel Custom Objects / Contacts /
// Payments / Affiliate Manager or any external database by writing a new
// class that implements the same interface — no UI or engine changes needed.
// ============================================================================

import type { AppData } from "../../types";

export interface DataStore {
  /** Load the full dataset, or null if nothing stored yet. */
  load(): Promise<AppData | null>;
  /** Persist the full dataset. */
  save(data: AppData): Promise<void>;
  /** Remove all stored data (used by "reset demo data"). */
  clear(): Promise<void>;
  /** Human label for the active backend (shown in Settings). */
  readonly name: string;
}
