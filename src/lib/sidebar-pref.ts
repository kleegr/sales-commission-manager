// ============================================================================
// sidebar-pref  (client)
//
// Persisted expanded/collapsed preference for the embedded (Kleegr / GoHighLevel
// iframe) navigation rail.
//
// This lives in localStorage, NOT sessionStorage, on purpose: GHL tears the
// iframe down and re-creates it whenever the user switches sub-accounts, which
// wipes sessionStorage (that is exactly why "scm.embedded" is re-latched from
// the ?kleegr=connected query string in useEmbedded). A layout preference the
// user set by hand should outlive both a reload and a sub-account switch, so it
// needs the durable store.
//
// The read/write helpers take the store as an argument and swallow every
// throw so they stay usable from a Safari private window or a GHL frame with
// third-party storage blocked -- in that case the preference simply does not
// persist and the caller falls back to its default.
// ============================================================================

export const SIDEBAR_PREF_KEY = "scm.sidebarExpanded";

/** The slice of the Storage API we need (keeps the helpers testable + DOM-free). */
export interface PrefStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/**
 * Read the stored preference, falling back to `fallback` when it is unset,
 * unrecognised, or the store is unavailable/throwing.
 */
export function readSidebarPref(store: PrefStore | undefined, fallback: boolean): boolean {
  try {
    const raw = store?.getItem(SIDEBAR_PREF_KEY);
    if (raw === "1") return true;
    if (raw === "0") return false;
    return fallback;
  } catch {
    return fallback;
  }
}

/** Persist the preference. Never throws: blocked storage is a no-op, not an error. */
export function writeSidebarPref(store: PrefStore | undefined, expanded: boolean): void {
  try {
    store?.setItem(SIDEBAR_PREF_KEY, expanded ? "1" : "0");
  } catch {
    // Storage blocked (private mode / third-party cookie policy): the choice
    // still applies for this session, it just does not survive a reload.
  }
}

/** The browser's localStorage, or undefined when it is unavailable. */
export function browserPrefStore(): PrefStore | undefined {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}
